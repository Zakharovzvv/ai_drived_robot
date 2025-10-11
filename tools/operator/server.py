"""FastAPI-based operator service bridging the ESP32 CLI to HTTP/WebSocket."""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Dict, Optional, Set

from fastapi import (  # type: ignore
    Depends,
    FastAPI,
    HTTPException,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.middleware.cors import CORSMiddleware  # type: ignore
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


class OperatorService:
    """Async facade over the ESP32 link with background telemetry polling."""

    def __init__(
        self,
        port: Optional[str] = None,
        baudrate: int = 115200,
        timeout: float = 1.0,
        poll_command: str = "status",
        poll_interval: float = 1.0,
    ) -> None:
        self._link = ESP32Link(port=port, baudrate=baudrate, timeout=timeout)
        self._poll_command = poll_command
        self._poll_interval = poll_interval
        self._poll_task: Optional[asyncio.Task[None]] = None
        self._stop_event = asyncio.Event()
        self._clients: Set[asyncio.Queue[dict[str, Any]]] = set()
        self._clients_lock = asyncio.Lock()

    async def start(self) -> None:
        if self._poll_task and not self._poll_task.done():
            return
        self._stop_event.clear()
        self._poll_task = asyncio.create_task(self._poll_loop())

    async def stop(self) -> None:
        self._stop_event.set()
        if self._poll_task:
            await self._poll_task
        await asyncio.to_thread(self._link.close)
        self._poll_task = None

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

    async def _poll_loop(self) -> None:
        while not self._stop_event.is_set():
            try:
                result = await self.run_command(
                    self._poll_command, raise_on_error=False
                )
                payload = {
                    "command": self._poll_command,
                    "raw": result.raw,
                    "data": result.data,
                }
            except SerialNotFoundError as exc:
                payload = {
                    "command": self._poll_command,
                    "error": str(exc),
                }
            except Exception as exc:  # pragma: no cover - unexpected
                payload = {
                    "command": self._poll_command,
                    "error": f"unexpected error: {exc}",
                }

            await self._broadcast(payload)

            try:
                await asyncio.wait_for(self._stop_event.wait(), timeout=self._poll_interval)
            except asyncio.TimeoutError:
                continue


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


def run() -> None:  # pragma: no cover - manual execution helper
    """Launch the FastAPI app using uvicorn."""

    import uvicorn  # type: ignore

    uvicorn.run("tools.operator.server:app", host="0.0.0.0", port=8000, reload=False)


if __name__ == "__main__":  # pragma: no cover - CLI execution helper
    run()