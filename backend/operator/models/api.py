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
    control_mode: str
    control_transport: Optional[str]
    control_endpoint: Optional[str]
    available_transports: List["TransportDescriptor"]
    camera_snapshot_url: Optional[str]
    camera_snapshot_source: str
    camera_transport: str
    camera_streaming: bool
    status_fresh: bool


class ControlTransportUpdate(BaseModel):
    mode: str


class TransportDescriptor(BaseModel):
    id: str
    label: str
    endpoint: Optional[str] = None
    available: bool = False
    last_error: Optional[str] = None
    last_success: Optional[float] = None
    last_failure: Optional[float] = None


class ControlState(BaseModel):
    mode: str
    active: Optional[str]
    transports: List[TransportDescriptor]


__all__ = [
    "CameraConfigResponse",
    "CameraConfigUpdate",
    "CommandRequest",
    "CommandResponse",
    "ControlState",
    "ControlTransportUpdate",
    "ShelfMapPaletteEntry",
    "ShelfMapResetRequest",
    "ShelfMapResponse",
    "ShelfMapUpdateRequest",
    "ServiceInfo",
    "TransportDescriptor",
]

ServiceInfo.model_rebuild()
ControlState.model_rebuild()
