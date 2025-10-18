import pytest
from httpx import ASGITransport, AsyncClient

from backend.operator.server import app, service
from backend.operator.services import operator_service
from backend.operator.esp32_link import CommandResult


class DummyLink:
    def __init__(self, *args, **kwargs) -> None:
        self.requested_port = kwargs.get("port")
        self.active_port = None

    def close(self) -> None:  # pragma: no cover - compatibility shim
        return


def install_dummy_links(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(operator_service, "ESP32Link", DummyLink, raising=False)
    monkeypatch.setattr(operator_service, "ESP32WSLink", DummyLink, raising=False)


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


@pytest.mark.asyncio
async def test_operator_service_camera_options_mark_supported(monkeypatch: pytest.MonkeyPatch) -> None:
    install_dummy_links(monkeypatch)

    svc = operator_service.OperatorService(port="socket://stub", control_transport="serial")

    async def fake_run_command(self, command: str, *, raise_on_error: bool = True):
        return CommandResult(
            raw=["cam_resolution=QQVGA cam_quality=12 cam_max=VGA"],
            data={"cam_resolution": "QQVGA", "cam_quality": 12, "cam_max": "VGA"},
        )

    monkeypatch.setattr(operator_service.OperatorService, "run_command", fake_run_command, raising=False)

    config = await svc.camera_get_config()

    ids = [item["id"] for item in config["available_resolutions"]]
    assert ids[0] == "QQVGA"
    assert ids[-1] == "UXGA"  # full list retained
    assert config["max_resolution"] == "VGA"

    cutoff = ids.index("VGA")
    for index, option in enumerate(config["available_resolutions"]):
        supported_flag = option.get("supported")
        if index <= cutoff:
            assert supported_flag is True
        else:
            assert supported_flag is False


@pytest.mark.asyncio
async def test_camera_set_config_error_includes_resolution_details(monkeypatch: pytest.MonkeyPatch) -> None:
    install_dummy_links(monkeypatch)

    svc = operator_service.OperatorService(port="socket://stub", control_transport="serial")

    async def fake_run_command(self, command: str, *, raise_on_error: bool = True):
        normalized = command.strip().upper()
        if normalized.startswith("CAMCFG "):
            return CommandResult(raw=["camcfg_error=RESOLUTION"], data={"camcfg_error": "RESOLUTION"})
        if normalized == "CAMCFG ?":
            return CommandResult(
                raw=["cam_resolution=QQVGA cam_quality=12 cam_max=QVGA"],
                data={"cam_resolution": "QQVGA", "cam_quality": 12, "cam_max": "QVGA"},
            )
        raise AssertionError(f"Unexpected command {command}")

    monkeypatch.setattr(operator_service.OperatorService, "run_command", fake_run_command, raising=False)

    with pytest.raises(RuntimeError) as excinfo:
        await svc.camera_set_config(resolution="SVGA")

    message = str(excinfo.value)
    assert "SVGA" in message
    assert "QVGA" in message


@pytest.mark.asyncio
async def test_diagnostics_marks_camera_configured_when_stream_disabled(monkeypatch: pytest.MonkeyPatch) -> None:
    install_dummy_links(monkeypatch)

    service_instance = operator_service.OperatorService(port="socket://stub", control_transport="serial")

    async def fake_run_command(self, command: str, *, raise_on_error: bool = True):
        normalized = command.strip().upper()
        if normalized == "STATUS":
            return CommandResult(
                raw=["status=ok"],
                data={
                    "cam_streaming": False,
                    "wifi_connected": True,
                    "wifi_ip": "192.168.0.72",
                    "cam_resolution": "QQVGA",
                    "cam_quality": 12,
                    "cam_max": "UXGA",
                },
            )
        if normalized == "CAMCFG ?":
            return CommandResult(
                raw=["cam_resolution=QQVGA cam_quality=12 cam_max=UXGA"],
                data={"cam_resolution": "QQVGA", "cam_quality": 12, "cam_max": "UXGA"},
            )
        raise AssertionError(f"Unexpected command {command}")

    monkeypatch.setattr(operator_service.OperatorService, "run_command", fake_run_command, raising=False)

    diagnostics = await service_instance.diagnostics()

    camera_snapshot = diagnostics.get("camera", {})
    assert camera_snapshot.get("configured") is True
    assert camera_snapshot.get("reachable") is True
    assert camera_snapshot.get("transport") == "wifi"
    assert camera_snapshot.get("streaming") is False
