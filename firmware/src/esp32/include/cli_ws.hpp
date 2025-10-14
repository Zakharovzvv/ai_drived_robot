#pragma once

// Initializes internal state for the CLI WebSocket bridge.
void cli_ws_init();

// Periodically invoked from the main loop to manage server lifecycle.
void cli_ws_tick();
