"""Tests for shelf map helpers exposed via the operator service."""
from __future__ import annotations

from unittest.mock import AsyncMock

import pytest

from tools.operator.esp32_link import CommandResult
from tools.operator.server import OperatorService


@pytest.mark.asyncio
async def test_shelf_get_map_parses_payload() -> None:
    svc = OperatorService()
    svc.run_command = AsyncMock(return_value=CommandResult(raw=["R,G,B; Y,W,K; -,-,-"], data={}))

    payload = await svc.shelf_get_map(force_refresh=True)

    assert payload["grid"] == [["R", "G", "B"], ["Y", "W", "K"], ["-", "-", "-"]]
    assert payload["source"] == "live"
    assert isinstance(payload["timestamp"], float)
    assert payload["palette"]


@pytest.mark.asyncio
async def test_shelf_get_map_caches_result() -> None:
    svc = OperatorService()
    svc._shelf_cache_ttl = 60.0  # type: ignore[attr-defined]
    svc.run_command = AsyncMock(return_value=CommandResult(raw=["R,R,R; R,R,R; R,R,R"], data={}))

    first = await svc.shelf_get_map()
    second = await svc.shelf_get_map()

    assert first["source"] == "live"
    assert second["source"] == "cache"
    assert svc.run_command.await_count == 1


@pytest.mark.asyncio
async def test_shelf_set_map_persist() -> None:
    svc = OperatorService()
    svc.run_command = AsyncMock(
        side_effect=[
            CommandResult(raw=["OK"], data={}),
            CommandResult(raw=["SAVED"], data={}),
            CommandResult(raw=["R,G,B; Y,W,K; -,-,-"], data={}),
        ]
    )

    payload = await svc.shelf_set_map(
        [["R", "G", "B"], ["Y", "W", "K"], ["-", "-", "-"]],
        persist=True,
    )

    calls = [item.args[0] for item in svc.run_command.await_args_list]  # type: ignore[attr-defined]
    assert calls[0].startswith("SMAP SET")
    assert calls[1] == "SMAP SAVE"
    assert calls[2] == "SMAP GET"
    assert payload["persisted"] is True


@pytest.mark.asyncio
async def test_shelf_set_map_rejects_invalid_codes() -> None:
    svc = OperatorService()
    with pytest.raises(ValueError):
        await svc.shelf_set_map(
            [["R", "G", "B"], ["Y", "W", "Z"], ["-", "-", "-"]]
        )