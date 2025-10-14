#include "log_sink.hpp"

#include <Arduino.h>
#include <cstdarg>
#include <cstring>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>

namespace {
constexpr size_t kLogCapacity = 256;
constexpr size_t kMaxLogLength = 240;

struct LogEntry {
  uint32_t seq;
  uint32_t timestamp_ms;
  char text[kMaxLogLength + 1];
};

LogEntry g_log_entries[kLogCapacity] = {};
size_t g_log_count = 0;
size_t g_log_head = 0;
uint32_t g_next_seq = 1;
SemaphoreHandle_t g_log_mutex = nullptr;

void push_locked(const char* line) {
  if (!line || !line[0]) {
    return;
  }
  LogEntry& slot = g_log_entries[g_log_head];
  slot.seq = g_next_seq++;
  slot.timestamp_ms = millis();
  strncpy(slot.text, line, kMaxLogLength);
  slot.text[kMaxLogLength] = '\0';

  g_log_head = (g_log_head + 1) % kLogCapacity;
  if (g_log_count < kLogCapacity) {
    ++g_log_count;
  }
}

}  // namespace

void log_sink_init() {
  if (!g_log_mutex) {
    g_log_mutex = xSemaphoreCreateMutex();
  }
  if (g_log_mutex) {
    xSemaphoreTake(g_log_mutex, portMAX_DELAY);
    g_log_count = 0;
    g_log_head = 0;
    g_next_seq = 1;
    memset(g_log_entries, 0, sizeof(g_log_entries));
    xSemaphoreGive(g_log_mutex);
  }
}

static void append_line(const char* line) {
  if (!line) {
    return;
  }
  Serial.println(line);
  if (!g_log_mutex) {
    return;
  }
  if (xSemaphoreTake(g_log_mutex, portMAX_DELAY) == pdTRUE) {
    push_locked(line);
    xSemaphoreGive(g_log_mutex);
  }
}

void log_line(const char* message) {
  append_line(message);
}

void logf(const char* fmt, ...) {
  if (!fmt) {
    return;
  }
  char buffer[kMaxLogLength + 1];
  va_list args;
  va_start(args, fmt);
  vsnprintf(buffer, sizeof(buffer), fmt, args);
  va_end(args);
  append_line(buffer);
}

LogDumpResult log_dump(Stream& io, uint32_t since_seq, size_t limit) {
  LogDumpResult result = {g_next_seq, 0, false};
  if (!g_log_mutex) {
    io.println("logs_next=0 logs_count=0 logs_truncated=0");
    return result;
  }

  if (limit == 0) {
    limit = kLogCapacity;
  }

  if (xSemaphoreTake(g_log_mutex, portMAX_DELAY) != pdTRUE) {
    io.println("logs_next=0 logs_count=0 logs_truncated=0");
    return result;
  }

  size_t emitted = 0;
  size_t available = g_log_count;
  size_t index = (g_log_head + kLogCapacity - g_log_count) % kLogCapacity;
  uint32_t next_seq = g_next_seq;
  while (available > 0 && emitted < limit) {
    const LogEntry& entry = g_log_entries[index];
    if (entry.seq > since_seq && entry.text[0] != '\0') {
      io.printf("%lu|%s\n", static_cast<unsigned long>(entry.seq), entry.text);
      ++emitted;
      next_seq = entry.seq + 1;
    }
    index = (index + 1) % kLogCapacity;
    --available;
  }

  bool truncated = false;
  if (available > 0) {
    // There are older entries that were not scanned due to limit; compute whether
    // any of them are newer than since_seq.
    size_t check = available;
    size_t idx = index;
    while (check > 0) {
      const LogEntry& entry = g_log_entries[idx];
      if (entry.seq > since_seq && entry.text[0] != '\0') {
        truncated = true;
        next_seq = entry.seq;
        break;
      }
      idx = (idx + 1) % kLogCapacity;
      --check;
    }
  }

  xSemaphoreGive(g_log_mutex);

  result.next_seq = next_seq;
  result.count = emitted;
  result.truncated = truncated;
  io.printf(
    "logs_next=%lu logs_count=%u logs_truncated=%u\n",
    static_cast<unsigned long>(result.next_seq),
    static_cast<unsigned>(result.count),
    result.truncated ? 1U : 0U
  );
  return result;
}

uint32_t log_sink_next_seq() {
  if (!g_log_mutex) {
    return g_next_seq;
  }
  uint32_t seq = g_next_seq;
  if (xSemaphoreTake(g_log_mutex, portMAX_DELAY) == pdTRUE) {
    seq = g_next_seq;
    xSemaphoreGive(g_log_mutex);
  }
  return seq;
}
