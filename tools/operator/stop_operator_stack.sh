#!/usr/bin/env bash
set -euo pipefail

# Stop processes started by start_operator_stack.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
RUNTIME_DIR="${REPO_ROOT}/.operator_runtime"
BACKEND_PID_FILE="${RUNTIME_DIR}/backend.pid"
FRONTEND_PID_FILE="${RUNTIME_DIR}/frontend.pid"

function stop_process() {
  local pid_file="$1"
  local name="$2"

  if [[ ! -f "${pid_file}" ]]; then
    echo "[operator] ${name}: no PID file"
    return
  fi

  local pid
  pid="$(cat "${pid_file}")"
  if [[ -z "${pid}" ]]; then
    echo "[operator] ${name}: empty PID file"
    rm -f "${pid_file}"
    return
  fi

  if ! ps -p "${pid}" > /dev/null 2>&1; then
    echo "[operator] ${name}: process ${pid} not running"
    rm -f "${pid_file}"
    return
  fi

  echo "[operator] Stopping ${name} (PID ${pid})"
  kill "${pid}" >/dev/null 2>&1 || true
  for _ in {1..10}; do
    if ps -p "${pid}" > /dev/null 2>&1; then
      sleep 0.3
    else
      break
    fi
  done
  if ps -p "${pid}" > /dev/null 2>&1; then
    echo "[operator] ${name} did not exit gracefully; sending SIGKILL"
    kill -9 "${pid}" >/dev/null 2>&1 || true
  fi
  rm -f "${pid_file}"
}

stop_process "${BACKEND_PID_FILE}" "backend"
stop_process "${FRONTEND_PID_FILE}" "frontend"

echo "[operator] All operator services stopped"
