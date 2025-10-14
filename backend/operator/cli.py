"""Command-line utility for interacting with the ESP32 operator CLI.

The tool exposes quick commands for fetching status, streaming telemetry, invoking
control actions, and managing the shelf map. It reuses the shared serial link
abstraction defined in ``esp32_link``.
"""
from __future__ import annotations

import json
import os
import sys
import time
from typing import Optional, Union

import typer  # type: ignore

from .esp32_link import ESP32Link, CommandResult, SerialNotFoundError
from .esp32_ws_link import ESP32WSLink

app = typer.Typer(add_completion=False, help="Operator CLI for the RBM robot controller")


def _format_result(result: CommandResult, raw: bool) -> str:
    if raw or not result.data:
        return "\n".join(result.raw)
    return json.dumps(result.data, indent=2, sort_keys=True)


def _resolve_transport(value: Optional[str]) -> str:
    if value and value.strip():
        candidate = value.strip().lower()
        if candidate in {"serial", "ws"}:
            return candidate
    env_value = os.getenv("OPERATOR_CONTROL_TRANSPORT")
    if env_value and env_value.strip():
        candidate = env_value.strip().lower()
        if candidate in {"serial", "ws"}:
            return candidate
    return "serial"


def _create_link(
    port: Optional[str],
    baudrate: int,
    timeout: float,
    transport: Optional[str],
    ws_endpoint: Optional[str],
) -> Union[ESP32Link, ESP32WSLink]:
    mode = _resolve_transport(transport)
    if mode == "ws":
        endpoint = ws_endpoint or os.getenv("OPERATOR_WS_ENDPOINT")
        if not endpoint or not endpoint.strip():
            raise SerialNotFoundError(
                "WebSocket endpoint is not configured; set OPERATOR_WS_ENDPOINT or use --ws-endpoint."
            )
        return ESP32WSLink(url=endpoint.strip(), timeout=timeout)

    return ESP32Link(port=port, baudrate=baudrate, timeout=timeout)


@app.command()
def status(
    port: Optional[str] = typer.Option(
        None, help="Serial port path (auto-discovery if omitted)."
    ),
    baudrate: int = typer.Option(115200, help="Serial baud rate."),
    timeout: float = typer.Option(1.0, help="Command timeout in seconds."),
    raw: bool = typer.Option(False, help="Print raw CLI response instead of JSON."),
    transport: Optional[str] = typer.Option(
        None, help="Control transport: serial (default) or ws."
    ),
    ws_endpoint: Optional[str] = typer.Option(
        None, help="WebSocket endpoint when using transport=ws."
    ),
) -> None:
    """Fetch the current STATUS frame from the ESP32."""

    try:
        with _create_link(port, baudrate, timeout, transport, ws_endpoint) as link:
            result = link.run_command("status")
    except SerialNotFoundError as exc:
        typer.secho(str(exc), fg=typer.colors.RED)
        raise typer.Exit(code=2) from exc

    typer.echo(_format_result(result, raw))


@app.command()
def telemetry(
    command: str = typer.Option("status", help="CLI command to poll repeatedly."),
    interval: float = typer.Option(1.0, help="Polling interval in seconds."),
    port: Optional[str] = typer.Option(None, help="Serial port path."),
    baudrate: int = typer.Option(115200, help="Serial baud rate."),
    timeout: float = typer.Option(1.0, help="Command timeout."),
    raw: bool = typer.Option(False, help="Print raw output lines."),
    transport: Optional[str] = typer.Option(
        None, help="Control transport: serial (default) or ws."
    ),
    ws_endpoint: Optional[str] = typer.Option(
        None, help="WebSocket endpoint when using transport=ws."
    ),
) -> None:
    """Stream telemetry by periodically executing a CLI command."""

    try:
        with _create_link(port, baudrate, timeout, transport, ws_endpoint) as link:
            while True:
                result = link.run_command(command, raise_on_error=False)
                typer.echo(_format_result(result, raw))
                time.sleep(max(interval, 0.05))
    except KeyboardInterrupt:  # pragma: no cover - interactive
        typer.echo("Interrupted", err=True)
    except SerialNotFoundError as exc:
        typer.secho(str(exc), fg=typer.colors.RED)
        raise typer.Exit(code=2) from exc


