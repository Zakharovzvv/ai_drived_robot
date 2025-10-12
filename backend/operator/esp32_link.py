"""High-level helper for talking to the ESP32 UART CLI over a serial connection.

The link is shared by the CLI tool and the web backend. It provides:
* auto-discovery of the first matching serial port (configurable override)
* resilient command execution with configurable timeouts and prompt detection
* parsing helpers for key=value CLI replies
* background streaming utilities for telemetry subscriptions
"""
from __future__ import annotations

import re
import threading
import time
from collections import deque
from dataclasses import dataclass
from typing import Any, Callable, Dict, Iterable, List, Optional

import logging

logger = logging.getLogger(__name__)

try:
    import serial  # type: ignore
    from serial.tools import list_ports  # type: ignore
except ImportError as exc:  # pragma: no cover - handled at runtime
    serial = None
    list_ports = None
    _IMPORT_ERROR = exc
else:
    _IMPORT_ERROR = None


if serial is not None:  # pragma: no cover - depends on runtime environment
    SerialException = serial.SerialException
else:  # pragma: no cover - used to silence type-checkers when pyserial missing
    class SerialException(Exception):
        """Fallback serial exception used when pyserial is unavailable."""

        pass


DEFAULT_BAUDRATE = 115200
# Status polls can block on repeated I2C retries; allow ample margin.
DEFAULT_TIMEOUT = 20.0  # seconds
# Allow long gaps between chunks (I2C retries delay status output by several seconds).
DEFAULT_SILENCE_GAP = 10.0  # seconds without data before we consider reply finished


class SerialNotFoundError(RuntimeError):
    """Raised when no matching serial interface is available."""


class CommandError(RuntimeError):
    """Raised when the CLI indicates an error condition."""


@dataclass
class CommandResult:
    """Structured response for a CLI command."""

    raw: List[str]
    data: Dict[str, object]

    def __bool__(self) -> bool:  # pragma: no cover - convenience helper
        return bool(self.raw)


def discover_serial_port(preferred: Optional[str] = None) -> str:
    """Locate a serial port.

    Args:
        preferred: explicit port name requested by the operator.

    Returns:
        The port path as understood by pyserial (e.g. "/dev/tty.usbmodem1101").

    Raises:
        SerialNotFoundError: if no suitable port can be found.
    """

    if preferred:
        return preferred

    if list_ports is None:  # pragma: no cover - dependency missing during static checks
        raise SerialNotFoundError(
            "pyserial is not installed; install via 'pip install pyserial'."
        )

    ports = list(list_ports.comports())
    if not ports:
        raise SerialNotFoundError("No serial devices detected. Specify --port explicitly.")

    # Heuristic: prefer devices whose description mentions ESP32/USB/SLAB.
    for candidate in ports:
        description = (candidate.description or "").lower()
        if any(keyword in description for keyword in ("esp32", "usb", "cp210", "ch34")):
            return candidate.device

    # Fallback: return the first device.
    return ports[0].device


