"""Persistence helpers for Wi-Fi discovery configuration."""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Dict, Optional

_CONFIG_ENV_VAR = "OPERATOR_WIFI_CONFIG_PATH"
_DEFAULT_CONFIG_PATH = Path.home() / ".cache" / "rbm-operator" / "wifi_config.json"
_SUPPORTED_KEYS = {
    "mac_address",
    "mac_prefix",
    "ip_address",
    "ws_port",
    "ws_path",
}


def _resolve_path(path: Optional[os.PathLike[str] | str] = None) -> Path:
    if path is not None:
        return Path(path).expanduser().resolve()

    env_override = os.getenv(_CONFIG_ENV_VAR)
    if env_override:
        return Path(env_override).expanduser().resolve()

    return _DEFAULT_CONFIG_PATH


def load_wifi_config(path: Optional[os.PathLike[str] | str] = None) -> Dict[str, object]:
    config_path = _resolve_path(path)
    try:
        if not config_path.is_file():
            return {}
        with config_path.open("r", encoding="utf-8") as handle:
            payload = json.load(handle)
    except FileNotFoundError:
        return {}
    except (OSError, json.JSONDecodeError):
        return {}

    if not isinstance(payload, dict):
        return {}

    result: Dict[str, object] = {}
    for key in _SUPPORTED_KEYS:
        if key in payload:
            result[key] = payload[key]
    return result


def save_wifi_config(config: Dict[str, object], path: Optional[os.PathLike[str] | str] = None) -> None:
    config_path = _resolve_path(path)
    payload = {key: value for key, value in config.items() if key in _SUPPORTED_KEYS}
    try:
        config_path.parent.mkdir(parents=True, exist_ok=True)
        with config_path.open("w", encoding="utf-8") as handle:
            json.dump(payload, handle)
    except OSError:
        # Non-critical; ignore persistence failures.
        return


__all__ = ["load_wifi_config", "save_wifi_config"]
