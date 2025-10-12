"""FastAPI routing layer for the operator backend."""
from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import Response

from ..models.api import (
    CameraConfigResponse,
    CameraConfigUpdate,
    CommandRequest,
    CommandResponse,
    ServiceInfo,
    ShelfMapResetRequest,
    ShelfMapResponse,
    ShelfMapUpdateRequest,
)
from ..services.operator_service import (
    CameraNotConfiguredError,
    CameraSnapshotError,
    OperatorService,
)
from ..services.dependencies import get_service
from ..esp32_link import SerialNotFoundError

router = APIRouter()


@router.get("/api/status", response_model=CommandResponse)
async def api_status(svc: OperatorService = Depends(get_service)) -> CommandResponse:
    try:
        result = await svc.run_command("status", raise_on_error=False)
    except SerialNotFoundError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    return CommandResponse(command="status", raw=result.raw, data=result.data)


@router.post("/api/command", response_model=CommandResponse)
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


@router.websocket("/ws/telemetry")
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


@router.websocket("/ws/camera")
async def camera_ws(
    websocket: WebSocket,
    svc: OperatorService = Depends(get_service),
) -> None:
    await websocket.accept()
    try:
        await svc.stream_camera_frames(websocket)
    except WebSocketDisconnect:  # pragma: no cover - network event
        pass


@router.get("/api/camera/snapshot")
async def api_camera_snapshot(svc: OperatorService = Depends(get_service)) -> Response:
    try:
        payload, media_type = await svc.get_camera_snapshot()
    except CameraNotConfiguredError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except CameraSnapshotError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    return Response(content=payload, media_type=media_type)


@router.get("/api/camera/config", response_model=CameraConfigResponse)
async def api_camera_config(svc: OperatorService = Depends(get_service)) -> CameraConfigResponse:
    try:
        config = await svc.camera_get_config()
    except SerialNotFoundError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return CameraConfigResponse(**config)


@router.post("/api/camera/config", response_model=CameraConfigResponse)
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


@router.get("/api/shelf-map", response_model=ShelfMapResponse)
async def api_shelf_map(svc: OperatorService = Depends(get_service)) -> ShelfMapResponse:
    try:
        payload = await svc.shelf_get_map()
    except SerialNotFoundError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return ShelfMapResponse(**payload)


@router.put("/api/shelf-map", response_model=ShelfMapResponse)
async def api_shelf_map_update(
    request: ShelfMapUpdateRequest,
    svc: OperatorService = Depends(get_service),
) -> ShelfMapResponse:
    try:
        payload = await svc.shelf_set_map(request.grid, persist=request.persist)
    except SerialNotFoundError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return ShelfMapResponse(**payload)


@router.post("/api/shelf-map/reset", response_model=ShelfMapResponse)
async def api_shelf_map_reset(
    request: ShelfMapResetRequest,
    svc: OperatorService = Depends(get_service),
) -> ShelfMapResponse:
    try:
        payload = await svc.shelf_reset_map(persist=request.persist)
    except SerialNotFoundError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return ShelfMapResponse(**payload)


@router.get("/api/info", response_model=ServiceInfo)
async def api_info(svc: OperatorService = Depends(get_service)) -> ServiceInfo:
    return ServiceInfo(**svc.describe())


@router.get("/api/logs")
async def api_logs(
    limit: int = 200,
    svc: OperatorService = Depends(get_service),
) -> dict[str, Any]:
    limit = max(1, min(limit, 1000))
    return {"entries": svc.get_recent_logs(limit)}


@router.get("/api/diagnostics")
async def api_diagnostics(svc: OperatorService = Depends(get_service)) -> dict[str, Any]:
    return await svc.diagnostics()


@router.websocket("/ws/logs")
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
                    "entries": snapshot,
                }
            )
        )
        queue = await svc.register_log_client()
        try:
            while True:
                message = await queue.get()
                await websocket.send_text(json.dumps(message))
        except WebSocketDisconnect:  # pragma: no cover - network event
            pass
        finally:
            await svc.unregister_log_client(queue)
    except WebSocketDisconnect:  # pragma: no cover - network event
        pass


__all__ = ["router"]
