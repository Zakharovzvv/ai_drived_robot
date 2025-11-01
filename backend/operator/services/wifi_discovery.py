"""Utilities for discovering the ESP32 Wi-Fi endpoint via ARP tables."""
from __future__ import annotations

import re
import subprocess
from pathlib import Path
from typing import Iterable, List, Optional, Sequence, Tuple

_DEFAULT_MAC_PREFIX = "cc:ba:97"
_DEFAULT_WS_PORT = 81
_DEFAULT_WS_PATH = "/ws/cli"
_ARP_PROC_PATH = Path("/proc/net/arp")
_MAC_TOKEN_RE = re.compile(r"[0-9a-f]{2}", re.IGNORECASE)
_ARP_CMD_PATTERN = re.compile(
    r"\((?P<ip>\d{1,3}(?:\.\d{1,3}){3})\)\\s+at\\s+(?P<mac>[0-9a-fA-F:.-]{11,})",
)


def _normalize_mac(value: str) -> str:
    tokens = _MAC_TOKEN_RE.findall(value.lower())
    if not tokens:
        return ""
    return ":".join(tokens)


def _best_match(
    entries: Sequence[Tuple[str, str]],
    mac_address: Optional[str],
    mac_prefix: Optional[str],
) -> Optional[str]:
    normalized_mac = _normalize_mac(mac_address) if mac_address else ""
    normalized_prefix = _normalize_mac(mac_prefix) if mac_prefix else ""
    if not normalized_prefix and normalized_mac:
        split = normalized_mac.split(":")
        normalized_prefix = ":".join(split[:3])
    if not normalized_prefix:
        normalized_prefix = _DEFAULT_MAC_PREFIX

    normalized_mac = normalized_mac.lower()
    normalized_prefix = normalized_prefix.lower()

    exact_match_ip: Optional[str] = None
    prefix_match_ip: Optional[str] = None

    for ip, mac in entries:
        clean_mac = _normalize_mac(mac).lower()
        if not clean_mac:
            continue
        if normalized_mac and clean_mac == normalized_mac:
            exact_match_ip = ip
            break
        if normalized_prefix and clean_mac.startswith(normalized_prefix) and prefix_match_ip is None:
            prefix_match_ip = ip

    if exact_match_ip:
        return exact_match_ip
    return prefix_match_ip


def _collect_from_proc(path_override: Optional[Path | str]) -> List[Tuple[str, str]]:
    candidates: Iterable[Path] = []
    if path_override is not None:
        candidates = [Path(path_override)]
    else:
        candidates = [_ARP_PROC_PATH]

    results: List[Tuple[str, str]] = []
    for path in candidates:
        try:
            text = path.read_text(encoding="utf-8")
        except FileNotFoundError:
            continue
        except OSError:
            continue
        lines = text.splitlines()
        if len(lines) <= 1:
            continue
        for line in lines[1:]:
            parts = line.split()
            if len(parts) < 4:
                continue
            ip, _hw_type, _flags, mac = parts[:4]
            mac_lower = mac.lower()
            if mac_lower == "00:00:00:00:00:00" or mac_lower == "(incomplete)":
                continue
            results.append((ip, mac))
        if results:
            break
    return results


def _collect_from_arp_command() -> List[Tuple[str, str]]:
    try:
        outcome = subprocess.run(
            ["arp", "-an"],
            capture_output=True,
            text=True,
            check=False,
        )
    except FileNotFoundError:
        return []
    except Exception:
        return []

    entries: List[Tuple[str, str]] = []
    for line in (outcome.stdout or "").splitlines():
        match = _ARP_CMD_PATTERN.search(line)
        if not match:
            continue
        ip = match.group("ip")
        mac = match.group("mac")
        entries.append((ip, mac))
    return entries


def discover_wifi_ip(
    *,
    mac_prefix: Optional[str] = None,
    mac_address: Optional[str] = None,
    arp_table_path: Optional[Path | str] = None,
    use_system_arp: bool = True,
) -> Optional[str]:
    """Return the first IP matching the given MAC parameters from ARP tables."""
    entries = _collect_from_proc(arp_table_path)
    if not entries and use_system_arp and arp_table_path is None:
        entries = _collect_from_arp_command()
    if not entries:
        return None
    return _best_match(entries, mac_address, mac_prefix)


def discover_wifi_endpoint(
    *,
    mac_prefix: Optional[str] = None,
    mac_address: Optional[str] = None,
    port: Optional[int] = None,
    path: Optional[str] = None,
    arp_table_path: Optional[Path | str] = None,
    use_system_arp: bool = True,
) -> Optional[str]:
    """Return the WebSocket endpoint for the ESP32 CLI based on ARP discovery."""
    ip = discover_wifi_ip(
        mac_prefix=mac_prefix,
        mac_address=mac_address,
        arp_table_path=arp_table_path,
        use_system_arp=use_system_arp,
    )
    if not ip:
        return None

    resolved_port = port if isinstance(port, int) and port > 0 else _DEFAULT_WS_PORT
    resolved_path = (path or _DEFAULT_WS_PATH).strip() or _DEFAULT_WS_PATH
    if not resolved_path.startswith("/"):
        resolved_path = f"/{resolved_path}"

    return f"ws://{ip}:{resolved_port}{resolved_path}"


__all__ = [
    "discover_wifi_endpoint",
    "discover_wifi_ip",
]
