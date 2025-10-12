"""Utilities for converting raw serial logs into structured records suitable for UI rendering."""
from __future__ import annotations

from datetime import datetime, timezone
import re
from typing import Any, Dict, Iterable, List, Sequence, Tuple

from .esp32_link import parse_value

_LOG_PREFIX_RE = re.compile(r"^\[(?P<tag>[^\]]+)\]\s*(?P<body>.*)$")
_KEY_VALUE_RE = re.compile(r"(?P<key>[A-Za-z0-9_./-]+)=(?P<value>[^\s,;]+)")
_COLON_RE = re.compile(r"^(?P<key>[A-Za-z0-9_ ./-]+):\s*(?P<value>.*)$")

_TAG_CLASSIFICATION = {
    "esp32": ("esp32", "system"),
    "wifi": ("esp32", "wifi"),
    "cli": ("esp32", "cli"),
    "loop": ("esp32", "loop"),
    "bt": ("esp32", "automation"),
    "tlm": ("esp32", "telemetry"),
    "i2c": ("esp32", "i2c"),
    "vision": ("esp32", "vision"),
    "camera": ("esp32", "camera"),
    "cam": ("esp32", "camera"),
    "shelf_map": ("esp32", "shelf_map"),
    "uno": ("arduino", "system"),
    "power": ("esp32", "power"),
}

_DEFAULT_SOURCE = ("esp32", "system")


def _classify(tag: str | None, body: str) -> Tuple[str, str]:
    if tag:
        normalized = tag.strip().lower().replace(" ", "_")
        if normalized in _TAG_CLASSIFICATION:
            return _TAG_CLASSIFICATION[normalized]
        if "uno" in normalized:
            return "arduino", normalized
        if "wifi" in normalized:
            return "esp32", "wifi"
        if "camera" in normalized or "cam" in normalized:
            return "esp32", "camera"
    upper_body = body.upper()
    if upper_body.startswith("[UNO]"):
        return "arduino", "system"
    if "GURU MEDITATION" in upper_body:
        return "esp32", "fault"
    return _DEFAULT_SOURCE


def _format_timestamp(timestamp: float) -> str:
    return datetime.fromtimestamp(timestamp, tz=timezone.utc).isoformat()


def _convert_value(raw: str) -> Any:
    try:
        return parse_value(raw)
    except Exception:
        return raw


def structure_log_line(timestamp: float, line: str) -> List[Dict[str, Any]]:
    """Convert a raw log line into one or more structured entries."""

    if not line:
        return []

    raw = line.strip()
    if not raw:
        return []

    tag: str | None = None
    body = raw
    prefix_match = _LOG_PREFIX_RE.match(raw)
    if prefix_match:
        tag = prefix_match.group("tag").strip()
        body = prefix_match.group("body").strip()

    source, device = _classify(tag, body)
    iso_time = _format_timestamp(timestamp)
    entries: List[Dict[str, Any]] = []
    kv_pairs = list(_KEY_VALUE_RE.finditer(body))
    if kv_pairs:
        for idx, match in enumerate(kv_pairs):
            key = match.group("key")
            value_raw = match.group("value")
            value = _convert_value(value_raw)
            entries.append(
                {
                    "timestamp": timestamp,
                    "time_iso": iso_time,
                    "source": source,
                    "device": device,
                    "tag": tag,
                    "parameter": key,
                    "value": value,
                    "raw": raw,
                }
            )
        return entries

    colon_match = _COLON_RE.match(body)
    if colon_match:
        parameter = colon_match.group("key").strip()
        value_text = colon_match.group("value").strip()
    else:
        parameter = tag or device or "message"
        value_text = body

    value = _convert_value(value_text) if isinstance(value_text, str) else value_text
    entries.append(
        {
            "timestamp": timestamp,
            "time_iso": iso_time,
            "source": source,
            "device": device,
            "tag": tag,
            "parameter": parameter.strip() if isinstance(parameter, str) else parameter,
            "value": value,
            "raw": raw,
        }
    )
    return entries


def structure_logs(entries: Sequence[Tuple[float, str]]) -> List[Dict[str, Any]]:
    """Convert an iterable of raw log tuples into structured records."""

    structured: List[Dict[str, Any]] = []
    for timestamp, line in entries:
        structured.extend(structure_log_line(timestamp, line))
    return structured
