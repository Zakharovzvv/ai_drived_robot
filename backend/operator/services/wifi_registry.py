"""Persistence helpers for remembering the last known Wi-Fi CLI endpoint."""
from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Optional

_CACHE_ENV_VAR = "OPERATOR_WIFI_CACHE_PATH"
_DEFAULT_CACHE_PATH = Path.home() / ".cache" / "rbm-operator" / "last_wifi_endpoint.json"


def _resolve_path(path: Optional[os.PathLike[str] | str] = None) -> Path:
    if path is not None:
        return Path(path).expanduser().resolve()

    env_override = os.getenv(_CACHE_ENV_VAR)
    if env_override:
        return Path(env_override).expanduser().resolve()

    return _DEFAULT_CACHE_PATH


def load_last_endpoint(path: Optional[os.PathLike[str] | str] = None) -> Optional[str]:
    cache_path = _resolve_path(path)
    try:
        if not cache_path.is_file():
            return None
        with cache_path.open("r", encoding="utf-8") as handle:
            payload = json.load(handle)
    except FileNotFoundError:
        return None
    except (OSError, json.JSONDecodeError):
        return None

    endpoint = payload.get("endpoint") if isinstance(payload, dict) else None
    if isinstance(endpoint, str) and endpoint.strip():
        return endpoint.strip()
    return None


def save_last_endpoint(endpoint: str, path: Optional[os.PathLike[str] | str] = None) -> None:
    cache_path = _resolve_path(path)
    if not endpoint:
        return

    payload = {
        "endpoint": endpoint.strip(),
        "updated_at": int(time.time()),
    }

    try:
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        with cache_path.open("w", encoding="utf-8") as handle:
            json.dump(payload, handle)
    except OSError:
        # Non-critical; ignore persistence failures.
        return


def clear_last_endpoint(path: Optional[os.PathLike[str] | str] = None) -> None:
    cache_path = _resolve_path(path)
    try:
        cache_path.unlink()
    except FileNotFoundError:
        return
    except OSError:
        return


__all__ = [
    "clear_last_endpoint",
    "load_last_endpoint",
    "save_last_endpoint",
]
