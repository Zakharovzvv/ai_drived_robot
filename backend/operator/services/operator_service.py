"""Core business logic for the operator backend."""
from __future__ import annotations

import asyncio
import contextlib
import base64
import json
import logging
import os
import threading
import time
import urllib.error
import urllib.request
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set, Tuple
from urllib.parse import urlparse

from fastapi import WebSocket

from ..esp32_link import CommandResult, ESP32Link, SerialNotFoundError
from ..esp32_ws_link import ESP32WSLink
from ..log_parser import structure_logs

logger = logging.getLogger("operator.service")

TRANSPORT_WIFI = "wifi"
TRANSPORT_SERIAL = "serial"
TRANSPORT_AUTO = "auto"
TRANSPORT_LABELS = {
    TRANSPORT_WIFI: "Wi-Fi",
    TRANSPORT_SERIAL: "UART",
}
DEFAULT_TRANSPORT_RETRY_COOLDOWN = 5.0


class CameraNotConfiguredError(RuntimeError):
    """Raised when camera access is requested but no URL configured."""


class CameraSnapshotError(RuntimeError):
    """Raised when fetching a camera snapshot fails."""


class OperatorService:
    """Async facade over the ESP32 link with background telemetry polling."""

    def __init__(
        self,
        port: Optional[str] = None,
        baudrate: int = 115200,
        timeout: float = 1.0,
        poll_command: str = "status",
        poll_interval: float = 1.0,
        camera_snapshot_url: Optional[str] = None,
        camera_timeout: float = 3.0,
        camera_transport: Optional[str] = None,
        camera_stream_interval: Optional[float] = None,
        control_transport: Optional[str] = None,
        ws_endpoint: Optional[str] = None,
    ) -> None:
        self._link_lock = threading.RLock()
        self._transports: Dict[str, Any] = {}
        self._transport_endpoints: Dict[str, Optional[str]] = {}
        self._transport_health: Dict[str, Dict[str, Any]] = {}
        self._transport_retry_cooldown = DEFAULT_TRANSPORT_RETRY_COOLDOWN
        cooldown_env = os.getenv("OPERATOR_TRANSPORT_RETRY_COOLDOWN")
        if cooldown_env:
            try:
                self._transport_retry_cooldown = max(0.0, float(cooldown_env))
            except ValueError:
                logger.warning(
                    "Invalid OPERATOR_TRANSPORT_RETRY_COOLDOWN=%s; using %.1f",
                    cooldown_env,
                    DEFAULT_TRANSPORT_RETRY_COOLDOWN,
                )
        self._active_transport: Optional[str] = None
        self._control_transport: Optional[str] = None
        self._control_endpoint: Optional[str] = None
        self._control_mode = TRANSPORT_AUTO
        self._link: Optional[Any] = None
        port_override = port
        if not port_override:
            env_port = os.getenv("OPERATOR_SERIAL_PORT")
            if env_port and env_port.strip():
                port_override = env_port.strip()

        baud_override = baudrate
        env_baud = os.getenv("OPERATOR_SERIAL_BAUDRATE")
        if env_baud:
            try:
                baud_override = int(env_baud)
            except ValueError:
                logger.warning("Invalid OPERATOR_SERIAL_BAUDRATE=%s; using %s", env_baud, baudrate)

        timeout_override = timeout
        env_timeout = os.getenv("OPERATOR_SERIAL_TIMEOUT")
        if env_timeout:
            try:
                timeout_override = float(env_timeout)
            except ValueError:
                logger.warning("Invalid OPERATOR_SERIAL_TIMEOUT=%s; using %s", env_timeout, timeout)
        self._serial_timeout = timeout_override

        transport_override = control_transport
        if transport_override is None:
            env_transport = os.getenv("OPERATOR_CONTROL_TRANSPORT")
            if env_transport and env_transport.strip():
                transport_override = env_transport
        transport_mode_raw = (transport_override or TRANSPORT_AUTO).strip().lower()
        if transport_mode_raw in {"ws", "wifi"}:
            desired_mode = TRANSPORT_WIFI
        elif transport_mode_raw in {"serial", "uart"}:
            desired_mode = TRANSPORT_SERIAL
        elif transport_mode_raw == TRANSPORT_AUTO:
            desired_mode = TRANSPORT_AUTO
        else:
            logger.warning(
                "Unsupported OPERATOR_CONTROL_TRANSPORT=%s; defaulting to auto",
                transport_mode_raw,
            )
            desired_mode = TRANSPORT_AUTO

        ws_override = ws_endpoint
        if ws_override is None:
            env_ws = os.getenv("OPERATOR_WS_ENDPOINT")
            if env_ws and env_ws.strip():
                ws_override = env_ws
        ws_clean = ws_override.strip() if isinstance(ws_override, str) else None

        self._ws_static_endpoint = ws_clean
        self._ws_auto_enabled = False

        if ws_clean:
            if self._configure_wifi_transport(ws_clean, timeout_override):
                logger.info("Wi-Fi transport enabled with static endpoint %s", ws_clean)
        else:
            self._ws_auto_enabled = True
            if desired_mode == TRANSPORT_WIFI:
                logger.info(
                    "Wi-Fi transport will be auto-configured once the ESP32 reports its IP address"
                )

        serial_link = ESP32Link(
            port=port_override,
            baudrate=baud_override,
            timeout=timeout_override,
        )
        self._transports[TRANSPORT_SERIAL] = serial_link
        self._transport_endpoints[TRANSPORT_SERIAL] = port_override
        self._transport_health[TRANSPORT_SERIAL] = {
            "available": False,
            "last_error": None,
            "last_success": None,
            "last_failure": None,
        }

        if not self._transports:
            raise ValueError("No control transports configured; configure Wi-Fi and/or UART")

        self._control_mode = desired_mode
        self._set_initial_transport()
        self._poll_command = poll_command
        self._poll_interval = poll_interval
        self._poll_task: Optional[asyncio.Task[None]] = None
        self._stop_event = asyncio.Event()
        self._clients: Set[asyncio.Queue[dict[str, Any]]] = set()
        self._clients_lock = asyncio.Lock()
        self._log_clients: Set[asyncio.Queue[dict[str, Any]]] = set()
        self._log_clients_lock = asyncio.Lock()
        self._log_task: Optional[asyncio.Task[None]] = None
        self._initial_probe_task: Optional[asyncio.Task[None]] = None
        self._log_sequence = 0
        override = (
            camera_snapshot_url
            if camera_snapshot_url is not None
            else os.getenv("OPERATOR_CAMERA_SNAPSHOT_URL")
        )
        self._camera_snapshot_override = override or None
        self._camera_timeout = camera_timeout
        self._default_camera_content_type = "image/jpeg"
        self._camera_transport = self._normalize_transport(
            camera_transport if camera_transport is not None else os.getenv("OPERATOR_CAMERA_TRANSPORT")
        )
        self._camera_stream_interval = (
            camera_stream_interval
            if camera_stream_interval is not None
            else self._resolve_camera_stream_interval()
        )
        self._last_status: dict[str, Any] = {}
        self._last_status_timestamp: Optional[float] = None
        self._last_status_error: Optional[str] = None
        self._camera_resolution_options = [
            {"id": "QQVGA", "label": "QQVGA", "width": 160, "height": 120},
            {"id": "QVGA", "label": "QVGA", "width": 320, "height": 240},
            {"id": "VGA", "label": "VGA", "width": 640, "height": 480},
            {"id": "SVGA", "label": "SVGA", "width": 800, "height": 600},
            {"id": "XGA", "label": "XGA", "width": 1024, "height": 768},
            {"id": "SXGA", "label": "SXGA", "width": 1280, "height": 1024},
            {"id": "UXGA", "label": "UXGA", "width": 1600, "height": 1200},
        ]
        self._camera_quality_range = (10, 63)
        self._shelf_palette = [
            {"id": "-", "label": "Empty", "color": "#0f172a"},
            {"id": "R", "label": "Red", "color": "#ef4444"},
            {"id": "G", "label": "Green", "color": "#22c55e"},
            {"id": "B", "label": "Blue", "color": "#3b82f6"},
            {"id": "Y", "label": "Yellow", "color": "#facc15"},
            {"id": "W", "label": "White", "color": "#f8fafc"},
            {"id": "K", "label": "Black", "color": "#111827"},
        ]
        self._shelf_allowed_codes: Set[str] = {entry["id"] for entry in self._shelf_palette}
        self._shelf_cache: Optional[Dict[str, Any]] = None
        self._shelf_cache_timestamp: Optional[float] = None
        self._shelf_cache_ttl = 1.0

    def _configure_wifi_transport(self, endpoint: str, timeout: float) -> bool:
        try:
            ws_link = ESP32WSLink(url=endpoint, timeout=timeout)
        except SerialNotFoundError as exc:
            logger.warning("Wi-Fi transport unavailable at %s: %s", endpoint, exc)
            self._transports.pop(TRANSPORT_WIFI, None)
            self._transport_endpoints[TRANSPORT_WIFI] = endpoint
            state = self._transport_health.setdefault(
                TRANSPORT_WIFI,
                {"available": False, "last_error": None, "last_success": None, "last_failure": None},
            )
            state["available"] = False
            state["last_error"] = str(exc)
            state["last_failure"] = time.time()
            return False

        self._transports[TRANSPORT_WIFI] = ws_link
        self._transport_endpoints[TRANSPORT_WIFI] = endpoint
        self._transport_health.setdefault(
            TRANSPORT_WIFI,
            {"available": False, "last_error": None, "last_success": None, "last_failure": None},
        )
        return True

    def _set_initial_transport(self) -> None:
        if self._control_mode == TRANSPORT_WIFI and TRANSPORT_WIFI in self._transports:
            self._set_active_transport(TRANSPORT_WIFI)
            return
        if self._control_mode == TRANSPORT_SERIAL and TRANSPORT_SERIAL in self._transports:
            self._set_active_transport(TRANSPORT_SERIAL)
            return
        if self._control_mode == TRANSPORT_AUTO:
            if TRANSPORT_WIFI in self._transports:
                self._set_active_transport(TRANSPORT_WIFI)
                return
            if TRANSPORT_SERIAL in self._transports:
                self._set_active_transport(TRANSPORT_SERIAL)
                return
        self._set_active_transport(None)

    def _set_active_transport(self, transport: Optional[str]) -> None:
        if transport is None:
            self._active_transport = None
            self._control_transport = None
            self._control_endpoint = None
            self._link = None
            return

        link = self._transports.get(transport)
        if not link:
            self._active_transport = None
            self._control_transport = None
            self._control_endpoint = None
            self._link = None
            return

        self._active_transport = transport
        self._control_transport = transport
        self._control_endpoint = self._transport_endpoints.get(transport)
        self._link = link

    def _preferred_transport_order(self) -> List[str]:
        if self._control_mode == TRANSPORT_WIFI:
            return [TRANSPORT_WIFI]
        if self._control_mode == TRANSPORT_SERIAL:
            return [TRANSPORT_SERIAL]

        order: List[str] = []
        if TRANSPORT_WIFI in self._transports:
            order.append(TRANSPORT_WIFI)
        if TRANSPORT_SERIAL in self._transports:
            order.append(TRANSPORT_SERIAL)
        if self._active_transport and self._active_transport not in order:
            order.insert(0, self._active_transport)
        return order

    def _ensure_wifi_transport(self, status: Dict[str, Any]) -> None:
        if not self._ws_auto_enabled:
            return
        wifi_connected = bool(status.get("wifi_connected"))
        wifi_ip_raw = status.get("wifi_ip")
        wifi_ip = str(wifi_ip_raw or "").strip()
        if not wifi_connected or not wifi_ip or wifi_ip in {"0.0.0.0", "0", "none"}:
            return

        endpoint = f"ws://{wifi_ip}:81/ws/cli"
        with self._link_lock:
            current_endpoint = self._transport_endpoints.get(TRANSPORT_WIFI)
            if current_endpoint == endpoint and TRANSPORT_WIFI in self._transports:
                return

            existing_link = self._transports.get(TRANSPORT_WIFI)
            if existing_link and hasattr(existing_link, "close"):
                with contextlib.suppress(Exception):
                    existing_link.close()

            if not self._configure_wifi_transport(endpoint, self._serial_timeout):
                return

            if self._control_mode in {TRANSPORT_WIFI, TRANSPORT_AUTO}:
                if self._control_mode == TRANSPORT_WIFI or self._active_transport != TRANSPORT_WIFI:
                    logger.info("Wi-Fi control transport registered at %s", endpoint)
                self._set_active_transport(TRANSPORT_WIFI)

    def _record_transport_success(self, transport: str) -> None:
        state = self._transport_health.setdefault(
            transport,
            {"available": False, "last_error": None, "last_success": None, "last_failure": None},
        )
        state["available"] = True
        state["last_error"] = None
        state["last_success"] = time.time()

    def _record_transport_failure(self, transport: str, error: str) -> None:
        state = self._transport_health.setdefault(
            transport,
            {"available": False, "last_error": None, "last_success": None, "last_failure": None},
        )
        state["available"] = False
        state["last_error"] = error
        state["last_failure"] = time.time()

    def _should_skip_transport(self, transport: str) -> bool:
        if self._control_mode != TRANSPORT_AUTO:
            return False
        if transport == self._active_transport:
            return False
        state = self._transport_health.get(transport)
        if not state or state.get("available", False):
            return False
        last_failure = state.get("last_failure")
        if last_failure is None:
            return False
        return (time.time() - last_failure) < self._transport_retry_cooldown

    def _control_state_snapshot(self) -> Dict[str, Any]:
        transports: List[Dict[str, Any]] = []
        for transport_id in sorted(self._transports.keys()):
            health = self._transport_health.get(transport_id, {})
            transports.append(
                {
                    "id": transport_id,
                    "label": TRANSPORT_LABELS.get(transport_id, transport_id.upper()),
                    "endpoint": self._transport_endpoints.get(transport_id),
                    "available": bool(health.get("available", False)),
                    "last_error": health.get("last_error"),
                    "last_success": health.get("last_success"),
                    "last_failure": health.get("last_failure"),
                }
            )
        return {
            "mode": self._control_mode,
            "active": self._active_transport,
            "transports": transports,
        }

    def get_control_state(self) -> Dict[str, Any]:
        return self._control_state_snapshot()

    async def set_control_mode(self, mode: str) -> Dict[str, Any]:
        normalized = (mode or "").strip().lower()
        if normalized in {TRANSPORT_AUTO, "auto"}:
            target = TRANSPORT_AUTO
        elif normalized in {TRANSPORT_WIFI, "wifi", "ws", "websocket"}:
            target = TRANSPORT_WIFI
        elif normalized in {TRANSPORT_SERIAL, "serial", "uart"}:
            target = TRANSPORT_SERIAL
        else:
            raise ValueError(f"Unsupported control mode: {mode!r}")

        schedule_probe = False
        with self._link_lock:
            if target == TRANSPORT_AUTO:
                self._control_mode = TRANSPORT_AUTO
                if self._active_transport not in self._transports:
                    self._set_active_transport(None)
                schedule_probe = True
            else:
                if target not in self._transports:
                    raise ValueError(f"Transport {target} is not configured")
                self._control_mode = target
                self._set_active_transport(target)

        if schedule_probe and not self._initial_probe_task:
            self._initial_probe_task = asyncio.create_task(self._initial_probe())

        return self._control_state_snapshot()

    async def _initial_probe(self) -> None:
        try:
            order = self._preferred_transport_order()
            for transport_id in order:
                if self._should_skip_transport(transport_id):
                    continue
                link = self._transports.get(transport_id)
                if not link:
                    continue
                try:
                    await asyncio.to_thread(
                        link.run_command,
                        self._poll_command,
                        raise_on_error=False,
                    )
                    self._record_transport_success(transport_id)
                    with self._link_lock:
                        self._set_active_transport(transport_id)
                    return
                except SerialNotFoundError as exc:
                    self._record_transport_failure(transport_id, str(exc))
                    if self._control_mode != TRANSPORT_AUTO:
                        return
                except Exception as exc:  # pragma: no cover - defensive
                    logger.exception("Initial probe failed for transport %s", transport_id)
            logger.warning("No control transport available during initial probe")
        finally:
            self._initial_probe_task = None


    async def start(self) -> None:
        if self._poll_task and not self._poll_task.done():
            return
        self._stop_event.clear()
        if self._control_mode == TRANSPORT_AUTO and not self._initial_probe_task:
            self._initial_probe_task = asyncio.create_task(self._initial_probe())
        self._poll_task = asyncio.create_task(self._poll_loop())
        self._log_task = asyncio.create_task(self._log_loop())

    async def stop(self) -> None:
        self._stop_event.set()
        if self._poll_task:
            await self._poll_task
        if self._log_task:
            await self._log_task
        if self._initial_probe_task:
            self._initial_probe_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._initial_probe_task
            self._initial_probe_task = None
        for link in set(self._transports.values()):
            await asyncio.to_thread(link.close)
        self._poll_task = None
        self._log_task = None

    async def run_command(
        self,
        command: str,
        *,
        raise_on_error: bool = True,
    ) -> CommandResult:
        order = self._preferred_transport_order()
        if not order:
            raise SerialNotFoundError("No control transports configured")

        last_error: Optional[SerialNotFoundError] = None

        for transport_id in order:
            if self._should_skip_transport(transport_id):
                continue
            link = self._transports.get(transport_id)
            if not link:
                continue
            try:
                result = await asyncio.to_thread(
                    link.run_command,
                    command,
                    raise_on_error=raise_on_error,
                )
            except SerialNotFoundError as exc:
                self._record_transport_failure(transport_id, str(exc))
                last_error = exc
                if self._control_mode != TRANSPORT_AUTO:
                    raise
                continue
            except Exception as exc:  # pragma: no cover - safeguard
                logger.exception("Failed to run command '%s' via %s", command, transport_id)
                last_error = SerialNotFoundError(str(exc))
                if self._control_mode != TRANSPORT_AUTO:
                    raise last_error
                continue

            self._record_transport_success(transport_id)
            with self._link_lock:
                if transport_id != self._active_transport:
                    logger.info("Switching control transport to %s", transport_id)
                self._set_active_transport(transport_id)
            return result

        if last_error is not None:
            raise last_error
        raise SerialNotFoundError("All control transports are unavailable")

    async def get_camera_snapshot(self) -> Tuple[bytes, str]:
        url, source = self._resolve_camera_snapshot(require_stream=True)
        if not url:
            raise CameraNotConfiguredError(
                "Camera snapshot URL is not configured (set OPERATOR_CAMERA_SNAPSHOT_URL)."
            )
        logger.debug("Fetching camera snapshot via %s source: %s", source, url)
        return await asyncio.to_thread(self._fetch_camera_snapshot, url)

    def _fetch_camera_snapshot(self, url: str) -> Tuple[bytes, str]:
        request = urllib.request.Request(
            url,
            headers={
                "Accept": "image/jpeg,image/png;q=0.9,*/*;q=0.8",
                "Cache-Control": "no-cache",
            },
        )

        try:
            with urllib.request.urlopen(request, timeout=self._camera_timeout) as response:
                payload = response.read()
                if not payload:
                    raise CameraSnapshotError("Camera snapshot response was empty")

                content_type = response.headers.get("Content-Type", self._default_camera_content_type)
                media_type = content_type.split(";", 1)[0].strip() or self._default_camera_content_type
                return payload, media_type
        except urllib.error.HTTPError as exc:  # pragma: no cover - network dependent
            raise CameraSnapshotError(f"HTTP {exc.code}: {exc.reason}") from exc
        except urllib.error.URLError as exc:  # pragma: no cover - network dependent
            raise CameraSnapshotError(str(exc.reason or exc)) from exc

    def describe(self) -> dict[str, Any]:
        transport = self._determine_camera_transport()
        serial_link = self._transports.get(TRANSPORT_SERIAL)
        serial_port = None
        if isinstance(serial_link, ESP32Link):
            serial_port = serial_link.active_port or serial_link.requested_port
        if serial_port is None:
            serial_port = self._transport_endpoints.get(TRANSPORT_SERIAL)

        control_state = self._control_state_snapshot()
        active_endpoint = None
        if self._active_transport == TRANSPORT_SERIAL and isinstance(serial_link, ESP32Link):
            active_endpoint = serial_link.active_port or serial_link.requested_port
        if active_endpoint is None and self._active_transport:
            active_endpoint = self._transport_endpoints.get(self._active_transport)

        status_fresh = self._status_is_recent()
        snapshot_url, source = self._resolve_camera_snapshot()
        streaming_flag = (
            bool((self._last_status or {}).get("cam_streaming")) if status_fresh else False
        )
        return {
            "serial_port": serial_port,
            "control_mode": control_state["mode"],
            "control_transport": control_state["active"],
            "control_endpoint": active_endpoint,
            "available_transports": control_state["transports"],
            "camera_snapshot_url": snapshot_url,
            "camera_snapshot_source": source,
            "camera_transport": transport,
            "camera_streaming": streaming_flag,
            "status_fresh": status_fresh,
        }

    def camera_configured(self) -> bool:
        snapshot_url, _ = self._resolve_camera_snapshot()
        return snapshot_url is not None

    async def camera_get_config(self) -> dict[str, Any]:
        try:
            result = await self.run_command("camcfg ?", raise_on_error=False)
        except SerialNotFoundError:
            raise
        data = result.data or {}
        error = data.get("camcfg_error")
        if error:
            raise RuntimeError(f"camcfg_error={error}")

        resolution = str(data.get("cam_resolution") or "").upper()
        quality = data.get("cam_quality")
        max_resolution = str(data.get("cam_max") or "").upper()
        if not resolution:
            resolution = "UNKNOWN"
        try:
            quality_int = int(quality)
        except (TypeError, ValueError):
            quality_int = self._camera_quality_range[0]

        available_options = list(self._camera_resolution_options)
        if max_resolution:
            ordered_ids = [option["id"] for option in available_options]
            try:
                cutoff = ordered_ids.index(max_resolution)
            except ValueError:
                cutoff = None
            if cutoff is not None:
                available_options = available_options[: cutoff + 1]

        running = bool((self._last_status or {}).get("cam_streaming")) if self._status_is_recent() else False
        return {
            "resolution": resolution,
            "quality": quality_int,
            "running": running,
            "max_resolution": max_resolution or None,
            "available_resolutions": available_options,
            "quality_min": self._camera_quality_range[0],
            "quality_max": self._camera_quality_range[1],
        }

    async def camera_set_config(
        self, *, resolution: Optional[str] = None, quality: Optional[int] = None
    ) -> dict[str, Any]:
        parts: List[str] = []
        if quality is not None:
            q_min, q_max = self._camera_quality_range
            clamped = max(q_min, min(q_max, int(quality)))
            parts.append(f"QUALITY={clamped}")
        if resolution:
            parts.append(f"RES={resolution.upper()}")

        if not parts:
            return await self.camera_get_config()

        stream_restart_required = False
        if not self._camera_snapshot_override and self._status_is_recent():
            stream_restart_required = bool((self._last_status or {}).get("cam_streaming"))

        restart_succeeded = False

        if stream_restart_required:
            try:
                await self.run_command("camstream off", raise_on_error=False)
            except SerialNotFoundError:
                logger.warning("CAMSTREAM OFF failed before CAMCFG; skipping restart")
                stream_restart_required = False
            except Exception:
                logger.exception("Failed to stop camera stream before applying CAMCFG")
                stream_restart_required = False

        command = f"CAMCFG {' '.join(parts)}"
        result = await self.run_command(command, raise_on_error=False)
        data = result.data or {}
        error = data.get("camcfg_error")
        if error:
            raise RuntimeError(str(error))

        config = await self.camera_get_config()

        if stream_restart_required:
            try:
                restart_result = await self.run_command("camstream on", raise_on_error=False)
                response = (restart_result.data or {}).get("camstream")
                if isinstance(response, str):
                    restart_succeeded = response.strip().upper() == "ON"
                elif isinstance(response, bool):
                    restart_succeeded = response
                else:
                    restart_succeeded = True
            except SerialNotFoundError:
                logger.warning("CAMSTREAM ON failed after CAMCFG; camera remains offline")
            except Exception:
                logger.exception("Failed to restart camera stream after applying CAMCFG")

        if stream_restart_required:
            config = dict(config)
            config["running"] = restart_succeeded

        return config

    def _shelf_palette_copy(self) -> List[dict[str, str]]:
        return [dict(entry) for entry in self._shelf_palette]

    def _shelf_clone_grid(self, grid: Sequence[Sequence[str]]) -> List[List[str]]:
        return [list(row) for row in grid]

    def _normalize_shelf_code(self, value: object) -> str:
        if value is None:
            return "-"
        code = str(value).strip().upper()
        if code in {"", "-", "NONE", "N", "EMPTY"}:
            code = "-"
        if code not in self._shelf_allowed_codes:
            raise ValueError(f"Unsupported shelf color code: {value}")
        return code

    def _normalize_shelf_grid(self, grid: Sequence[Sequence[str]]) -> List[List[str]]:
        if len(grid) != 3:
            raise ValueError("Shelf map must have exactly 3 rows")
        normalized: List[List[str]] = []
        for row in grid:
            if len(row) != 3:
                raise ValueError("Shelf map rows must have exactly 3 columns")
            normalized.append([self._normalize_shelf_code(cell) for cell in row])
        return normalized

    def _serialize_shelf_grid(self, grid: Sequence[Sequence[str]]) -> str:
        rows: List[str] = []
        for row in grid:
            rows.append(",".join(cell for cell in row))
        return "; ".join(rows)

    def _extract_shelf_payload_line(self, lines: Sequence[str]) -> str:
        for line in reversed(list(lines)):
            stripped = line.strip()
            if not stripped:
                continue
            upper = stripped.upper()
            if upper.startswith("SMAP="):
                raise RuntimeError(stripped)
            if "=" in stripped:
                continue
            if ";" not in stripped and "," not in stripped:
                continue
            try:
                self._parse_shelf_payload(stripped)
            except ValueError:
                continue
            return stripped
        raise RuntimeError("SMAP command returned no data")

    def _parse_shelf_payload(self, payload: str) -> List[List[str]]:
        rows_raw = [segment.strip() for segment in payload.split(";")]
        rows: List[List[str]] = []
        for raw in rows_raw:
            if not raw:
                continue
            cells = [self._normalize_shelf_code(token) for token in raw.split(",")]
            while len(cells) < 3:
                cells.append("-")
            rows.append(cells[:3])
            if len(rows) == 3:
                break
        while len(rows) < 3:
            rows.append(["-", "-", "-"])
        return rows[:3]

    def _shelf_command_succeeded(self, lines: Sequence[str], expected: str) -> bool:
        expected_upper = expected.upper()
        for line in lines or []:
            if line.strip().upper() == expected_upper:
                return True
        return False

    async def shelf_get_map(self, *, force_refresh: bool = False) -> dict[str, Any]:
        now = time.time()
        if (
            not force_refresh
            and self._shelf_cache
            and self._shelf_cache_timestamp is not None
            and (now - self._shelf_cache_timestamp) <= self._shelf_cache_ttl
        ):
            cached_grid = self._shelf_clone_grid(self._shelf_cache["grid"])
            return {
                "grid": cached_grid,
                "palette": self._shelf_palette_copy(),
                "raw": self._shelf_cache["raw"],
                "timestamp": self._shelf_cache_timestamp,
                "source": "cache",
                "persisted": self._shelf_cache.get("persisted"),
            }

        result = await self.run_command("SMAP GET", raise_on_error=False)
        payload = self._extract_shelf_payload_line(result.raw or [])
        grid = self._parse_shelf_payload(payload)
        timestamp = time.time()
        self._shelf_cache = {
            "grid": self._shelf_clone_grid(grid),
            "raw": payload,
            "persisted": None,
        }
        self._shelf_cache_timestamp = timestamp
        return {
            "grid": grid,
            "palette": self._shelf_palette_copy(),
            "raw": payload,
            "timestamp": timestamp,
            "source": "live",
            "persisted": None,
        }

    async def shelf_set_map(
        self,
        grid: Sequence[Sequence[str]],
        *,
        persist: bool = False,
    ) -> dict[str, Any]:
        normalized = self._normalize_shelf_grid(grid)
        payload = self._serialize_shelf_grid(normalized)
        result = await self.run_command(f"SMAP SET {payload}", raise_on_error=False)
        if not self._shelf_command_succeeded(result.raw or [], "OK"):
            raise RuntimeError("SMAP SET failed")

        persisted = False
        if persist:
            save_result = await self.run_command("SMAP SAVE", raise_on_error=False)
            if not self._shelf_command_succeeded(save_result.raw or [], "SAVED"):
                raise RuntimeError("SMAP SAVE failed")
            persisted = True

        response = await self.shelf_get_map(force_refresh=True)
        response["persisted"] = persisted
        if self._shelf_cache:
            self._shelf_cache["persisted"] = persisted if persisted else None
        return response

    async def shelf_reset_map(self, *, persist: bool = False) -> dict[str, Any]:
        result = await self.run_command("SMAP CLEAR", raise_on_error=False)
        if not self._shelf_command_succeeded(result.raw or [], "RESET"):
            raise RuntimeError("SMAP CLEAR failed")

        persisted = False
        if persist:
            save_result = await self.run_command("SMAP SAVE", raise_on_error=False)
            if not self._shelf_command_succeeded(save_result.raw or [], "SAVED"):
                raise RuntimeError("SMAP SAVE failed")
            persisted = True

        response = await self.shelf_get_map(force_refresh=True)
        response["persisted"] = persisted
        if self._shelf_cache:
            self._shelf_cache["persisted"] = persisted if persisted else None
        return response

    def _resolve_camera_snapshot(
        self,
        status: Optional[dict[str, Any]] = None,
        *,
        require_stream: bool = False,
    ) -> Tuple[Optional[str], str]:
        if self._camera_snapshot_override:
            return self._camera_snapshot_override, "override"

        effective = status if status is not None else self._effective_status_snapshot()
        data = effective or {}
        ip = data.get("wifi_ip") or data.get("wifi_ip_addr")
        streaming = data.get("cam_streaming")
        streaming_flag = bool(streaming) if isinstance(streaming, bool) else str(streaming).lower() == "true"

        if require_stream and not streaming_flag:
            raise CameraSnapshotError("Camera stream disabled")

        if not ip or not streaming_flag:
            return None, "auto"

        return f"http://{ip}/camera/snapshot", "auto"

    def _resolve_camera_stream_interval(self) -> float:
        env_value = os.getenv("OPERATOR_CAMERA_STREAM_INTERVAL_MS")
        default_seconds = 0.4
        if not env_value:
            return default_seconds
        try:
            milliseconds = float(env_value)
            return max(0.1, milliseconds / 1000.0)
        except ValueError:
            logger.warning("Invalid OPERATOR_CAMERA_STREAM_INTERVAL_MS='%s'", env_value)
            return default_seconds

    def _status_is_recent(self, now: Optional[float] = None) -> bool:
        if self._last_status_timestamp is None:
            return False
        now = now or time.time()
        freshness_horizon = max(self._poll_interval * 2.5, 5.0)
        return (now - self._last_status_timestamp) <= freshness_horizon

    def _effective_status_snapshot(self) -> Optional[dict[str, Any]]:
        if not self._status_is_recent():
            return None
        if not self._last_status:
            return None
        return dict(self._last_status)

    def _normalize_transport(self, value: Optional[str]) -> Optional[str]:
        if not value:
            return None

        normalized = value.strip().lower()
        aliases = {
            "wifi": "wifi",
            "wi-fi": "wifi",
            "wireless": "wifi",
            "typec": "type-c",
            "type-c": "type-c",
            "usbc": "type-c",
            "usb": "type-c",
        }

        mapped = aliases.get(normalized, normalized)
        if mapped in {"wifi", "type-c"}:
            return mapped

        logger.warning("Unknown camera transport '%s'; falling back to auto-detection", value)
        return None

    def _determine_camera_transport(self) -> str:
        if self._camera_transport:
            return self._camera_transport

        snapshot_url, _ = self._resolve_camera_snapshot()
        if not snapshot_url:
            return "unconfigured"

        try:
            parsed = urlparse(snapshot_url)
        except ValueError:  # pragma: no cover - defensive
            return "unknown"

        scheme = (parsed.scheme or "").lower()
        host = (parsed.hostname or "").lower()

        if scheme in {"http", "https", "rtsp", "rtsps"}:
            if host in {"localhost", "127.0.0.1", "::1"}:
                return "type-c"
            return "wifi"

        return "unknown"

    async def diagnostics(self) -> dict[str, Any]:
        info = self.describe()
        serial_link = self._transports.get(TRANSPORT_SERIAL)
        requested_port = None
        active_port = None
        if isinstance(serial_link, ESP32Link):
            requested_port = serial_link.requested_port
            active_port = serial_link.active_port
        if requested_port is None:
            requested_port = self._transport_endpoints.get(TRANSPORT_SERIAL)

        diag: dict[str, Any] = {
            "timestamp": time.time(),
            "serial": {
                "requested_port": requested_port,
                "active_port": active_port,
                "connected": False,
            },
            "camera": {
                "configured": False,
                "snapshot_url": None,
                "transport": info.get("camera_transport"),
                "stream_interval_ms": int(self._camera_stream_interval * 1000),
                "streaming": False,
                "source": info.get("camera_snapshot_source"),
            },
            "wifi": {
                "connected": None,
                "ip": None,
            },
            "uno": {
                "connected": False,
                "error": None,
                "state_id": None,
                "err_flags": None,
                "seq_ack": None,
            },
            "status": {},
        }

        try:
            status_result = await self.run_command("status", raise_on_error=False)
        except SerialNotFoundError as exc:
            self._last_status_error = str(exc)
            diag["serial"]["connected"] = False
            diag["serial"]["error"] = str(exc)
            diag["meta"] = {
                "status_fresh": False,
                "status_error": str(exc),
                "status_age_s": None,
            }
            if (
                self._control_mode == TRANSPORT_AUTO
                and not self._initial_probe_task
                and not self._stop_event.is_set()
            ):
                self._initial_probe_task = asyncio.create_task(self._initial_probe())
            return diag

        now = time.time()
        data = status_result.data or {}
        lines = status_result.raw or []
        status_fresh = False

        if lines and data:
            merged = dict(self._last_status)
            merged.update(data)
            self._last_status = merged
            self._last_status_timestamp = now
            self._last_status_error = None
            status_fresh = True
        else:
            status_fresh = self._status_is_recent(now)
            if not status_fresh and not lines:
                self._last_status_error = "no_data"

        snapshot = dict(self._last_status) if status_fresh else {}

        active_port = None
        if isinstance(serial_link, ESP32Link):
            active_port = serial_link.active_port
        if active_port is None:
            active_port = self._transport_endpoints.get(TRANSPORT_SERIAL)
        diag["serial"]["active_port"] = active_port
        diag["serial"]["connected"] = bool(active_port and status_fresh)
        diag["serial"]["stale"] = not status_fresh
        diag["serial"]["status_age_s"] = (
            None
            if self._last_status_timestamp is None
            else max(0.0, now - self._last_status_timestamp)
        )
        if self._last_status_error:
            diag["serial"]["status_error"] = self._last_status_error

        diag["status"] = snapshot if status_fresh else {}

        wifi_connected_flag = snapshot.get("wifi_connected") if status_fresh else None
        if wifi_connected_flag is not None:
            diag["wifi"]["connected"] = bool(wifi_connected_flag)
            wifi_ip = snapshot.get("wifi_ip") or snapshot.get("wifi_ip_addr")
            if wifi_ip is not None:
                diag["wifi"]["ip"] = wifi_ip
        else:
            diag["wifi"]["connected"] = False
            diag["wifi"]["ip"] = None

        status_error = snapshot.get("status_error") if status_fresh else None
        diag["uno"]["error"] = status_error
        diag["uno"]["connected"] = bool(status_fresh and status_error is None)
        diag["uno"]["state_id"] = snapshot.get("state_id") if status_fresh else None
        diag["uno"]["err_flags"] = snapshot.get("err_flags") if status_fresh else None
        diag["uno"]["seq_ack"] = snapshot.get("seq_ack") if status_fresh else None

        snapshot_url, source = self._resolve_camera_snapshot(status=snapshot if status_fresh else None)
        diag["camera"]["configured"] = snapshot_url is not None
        diag["camera"]["snapshot_url"] = snapshot_url
        diag["camera"]["streaming"] = bool(status_fresh and snapshot.get("cam_streaming"))
        diag["camera"]["source"] = source
        diag["camera"]["resolution"] = snapshot.get("cam_resolution") if status_fresh else None
        diag["camera"]["quality"] = snapshot.get("cam_quality") if status_fresh else None
        diag["camera"]["cam_max"] = snapshot.get("cam_max") if status_fresh else None
        try:
            camcfg = await self.camera_get_config()
            if isinstance(camcfg, dict):
                diag["camera"]["resolution"] = camcfg.get("resolution") or diag["camera"].get("resolution")
                diag["camera"]["quality"] = (
                    camcfg.get("quality") if camcfg.get("quality") is not None else diag["camera"].get("quality")
                )
                if camcfg.get("available_resolutions") is not None:
                    diag["camera"]["available_resolutions"] = camcfg.get("available_resolutions")
                if camcfg.get("max_resolution") is not None:
                    diag["camera"]["max_resolution"] = camcfg.get("max_resolution")
                if camcfg.get("running") is not None:
                    diag["camera"]["streaming"] = bool(camcfg.get("running"))
        except SerialNotFoundError:
            pass
        except Exception:
            logger.exception("Failed to fetch camera config for diagnostics")

        diag["meta"] = {
            "status_fresh": status_fresh,
            "status_age_s": (
                None
                if self._last_status_timestamp is None
                else max(0.0, now - self._last_status_timestamp)
            ),
        }
        if self._last_status_error:
            diag["meta"]["status_error"] = self._last_status_error

        return diag

    async def register_client(self) -> asyncio.Queue[dict[str, Any]]:
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=1)
        async with self._clients_lock:
            self._clients.add(queue)
        return queue

    async def unregister_client(self, queue: asyncio.Queue[dict[str, Any]]) -> None:
        async with self._clients_lock:
            self._clients.discard(queue)

    async def _broadcast(self, payload: dict[str, Any]) -> None:
        async with self._clients_lock:
            if not self._clients:
                return
            for queue in list(self._clients):
                if queue.full():
                    try:
                        queue.get_nowait()
                    except asyncio.QueueEmpty:  # pragma: no cover - race
                        pass
                await queue.put(payload)

    def get_recent_logs(self, limit: int = 200) -> List[dict[str, Any]]:
        limit = max(1, min(limit, 1000))
        serial_link = self._transports.get(TRANSPORT_SERIAL)
        if not isinstance(serial_link, ESP32Link):
            return []
        raw_entries = serial_link.recent_logs(limit * 4)
        structured = structure_logs(raw_entries)
        if len(structured) > limit:
            structured = structured[-limit:]
        return self._attach_log_ids(structured)

    def _attach_log_ids(self, entries: List[dict[str, Any]]) -> List[dict[str, Any]]:
        results: List[dict[str, Any]] = []
        for entry in entries:
            item = dict(entry)
            timestamp = item.get("timestamp")
            if not isinstance(timestamp, (int, float)):
                timestamp = time.time()
                item["timestamp"] = timestamp
            identifier = f"{int(timestamp * 1000)}-{self._log_sequence}"
            self._log_sequence = (self._log_sequence + 1) % 1_000_000_000
            item["id"] = identifier
            results.append(item)
        return results

    async def register_log_client(self) -> asyncio.Queue[dict[str, Any]]:
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=200)
        async with self._log_clients_lock:
            self._log_clients.add(queue)
        return queue

    async def unregister_log_client(self, queue: asyncio.Queue[dict[str, Any]]) -> None:
        async with self._log_clients_lock:
            self._log_clients.discard(queue)

    async def _broadcast_logs(self, entries: List[dict[str, Any]]) -> None:
        if not entries:
            return
        message = {"type": "log", "entries": entries}
        async with self._log_clients_lock:
            if not self._log_clients:
                return
            for queue in list(self._log_clients):
                while True:
                    try:
                        queue.put_nowait(message)
                        break
                    except asyncio.QueueFull:
                        try:
                            queue.get_nowait()
                        except asyncio.QueueEmpty:
                            break

    async def _log_loop(self) -> None:
        while not self._stop_event.is_set():
            entries: List[tuple[float, str]] = []
            with self._link_lock:
                wifi_link = self._transports.get(TRANSPORT_WIFI)
                serial_link = self._transports.get(TRANSPORT_SERIAL)

            if isinstance(wifi_link, ESP32WSLink):
                try:
                    entries = await asyncio.to_thread(wifi_link.collect_pending_logs)
                except SerialNotFoundError as exc:
                    logger.debug("Wi-Fi log collection unavailable: %s", exc)
                    entries = []

            if not entries and isinstance(serial_link, ESP32Link):
                try:
                    entries = await asyncio.to_thread(serial_link.collect_pending_logs)
                except SerialNotFoundError as exc:
                    logger.debug("Serial log collection unavailable: %s", exc)
                    entries = []

            if entries:
                structured = structure_logs(entries)
                if structured:
                    structured = self._attach_log_ids(structured)
                    await self._broadcast_logs(structured)
            try:
                await asyncio.wait_for(self._stop_event.wait(), timeout=0.25)
            except asyncio.TimeoutError:
                continue

    async def _poll_loop(self) -> None:
        while not self._stop_event.is_set():
            try:
                result = await self.run_command(
                    self._poll_command, raise_on_error=False
                )
                if result.raw and result.data:
                    merged = dict(self._last_status)
                    merged.update(result.data)
                    if merged:
                        self._ensure_wifi_transport(merged)
                    if "cam_streaming" in merged or "wifi_connected" in merged:
                        self._last_status = merged
                    self._last_status_timestamp = time.time()
                    self._last_status_error = None
                elif not result.raw:
                    self._last_status_error = "no_data"
                payload = {
                    "command": self._poll_command,
                    "raw": result.raw,
                    "data": result.data,
                }
            except SerialNotFoundError as exc:
                self._last_status_error = str(exc)
                payload = {
                    "command": self._poll_command,
                    "error": str(exc),
                }
                if (
                    self._control_mode == TRANSPORT_AUTO
                    and not self._initial_probe_task
                    and not self._stop_event.is_set()
                ):
                    self._initial_probe_task = asyncio.create_task(self._initial_probe())
            except Exception as exc:  # pragma: no cover - unexpected
                self._last_status_error = str(exc)
                payload = {
                    "command": self._poll_command,
                    "error": f"unexpected error: {exc}",
                }

            await self._broadcast(payload)

            try:
                await asyncio.wait_for(self._stop_event.wait(), timeout=self._poll_interval)
            except asyncio.TimeoutError:
                continue

    async def stream_camera_frames(self, websocket: WebSocket) -> None:
        reconnect_delay = max(self._camera_stream_interval, 0.5)
        while True:
            try:
                frame, media_type = await self.get_camera_snapshot()
            except CameraNotConfiguredError as exc:
                payload = {
                    "type": "error",
                    "message": str(exc),
                }
                await websocket.send_text(json.dumps(payload))
                await asyncio.sleep(reconnect_delay)
                continue
            except CameraSnapshotError as exc:
                payload = {
                    "type": "error",
                    "message": str(exc),
                }
                await websocket.send_text(json.dumps(payload))
                await asyncio.sleep(reconnect_delay)
                continue

            encoded = base64.b64encode(frame).decode("ascii")
            payload = {
                "type": "frame",
                "mime": media_type,
                "payload": encoded,
                "timestamp": time.time(),
            }
            await websocket.send_text(json.dumps(payload))
            await asyncio.sleep(self._camera_stream_interval)


__all__ = [
    "CameraNotConfiguredError",
    "CameraSnapshotError",
    "OperatorService",
]
