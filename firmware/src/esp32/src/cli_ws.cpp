#include "cli_ws.hpp"

#include "cli_handler.hpp"
#include "log_sink.hpp"
#include "wifi_link.hpp"

#include <Arduino.h>
#include <esp_http_server.h>
#include <freertos/FreeRTOS.h>
#include <cstdio>
#include <cstring>
#include <cstdlib>

namespace {
constexpr const char* kCliWsPath = "/ws/cli";
constexpr uint16_t kMaxCommandLength = 512;
constexpr uint32_t kHeartbeatIntervalMs = 2000;
constexpr uint32_t kClientIdleTimeoutMs = 15000;
constexpr size_t kMaxWsClients = 4;
httpd_handle_t s_ws_server = nullptr;
unsigned long s_last_heartbeat_ms = 0;

struct WsClient {
  int socket_fd;
  unsigned long last_heartbeat_ms;
};

WsClient s_ws_clients[kMaxWsClients];

void reset_clients() {
  for (size_t i = 0; i < kMaxWsClients; ++i) {
    s_ws_clients[i].socket_fd = -1;
    s_ws_clients[i].last_heartbeat_ms = 0;
  }
  s_last_heartbeat_ms = 0;
}

void unregister_client(int socket_fd) {
  if (socket_fd < 0) {
    return;
  }
  for (size_t i = 0; i < kMaxWsClients; ++i) {
    if (s_ws_clients[i].socket_fd == socket_fd) {
      s_ws_clients[i].socket_fd = -1;
      s_ws_clients[i].last_heartbeat_ms = 0;
      logf("[CLIWS] client closed fd=%d", socket_fd);
      break;
    }
  }
}

void register_client(httpd_req_t* request) {
  const int socket_fd = httpd_req_to_sockfd(request);
  if (socket_fd < 0) {
    return;
  }
  for (size_t i = 0; i < kMaxWsClients; ++i) {
    if (s_ws_clients[i].socket_fd == socket_fd) {
      s_ws_clients[i].last_heartbeat_ms = millis();
      return;
    }
  }
  for (size_t i = 0; i < kMaxWsClients; ++i) {
    if (s_ws_clients[i].socket_fd < 0) {
      s_ws_clients[i].socket_fd = socket_fd;
      s_ws_clients[i].last_heartbeat_ms = millis();
      logf("[CLIWS] client registered fd=%d", socket_fd);
      return;
    }
  }
  log_line("[CLIWS] too many WebSocket clients");
}

void broadcast_heartbeat() {
  if (!s_ws_server) {
    return;
  }
  const unsigned long now = millis();
  for (size_t i = 0; i < kMaxWsClients; ++i) {
    if (s_ws_clients[i].socket_fd < 0) {
      continue;
    }
    if (now - s_ws_clients[i].last_heartbeat_ms > kClientIdleTimeoutMs) {
      logf("[CLIWS] client timeout fd=%d", s_ws_clients[i].socket_fd);
      unregister_client(s_ws_clients[i].socket_fd);
    }
  }
  if (now - s_last_heartbeat_ms < kHeartbeatIntervalMs) {
    return;
  }
  s_last_heartbeat_ms = now;

  char payload[96];
  snprintf(
    payload,
    sizeof(payload),
    "{\"type\":\"heartbeat\",\"uptime_ms\":%lu,\"logs_next\":%lu}",
    static_cast<unsigned long>(now),
    static_cast<unsigned long>(log_sink_next_seq())
  );

  httpd_ws_frame_t frame = {};
  frame.type = HTTPD_WS_TYPE_TEXT;
  frame.payload = reinterpret_cast<uint8_t*>(payload);
  frame.len = strlen(payload);

  for (size_t i = 0; i < kMaxWsClients; ++i) {
    if (s_ws_clients[i].socket_fd < 0) {
      continue;
    }
    esp_err_t err = httpd_ws_send_frame_async(s_ws_server, s_ws_clients[i].socket_fd, &frame);
    if (err != ESP_OK) {
      logf("[CLIWS] heartbeat failed fd=%d err=0x%x", s_ws_clients[i].socket_fd, static_cast<unsigned>(err));
      unregister_client(s_ws_clients[i].socket_fd);
    } else {
      s_ws_clients[i].last_heartbeat_ms = now;
    }
  }
}

esp_err_t cli_ws_handler(httpd_req_t* request) {
  if (request->method == HTTP_GET) {
    log_line("[CLIWS] handshake");
    register_client(request);
    return ESP_OK;
  }

  httpd_ws_frame_t frame = {};
  frame.type = HTTPD_WS_TYPE_TEXT;
  frame.payload = nullptr;

  esp_err_t err = httpd_ws_recv_frame(request, &frame, 0);
  if (err != ESP_OK) {
    logf("[CLIWS] failed to size frame: 0x%x", static_cast<unsigned>(err));
    return err;
  }

  if (frame.len == 0) {
    return ESP_OK;
  }
  if (frame.len > kMaxCommandLength) {
    logf("[CLIWS] command too long (%u)", static_cast<unsigned>(frame.len));
    const char* error_msg = "ERR COMMAND_TOO_LONG";
    httpd_ws_frame_t response = {};
    response.type = HTTPD_WS_TYPE_TEXT;
    response.payload = reinterpret_cast<uint8_t*>(const_cast<char*>(error_msg));
    response.len = strlen(error_msg);
    httpd_ws_send_frame(request, &response);  // best effort
    return ESP_OK;
  }

  uint8_t* payload = reinterpret_cast<uint8_t*>(malloc(frame.len + 1));
  if (!payload) {
    log_line("[CLIWS] out of memory for payload");
    return ESP_ERR_NO_MEM;
  }
  frame.payload = payload;

  err = httpd_ws_recv_frame(request, &frame, frame.len);
  if (err != ESP_OK) {
    logf("[CLIWS] failed to receive frame: 0x%x", static_cast<unsigned>(err));
    free(payload);
    return err;
  }

  if (frame.type == HTTPD_WS_TYPE_CLOSE) {
    const int socket_fd = httpd_req_to_sockfd(request);
    unregister_client(socket_fd);
    free(payload);
    return ESP_OK;
  }

  if (frame.type == HTTPD_WS_TYPE_PING) {
    const unsigned long now = millis();
    const int socket_fd = httpd_req_to_sockfd(request);
    if (socket_fd >= 0) {
      for (size_t i = 0; i < kMaxWsClients; ++i) {
        if (s_ws_clients[i].socket_fd == socket_fd) {
          s_ws_clients[i].last_heartbeat_ms = now;
          break;
        }
      }
    }
    httpd_ws_frame_t pong = {};
    pong.type = HTTPD_WS_TYPE_PONG;
    pong.payload = frame.payload;
    pong.len = frame.len;
    esp_err_t pong_err = httpd_ws_send_frame(request, &pong);
    if (pong_err != ESP_OK) {
      logf("[CLIWS] failed to send pong: 0x%x", static_cast<unsigned>(pong_err));
    }
    free(payload);
    return ESP_OK;
  }

  if (frame.type == HTTPD_WS_TYPE_PONG) {
    const unsigned long now = millis();
    const int socket_fd = httpd_req_to_sockfd(request);
    if (socket_fd >= 0) {
      for (size_t i = 0; i < kMaxWsClients; ++i) {
        if (s_ws_clients[i].socket_fd == socket_fd) {
          s_ws_clients[i].last_heartbeat_ms = now;
          break;
        }
      }
    }
    free(payload);
    return ESP_OK;
  }

  payload[frame.len] = '\0';
  String command(reinterpret_cast<char*>(payload));
  free(payload);
  command.trim();
  if (!command.length()) {
    return ESP_OK;
  }

  logf("[CLIWS] RX '%s'", command.c_str());
  String reply = cli_handle_command_capture(command);
  if (reply.length() == 0) {
    reply = "\n";  // keep WebSocket clients aware of completion
  }

  httpd_ws_frame_t response = {};
  response.type = HTTPD_WS_TYPE_TEXT;
  response.payload = reinterpret_cast<uint8_t*>(const_cast<char*>(reply.c_str()));
  response.len = reply.length();

  err = httpd_ws_send_frame(request, &response);
  if (err != ESP_OK) {
    logf("[CLIWS] failed to send reply: 0x%x", static_cast<unsigned>(err));
  }
  const int socket_fd = httpd_req_to_sockfd(request);
  if (socket_fd >= 0) {
    for (size_t i = 0; i < kMaxWsClients; ++i) {
      if (s_ws_clients[i].socket_fd == socket_fd) {
        s_ws_clients[i].last_heartbeat_ms = millis();
        break;
      }
    }
  }
  return ESP_OK;
}

bool start_server() {
  if (s_ws_server) {
    return true;
  }

  if (!wifi_is_connected()) {
    return false;
  }

  httpd_config_t config = HTTPD_DEFAULT_CONFIG();
  config.server_port = 81;
  config.ctrl_port = 32769;
  config.max_uri_handlers = 4;
  config.recv_wait_timeout = 10;
  config.send_wait_timeout = 10;

  esp_err_t err = httpd_start(&s_ws_server, &config);
  if (err != ESP_OK) {
    logf("[CLIWS] httpd_start failed: 0x%x", static_cast<unsigned>(err));
    s_ws_server = nullptr;
    return false;
  }

  httpd_uri_t uri_config = {};
  uri_config.uri = kCliWsPath;
  uri_config.method = HTTP_GET;
  uri_config.handler = cli_ws_handler;
  uri_config.is_websocket = true;

  err = httpd_register_uri_handler(s_ws_server, &uri_config);
  if (err != ESP_OK) {
    logf("[CLIWS] register handler failed: 0x%x", static_cast<unsigned>(err));
    httpd_stop(s_ws_server);
    s_ws_server = nullptr;
    return false;
  }

  log_line("[CLIWS] WebSocket server started on port 81");
  s_last_heartbeat_ms = 0;
  return true;
}

void stop_server() {
  if (!s_ws_server) {
    return;
  }
  httpd_stop(s_ws_server);
  s_ws_server = nullptr;
  log_line("[CLIWS] WebSocket server stopped");
  reset_clients();
}

}  // namespace

void cli_ws_init() {
  s_ws_server = nullptr;
  reset_clients();
  if (wifi_is_connected()) {
    start_server();
  }
}

void cli_ws_tick() {
  if (wifi_is_connected()) {
    start_server();
    broadcast_heartbeat();
  } else {
    stop_server();
  }
}
