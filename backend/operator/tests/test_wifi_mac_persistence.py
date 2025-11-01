"""Tests covering Wi-Fi MAC persistence logic."""
from __future__ import annotations

from typing import List, Tuple

import pytest

from backend.operator.services.operator_service import OperatorService
from backend.operator.services.operator_service import CommandResult, SerialNotFoundError


def test_status_persists_mac_during_auto_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    saved_config: List[dict[str, object]] = []
    monkeypatch.setattr(
        "backend.operator.services.operator_service.save_wifi_config",
        lambda config: saved_config.append(dict(config)),
    )
    monkeypatch.setattr(
        "backend.operator.services.operator_service.load_wifi_config",
        lambda: {},
    )
    monkeypatch.setattr(
        "backend.operator.services.operator_service.save_last_endpoint",
        lambda endpoint: None,
    )
    monkeypatch.setattr(
        "backend.operator.services.operator_service.load_last_endpoint",
        lambda: None,
    )

    class RecordingWSLink:
        def __init__(self, url: str, timeout: float) -> None:
            self.url = url
            self.timeout = timeout

        def run_command(self, *args: object, **kwargs: object) -> CommandResult:  # pragma: no cover - compatibility
            raise SerialNotFoundError("not implemented")

        def collect_pending_logs(self) -> List[Tuple[float, str]]:  # pragma: no cover - compatibility
            return []

        def close(self) -> None:  # pragma: no cover - compatibility
            pass

    created_links: List[RecordingWSLink] = []

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

        def collect_pending_logs(self) -> List[Tuple[float, str]]:  # pragma: no cover - compatibility
            return []

        def close(self) -> None:  # pragma: no cover - compatibility
            self.active_port = None

    monkeypatch.setattr("backend.operator.services.operator_service.ESP32WSLink", make_ws_link)
    monkeypatch.setattr("backend.operator.services.operator_service.ESP32Link", SerialStubLink)

    svc = OperatorService(port="socket://stub", control_transport="auto")

    assert not saved_config
    assert created_links == []

    status_payload = {
        "wifi_connected": True,
        "wifi_ip": "192.168.50.10",
        "wifi_mac": "CC:BA:97:11:22:33",
    }

    svc._ensure_wifi_transport(status_payload)

    assert created_links[-1].url == "ws://192.168.50.10:81/ws/cli"
    assert saved_config
    latest_config = saved_config[-1]
    assert latest_config["mac_address"] == "cc:ba:97:11:22:33"
    assert latest_config["mac_prefix"] == "cc:ba:97"
    assert "ip_address" not in latest_config
    wifi_snapshot = svc.get_wifi_config()
    assert wifi_snapshot["mac_address"] == "cc:ba:97:11:22:33"
    assert wifi_snapshot["mac_prefix"] == "cc:ba:97"
    assert wifi_snapshot["endpoint"] == "ws://192.168.50.10:81/ws/cli"
    assert wifi_snapshot["transport_available"] is True
    assert wifi_snapshot["auto_discovery"] is True
