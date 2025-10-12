"""Pydantic schemas shared across API routes."""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from pydantic import BaseModel


class CommandRequest(BaseModel):
    command: str
    raise_on_error: bool = False


class CommandResponse(BaseModel):
    command: str
    raw: list[str]
    data: Dict[str, Any]


class CameraConfigResponse(BaseModel):
    resolution: str
    quality: int
    running: bool
    available_resolutions: List[dict[str, Any]]
    quality_min: int
    quality_max: int


class CameraConfigUpdate(BaseModel):
    resolution: Optional[str] = None
    quality: Optional[int] = None


class ShelfMapPaletteEntry(BaseModel):
    id: str
    label: str
    color: str


class ShelfMapResponse(BaseModel):
    grid: List[List[str]]
    palette: List[ShelfMapPaletteEntry]
    raw: str
    timestamp: float
    source: str
    persisted: Optional[bool] = None


class ShelfMapUpdateRequest(BaseModel):
    grid: List[List[str]]
    persist: bool = False


class ShelfMapResetRequest(BaseModel):
    persist: bool = False


class ServiceInfo(BaseModel):
    serial_port: Optional[str]
    camera_snapshot_url: Optional[str]
    camera_snapshot_source: str
    camera_transport: str
    camera_streaming: bool
    status_fresh: bool


__all__ = [
    "CameraConfigResponse",
    "CameraConfigUpdate",
    "CommandRequest",
    "CommandResponse",
    "ServiceInfo",
    "ShelfMapPaletteEntry",
    "ShelfMapResetRequest",
    "ShelfMapResponse",
    "ShelfMapUpdateRequest",
]
