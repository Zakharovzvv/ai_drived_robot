"""Tests for dual transport control logic in OperatorService."""
from __future__ import annotations

import asyncio
import types
from typing import Iterable, Union

import pytest

from backend.operator.esp32_link import CommandResult, SerialNotFoundError
from backend.operator.services import operator_service
from backend.operator.services.operator_service import (
    OperatorService,
    TRANSPORT_AUTO,
    TRANSPORT_SERIAL,
    TRANSPORT_WIFI,
)


class StubLink:
    """Simple link stub capturing run_command calls and scripted responses."""

    def __init__(self, responses: Iterable[Union[CommandResult, Exception]], endpoint: str) -> None:
        self._responses = list(responses)
        self.endpoint = endpoint
        self.requested_port = endpoint
        self.active_port: str | None = None
        self.calls: int = 0

    def run_command(self, command: str, *, raise_on_error: bool = True, **_: object) -> CommandResult:
        self.calls += 1
        if not self._responses:
            raise AssertionError("StubLink received more run_command calls than scripted")
        outcome = self._responses.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        self.active_port = self.endpoint
        return outcome

    def close(self) -> None:  # pragma: no cover - compatibility shim
        self.active_port = None


@pytest.fixture(autouse=True)
def stub_wifi_config(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(operator_service, "load_wifi_config", lambda: {})
    monkeypatch.setattr(operator_service, "save_wifi_config", lambda config: None)


@pytest.mark.asyncio
async def test_run_command_falls_back_to_serial(monkeypatch: pytest.MonkeyPatch) -> None:
    wifi_link = StubLink([SerialNotFoundError("wifi down")], endpoint="ws://stub")
    serial_link = StubLink([
        CommandResult(raw=["ok"], data={"ok": 1}),
    ], endpoint="socket://stub")

    monkeypatch.setattr(operator_service, "ESP32WSLink", lambda *_, **__: wifi_link)
    monkeypatch.setattr(operator_service, "ESP32Link", lambda *_, **__: serial_link)

    svc = OperatorService(
        port="socket://stub",
        ws_endpoint="ws://stub",
        control_transport="auto",
    )

    result = await svc.run_command("status")

    assert result.data == {"ok": 1}
    assert svc._active_transport == TRANSPORT_SERIAL
    assert wifi_link.calls == 1
    assert serial_link.calls == 1

    state = svc.get_control_state()
    assert state["mode"] == TRANSPORT_AUTO
    assert state["active"] == TRANSPORT_SERIAL
    transports = {item["id"]: item for item in state["transports"]}
    assert transports["serial"]["available"] is True
    assert transports["wifi"]["available"] is False


@pytest.mark.asyncio
async def test_set_control_mode_switches_and_triggers_probe(monkeypatch: pytest.MonkeyPatch) -> None:
    wifi_link = StubLink([], endpoint="ws://stub")
    class SerialStubLink:
        def __init__(self, *args: object, **kwargs: object) -> None:
            self.requested_port = "socket://stub"
            self.active_port: str | None = None

        def run_command(self, *args: object, **kwargs: object) -> CommandResult:
            raise SerialNotFoundError("serial disabled")

        def collect_pending_logs(self) -> list[tuple[float, str]]:  # pragma: no cover - compatibility
            return []

        def close(self) -> None:  # pragma: no cover - compatibility
            self.active_port = None

    monkeypatch.setattr(operator_service, "ESP32WSLink", lambda *_, **__: wifi_link)
    monkeypatch.setattr(operator_service, "ESP32Link", SerialStubLink)

    svc = OperatorService(
        port="socket://stub",
        ws_endpoint="ws://stub",
        control_transport="serial",
    )

    state_serial = await svc.set_control_mode("serial")
    assert state_serial["mode"] == TRANSPORT_SERIAL
    assert svc._active_transport == TRANSPORT_SERIAL

    probe_called = asyncio.Event()

    async def fake_probe(self) -> None:
        probe_called.set()
        self._initial_probe_task = None

    monkeypatch.setattr(svc, "_initial_probe", types.MethodType(fake_probe, svc))

    state_auto = await svc.set_control_mode("auto")
    assert state_auto["mode"] == TRANSPORT_AUTO
    await asyncio.wait_for(probe_called.wait(), timeout=0.1)
    assert svc._initial_probe_task is None


@pytest.mark.asyncio
async def test_set_control_mode_requires_configured_transport(monkeypatch: pytest.MonkeyPatch) -> None:
    serial_link = StubLink([], endpoint="socket://stub")
    monkeypatch.setattr(operator_service, "ESP32Link", lambda *_, **__: serial_link)

    svc = OperatorService(port="socket://stub", control_transport="serial")

    with pytest.raises(ValueError, match="Transport wifi is not configured"):
        await svc.set_control_mode("wifi")


@pytest.mark.asyncio
async def test_update_wifi_config_sets_static_endpoint(monkeypatch: pytest.MonkeyPatch) -> None:
    serial_link = StubLink([], endpoint="socket://stub")
    monkeypatch.setattr(operator_service, "ESP32Link", lambda *_, **__: serial_link)

    saved_config: dict[str, object] = {}
    monkeypatch.setattr(operator_service, "save_wifi_config", lambda config: saved_config.update(config))
    monkeypatch.setattr(operator_service, "load_wifi_config", lambda: {})
    monkeypatch.setattr(operator_service, "load_last_endpoint", lambda: None)
    recorded_endpoints: list[str] = []
    monkeypatch.setattr(operator_service, "save_last_endpoint", lambda endpoint: recorded_endpoints.append(endpoint))

    class DummyWS:
        def __init__(self, url: str, timeout: float) -> None:
            self.url = url
            self.timeout = timeout

        def run_command(self, *args, **kwargs):  # pragma: no cover - not used
            raise SerialNotFoundError("not implemented")

        def collect_pending_logs(self):  # pragma: no cover - not used
            return []

        def close(self) -> None:
            pass

    monkeypatch.setattr(operator_service, "ESP32WSLink", lambda url, timeout: DummyWS(url, timeout))

    svc = OperatorService(port="socket://stub", control_transport="auto")

    result = await svc.update_wifi_config(
        mac_address="CC-BA-97-11-22-33",
        ip_address="192.168.31.91",
    )

    assert result["mac_address"] == "cc:ba:97:11:22:33"
    assert result["mac_prefix"] == "cc:ba:97"
    assert result["ip_address"] == "192.168.31.91"
    assert result["endpoint"] == "ws://192.168.31.91:81/ws/cli"
    assert result["auto_discovery"] is False
    assert recorded_endpoints[-1] == "ws://192.168.31.91:81/ws/cli"
    assert saved_config["ip_address"] == "192.168.31.91"


@pytest.mark.asyncio
async def test_update_wifi_config_rejects_invalid_ip(monkeypatch: pytest.MonkeyPatch) -> None:
    serial_link = StubLink([], endpoint="socket://stub")
    monkeypatch.setattr(operator_service, "ESP32Link", lambda *_, **__: serial_link)
    monkeypatch.setattr(operator_service, "ESP32WSLink", lambda url, timeout: StubLink([], endpoint=url))

    svc = OperatorService(port="socket://stub", control_transport="auto")

    with pytest.raises(ValueError, match="Invalid IPv4/IPv6 address"):
        await svc.update_wifi_config(ip_address="not-an-ip")


@pytest.mark.asyncio
async def test_wifi_failure_enables_auto_discovery(monkeypatch: pytest.MonkeyPatch) -> None:
    wifi_link = StubLink([SerialNotFoundError("wifi down")], endpoint="ws://stale")
    serial_link = StubLink([
        CommandResult(raw=["ok"], data={"ok": 1}),
    ], endpoint="socket://stub")

    monkeypatch.setattr(operator_service, "ESP32WSLink", lambda *_, **__: wifi_link)
    monkeypatch.setattr(operator_service, "ESP32Link", lambda *_, **__: serial_link)
    monkeypatch.setattr(operator_service, "load_last_endpoint", lambda: "ws://stale")

    clears: list[object] = []
    monkeypatch.setattr(operator_service, "clear_last_endpoint", lambda path=None: clears.append(path))

    svc = OperatorService(
        port="socket://stub",
        control_transport="auto",
    )

    assert svc._transport_endpoints.get(operator_service.TRANSPORT_WIFI) == "ws://stale"
    assert svc._ws_auto_enabled is True

    result = await svc.run_command("status")
    assert result.data == {"ok": 1}

    await asyncio.sleep(0)

    assert svc._ws_auto_enabled is True
    assert svc._transport_endpoints.get(operator_service.TRANSPORT_WIFI) is None
    assert operator_service.TRANSPORT_WIFI not in svc._transports
    assert clears, "clear_last_endpoint should be called"

    state = svc.get_control_state()
    transports = {entry["id"]: entry for entry in state["transports"]}
    wifi_entry = transports.get(TRANSPORT_WIFI)
    assert wifi_entry is not None
    assert wifi_entry["endpoint"] is None
    assert wifi_entry["available"] is False
    assert state["active"] == TRANSPORT_SERIAL


@pytest.mark.asyncio
async def test_diagnostics_prefers_control_endpoint_for_wifi_ip(monkeypatch: pytest.MonkeyPatch) -> None:
    wifi_link = StubLink(
        [
            CommandResult(raw=["status"], data={"wifi_connected": True, "wifi_ip": "192.168.31.91"}),
            CommandResult(raw=["camcfg"], data={"cam_resolution": "QVGA", "cam_quality": 20}),
        ],
        endpoint="ws://192.168.31.91:81/ws/cli",
    )
    class SerialStubLink:
        def __init__(self, *args: object, **kwargs: object) -> None:
            self.requested_port = "socket://stub"
            self.active_port: str | None = None

        def run_command(self, *args: object, **kwargs: object) -> CommandResult:
            raise SerialNotFoundError("serial disabled")

        def collect_pending_logs(self) -> list[tuple[float, str]]:  # pragma: no cover - compatibility
            return []

        def close(self) -> None:  # pragma: no cover - compatibility
            self.active_port = None

    monkeypatch.setattr(operator_service, "ESP32WSLink", lambda *_, **__: wifi_link)
    monkeypatch.setattr(operator_service, "ESP32Link", SerialStubLink)
    monkeypatch.setattr(operator_service, "load_last_endpoint", lambda: None)
    monkeypatch.setattr(operator_service, "save_last_endpoint", lambda endpoint: None)

    svc = OperatorService(
        port="socket://stub",
        ws_endpoint="ws://192.168.31.91:81/ws/cli",
        control_transport="auto",
    )

    diag = await svc.diagnostics()

    assert diag["wifi"]["endpoint"] == "ws://192.168.31.91:81/ws/cli"
    assert diag["wifi"]["ip"] == "192.168.31.91"
    assert diag["wifi"]["transport_available"] is True
    assert diag["wifi"]["connected"] is True

    transports = {entry["id"]: entry for entry in diag["control"]["transports"]}
    wifi_entry = transports.get(TRANSPORT_WIFI)
    assert wifi_entry is not None
    assert wifi_entry["endpoint"] == "ws://192.168.31.91:81/ws/cli"
    assert wifi_entry["available"] is True


@pytest.mark.asyncio
async def test_status_updates_static_wifi_ip(monkeypatch: pytest.MonkeyPatch) -> None:
    saved_config: list[dict[str, object]] = []
    monkeypatch.setattr(operator_service, "save_wifi_config", lambda config: saved_config.append(dict(config)))
    monkeypatch.setattr(operator_service, "load_wifi_config", lambda: {"ip_address": "192.168.0.72"})

    last_endpoints: list[str] = []
    monkeypatch.setattr(operator_service, "save_last_endpoint", lambda endpoint: last_endpoints.append(endpoint))

    class RecordingWSLink:
        def __init__(self, url: str, timeout: float) -> None:
            self.url = url
            self.timeout = timeout

        def run_command(self, *args: object, **kwargs: object) -> CommandResult:
            raise SerialNotFoundError("not implemented")

        def collect_pending_logs(self) -> list[tuple[float, str]]:  # pragma: no cover - compatibility
            return []

        def close(self) -> None:  # pragma: no cover - compatibility
            pass

    created_links: list[RecordingWSLink] = []

    def make_ws_link(url: str, timeout: float) -> RecordingWSLink:
        link = RecordingWSLink(url, timeout)
        created_links.append(link)
        return link

    class SerialStubLink:
        def __init__(self, *args: object, **kwargs: object) -> None:
            self.requested_port = "socket://stub"
            self.active_port: str | None = None

        def run_command(self, *args: object, **kwargs: object) -> CommandResult:
            raise SerialNotFoundError("serial disabled")

        def collect_pending_logs(self) -> list[tuple[float, str]]:  # pragma: no cover - compatibility
            return []

        def close(self) -> None:  # pragma: no cover - compatibility
            self.active_port = None

    monkeypatch.setattr(operator_service, "ESP32WSLink", make_ws_link)
    monkeypatch.setattr(operator_service, "ESP32Link", SerialStubLink)
    monkeypatch.setattr(operator_service, "load_last_endpoint", lambda: None)

    svc = OperatorService(port="socket://stub", control_transport="auto")

    assert created_links[0].url == "ws://192.168.0.72:81/ws/cli"

    svc._ensure_wifi_transport({"wifi_connected": True, "wifi_ip": "192.168.31.91"})

    assert svc._transport_endpoints[TRANSPORT_WIFI] == "ws://192.168.31.91:81/ws/cli"
    assert svc._wifi_user_ip == "192.168.31.91"
    assert created_links[-1].url == "ws://192.168.31.91:81/ws/cli"
    assert last_endpoints and last_endpoints[-1] == "ws://192.168.31.91:81/ws/cli"
    config = svc.get_wifi_config()
    assert config["ip_address"] == "192.168.31.91"
    assert config["transport_available"] is True
    assert saved_config and saved_config[-1]["ip_address"] == "192.168.31.91"