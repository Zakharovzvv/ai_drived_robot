"""ASGI entrypoint wiring the operator backend components together."""
from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .api.routes import router
from .services.dependencies import (
    get_service,
    service,
    shutdown_service,
    startup_service,
)
from .services.operator_service import OperatorService


@asynccontextmanager
async def _lifespan(_: FastAPI):
    await startup_service()
    try:
        yield
    finally:
        await shutdown_service()


app = FastAPI(title="RBM Operator Service", version="0.1.0", lifespan=_lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(router)


async def get_operator_service():
    """Dependency alias kept for backwards compatibility."""

    return get_service()


def run() -> None:  # pragma: no cover - manual execution helper
    """Launch the FastAPI app using uvicorn."""

    import uvicorn  # type: ignore

    uvicorn.run("backend.operator.server:app", host="0.0.0.0", port=8000, reload=False)


__all__ = [
    "app",
    "get_operator_service",
    "OperatorService",
    "run",
    "service",
]


if __name__ == "__main__":  # pragma: no cover - manual execution path
    run()