class ESP32Link:
    """Thread-safe helper for communicating with the ESP32 CLI."""

    def __init__(
        self,
        port: Optional[str] = None,
        baudrate: int = DEFAULT_BAUDRATE,
        timeout: float = DEFAULT_TIMEOUT,
        silence_gap: float = DEFAULT_SILENCE_GAP,
        prompt_pattern: str = r"^(?>[>#]\s*)?$",
    ) -> None:
        self._requested_port = port
        self._baudrate = baudrate
        self._timeout = timeout
        self._silence_gap = silence_gap
        self._prompt_regex = re.compile(prompt_pattern)
        self._serial: Optional[Any] = None
        self._lock = threading.RLock()
        self._active_port: Optional[str] = None
        self._log_fragment: bytes = b""
        self._log_buffer: "deque[tuple[float, str]]" = deque(maxlen=1000)
        self._pending_logs: list[tuple[float, str]] = []

    # ------------------------------------------------------------------
    # Lifecycle helpers
    # ------------------------------------------------------------------
    def open(self) -> None:
        """Open the serial port if it is not already open."""

        with self._lock:
            if self._serial and self._serial.is_open:
                return

            if serial is None:
                raise SerialNotFoundError(
                    "pyserial is not installed; install via 'pip install pyserial'."
                )

            port_path = discover_serial_port(self._requested_port)
            try:
                open_serial = getattr(serial, "serial_for_url", serial.Serial)
                self._serial = open_serial(
                    port_path,
                    baudrate=self._baudrate,
                    timeout=self._timeout,
                    write_timeout=self._timeout,
                )
            except (SerialException, OSError) as exc:
                self._serial = None
                self._active_port = None
                raise SerialNotFoundError(f"could not open port {port_path}: {exc}") from exc
            self._serial.reset_input_buffer()
            self._serial.reset_output_buffer()
            self._active_port = port_path

    def close(self) -> None:
        """Close the underlying serial connection."""

        with self._lock:
            if self._serial and self._serial.is_open:
                self._serial.close()
            self._serial = None
            self._active_port = None

    def __enter__(self) -> "ESP32Link":
        """Context manager entry."""

        self.open()
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.close()

    @property
    def active_port(self) -> Optional[str]:
        """Return the currently open serial port, if any."""

        return self._active_port

    @property
    def requested_port(self) -> Optional[str]:
        """Return the user-requested serial port, if any."""

        return self._requested_port

    # ------------------------------------------------------------------
    # Command execution
    # ------------------------------------------------------------------
    def run_command(
        self,
        command: str,
        *,
        timeout: Optional[float] = None,
        raise_on_error: bool = True,
        parser: Optional[Callable[[List[str]], Dict[str, object]]] = None,
    ) -> CommandResult:
        """Send a command and return the parsed result."""

        with self._lock:
            self.open()
            if not self._serial:
                raise SerialNotFoundError("Serial device unavailable")

            ser = self._serial
            try:
                self._record_new_logs(self._drain_logs_locked())
                ser.write((command.strip() + "\n").encode("utf-8"))
                ser.flush()

                lines = self._read_reply_lines(ser, timeout=timeout)

                self._record_new_logs(self._drain_logs_locked())
            except SerialNotFoundError:
                raise
            except (SerialException, OSError) as exc:
                self._handle_serial_disconnect(exc)
                raise SerialNotFoundError(str(exc)) from exc

        if raise_on_error:
            self._detect_cli_error(lines)

        parsed = parse_key_value_lines(lines) if parser is None else parser(lines)
        return CommandResult(raw=lines, data=parsed)

    def _handle_serial_disconnect(self, exc: BaseException) -> None:
        """Close the current serial handle after an unexpected disconnect."""

        logger.warning("Serial link lost: %s", exc)
        if self._serial:
            try:
                self._serial.close()
            except Exception:  # pragma: no cover - best effort cleanup
                pass
        self._serial = None
        self._active_port = None
        self._log_fragment = b""

    def collect_pending_logs(self) -> list[tuple[float, str]]:
        """Return log lines captured since the last call."""

        with self._lock:
            self._record_new_logs(self._drain_logs_locked())
            pending = list(self._pending_logs)
            self._pending_logs.clear()
        return pending

    def recent_logs(self, limit: int = 200) -> list[tuple[float, str]]:
        """Return the most recent log entries."""

        with self._lock:
            return list(self._log_buffer)[-limit:]

    # ------------------------------------------------------------------
    def subscribe(
        self,
        command: str,
        *,
        interval: float = 0.5,
        stop_event: Optional[threading.Event] = None,
        callback: Optional[Callable[[CommandResult], None]] = None,
    ) -> None:
        """Repeatedly execute a command and invoke a callback with each result."""

        stop_event = stop_event or threading.Event()

        while not stop_event.is_set():
            try:
                result = self.run_command(command, raise_on_error=False)
            except SerialException as exc:  # pragma: no cover - hardware dependent
                if callback:
                    callback(CommandResult(raw=[str(exc)], data={"error": str(exc)}))
                stop_event.wait(interval)
                continue

            if callback:
                callback(result)

            stop_event.wait(interval)

    # ------------------------------------------------------------------
    def _read_reply_lines(
        self,
        ser: Any,
        *,
        timeout: Optional[float],
    ) -> List[str]:
        deadline = time.monotonic() + (timeout or self._timeout)
        lines: List[str] = []
        last_data_ts: Optional[float] = None

        while time.monotonic() < deadline:
            try:
                raw = ser.readline()
            except (SerialException, OSError) as exc:
                self._handle_serial_disconnect(exc)
                raise SerialNotFoundError(str(exc)) from exc

            if raw:
                decoded = raw.decode("utf-8", errors="ignore").strip()
                if decoded:
                    if self._prompt_regex.match(decoded):
                        break
                    lines.append(decoded)
                    last_data_ts = time.monotonic()
            else:
                if lines and last_data_ts is not None:
                    if time.monotonic() - last_data_ts >= self._silence_gap:
                        break

        return lines

    @staticmethod
    def _detect_cli_error(lines: List[str]) -> None:
        for line in lines:
            if line.lower().startswith("error"):
                raise CommandError(line)

    def _drain_logs_locked(self) -> List[str]:
        if not self._serial or not self._serial.is_open:
            return []

        ser = self._serial
        collected: List[str] = []

        while True:
            try:
                waiting = getattr(ser, "in_waiting", 0)
            except (AttributeError, SerialException):
                waiting = 0
            except OSError as exc:
                self._handle_serial_disconnect(exc)
                raise SerialNotFoundError(str(exc)) from exc

            if not waiting:
                break

            try:
                chunk = ser.read(waiting)
            except (SerialException, OSError) as exc:
                self._handle_serial_disconnect(exc)
                raise SerialNotFoundError(str(exc)) from exc
            if not chunk:
                break

            data = self._log_fragment + chunk
            lines = data.split(b"\n")
            if data.endswith(b"\n"):
                self._log_fragment = b""
            else:
                self._log_fragment = lines.pop() if lines else data

            if lines and lines[-1] == b"":
                lines = lines[:-1]

            for raw in lines:
                line = raw.decode("utf-8", errors="ignore").rstrip("\r")
                if line:
                    collected.append(line)

        return collected

    def _record_new_logs(self, lines: Iterable[str]) -> None:
        if not lines:
            return

        now = time.time()
        for line in lines:
            entry = (now, line)
            self._log_buffer.append(entry)
            self._pending_logs.append(entry)


# ----------------------------------------------------------------------
# Parsing helpers
# ----------------------------------------------------------------------
VALUE_DECODERS: List[Callable[[str], object]] = [
    lambda token: int(token, 0),
    float,
]


def parse_value(token: str) -> object:
    token = token.strip()
    for decoder in VALUE_DECODERS:
        try:
            return decoder(token)
        except ValueError:
            continue

    if token.lower() in {"true", "false"}:
        return token.lower() == "true"

    return token


def parse_key_value_lines(lines: Iterable[str]) -> Dict[str, object]:
    """Parse CLI output consisting of key=value pairs."""

    data: Dict[str, object] = {}
    for line in lines:
        segments = re.split(r"[\s,]+", line)
        for segment in segments:
            if "=" not in segment:
                continue
            key, raw_value = segment.split("=", 1)
            key = key.strip()
            if not key:
                continue
            data[key] = parse_value(raw_value)
    return data


__all__ = [
    "CommandError",
    "CommandResult",
    "ESP32Link",
    "SerialNotFoundError",
    "discover_serial_port",
    "parse_key_value_lines",
    "parse_value",
]
