"""Integration tests for FastAPI routes using dependency overrides."""
from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any, AsyncGenerator

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from backend.operator import app
from backend.operator.esp32_link import CommandResult, SerialNotFoundError
from backend.operator.services import dependencies


class _StubService:
    def __init__(self) -> None:
        self._command_log: list[tuple[str, bool]] = []
        self._camera_config: dict[str, Any] = {
            "resolution": "QVGA",
            "quality": 20,
            "running": False,
            "available_resolutions": [
                {"id": "QVGA", "label": "QVGA", "width": 320, "height": 240}
            ],
            "quality_min": 10,
            "quality_max": 63,
        }

    async def run_command(self, command: str, *, raise_on_error: bool = True) -> CommandResult:
        self._command_log.append((command, raise_on_error))
        if command == "status":
            data = {"cam_streaming": False}
        else:
            data = {}
        return CommandResult(raw=["OK"], data=data)

    async def camera_get_config(self) -> dict[str, Any]:
        return dict(self._camera_config)

    async def camera_set_config(self, *, resolution: str | None = None, quality: int | None = None) -> dict[str, Any]:
        if resolution:
            self._camera_config["resolution"] = resolution.upper()
        if quality is not None:
            self._camera_config["quality"] = quality
        return await self.camera_get_config()

    async def describe(self) -> dict[str, Any]:
        return {
            "serial_port": "stub",
            "camera_snapshot_url": None,
            "camera_snapshot_source": "override",
            "camera_transport": "wifi",
            "camera_streaming": False,
            "status_fresh": True,
        }

    async def diagnostics(self) -> dict[str, Any]:
        camera_snapshot = dict(self._camera_config)
        camera_snapshot.setdefault("configured", True)
        camera_snapshot.setdefault("transport", "wifi")
        return {"meta": {"status_fresh": True}, "camera": camera_snapshot}

    async def shelf_get_map(self) -> dict[str, Any]:
        return {
            "grid": [["R", "G", "B"], ["-", "-", "-"], ["-", "-", "-"]],
            "palette": [],
            "raw": "R,G,B; -,-,-; -,-,-",
            "timestamp": 0.0,
            "source": "stub",
            "persisted": None,
        }

    async def get_recent_logs(self, limit: int = 200) -> list[dict[str, Any]]:  # type: ignore[override]
        return [{"id": "1", "timestamp": 0.0, "parameter": "stub", "value": "ok"}]

    async def register_client(self) -> asyncio.Queue[dict[str, Any]]:  # pragma: no cover - WS only
        return asyncio.Queue()


class _ErrorService(_StubService):
    async def run_command(self, command: str, *, raise_on_error: bool = True) -> CommandResult:
        raise SerialNotFoundError("serial unavailable")


@pytest_asyncio.fixture(name="client")
async def client_fixture() -> AsyncGenerator[AsyncClient, None]:
    service = _StubService()

    async def _override() -> _StubService:
        return service

    app.dependency_overrides[dependencies.get_service] = _override
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        yield client
    app.dependency_overrides.pop(dependencies.get_service, None)


@pytest.mark.asyncio
async def test_status_endpoint_returns_command_payload(client: AsyncClient) -> None:
    response = await client.get("/api/status")
    assert response.status_code == 200
    body = response.json()
    assert body["command"] == "status"
    assert body["raw"] == ["OK"]


@pytest.mark.asyncio
async def test_camera_config_update_requires_payload(client: AsyncClient) -> None:
    response = await client.post("/api/camera/config", json={})
    assert response.status_code == 400
    assert "No parameters" in response.json()["detail"]


@pytest.mark.asyncio
async def test_camera_config_update_applies_changes(client: AsyncClient) -> None:
    response = await client.post("/api/camera/config", json={"quality": 25})
    assert response.status_code == 200
    assert response.json()["quality"] == 25


@pytest.mark.asyncio
async def test_command_endpoint_handles_serial_errors() -> None:
    async def _override() -> _ErrorService:
        return _ErrorService()

    app.dependency_overrides[dependencies.get_service] = _override
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await client.post("/api/command", json={"command": "STATUS"})
    app.dependency_overrides.pop(dependencies.get_service, None)

    assert response.status_code == 503
    assert "serial" in response.json()["detail"]
