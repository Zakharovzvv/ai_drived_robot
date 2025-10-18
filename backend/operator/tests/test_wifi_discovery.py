"""Unit tests for Wi-Fi discovery helpers."""
from __future__ import annotations

import json
from pathlib import Path
from typing import List, Tuple

import pytest

from backend.operator.services import wifi_discovery


@pytest.fixture()
def temp_arp_file(tmp_path: Path) -> Path:
    table = """IP address       HW type     Flags       HW address            Mask     Device
192.168.1.12     0x1         0x2         cc:ba:97:aa:bb:cc     *        en0
192.168.1.30     0x1         0x2         00:00:00:00:00:00     *        en0
"""
    path = tmp_path / "arp"
    path.write_text(table, encoding="utf-8")
    return path


def test_discover_wifi_ip_prefers_exact_mac(temp_arp_file: Path) -> None:
    ip = wifi_discovery.discover_wifi_ip(
        mac_address="CC:BA:97:AA:BB:CC",
        arp_table_path=temp_arp_file,
        use_system_arp=False,
    )
    assert ip == "192.168.1.12"


def test_discover_wifi_ip_falls_back_to_prefix(temp_arp_file: Path) -> None:
    ip = wifi_discovery.discover_wifi_ip(
        mac_prefix="cc:ba:97",
        arp_table_path=temp_arp_file,
        use_system_arp=False,
    )
    assert ip == "192.168.1.12"


def test_discover_wifi_endpoint_uses_default_path(monkeypatch: pytest.MonkeyPatch) -> None:
    entries: List[Tuple[str, str]] = [("192.168.50.77", "cc:ba:97:10:22:33")]

    def fake_collect(*_: object, **__: object) -> List[Tuple[str, str]]:
        return entries

    monkeypatch.setattr(wifi_discovery, "_collect_from_proc", fake_collect)
    endpoint = wifi_discovery.discover_wifi_endpoint(use_system_arp=False)
    assert endpoint == "ws://192.168.50.77:81/ws/cli"


def test_discover_wifi_endpoint_accepts_custom_port_and_path(monkeypatch: pytest.MonkeyPatch) -> None:
    entries: List[Tuple[str, str]] = [("192.168.10.4", "cc:ba:97:99:88:77")]

    def fake_collect(*_: object, **__: object) -> List[Tuple[str, str]]:
        return entries

    monkeypatch.setattr(wifi_discovery, "_collect_from_proc", fake_collect)
    endpoint = wifi_discovery.discover_wifi_endpoint(
        port=9000,
        path="cli",
        use_system_arp=False,
    )
    assert endpoint == "ws://192.168.10.4:9000/cli"


def test_discover_wifi_endpoint_returns_none_when_no_match(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(wifi_discovery, "_collect_from_proc", lambda *_, **__: [])
    monkeypatch.setattr(wifi_discovery, "_collect_from_arp_command", lambda: [])
    assert wifi_discovery.discover_wifi_endpoint() is None
