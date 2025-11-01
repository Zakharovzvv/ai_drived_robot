#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: operator_stack_docker.sh <command> [stack]

Commands:
  build [stack]    Build (or rebuild) images. stack: front|backend|all (default: all)
  start [stack]    Launch the operator stack in detached mode. stack filters services.
  stop [stack]     Stop and remove the containers. stack filters services.
  restart [stack]  Recreate the containers (stop + start). stack filters services.
  status [stack]   Show container status via docker compose ps. stack filters services.
  logs [stack]     Tail logs for the specified services (press Ctrl+C to exit).

stack values accepted: front, frontend, back, backend, all
If stack is omitted, the command will act on both frontend and backend (all).
EOF
}

if [[ $# -lt 1 ]]; then
  usage
  exit 1
fi

action="$1"
# optional stack argument (front/backend/all)
stack_arg="${2:-all}"

# normalize stack to service names used in compose
resolve_services() {
  local s="$1"
  case "${s,,}" in
    front|frontend)
      echo "frontend"
      ;;
    back|backend)
      echo "backend"
      ;;
    all)
      # empty means "all services" for docker compose
      echo ""
      ;;
    *)
      echo ""  # fallback to all
      ;;
  esac
}

SERVICES="$(resolve_services "${stack_arg}")"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
COMPOSE_FILE="${REPO_ROOT}/docker-compose.yml"

ENV_FILE="${REPO_ROOT}/.env"
env_loaded=false
load_env() {
  if [[ "${env_loaded}" == true ]]; then
    return
  fi
  if [[ -f "${ENV_FILE}" ]]; then
    echo "[operator] Loading environment from ${ENV_FILE}"
    local -a preserve_names=()
    local -a preserve_values=()
    local line name value
    while IFS= read -r line; do
      if [[ "${line}" == OPERATOR_* ]]; then
        name="${line%%=*}"
        value="${line#*=}"
        preserve_names+=("${name}")
        preserve_values+=("${value}")
      fi
    done < <(env)
    # shellcheck disable=SC1090
    set -a
    source "${ENV_FILE}"
    set +a
    for idx in "${!preserve_names[@]}"; do
      export "${preserve_names[idx]}=${preserve_values[idx]}"
    done
  fi
  env_loaded=true
}

load_env

WIFI_CACHE_FILE="${REPO_ROOT}/.wifi_last_ip"
ESP32_MAC_PREFIX_DEFAULT="cc:ba:97"
BACKEND_STATE_DIR="${REPO_ROOT}/.state/backend"
BACKEND_WIFI_CACHE_JSON="${BACKEND_STATE_DIR}/last_wifi_endpoint.json"

write_last_ip_file() {
  local ip="$1"
  if [[ -n "${ip}" ]]; then
    printf '%s\n' "${ip}" > "${WIFI_CACHE_FILE}"
  fi
}

persist_wifi_cache_json() {
  local endpoint="$1"
  local timestamp
  timestamp="$(date +%s)"
  mkdir -p "${BACKEND_STATE_DIR}"
  local escaped_endpoint
  escaped_endpoint="${endpoint//\"/\\\"}"
  printf '{"endpoint": "%s", "updated_at": %s}\n' "${escaped_endpoint}" "${timestamp}" > "${BACKEND_WIFI_CACHE_JSON}"
  local ip
  ip="${endpoint#*//}"
  ip="${ip%%:*}"
  write_last_ip_file "${ip}"
}

read_cached_endpoint() {
  if [[ -f "${BACKEND_WIFI_CACHE_JSON}" ]]; then
    python3 - "$BACKEND_WIFI_CACHE_JSON" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
try:
    payload = json.loads(path.read_text(encoding="utf-8"))
except (OSError, json.JSONDecodeError):
    sys.exit(1)

endpoint = payload.get("endpoint")
if isinstance(endpoint, str) and endpoint.strip():
    print(endpoint.strip())
    sys.exit(0)
sys.exit(1)
PY
    return $?
  fi
  return 1
}

