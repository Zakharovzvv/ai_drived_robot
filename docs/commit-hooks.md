# Commit hooks and CI

This project includes a pre-commit hook template that runs the full test suite (backend + frontend) to prevent committing broken code.

Files added:

- `.githooks/pre-commit` — the hook script. Activate locally with `git config core.hooksPath .githooks`.
- `scripts/run_all_tests.sh` — the orchestrator that runs backend pytest and frontend tests under `frontend/web`.

Enable hooks locally:

1. Make hooks and scripts executable:

```bash
chmod +x .githooks/pre-commit
chmod +x scripts/run_all_tests.sh
```

1. Tell git to use the repository hooks folder:

```bash
git config core.hooksPath .githooks
```

1. Ensure dependencies are installed before committing:

   - Backend (inside your virtual environment):

     ```bash
     python3 -m pip install -e backend/operator[dev]
     ```

   - Frontend:

     ```bash
     corepack enable
     cd frontend/web
     pnpm install --frozen-lockfile
     ```

1. Try a commit. The pre-commit hook will run the tests and abort the commit if any test fails.

CI

There's also a GitHub Actions workflow at `.github/workflows/ci.yml` which runs both backend and frontend tests on push and pull requests to `main`.

Notes & assumptions

- The backend test runner requires `python3` and `pytest` available via `python3 -m pytest`; install dependencies with the editable install above (or via `hatch shell`).
- The frontend test runner requires `pnpm`; no npm fallback is provided. Enable pnpm through Corepack (`corepack enable`) or install pnpm globally.
- `scripts/run_all_tests.sh` installs frontend dependencies automatically only when `node_modules` is missing; keep your working copy bootstrapped (`pnpm install`) to avoid install overhead on each commit.
- If your project uses different test commands or locations, update `scripts/run_all_tests.sh` and `.github/workflows/ci.yml` accordingly.
