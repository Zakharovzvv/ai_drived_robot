#include "wifi_link.hpp"
#include "config.hpp"
#include "log_sink.hpp"
#include <Arduino.h>
#include <WiFi.h>
extern "C" {
#include <esp_wifi.h>
}

namespace {
constexpr uint32_t kReconnectIntervalMs = 5000;
constexpr uint32_t kStatusLogThrottleMs = 2000;

constexpr wifi_country_t kCountryRU = {"RU", 1, 13, WIFI_COUNTRY_POLICY_MANUAL};

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
    logf(
        "[WiFi] Connected, IP=%s, RSSI=%d dBm, channel=%d",
        WiFi.localIP().toString().c_str(),
        WiFi.RSSI(),
        WiFi.channel());
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
  WiFi.persistent(true);
  WiFi.setAutoReconnect(true);
  WiFi.setSleep(false);
  esp_wifi_set_country(&kCountryRU);
  esp_wifi_set_ps(WIFI_PS_NONE);
  esp_wifi_set_bandwidth(WIFI_IF_STA, WIFI_BW_HT20);
  esp_wifi_set_protocol(WIFI_IF_STA, WIFI_PROTOCOL_11B | WIFI_PROTOCOL_11G | WIFI_PROTOCOL_11N);
  esp_wifi_set_max_tx_power(78);  // ≈19.5 dBm; keep within local regulations.
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
