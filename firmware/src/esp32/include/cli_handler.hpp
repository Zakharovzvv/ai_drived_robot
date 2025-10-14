#pragma once

#include <Arduino.h>

// Executes a CLI command using the shared automation logic.
// Output is written to the provided Stream (identical to the UART CLI behaviour).
void cli_handle_command(const String& command, Stream& output);

// Executes a CLI command and returns the captured reply as a single string.
String cli_handle_command_capture(const String& command);
