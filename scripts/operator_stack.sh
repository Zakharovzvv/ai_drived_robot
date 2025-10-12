#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: operator_stack.sh <start|stop|restart|status>

Commands:
  start      Launch the operator backend (FastAPI) and frontend (Vite).
  stop       Stop all operator processes started by this script.
  restart    Stop then start the operator stack.
  status     Display whether backend and frontend processes are running.
EOF
}

if [[ $# -lt 1 ]]; then
  usage
  exit 1
fi

action="$1"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
RUNTIME_DIR="${REPO_ROOT}/.operator_runtime"
BACKEND_PID_FILE="${RUNTIME_DIR}/backend.pid"
FRONTEND_PID_FILE="${RUNTIME_DIR}/frontend.pid"
BACKEND_LOG="${RUNTIME_DIR}/backend.log"
FRONTEND_LOG="${RUNTIME_DIR}/frontend.log"
BACKEND_ENV_BIN="${REPO_ROOT}/backend/operator/.venv/bin"
ENV_FILE="${REPO_ROOT}/.env"

mkdir -p "${RUNTIME_DIR}"

env_loaded=false
load_env() {
  if [[ "${env_loaded}" == true ]]; then
    return
  fi
  if [[ -f "${ENV_FILE}" ]]; then
    echo "[operator] Loading environment from ${ENV_FILE}"
    # shellcheck disable=SC1090
    set -a
    source "${ENV_FILE}"
    set +a
  fi
  env_loaded=true
}

is_running() {
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

resolve_python() {
  local py_exec="${BACKEND_ENV_BIN}/python"
  if [[ ! -x "${py_exec}" ]]; then
    py_exec="python"
    if ! command -v "${py_exec}" >/dev/null 2>&1; then
      if command -v python3 >/dev/null 2>&1; then
        py_exec="python3"
      else
        echo "[operator] python3 not found. Install Python or create the backend virtualenv." >&2
        exit 1
      fi
    fi
  fi
  echo "${py_exec}"
}

start_backend() {
  if is_running "${BACKEND_PID_FILE}"; then
    echo "[operator] Backend already running (PID $(cat "${BACKEND_PID_FILE}"))"
    return
  fi

  load_env
  local py_exec
  py_exec="$(resolve_python)"

  if ! "${py_exec}" -c "import uvicorn" >/dev/null 2>&1; then
    echo "[operator] uvicorn is not installed for ${py_exec}. Activate the backend virtualenv and run 'pip install -e .'" >&2
    exit 1
  fi

  local cmd=("${py_exec}" -m backend.operator.server)

  echo "[operator] Starting backend: ${cmd[*]}"
  (
    cd "${REPO_ROOT}" || exit 1
    PYTHONPATH="${REPO_ROOT}:${PYTHONPATH:-}" nohup "${cmd[@]}" >"${BACKEND_LOG}" 2>&1 &
    echo $! > "${BACKEND_PID_FILE}"
  )
}

start_frontend() {
  if is_running "${FRONTEND_PID_FILE}"; then
    echo "[operator] Frontend already running (PID $(cat "${FRONTEND_PID_FILE}"))"
    return
  fi

  load_env
  if ! command -v pnpm >/dev/null 2>&1; then
    echo "[operator] pnpm is required to start the frontend" >&2
    exit 1
  fi

  if [[ ! -d "${REPO_ROOT}/frontend/web/node_modules" ]]; then
    echo "[operator] node_modules missing. Run 'pnpm install' inside frontend/web before starting." >&2
    exit 1
  fi

  echo "[operator] Starting frontend: pnpm run dev"
  (
    cd "${REPO_ROOT}/frontend/web" || exit 1
    nohup pnpm run dev >"${FRONTEND_LOG}" 2>&1 &
    echo $! > "${FRONTEND_PID_FILE}"
  )
}

stop_process() {
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

start_stack() {
  start_backend
  start_frontend
  echo "[operator] Backend log: ${BACKEND_LOG}"
  echo "[operator] Frontend log: ${FRONTEND_LOG}"
  echo "[operator] Services running. Open http://localhost:5173"
}

stop_stack() {
  stop_process "${BACKEND_PID_FILE}" "backend"
  stop_process "${FRONTEND_PID_FILE}" "frontend"
  echo "[operator] All operator services stopped"
}

status_stack() {
  if is_running "${BACKEND_PID_FILE}"; then
    echo "[operator] backend: running (PID $(cat "${BACKEND_PID_FILE}"))"
    echo "[operator]   log: ${BACKEND_LOG}"
  else
    echo "[operator] backend: not running"
  fi

  if is_running "${FRONTEND_PID_FILE}"; then
    echo "[operator] frontend: running (PID $(cat "${FRONTEND_PID_FILE}"))"
    echo "[operator]   log: ${FRONTEND_LOG}"
  else
    echo "[operator] frontend: not running"
  fi
}

case "${action}" in
  start)
    start_stack
    ;;
  stop)
    stop_stack
    ;;
  restart)
    stop_stack
    start_stack
    ;;
  status)
    status_stack
    ;;
  *)
    usage
    exit 1
    ;;
esac
