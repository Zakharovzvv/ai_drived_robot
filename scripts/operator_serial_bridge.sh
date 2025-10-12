#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 ]]; then
  cat <<'EOF'
Usage: operator_serial_bridge.sh <serial-device> [tcp-port]

Create a TCP bridge to a local serial device using socat so Docker containers
(such as the operator backend) can connect via socket://host.docker.internal:<port>.

Examples:
  ./scripts/operator_serial_bridge.sh /dev/cu.usbmodem1101
  ./scripts/operator_serial_bridge.sh /dev/ttyUSB0 4444

Stop the bridge with Ctrl+C. Requires socat (install via 'brew install socat' on macOS).
EOF
  exit 1
fi

SERIAL_DEVICE="$1"
TCP_PORT="${2:-3333}"

if ! command -v socat >/dev/null 2>&1; then
  echo "[serial-bridge] socat is not installed. Install it (e.g. 'brew install socat') and retry." >&2
  exit 1
fi

if [[ ! -e "${SERIAL_DEVICE}" ]]; then
  echo "[serial-bridge] Serial device ${SERIAL_DEVICE} not found." >&2
  exit 1
fi

echo "[serial-bridge] Bridging ${SERIAL_DEVICE} -> TCP ${TCP_PORT}" >&2
echo "[serial-bridge] Update OPERATOR_SERIAL_PORT=socket://host.docker.internal:${TCP_PORT} before restarting Docker stack." >&2
trap 'echo "[serial-bridge] Shutting down" >&2' INT TERM

socat -d -d \
  TCP-LISTEN:${TCP_PORT},reuseaddr,fork \
  FILE:${SERIAL_DEVICE},raw,echo=0,ispeed=115200,ospeed=115200
