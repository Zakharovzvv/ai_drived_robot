#!/usr/bin/env bash
set -euo pipefail

# Usage: flash_firmware.sh [esp32|uno|all]
# Default target is "all". Override PlatformIO path via PLATFORMIO_BIN if needed.
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIRMWARE_DIR="${PROJECT_ROOT}/firmware"
PLATFORMIO_BIN="${PLATFORMIO_BIN:-$HOME/.platformio/penv/bin/platformio}"

if [[ ! -x "${PLATFORMIO_BIN}" ]]; then
  echo "error: platformio executable not found at ${PLATFORMIO_BIN}" >&2
  echo "set PLATFORMIO_BIN to override the path" >&2
  exit 1
fi

auto_detect_serial_port() {
  local board_hint="${1:-}"
  local -a patterns=(
    "/dev/cu.usbserial*"
    "/dev/cu.usbmodem*"
    "/dev/cu.SLAB_USBtoUART*"
    "/dev/cu.wchusbserial*"
    "/dev/ttyUSB*"
    "/dev/ttyACM*"
  )
  local -a matches=()
  local pattern candidate
  for pattern in "${patterns[@]}"; do
    while IFS= read -r candidate; do
      [[ -z "${candidate}" ]] && continue
      [[ ! -e "${candidate}" ]] && continue
      [[ "${candidate}" == *Bluetooth* ]] && continue
      matches+=("${candidate}")
    done < <(compgen -G "${pattern}" 2>/dev/null || true)
  done

  if ((${#matches[@]} == 0)); then
    return 1
  fi

  mapfile -t matches < <(printf '%s\n' "${matches[@]}" | sort -u)
  local -a preferred_tokens=("usbserial" "usbmodem" "SLAB" "wchusbserial" "ttyUSB" "ttyACM")
  local token
  for token in "${preferred_tokens[@]}"; do
    for candidate in "${matches[@]}"; do
      if [[ "${candidate}" == *"${token}"* ]]; then
        echo "${candidate}"
        return 0
      fi
    done
  done

  echo "${matches[0]}"
  return 0
}

flash_esp32() {
  local upload_args=()
  local port="${PLATFORMIO_UPLOAD_PORT:-}"
  if [[ -z "${port}" ]]; then
    port=$(auto_detect_serial_port "esp32") || port=""
  fi
  if [[ -n "${port}" ]]; then
    echo "[flash] Using port ${port}"
    upload_args+=(--upload-port "${port}")
  else
    echo "[flash] warning: could not auto-detect ESP32 port" >&2
  fi
  echo "[flash] ESP32-S3 upload started"
  (cd "${FIRMWARE_DIR}" && "${PLATFORMIO_BIN}" run --environment esp32s3 --target upload "${upload_args[@]}")
  echo "[flash] ESP32-S3 upload finished"
}

flash_uno() {
  echo "[flash] Arduino Uno upload started"
  (cd "${FIRMWARE_DIR}" && "${PLATFORMIO_BIN}" run --environment uno --target upload)
  echo "[flash] Arduino Uno upload finished"
}

TARGET="${1:-all}"
case "${TARGET}" in
  esp32|ESP32)
    flash_esp32
    ;;
  uno|UNO|arduino|Arduino)
    flash_uno
    ;;
  all|both|ALL|BOTH)
    flash_esp32
    flash_uno
    ;;
  *)
    echo "usage: $0 [esp32|uno|all]" >&2
    exit 2
    ;;
esac
