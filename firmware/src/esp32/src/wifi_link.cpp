#include "wifi_link.hpp"
#include "config.hpp"
#include "log_sink.hpp"
#include <Arduino.h>
#include <WiFi.h>

namespace {
constexpr uint32_t kReconnectIntervalMs = 5000;
constexpr uint32_t kStatusLogThrottleMs = 2000;

uint32_t g_lastAttemptMs = 0;
uint32_t g_lastStatusLogMs = 0;
uint32_t g_attemptCounter = 0;
wl_status_t g_lastStatus = WL_NO_SHIELD;
bool g_wifiConfigured = false;

void start_connect_attempt(){
  g_lastAttemptMs = millis();
  ++g_attemptCounter;
  WiFi.disconnect(false /*wifioff*/, false /*erase*/);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  logf("[WiFi] Attempt #%u to connect to '%s'", static_cast<unsigned>(g_attemptCounter), WIFI_SSID);
}

void log_status_change(wl_status_t status){
  uint32_t now = millis();
  if(now - g_lastStatusLogMs < kStatusLogThrottleMs){
    return;
  }
  g_lastStatusLogMs = now;

  switch(status){
  case WL_CONNECTED:
    logf("[WiFi] Connected, IP=%s", WiFi.localIP().toString().c_str());
    break;
  case WL_DISCONNECTED:
    log_line("[WiFi] Disconnected");
    break;
  case WL_CONNECTION_LOST:
    log_line("[WiFi] Connection lost");
    break;
  case WL_CONNECT_FAILED:
    log_line("[WiFi] Connect failed");
    break;
  case WL_IDLE_STATUS:
    log_line("[WiFi] Idle");
    break;
  default:
    logf("[WiFi] Status=%d", static_cast<int>(status));
    break;
  }
}
}  // namespace

void wifi_init(){
  if (!WIFI_SSID || WIFI_SSID[0] == '\0') {
    log_line("[WiFi] WIFI_SSID is empty; skip connection");
    return;
  }

  WiFi.mode(WIFI_STA);
  WiFi.persistent(false);
  WiFi.setAutoReconnect(true);
  WiFi.setSleep(false);
  g_wifiConfigured = true;
  g_lastStatus = WL_NO_SHIELD;
  start_connect_attempt();
}

void wifi_tick(){
  if(!g_wifiConfigured){
    return;
  }

  wl_status_t status = WiFi.status();
  if(status != g_lastStatus){
    log_status_change(status);
    g_lastStatus = status;
  }

  if(status == WL_CONNECTED){
    return;
  }

  uint32_t now = millis();
  if(now - g_lastAttemptMs >= kReconnectIntervalMs){
    start_connect_attempt();
  }
}

bool wifi_is_connected(){
  return WiFi.status() == WL_CONNECTED;
}

IPAddress wifi_local_ip(){
  return WiFi.localIP();
}
