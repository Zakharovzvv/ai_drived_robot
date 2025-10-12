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

run_compose() {
  # shellcheck disable=SC2086
  # If SERVICES is empty, run against whole compose file; otherwise append service names
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
    run_compose up -d
    run_compose ps
    ;;
  stop)
    # For stopping/removing specific services use stop + rm -f; `down` always removes the whole compose project
    if [[ -z "${SERVICES}" ]]; then
      run_compose down
    else
      # stop and remove the specified services
      run_compose stop
      # remove containers for the specific services
      ${COMPOSE_BIN} rm -f ${SERVICES}
    fi
    ;;
  restart)
    if [[ -z "${SERVICES}" ]]; then
      run_compose down
      run_compose up -d
      run_compose ps
    else
      # Restart specific services by recreating them
      ${COMPOSE_BIN} stop ${SERVICES}
      ${COMPOSE_BIN} rm -f ${SERVICES}
      run_compose up -d
      run_compose ps ${SERVICES}
    fi
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
