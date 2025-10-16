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

flash_esp32() {
  echo "[flash] ESP32-S3 upload started"
  (cd "${FIRMWARE_DIR}" && "${PLATFORMIO_BIN}" run --environment esp32s3 --target upload)
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
