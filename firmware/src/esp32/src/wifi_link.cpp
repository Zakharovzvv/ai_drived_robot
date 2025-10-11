#include "wifi_link.hpp"
#include "config.hpp"
#include <Arduino.h>
#include <WiFi.h>

namespace {
constexpr uint32_t kConnectTimeoutMs = 15000;
}

void wifi_init(){
  if (!WIFI_SSID || WIFI_SSID[0] == '\0') {
    Serial.println("[WiFi] WIFI_SSID is empty; skip connection");
    return;
  }
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.printf("[WiFi] Connecting to '%s'\n", WIFI_SSID);
  uint32_t start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < kConnectTimeoutMs) {
    delay(250);
    Serial.print('.');
  }
  Serial.println();
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("[WiFi] Connected, IP=%s\n", WiFi.localIP().toString().c_str());
    WiFi.setSleep(false);
  } else {
    Serial.println("[WiFi] Connection timed out");
  }
}

bool wifi_is_connected(){
  return WiFi.status() == WL_CONNECTED;
}

IPAddress wifi_local_ip(){
  return WiFi.localIP();
}