discover_wifi_ip() {
  local ip=""
  local endpoint=""

  if endpoint="$(read_cached_endpoint 2>/dev/null)"; then
    ip="${endpoint#*//}"
    ip="${ip%%:*}"
    if [[ -n "${ip}" ]] && ping -c1 -W1 "${ip}" >/dev/null 2>&1; then
      write_last_ip_file "${ip}"
      echo "${ip}"
      return 0
    fi
    ip=""
  fi

  if [[ -f "${WIFI_CACHE_FILE}" ]]; then
    ip="$(tr -d '\r\n' < "${WIFI_CACHE_FILE}" | head -n1 | tr -d ' ')"
    if [[ -n "${ip}" ]]; then
      if ping -c1 -W1 "${ip}" >/dev/null 2>&1; then
        persist_wifi_cache_json "ws://${ip}:81/ws/cli"
        echo "${ip}"
        return 0
      else
        rm -f "${WIFI_CACHE_FILE}"
      fi
    fi
    ip=""
  fi

  local screenlog="${REPO_ROOT}/firmware/screenlog.0"
  if [[ -z "${ip}" && -f "${screenlog}" ]]; then
    ip="$(grep -Eo 'IP=[0-9]{1,3}(\.[0-9]{1,3}){3}' "${screenlog}" | tail -n1 | cut -d'=' -f2)"
    if [[ -n "${ip}" ]]; then
      write_last_ip_file "${ip}"
      persist_wifi_cache_json "ws://${ip}:81/ws/cli"
      echo "${ip}"
      return 0
    fi
  fi

  local mac_prefix="${OPERATOR_WIFI_MAC_PREFIX:-${ESP32_MAC_PREFIX_DEFAULT}}"
  if [[ -z "${mac_prefix}" ]]; then
    mac_prefix="${ESP32_MAC_PREFIX_DEFAULT}"
  fi
  if command -v arp >/dev/null 2>&1; then
    ip="$(arp -an | awk -v mac="${mac_prefix,,}" 'BEGIN{IGNORECASE=1}{gsub(/[()]/,""); if(index(tolower($4), mac)==1){print $2; exit}}')"
    if [[ -n "${ip}" ]]; then
      write_last_ip_file "${ip}"
      persist_wifi_cache_json "ws://${ip}:81/ws/cli"
      echo "${ip}"
      return 0
    fi
  fi

  return 1
}

ensure_ws_endpoint() {
  if [[ -n "${OPERATOR_WS_ENDPOINT:-}" ]]; then
    persist_wifi_cache_json "${OPERATOR_WS_ENDPOINT}"
    return 0
  fi
  local ip
  if ip="$(discover_wifi_ip)"; then
    export OPERATOR_WS_ENDPOINT="ws://${ip}:81/ws/cli"
    echo "[docker-operator] Auto-detected Wi-Fi endpoint at ${OPERATOR_WS_ENDPOINT}"
    persist_wifi_cache_json "${OPERATOR_WS_ENDPOINT}"
    return 0
  fi
  echo "[docker-operator] Unable to auto-detect Wi-Fi endpoint; Wi-Fi control will remain unavailable." >&2
  return 1
}

if [[ ! -f "${COMPOSE_FILE}" ]]; then
  echo "[docker-operator] Compose file not found at ${COMPOSE_FILE}" >&2
  exit 1
fi

find_compose() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    echo "docker compose"
    return
  fi
  if command -v docker-compose >/dev/null 2>&1; then
    echo "docker-compose"
    return
  fi
  echo ""  # none
}

COMPOSE_BIN="$(find_compose)"
if [[ -z "${COMPOSE_BIN}" ]]; then
  echo "[docker-operator] Neither 'docker compose' nor 'docker-compose' is available. Install Docker Desktop / Compose v2." >&2
  exit 1
fi

BRIDGE_SCRIPT="${REPO_ROOT}/scripts/operator_serial_bridge.sh"
BRIDGE_PID_FILE="${REPO_ROOT}/.serial_bridge.pid"
BRIDGE_LOG_FILE="${REPO_ROOT}/.serial_bridge.log"
BRIDGE_DEVICE="${OPERATOR_BRIDGE_DEVICE:-}"
BRIDGE_TCP_PORT="${OPERATOR_BRIDGE_TCP_PORT:-3333}"

should_manage_bridge() {
  if [[ -z "${BRIDGE_DEVICE}" ]]; then
    return 1
  fi
  if [[ -z "${SERVICES}" || "${SERVICES}" == "backend" ]]; then
    return 0
  fi
  return 1
}

