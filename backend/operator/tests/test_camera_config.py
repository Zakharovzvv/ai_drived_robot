import asyncio

import pytest
from httpx import ASGITransport, AsyncClient

from backend.operator.server import app, service


@pytest.mark.asyncio
async def test_camera_config_get_returns_defaults(monkeypatch):
    async def fake_camera_get_config():
        return {
            "resolution": "QVGA",
            "quality": 20,
            "running": False,
            "available_resolutions": [
                {"id": "QVGA", "label": "QVGA", "width": 320, "height": 240}
            ],
            "quality_min": 10,
            "quality_max": 63,
        }

    monkeypatch.setattr(service, "camera_get_config", fake_camera_get_config)

    transport = ASGITransport(app=app)

    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await client.get("/api/camera/config")

    assert response.status_code == 200
    payload = response.json()
    assert payload["resolution"] == "QVGA"
    assert payload["quality"] == 20
