"""Dependency helpers for wiring OperatorService into FastAPI."""
from __future__ import annotations

from typing import Callable

from .operator_service import OperatorService


service = OperatorService()


async def startup_service() -> None:
    await service.start()


async def shutdown_service() -> None:
    await service.stop()


def get_service() -> OperatorService:
    return service


__all__ = [
    "get_service",
    "service",
    "shutdown_service",
    "startup_service",
]