bridge_running() {
  if [[ ! -f "${BRIDGE_PID_FILE}" ]]; then
    return 1
  fi
  local pid
  pid="$(cat "${BRIDGE_PID_FILE}" 2>/dev/null || true)"
  if [[ -z "${pid}" ]]; then
    rm -f "${BRIDGE_PID_FILE}"
    return 1
  fi
  if kill -0 "${pid}" 2>/dev/null; then
    return 0
  fi
  rm -f "${BRIDGE_PID_FILE}"
  return 1
}

start_bridge() {
  if ! should_manage_bridge; then
    return 0
  fi
  if bridge_running; then
    return 0
  fi
  if [[ ! -e "${BRIDGE_DEVICE}" ]]; then
    echo "[docker-operator] Serial bridge device ${BRIDGE_DEVICE} not found; continuing without UART bridge." >&2
    return 0
  fi
  if [[ ! -x "${BRIDGE_SCRIPT}" ]]; then
    echo "[docker-operator] Serial bridge script not found at ${BRIDGE_SCRIPT}" >&2
    return 1
  fi
  nohup "${BRIDGE_SCRIPT}" "${BRIDGE_DEVICE}" "${BRIDGE_TCP_PORT}" > "${BRIDGE_LOG_FILE}" 2>&1 &
  local pid=$!
  echo "${pid}" > "${BRIDGE_PID_FILE}"
  sleep 1
  if ! kill -0 "${pid}" 2>/dev/null; then
    echo "[docker-operator] Failed to start serial bridge (see ${BRIDGE_LOG_FILE}). Proceeding without UART bridge." >&2
    rm -f "${BRIDGE_PID_FILE}"
    return 0
  fi
  echo "[docker-operator] Serial bridge listening on TCP ${BRIDGE_TCP_PORT} (PID ${pid})."
  return 0
}

stop_bridge() {
  if ! should_manage_bridge; then
    return 0
  fi
  if [[ ! -f "${BRIDGE_PID_FILE}" ]]; then
    return 0
  fi
  local pid
  pid="$(cat "${BRIDGE_PID_FILE}" 2>/dev/null || true)"
  if [[ -n "${pid}" ]] && kill -0 "${pid}" 2>/dev/null; then
    local pgid
    pgid="$(ps -o pgid= -p "${pid}" 2>/dev/null | tr -d ' ')"
    if [[ -n "${pgid}" ]]; then
      kill -TERM -"${pgid}" 2>/dev/null || true
    else
      kill "${pid}" 2>/dev/null || true
    fi
    wait "${pid}" 2>/dev/null || true
  fi
  rm -f "${BRIDGE_PID_FILE}"
  return 0
}

run_compose() {
  # shellcheck disable=SC2086
  if [[ -z "${SERVICES}" ]]; then
    ${COMPOSE_BIN} -f "${COMPOSE_FILE}" "$@"
  else
    ${COMPOSE_BIN} -f "${COMPOSE_FILE}" "$@" ${SERVICES}
  fi
}

case "${action}" in
  build)
    run_compose build --pull
    ;;
  start)
    if ! start_bridge; then
      exit 1
    fi
    ensure_ws_endpoint || true
    run_compose up -d
    run_compose ps
    ;;
  stop)
    if [[ -z "${SERVICES}" ]]; then
      run_compose down
    else
      run_compose stop
      ${COMPOSE_BIN} rm -f ${SERVICES}
    fi
    stop_bridge
    ;;
  restart)
    stop_bridge
    if [[ -z "${SERVICES}" ]]; then
      run_compose down
    else
      ${COMPOSE_BIN} stop ${SERVICES}
      ${COMPOSE_BIN} rm -f ${SERVICES}
    fi
    if ! start_bridge; then
      exit 1
    fi
    ensure_ws_endpoint || true
    run_compose up -d
    run_compose ps
    ;;
  status)
    if [[ -z "${SERVICES}" ]]; then
      run_compose ps
    else
      run_compose ps ${SERVICES}
    fi
    ;;
  logs)
    if [[ -z "${SERVICES}" ]]; then
      run_compose logs -f
    else
      run_compose logs -f
    fi
    ;;
  *)
    usage
    exit 1
    ;;
esac
