#pragma once

#include <Arduino.h>

// Initializes the logging sink and resets the ring buffer state.
void log_sink_init();

// Appends a formatted log line, mirroring the output to the UART console.
void logf(const char* fmt, ...);

// Appends a plain log line without formatting.
void log_line(const char* message);

struct LogDumpResult {
  uint32_t next_seq;
  size_t count;
  bool truncated;
};

// Dumps log entries newer than since_seq into the provided Stream.
LogDumpResult log_dump(Stream& io, uint32_t since_seq, size_t limit);

// Returns the next log sequence number that will be assigned.
uint32_t log_sink_next_seq();