@app.command()
def command(
    expr: str = typer.Argument(..., help="Raw command string to send (e.g. 'BRAKE')."),
    port: Optional[str] = typer.Option(None, help="Serial port path."),
    baudrate: int = typer.Option(115200, help="Serial baud rate."),
    timeout: float = typer.Option(1.0, help="Command timeout."),
    raw: bool = typer.Option(False, help="Print raw CLI response."),
    transport: Optional[str] = typer.Option(
        None, help="Control transport: serial (default) or ws."
    ),
    ws_endpoint: Optional[str] = typer.Option(
        None, help="WebSocket endpoint when using transport=ws."
    ),
) -> None:
    """Send an arbitrary CLI command and print the result."""

    try:
        with _create_link(port, baudrate, timeout, transport, ws_endpoint) as link:
            result = link.run_command(expr, raise_on_error=False)
    except SerialNotFoundError as exc:
        typer.secho(str(exc), fg=typer.colors.RED)
        raise typer.Exit(code=2) from exc

    typer.echo(_format_result(result, raw))


@app.command()
def smap(
    action: str = typer.Argument(..., help="SMAP subcommand: get, set, save, clear."),
    payload: Optional[str] = typer.Argument(
        None,
        help="Optional payload (e.g. 'Row=0,Col=1,Color=R' or map string).",
    ),
    port: Optional[str] = typer.Option(None, help="Serial port path."),
    baudrate: int = typer.Option(115200, help="Serial baud rate."),
    timeout: float = typer.Option(1.0, help="Command timeout."),
    raw: bool = typer.Option(False, help="Print raw CLI response."),
    transport: Optional[str] = typer.Option(
        None, help="Control transport: serial (default) or ws."
    ),
    ws_endpoint: Optional[str] = typer.Option(
        None, help="WebSocket endpoint when using transport=ws."
    ),
) -> None:
    """Run SMAP operations through the CLI."""

    action_upper = action.strip().upper()
    argument = payload or ""

    cmd = f"SMAP {action_upper}"
    if argument:
        cmd += f" {argument}"

    try:
        with _create_link(port, baudrate, timeout, transport, ws_endpoint) as link:
            result = link.run_command(cmd, raise_on_error=False)
    except SerialNotFoundError as exc:
        typer.secho(str(exc), fg=typer.colors.RED)
        raise typer.Exit(code=2) from exc

    typer.echo(_format_result(result, raw))


@app.command()
def start_task(
    task: str = typer.Argument("default", help="Task identifier recognised by firmware."),
    port: Optional[str] = typer.Option(None, help="Serial port path."),
    baudrate: int = typer.Option(115200, help="Serial baud rate."),
    timeout: float = typer.Option(1.0, help="Command timeout."),
    transport: Optional[str] = typer.Option(
        None, help="Control transport: serial (default) or ws."
    ),
    ws_endpoint: Optional[str] = typer.Option(
        None, help="WebSocket endpoint when using transport=ws."
    ),
) -> None:
    """Trigger a high-level behaviour on the ESP32."""

    cmd = f"START {task}" if task else "START"

    try:
        with _create_link(port, baudrate, timeout, transport, ws_endpoint) as link:
            result = link.run_command(cmd, raise_on_error=False)
    except SerialNotFoundError as exc:
        typer.secho(str(exc), fg=typer.colors.RED)
        raise typer.Exit(code=2) from exc

    typer.echo("\n".join(result.raw) or "Command dispatched")


@app.command()
def brake(
    port: Optional[str] = typer.Option(None, help="Serial port path."),
    baudrate: int = typer.Option(115200, help="Serial baud rate."),
    timeout: float = typer.Option(1.0, help="Command timeout."),
    transport: Optional[str] = typer.Option(
        None, help="Control transport: serial (default) or ws."
    ),
    ws_endpoint: Optional[str] = typer.Option(
        None, help="WebSocket endpoint when using transport=ws."
    ),
) -> None:
    """Invoke the BRAKE command to safely neutralise all actuators."""

    try:
        with _create_link(port, baudrate, timeout, transport, ws_endpoint) as link:
            result = link.run_command("BRAKE", raise_on_error=False)
    except SerialNotFoundError as exc:
        typer.secho(str(exc), fg=typer.colors.RED)
        raise typer.Exit(code=2) from exc

    if result.raw:
        typer.echo("\n".join(result.raw))
    else:
        typer.echo("Brake command dispatched")


def main(argv: Optional[list[str]] = None) -> int:
    args = argv if argv is not None else sys.argv[1:]
    try:
        app(prog_name="rbm-operator", args=args, standalone_mode=False)
    except typer.Exit as exc:
        return exc.exit_code
    except SerialNotFoundError as exc:
        typer.secho(str(exc), fg=typer.colors.RED)
        return 2
    except Exception as exc:  # pragma: no cover - safety net
        typer.secho(f"Unexpected error: {exc}", fg=typer.colors.RED)
        return 1
    return 0


if __name__ == "__main__":  # pragma: no cover - manual execution
    sys.exit(main(sys.argv[1:]))


def run() -> None:
    """Entry point for console_scripts."""

    sys.exit(main(sys.argv[1:]))
