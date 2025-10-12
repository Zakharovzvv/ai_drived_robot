"""FastAPI-based operator service bridging the ESP32 CLI to HTTP/WebSocket."""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import time
import urllib.error
import urllib.request
from urllib.parse import urlparse
from typing import Any, Dict, List, Optional, Set, Tuple

from fastapi import (  # type: ignore
    Depends,
    FastAPI,
    HTTPException,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.middleware.cors import CORSMiddleware  # type: ignore
from fastapi.responses import Response  # type: ignore
from pydantic import BaseModel  # type: ignore

from .esp32_link import CommandResult, ESP32Link, SerialNotFoundError

logger = logging.getLogger("operator.server")


class CommandRequest(BaseModel):
    command: str
    raise_on_error: bool = False


class CommandResponse(BaseModel):
    command: str
    raw: list[str]
    data: Dict[str, Any]


class CameraConfigResponse(BaseModel):
    resolution: str
    quality: int
    running: bool
    available_resolutions: List[dict[str, Any]]
    quality_min: int
    quality_max: int


class CameraConfigUpdate(BaseModel):
    resolution: Optional[str] = None
    quality: Optional[int] = None


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
    ) -> None:
        self._link = ESP32Link(port=port, baudrate=baudrate, timeout=timeout)
        self._poll_command = poll_command
        self._poll_interval = poll_interval
        self._poll_task: Optional[asyncio.Task[None]] = None
        self._stop_event = asyncio.Event()
        self._clients: Set[asyncio.Queue[dict[str, Any]]] = set()
        self._clients_lock = asyncio.Lock()
        self._log_clients: Set[asyncio.Queue[dict[str, Any]]] = set()
        self._log_clients_lock = asyncio.Lock()
        self._log_task: Optional[asyncio.Task[None]] = None
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

    async def start(self) -> None:
        if self._poll_task and not self._poll_task.done():
            return
        self._stop_event.clear()
        self._poll_task = asyncio.create_task(self._poll_loop())
        self._log_task = asyncio.create_task(self._log_loop())

    async def stop(self) -> None:
        self._stop_event.set()
        if self._poll_task:
            await self._poll_task
        if self._log_task:
            await self._log_task
        await asyncio.to_thread(self._link.close)
        self._poll_task = None
        self._log_task = None

    async def run_command(
        self,
        command: str,
        *,
        raise_on_error: bool = True,
    ) -> CommandResult:
        try:
            return await asyncio.to_thread(
                self._link.run_command,
                command,
                raise_on_error=raise_on_error,
            )
        except SerialNotFoundError as exc:
            raise
        except Exception as exc:  # pragma: no cover - safeguard
            logger.exception("Failed to run command '%s'", command)
            raise exc

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
                # FastAPI only needs the media-type component.
                media_type = content_type.split(";", 1)[0].strip() or self._default_camera_content_type
                return payload, media_type
        except urllib.error.HTTPError as exc:  # pragma: no cover - network dependent
            raise CameraSnapshotError(f"HTTP {exc.code}: {exc.reason}") from exc
        except urllib.error.URLError as exc:  # pragma: no cover - network dependent
            raise CameraSnapshotError(str(exc.reason or exc)) from exc

    def describe(self) -> dict[str, Any]:
        """Return runtime metadata for diagnostics and UI."""

        transport = self._determine_camera_transport()
        port = self._link.active_port or self._link.requested_port
        status_fresh = self._status_is_recent()
        snapshot_url, source = self._resolve_camera_snapshot()
        streaming_flag = (
            bool((self._last_status or {}).get("cam_streaming")) if status_fresh else False
        )
        return {
            "serial_port": port,
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
        parts: list[str] = []
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

    def _resolve_camera_snapshot(
        self,
        status: Optional[dict[str, Any]] = None,
        *,
        require_stream: bool = False,
    ) -> Tuple[Optional[str], str]:
        if self._camera_snapshot_override:
            return self._camera_snapshot_override, "override"

        effective = status
        if status is None:
            effective = self._effective_status_snapshot()
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
        diag: dict[str, Any] = {
            "timestamp": time.time(),
            "serial": {
                "requested_port": self._link.requested_port,
                "active_port": self._link.active_port,
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
                # No reply from STATUS means the controller is likely offline.
                self._last_status_error = "no_data"

        snapshot = dict(self._last_status) if status_fresh else {}

        diag["serial"]["active_port"] = self._link.active_port
        diag["serial"]["connected"] = bool(self._link.active_port and status_fresh)
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
        # Expose current camera settings reported by STATUS (if fresh)
        diag["camera"]["resolution"] = snapshot.get("cam_resolution") if status_fresh else None
        diag["camera"]["quality"] = snapshot.get("cam_quality") if status_fresh else None
        diag["camera"]["cam_max"] = snapshot.get("cam_max") if status_fresh else None
        # Try to enrich diagnostics with the camera config fetched via CAMCFG
        try:
            camcfg = await self.camera_get_config()
            if isinstance(camcfg, dict):
                # camera_get_config returns resolution/quality/available_resolutions etc.
                diag["camera"]["resolution"] = camcfg.get("resolution") or diag["camera"].get("resolution")
                diag["camera"]["quality"] = camcfg.get("quality") if camcfg.get("quality") is not None else diag["camera"].get("quality")
                # expose available_resolutions and max_resolution for UI
                if camcfg.get("available_resolutions") is not None:
                    diag["camera"]["available_resolutions"] = camcfg.get("available_resolutions")
                if camcfg.get("max_resolution") is not None:
                    diag["camera"]["max_resolution"] = camcfg.get("max_resolution")
                # running state from camcfg is authoritative for configuration
                if camcfg.get("running") is not None:
                    diag["camera"]["streaming"] = bool(camcfg.get("running"))
        except SerialNotFoundError:
            # If serial is not available, leave camera fields as-is
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
        entries = self._link.recent_logs(limit)
        return [
            {
                "timestamp": timestamp,
                "line": line,
            }
            for timestamp, line in entries
        ]

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
        async with self._log_clients_lock:
            if not self._log_clients:
                return
            for queue in list(self._log_clients):
                for entry in entries:
                    while True:
                        try:
                            queue.put_nowait(entry)
                            break
                        except asyncio.QueueFull:
                            try:
                                queue.get_nowait()
                            except asyncio.QueueEmpty:
                                break

    async def _log_loop(self) -> None:
        while not self._stop_event.is_set():
            try:
                entries = await asyncio.to_thread(self._link.collect_pending_logs)
            except SerialNotFoundError as exc:
                logger.warning("Log streaming paused: %s", exc)
                entries = []
            if entries:
                payload = [
                    {
                        "type": "log",
                        "timestamp": ts,
                        "line": line,
                    }
                    for ts, line in entries
                ]
                await self._broadcast_logs(payload)
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


service = OperatorService()
app = FastAPI(title="RBM Operator Service", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def _startup() -> None:
    await service.start()


@app.on_event("shutdown")
async def _shutdown() -> None:
    await service.stop()


async def get_service() -> OperatorService:
    return service


@app.get("/api/status", response_model=CommandResponse)
async def api_status(svc: OperatorService = Depends(get_service)) -> CommandResponse:
    try:
        result = await svc.run_command("status", raise_on_error=False)
    except SerialNotFoundError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    return CommandResponse(command="status", raw=result.raw, data=result.data)


@app.post("/api/command", response_model=CommandResponse)
async def api_command(
    request: CommandRequest,
    svc: OperatorService = Depends(get_service),
) -> CommandResponse:
    try:
        result = await svc.run_command(
            request.command, raise_on_error=request.raise_on_error
        )
    except SerialNotFoundError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    return CommandResponse(command=request.command, raw=result.raw, data=result.data)


@app.websocket("/ws/telemetry")
async def telemetry_ws(
    websocket: WebSocket,
    svc: OperatorService = Depends(get_service),
) -> None:
    await websocket.accept()
    queue = await svc.register_client()
    try:
        while True:
            payload = await queue.get()
            await websocket.send_text(json.dumps(payload))
    except WebSocketDisconnect:  # pragma: no cover - network event
        pass
    finally:
        await svc.unregister_client(queue)


@app.websocket("/ws/camera")
async def camera_ws(
    websocket: WebSocket,
    svc: OperatorService = Depends(get_service),
) -> None:
    await websocket.accept()
    try:
        await svc.stream_camera_frames(websocket)
    except WebSocketDisconnect:  # pragma: no cover - network event
        pass


@app.get("/api/camera/snapshot")
async def api_camera_snapshot(svc: OperatorService = Depends(get_service)) -> Response:
    try:
        payload, media_type = await svc.get_camera_snapshot()
    except CameraNotConfiguredError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except CameraSnapshotError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    return Response(content=payload, media_type=media_type)


@app.get("/api/camera/config", response_model=CameraConfigResponse)
async def api_camera_config(svc: OperatorService = Depends(get_service)) -> CameraConfigResponse:
    try:
        config = await svc.camera_get_config()
    except SerialNotFoundError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return CameraConfigResponse(**config)


@app.post("/api/camera/config", response_model=CameraConfigResponse)
async def api_camera_config_update(
    request: CameraConfigUpdate,
    svc: OperatorService = Depends(get_service),
) -> CameraConfigResponse:
    if request.resolution is None and request.quality is None:
        raise HTTPException(status_code=400, detail="No parameters provided")
    try:
        config = await svc.camera_set_config(
            resolution=request.resolution,
            quality=request.quality,
        )
    except SerialNotFoundError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return CameraConfigResponse(**config)


class ServiceInfo(BaseModel):
    serial_port: Optional[str]
    camera_snapshot_url: Optional[str]
    camera_snapshot_source: str
    camera_transport: str
    camera_streaming: bool
    status_fresh: bool


@app.get("/api/info", response_model=ServiceInfo)
async def api_info(svc: OperatorService = Depends(get_service)) -> ServiceInfo:
    return ServiceInfo(**svc.describe())


@app.get("/api/logs")
async def api_logs(
    limit: int = 200,
    svc: OperatorService = Depends(get_service),
) -> dict[str, Any]:
    limit = max(1, min(limit, 1000))
    return {"lines": svc.get_recent_logs(limit)}


@app.get("/api/diagnostics")
async def api_diagnostics(svc: OperatorService = Depends(get_service)) -> dict[str, Any]:
    return await svc.diagnostics()


@app.websocket("/ws/logs")
async def logs_ws(
    websocket: WebSocket,
    svc: OperatorService = Depends(get_service),
) -> None:
    await websocket.accept()
    try:
        snapshot = svc.get_recent_logs()
        await websocket.send_text(
            json.dumps(
                {
                    "type": "snapshot",
                    "lines": snapshot,
                }
            )
        )
        queue = await svc.register_log_client()
        try:
            while True:
                entry = await queue.get()
                await websocket.send_text(json.dumps(entry))
        except WebSocketDisconnect:  # pragma: no cover - network event
            pass
        finally:
            await svc.unregister_log_client(queue)
    except WebSocketDisconnect:  # pragma: no cover - network event
        pass


def run() -> None:  # pragma: no cover - manual execution helper
    """Launch the FastAPI app using uvicorn."""

    import uvicorn  # type: ignore

    uvicorn.run("tools.operator.server:app", host="0.0.0.0", port=8000, reload=False)


if __name__ == "__main__":  # pragma: no cover - CLI execution helper
    run()