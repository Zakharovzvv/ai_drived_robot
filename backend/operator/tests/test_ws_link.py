from __future__ import annotations

import types

import pytest

from backend.operator import esp32_ws_link
from backend.operator.esp32_link import CommandError, CommandResult


class _FakeSocket:
    def __init__(self, reply: str) -> None:
        self.reply = reply
        self.sent: str | None = None
        self.closed = False

    def send(self, data: str) -> None:
        self.sent = data

    def recv(self) -> str:
        return self.reply

    def close(self) -> None:
        self.closed = True


@pytest.fixture(autouse=True)
def patch_websocket(monkeypatch: pytest.MonkeyPatch):
    calls: list[tuple[str, float | None]] = []

    def _create_connection(url: str, timeout: float | None = None):
        calls.append((url, timeout))
        return _FakeSocket("status_ok=1\nvalue=2\n")

    stub = types.SimpleNamespace(create_connection=_create_connection)
    monkeypatch.setattr(esp32_ws_link, "websocket", stub)
    monkeypatch.setattr(esp32_ws_link, "_IMPORT_ERROR", None)
    yield calls


def test_run_command_parses_reply(patch_websocket):
    link = esp32_ws_link.ESP32WSLink("ws://esp32.local/ws", timeout=3.0)
    result = link.run_command("status")

    assert result.data["status_ok"] == 1
    assert result.data["value"] == 2
    # Ensure the command was actually transmitted
    assert patch_websocket and patch_websocket[0][0] == "ws://esp32.local/ws"


def test_raise_on_cli_error(patch_websocket, monkeypatch: pytest.MonkeyPatch):
    def _err_connection(url: str, timeout: float | None = None):
        _ = url, timeout
        return _FakeSocket("ERR bad\n")

    patch_websocket.clear()
    stub = types.SimpleNamespace(create_connection=_err_connection)
    monkeypatch.setattr(esp32_ws_link, "websocket", stub)
    monkeypatch.setattr(esp32_ws_link, "_IMPORT_ERROR", None)

    link = esp32_ws_link.ESP32WSLink("ws://esp32.local/ws")
    with pytest.raises(CommandError):
        link.run_command("status")


def test_collect_pending_logs(monkeypatch: pytest.MonkeyPatch):
    link = esp32_ws_link.ESP32WSLink("ws://esp32.local/ws")

    responses = [
        [
            "10|[ESP32] Boot",
            "11|[WiFi] Connected",
            "logs_next=12 logs_count=2 logs_truncated=0",
        ],
        [
            "logs_next=12 logs_count=0 logs_truncated=0",
        ],
    ]

    def _fake_run(self, command: str, *, raise_on_error: bool = True):
        _ = raise_on_error
        assert command.startswith("logs")
        raw = responses.pop(0)
        return CommandResult(raw=raw, data={})

    monkeypatch.setattr(link, "run_command", types.MethodType(_fake_run, link))

    first = link.collect_pending_logs()
    assert len(first) == 2
    assert first[0][1] == "[ESP32] Boot"

    second = link.collect_pending_logs()
    assert second == []


def test_listener_heartbeat_updates_sequence():
    link = esp32_ws_link.ESP32WSLink("ws://esp32.local/ws")

    link._on_listener_message(  # type: ignore[attr-defined]
        None,
        '{"type":"heartbeat","uptime_ms":1024,"logs_next":25}',
    )

    assert link.uptime_ms == 1024
    assert link.last_heartbeat is not None
    assert link._log_next_seq == 25  # type: ignore[attr-defined]

    link._on_listener_message(None, '{"type":"heartbeat","logs_next":30}')  # type: ignore[attr-defined]
    assert link._log_next_seq == 30  # type: ignore[attr-defined]