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
    serial_link = StubLink([], endpoint="socket://stub")

    monkeypatch.setattr(operator_service, "ESP32WSLink", lambda *_, **__: wifi_link)
    monkeypatch.setattr(operator_service, "ESP32Link", lambda *_, **__: serial_link)

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