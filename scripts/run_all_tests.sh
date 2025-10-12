#!/usr/bin/env bash
set -euo pipefail

# Run backend (pytest) and frontend (pnpm vitest) test suites.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_DIR="$ROOT_DIR/backend/operator"
FRONTEND_DIR="$ROOT_DIR/frontend/web"

info() { printf '\n>> %s\n' "$1"; }
error() { printf '\nERROR: %s\n' "$1" >&2; exit 2; }

run_backend_tests() {
  if [ ! -d "$BACKEND_DIR/tests" ]; then
    info "No backend tests detected, skipping."
    return
  fi

    info "Running backend tests (pytest)..."
    (
      cd "$BACKEND_DIR"
      PYTHON_BIN="${PYTHON_BIN:-}"
      if [ -z "$PYTHON_BIN" ]; then
        if [ -x "$ROOT_DIR/.venv/bin/python3" ]; then
          PYTHON_BIN="$ROOT_DIR/.venv/bin/python3"
        elif command -v python3 >/dev/null 2>&1; then
          PYTHON_BIN="$(command -v python3)"
        else
          error "python3 is not available. Activate your virtualenv or set PYTHON_BIN."
        fi
      fi

      if ! "$PYTHON_BIN" -m pytest --version >/dev/null 2>&1; then
        error "pytest not installed. Run '$PYTHON_BIN -m pip install -e backend/operator[dev]' first."
      fi

      export PYTHONPATH="$ROOT_DIR:${PYTHONPATH:-}"
      "$PYTHON_BIN" -m pytest -q
    )
}

run_frontend_tests() {
  if [ ! -f "$FRONTEND_DIR/package.json" ]; then
    info "No frontend package.json found, skipping frontend tests."
    return
  fi

  if ! command -v pnpm >/dev/null 2>&1; then
    error "pnpm is required. Enable it via 'corepack enable' or install pnpm globally."
  fi

  info "Running frontend tests (pnpm test)..."
  (
    cd "$FRONTEND_DIR"
    if [ ! -d node_modules ]; then
      pnpm install --frozen-lockfile
    fi
    pnpm test -- --run
  )
}

run_backend_tests
run_frontend_tests

info "All tests finished successfully."
