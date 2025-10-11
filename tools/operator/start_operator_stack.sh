#!/usr/bin/env bash
set -euo pipefail

# This script launches the operator backend (FastAPI) and frontend (Vite)
# in the background and keeps track of their PIDs so they can be stopped
# via stop_operator_stack.sh. It assumes that the Python environment was
# prepared (pip install -e .) and that pnpm dependencies were installed
# previously.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
RUNTIME_DIR="${REPO_ROOT}/.operator_runtime"
BACKEND_PID_FILE="${RUNTIME_DIR}/backend.pid"
FRONTEND_PID_FILE="${RUNTIME_DIR}/frontend.pid"
BACKEND_LOG="${RUNTIME_DIR}/backend.log"
FRONTEND_LOG="${RUNTIME_DIR}/frontend.log"
VENV_BIN="${SCRIPT_DIR}/.venv/bin"

mkdir -p "${RUNTIME_DIR}"

function is_running() {
  local pid_file="$1"
  if [[ -f "${pid_file}" ]]; then
    local pid
    pid="$(cat "${pid_file}")"
    if [[ -n "${pid}" ]] && ps -p "${pid}" > /dev/null 2>&1; then
      return 0
    fi
  fi
  return 1
}

function start_backend() {
  if is_running "${BACKEND_PID_FILE}"; then
    echo "[operator] Backend already running (PID $(cat "${BACKEND_PID_FILE}"))"
    return
  fi

  local py_exec="${VENV_BIN}/python"
  if [[ ! -x "${py_exec}" ]]; then
    py_exec="python"
    if ! command -v "${py_exec}" >/dev/null 2>&1; then
      if command -v python3 >/dev/null 2>&1; then
        py_exec="python3"
      else
        echo "[operator] python3 not found. Install Python or create the virtualenv." >&2
        exit 1
      fi
    fi
  fi

  if ! "${py_exec}" -c "import uvicorn" >/dev/null 2>&1; then
    echo "[operator] uvicorn is not installed for ${py_exec}. Activate the operator virtualenv and run 'pip install -e .'" >&2
    exit 1
  fi

  local cmd=("${py_exec}" -m tools.operator.server)

  echo "[operator] Starting backend: ${cmd[*]}"
  (
    cd "${REPO_ROOT}" || exit 1
    PYTHONPATH="${REPO_ROOT}:${PYTHONPATH:-}" nohup "${cmd[@]}" >"${BACKEND_LOG}" 2>&1 &
    echo $! > "${BACKEND_PID_FILE}"
  )
}

function start_frontend() {
  if is_running "${FRONTEND_PID_FILE}"; then
    echo "[operator] Frontend already running (PID $(cat "${FRONTEND_PID_FILE}"))"
    return
  fi

  if ! command -v pnpm >/dev/null 2>&1; then
    echo "[operator] pnpm is required to start the frontend" >&2
    exit 1
  fi

  if [[ ! -d "${REPO_ROOT}/tools/operator/web/node_modules" ]]; then
    echo "[operator] node_modules missing. Run 'pnpm install' inside tools/operator/web before starting." >&2
    exit 1
  fi

  echo "[operator] Starting frontend: pnpm run dev"
  (
    cd "${REPO_ROOT}/tools/operator/web" || exit 1
    nohup pnpm run dev >"${FRONTEND_LOG}" 2>&1 &
    echo $! > "${FRONTEND_PID_FILE}"
  )
}

start_backend
start_frontend

echo "[operator] Backend log: ${BACKEND_LOG}"
echo "[operator] Frontend log: ${FRONTEND_LOG}"
echo "[operator] Services running. Open http://localhost:5173"
