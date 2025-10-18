"""Tests for Wi-Fi endpoint persistence helpers."""
from __future__ import annotations

from pathlib import Path

from backend.operator.services import wifi_registry


def test_wifi_registry_round_trip(tmp_path: Path) -> None:
    cache_file = tmp_path / "endpoint.json"

    # Initially cache is empty.
    assert wifi_registry.load_last_endpoint(cache_file) is None

    wifi_registry.save_last_endpoint("ws://10.0.0.5:81/ws/cli", cache_file)
    assert cache_file.is_file()

    restored = wifi_registry.load_last_endpoint(cache_file)
    assert restored == "ws://10.0.0.5:81/ws/cli"

    wifi_registry.clear_last_endpoint(cache_file)
    assert not cache_file.exists()
    assert wifi_registry.load_last_endpoint(cache_file) is None
