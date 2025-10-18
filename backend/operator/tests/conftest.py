"""Pytest fixtures shared across backend operator tests."""
from __future__ import annotations

from pathlib import Path

import pytest


@pytest.fixture(autouse=True)
def operator_env_sandbox(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    for name in (
        "OPERATOR_CONTROL_TRANSPORT",
        "OPERATOR_WS_ENDPOINT",
        "OPERATOR_SERIAL_PORT",
        "OPERATOR_TRANSPORT_RETRY_COOLDOWN",
    ):
        monkeypatch.delenv(name, raising=False)

    monkeypatch.setenv("OPERATOR_WIFI_CACHE_PATH", str(tmp_path / "wifi_endpoint.json"))
