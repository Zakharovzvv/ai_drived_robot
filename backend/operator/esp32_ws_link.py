"""WebSocket-based transport for talking to the ESP32 CLI."""
from __future__ import annotations

import json
import logging
import threading
import time
from typing import Any, Callable, Dict, Iterable, List, Optional

try:
    import websocket  # type: ignore
except ImportError as exc:  # pragma: no cover - runtime dependency
    websocket = None  # type: ignore
    _IMPORT_ERROR = exc
else:
    _IMPORT_ERROR = None

from .esp32_link import (
    CommandError,
    CommandResult,
    SerialNotFoundError,
    parse_key_value_lines,
)

logger = logging.getLogger(__name__)


class ESP32WSLink:
    """Minimal compatibility layer mirroring the serial link API."""

    _LISTENER_BACKOFF_INITIAL = 0.5
    _LISTENER_BACKOFF_MAX = 10.0

    def __init__(self, url: str, timeout: float = 5.0) -> None:
        if websocket is None:
            raise SerialNotFoundError(
                "websocket-client is not installed; install via 'pip install websocket-client'."
            ) from _IMPORT_ERROR

        self._url = url.strip()
        self._timeout = timeout
        self._active_endpoint: Optional[str] = None
        self._lock = threading.RLock()
        self._log_next_seq: int = 0
        self._listener_thread: Optional[threading.Thread] = None
        self._listener_app: Optional[Any] = None
        self._listener_stop = threading.Event()
        self._last_heartbeat: Optional[float] = None
        self._uptime_ms: Optional[int] = None
        self._consecutive_failures = 0

    # ------------------------------------------------------------------
    def open(self) -> None:
        """No-op for compatibility."""

        self._active_endpoint = self._url
        self._ensure_listener()

    def close(self) -> None:
        """No-op for compatibility."""

        self._active_endpoint = None
        self._stop_listener()

    def __enter__(self) -> "ESP32WSLink":
        self.open()
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.close()

    # ------------------------------------------------------------------
    def run_command(
        self,
        command: str,
        *,
        timeout: Optional[float] = None,
        raise_on_error: bool = True,
        parser: Optional[Callable[[Iterable[str]], Dict[str, Any]]] = None,
    ) -> CommandResult:
        if websocket is None:  # pragma: no cover - defensive when dependency missing
            raise SerialNotFoundError("websocket-client dependency unavailable") from _IMPORT_ERROR

        target = self._url
        self._ensure_listener()
        try:
            ws = websocket.create_connection(
                target,
                timeout=timeout or self._timeout,
            )
        except (websocket.WebSocketException, OSError) as exc:
            self._active_endpoint = None
            self._log_failure("WebSocket connect failed: %s", exc)
            raise SerialNotFoundError(str(exc)) from exc

        try:
            ws.send(command.strip())
            raw_reply = ws.recv()
        except (websocket.WebSocketException, OSError) as exc:
            self._log_failure("WebSocket command failed: %s", exc)
            raise SerialNotFoundError(str(exc)) from exc
        finally:
            try:
                ws.close()
            except Exception:  # pragma: no cover - best effort cleanup
                pass

        self._active_endpoint = target
        self._consecutive_failures = 0
        if isinstance(raw_reply, bytes):
            reply_text = raw_reply.decode("utf-8", errors="ignore")
        else:
            reply_text = str(raw_reply)

        lines = [line.strip() for line in reply_text.splitlines() if line.strip()]

        if raise_on_error:
            for line in lines:
                if line.lower().startswith("err"):
                    raise CommandError(line)

        parsed = parse_key_value_lines(lines) if parser is None else parser(lines)
        return CommandResult(raw=lines, data=parsed)

    # ------------------------------------------------------------------
    def collect_pending_logs(self, limit: int = 64) -> List[tuple[float, str]]:
        with self._lock:
            since = self._log_next_seq
        original_since = since
        command = f"logs since={since}"
        if limit > 0:
            command = f"{command} limit={limit}"

        try:
            result = self.run_command(command, raise_on_error=False)
        except SerialNotFoundError:
            raise
        except CommandError as exc:
            raise SerialNotFoundError(str(exc)) from exc

        timestamp = time.time()
        entries: List[tuple[float, str]] = []
        summary: Dict[str, Any] = {}
        min_seq_seen: Optional[int] = None
        last_seq = since

        for line in result.raw:
            normalized = line.strip()
            if not normalized:
                continue
            if normalized.lower().startswith("logs_"):
                summary.update(parse_key_value_lines([normalized]))
                continue
            if "|" not in normalized:
                continue
            seq_text, payload = normalized.split("|", 1)
            try:
                seq_value = int(seq_text.strip())
            except ValueError:
                continue
            if min_seq_seen is None or seq_value < min_seq_seen:
                min_seq_seen = seq_value
            if seq_value < since:
                continue
            entries.append((timestamp, payload.strip()))
            if seq_value >= last_seq:
                last_seq = seq_value + 1

        next_hint_raw = summary.get("logs_next")
        count_hint_raw = summary.get("logs_count")
        error_hint = summary.get("logs_error")

        next_hint: Optional[int] = None
        if isinstance(next_hint_raw, (int, float)):
            next_hint = int(next_hint_raw)
            last_seq = max(last_seq, next_hint)

        if error_hint:
            raise SerialNotFoundError(f"log dump error: {error_hint}")

        reset_cursor: Optional[int] = None
        if entries:
            reset_cursor = None
        else:
            if min_seq_seen is not None and min_seq_seen < original_since:
                reset_cursor = min_seq_seen
            elif next_hint is not None and next_hint < original_since:
                if isinstance(count_hint_raw, (int, float)) and int(count_hint_raw) > 0:
                    reset_cursor = max(0, next_hint - int(count_hint_raw))
                else:
                    reset_cursor = max(0, next_hint)

        with self._lock:
            if reset_cursor is not None and reset_cursor != self._log_next_seq:
                logger.info(
                    "Restarting Wi-Fi log capture after sequence reset (%s -> %s)",
                    original_since,
                    reset_cursor,
                )
                self._log_next_seq = reset_cursor
            elif last_seq > self._log_next_seq:
                self._log_next_seq = last_seq

        if reset_cursor is not None:
            return []
        return entries

    def recent_logs(self, limit: int = 200) -> List[tuple[float, str]]:
        return []

    # ------------------------------------------------------------------
    @property
    def active_port(self) -> Optional[str]:
        return self._active_endpoint

    @property
    def requested_port(self) -> Optional[str]:
        return self._url

    @property
    def last_heartbeat(self) -> Optional[float]:
        with self._lock:
            return self._last_heartbeat

    @property
    def uptime_ms(self) -> Optional[int]:
        with self._lock:
            return self._uptime_ms

    # ------------------------------------------------------------------
    def _ensure_listener(self) -> None:
        if self._listener_thread and self._listener_thread.is_alive():
            return
        if websocket is None:
            return
        if not hasattr(websocket, "WebSocketApp"):
            return

        self._listener_stop.clear()
        self._listener_thread = threading.Thread(
            target=self._listener_loop,
            name="ESP32WSLinkHeartbeat",
            daemon=True,
        )
        self._listener_thread.start()

    def _stop_listener(self) -> None:
        self._listener_stop.set()
        listener = self._listener_app
        if listener is not None:
            try:
                listener.keep_running = False  # type: ignore[attr-defined]
            except Exception:  # pragma: no cover - best effort cleanup
                pass
            try:
                listener.close()
            except Exception:  # pragma: no cover - best effort cleanup
                pass
        if self._listener_thread and self._listener_thread.is_alive():
            self._listener_thread.join(timeout=2.0)
        self._listener_thread = None
        self._listener_stop.clear()
        self._listener_app = None

    def _listener_loop(self) -> None:
        if websocket is None or not hasattr(websocket, "WebSocketApp"):
            return

        backoff = self._LISTENER_BACKOFF_INITIAL
        while not self._listener_stop.is_set():
            app = websocket.WebSocketApp(
                self._url,
                on_open=self._on_listener_open,
                on_close=self._on_listener_close,
                on_error=self._on_listener_error,
                on_message=self._on_listener_message,
            )

            try:
                self._listener_app = app
                app.run_forever(ping_interval=30, ping_timeout=10)
                backoff = self._LISTENER_BACKOFF_INITIAL
            except Exception as exc:  # pragma: no cover - best effort logging
                logger.debug("Wi-Fi heartbeat loop failed: %s", exc)
                backoff = min(backoff * 2, self._LISTENER_BACKOFF_MAX)
            finally:
                self._listener_app = None

            if self._listener_stop.is_set():
                break
            if self._listener_stop.wait(backoff):
                break

    # ------------------------------------------------------------------
    def _on_listener_open(self, _ws) -> None:
        logger.debug("Wi-Fi heartbeat listener connected to %s", self._url)

    def _on_listener_close(self, _ws, status_code, msg) -> None:  # pragma: no cover - runtime
        logger.debug("Wi-Fi heartbeat listener closed (%s): %s", status_code, msg)

    def _on_listener_error(self, _ws, error) -> None:  # pragma: no cover - runtime
        logger.debug("Wi-Fi heartbeat listener error: %s", error)

    def _on_listener_message(self, _ws, message) -> None:
        text = message.decode("utf-8", errors="ignore") if isinstance(message, bytes) else str(message)
        text = text.strip()
        if not text:
            return
        if text.startswith("{"):
            try:
                payload = json.loads(text)
            except ValueError:
                return
            if payload.get("type") != "heartbeat":
                return
            logs_next = payload.get("logs_next")
            uptime = payload.get("uptime_ms")
            now = time.time()
            with self._lock:
                if isinstance(logs_next, (int, float)) and int(logs_next) > self._log_next_seq:
                    self._log_next_seq = int(logs_next)
                if isinstance(uptime, (int, float)):
                    self._uptime_ms = int(uptime)
                self._last_heartbeat = now
            return
        logger.debug("Unhandled WS push message: %s", text)

    # ------------------------------------------------------------------
    def _log_failure(self, template: str, error: object) -> None:
        if self._consecutive_failures == 0:
            logger.warning(template, error)
        else:
            logger.debug(template, error)
        self._consecutive_failures += 1