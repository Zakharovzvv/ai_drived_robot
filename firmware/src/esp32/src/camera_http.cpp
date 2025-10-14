#include "camera_http.hpp"
#include "config.hpp"
#include "log_sink.hpp"
#include "wifi_link.hpp"

#include <Arduino.h>
#include <esp_camera.h>
#include <esp_http_server.h>
#include <img_converters.h>
#include <strings.h>

namespace {
httpd_handle_t s_httpd = nullptr;
constexpr char kSnapshotUri[] = "/camera/snapshot";
constexpr uint8_t kDefaultJpegQuality = 12;
constexpr framesize_t kDefaultFrameSize = FRAMESIZE_QQVGA;
constexpr uint8_t kMinJpegQuality = 10;
constexpr uint8_t kMaxJpegQuality = 63;

struct ResolutionEntry {
  framesize_t value;
  const char* name;
};

const ResolutionEntry kResolutionTable[] = {
  {FRAMESIZE_QQVGA, "QQVGA"},   // 160x120
  {FRAMESIZE_QVGA, "QVGA"},     // 320x240
  {FRAMESIZE_VGA, "VGA"},       // 640x480
  {FRAMESIZE_SVGA, "SVGA"},     // 800x600
  {FRAMESIZE_XGA, "XGA"},       // 1024x768
  {FRAMESIZE_SXGA, "SXGA"},     // 1280x1024
  {FRAMESIZE_UXGA, "UXGA"},     // 1600x1200
};

CameraHttpConfig s_config{ kDefaultFrameSize, kDefaultJpegQuality };
size_t s_max_resolution_index = 0;

size_t resolution_count() {
  return sizeof(kResolutionTable) / sizeof(kResolutionTable[0]);
}

int find_resolution_index(framesize_t size) {
  for (size_t i = 0; i < resolution_count(); ++i) {
    if (kResolutionTable[i].value == size) {
      return static_cast<int>(i);
    }
  }
  return -1;
}

const ResolutionEntry* find_resolution(framesize_t size) {
  for (const auto& entry : kResolutionTable) {
    if (entry.value == size) {
      return &entry;
    }
  }
  return nullptr;
}

const ResolutionEntry* find_resolution(const char* name) {
  if (!name) {
    return nullptr;
  }
  for (const auto& entry : kResolutionTable) {
    if (strcasecmp(entry.name, name) == 0) {
      return &entry;
    }
  }
  return nullptr;
}

esp_err_t snapshot_handler(httpd_req_t* req) {
  if (!wifi_is_connected()) {
    httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "WiFi disconnected");
    return ESP_FAIL;
  }

  camera_fb_t* fb = esp_camera_fb_get();
  if (!fb) {
    httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Camera capture failed");
    return ESP_FAIL;
  }

  uint8_t* jpg = fb->buf;
  size_t jpg_len = fb->len;
  bool allocated = false;

  if (fb->format != PIXFORMAT_JPEG) {
    if (!frame2jpg(fb, s_config.jpeg_quality, &jpg, &jpg_len)) {
      esp_camera_fb_return(fb);
      httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "JPEG convert failed");
      return ESP_FAIL;
    }
    allocated = (jpg != fb->buf);
  }

  httpd_resp_set_type(req, "image/jpeg");
  // Report actual framebuffer size for diagnostics
  char size_hdr[64];
  snprintf(size_hdr, sizeof(size_hdr), "%ux%u", fb->width, fb->height);
  httpd_resp_set_hdr(req, "X-Frame-Size", size_hdr);
  logf("[CameraHTTP] Serving snapshot %ux%u, len=%u", fb->width, fb->height, static_cast<unsigned>(jpg_len));
  httpd_resp_set_hdr(req, "Cache-Control", "no-cache, no-store, must-revalidate");
  httpd_resp_set_hdr(req, "Pragma", "no-cache");
  httpd_resp_set_hdr(req, "Expires", "0");
  esp_err_t res = httpd_resp_send(req, reinterpret_cast<const char*>(jpg), jpg_len);

  if (allocated && jpg) {
    free(jpg);
  }
  esp_camera_fb_return(fb);
  return res;
}

httpd_uri_t snapshot_uri_config() {
  httpd_uri_t uri = {};
  uri.uri = kSnapshotUri;
  uri.method = HTTP_GET;
  uri.handler = snapshot_handler;
  uri.user_ctx = nullptr;
  return uri;
}

}  // namespace

void camera_http_init() {
  camera_http_stop();
  s_config.frame_size = kDefaultFrameSize;
  s_config.jpeg_quality = kDefaultJpegQuality;
  int idx = find_resolution_index(kDefaultFrameSize);
  s_max_resolution_index = idx >= 0 ? static_cast<size_t>(idx) : 0;
}

bool camera_http_sync_sensor() {
  sensor_t* sensor = esp_camera_sensor_get();
  if (!sensor) {
    return false;
  }
  sensor->set_quality(sensor, s_config.jpeg_quality);
  sensor->set_framesize(sensor, s_config.frame_size);
  return true;
}

bool camera_http_start() {
  if (s_httpd != nullptr) {
    return true;
  }

  if (!wifi_is_connected()) {
    log_line("[CameraHTTP] WiFi not connected; cannot start server");
    return false;
  }

  camera_http_sync_sensor();

  httpd_config_t config = HTTPD_DEFAULT_CONFIG();
  config.max_uri_handlers = 4;
  config.uri_match_fn = httpd_uri_match_wildcard;

  esp_err_t err = httpd_start(&s_httpd, &config);
  if (err != ESP_OK) {
    logf("[CameraHTTP] httpd_start failed: 0x%x", static_cast<unsigned>(err));
    s_httpd = nullptr;
    return false;
  }

  httpd_uri_t snapshot_uri = snapshot_uri_config();
  err = httpd_register_uri_handler(s_httpd, &snapshot_uri);
  if (err != ESP_OK) {
    logf("[CameraHTTP] register snapshot handler failed: 0x%x", static_cast<unsigned>(err));
    camera_http_stop();
    return false;
  }

  log_line("[CameraHTTP] HTTP snapshot server started");
  return true;
}

void camera_http_stop() {
  if (s_httpd) {
    httpd_stop(s_httpd);
    s_httpd = nullptr;
    log_line("[CameraHTTP] HTTP snapshot server stopped");
  }
}

bool camera_http_is_running() {
  return s_httpd != nullptr;
}

CameraHttpConfig camera_http_get_config() {
  return s_config;
}

bool camera_http_set_quality(uint8_t quality) {
  if (quality < kMinJpegQuality) {
    quality = kMinJpegQuality;
  }
  if (quality > kMaxJpegQuality) {
    quality = kMaxJpegQuality;
  }
  sensor_t* sensor = esp_camera_sensor_get();
  if (sensor) {
    if (sensor->set_quality(sensor, quality) != 0) {
      return false;
    }
  }
  s_config.jpeg_quality = quality;
  return true;
}

bool camera_http_set_resolution(framesize_t frame_size) {
  const ResolutionEntry* entry = find_resolution(frame_size);
  if (!entry) {
    return false;
  }
  int idx = find_resolution_index(frame_size);
  if (idx < 0) {
    return false;
  }
  if (static_cast<size_t>(idx) > s_max_resolution_index) {
    return false;
  }
  sensor_t* sensor = esp_camera_sensor_get();
  if (sensor) {
    if (sensor->set_framesize(sensor, frame_size) != 0) {
      return false;
    }
  }
  s_config.frame_size = frame_size;
  return true;
}

bool camera_http_lookup_resolution(const char* name, framesize_t* out) {
  if (!out) {
    return false;
  }
  const ResolutionEntry* entry = find_resolution(name);
  if (!entry) {
    return false;
  }
  *out = entry->value;
  return true;
}

bool camera_http_set_resolution_by_name(const char* name) {
  framesize_t value = s_config.frame_size;
  if (!camera_http_lookup_resolution(name, &value)) {
    return false;
  }
  return camera_http_set_resolution(value);
}

const char* camera_http_resolution_name(framesize_t frame_size) {
  const ResolutionEntry* entry = find_resolution(frame_size);
  return entry ? entry->name : "UNKNOWN";
}

void camera_http_set_supported_max_resolution(framesize_t frame_size) {
  int idx = find_resolution_index(frame_size);
  if (idx < 0) {
    idx = find_resolution_index(kDefaultFrameSize);
  }
  if (idx < 0) {
    idx = 0;
  }
  s_max_resolution_index = static_cast<size_t>(idx);
}

framesize_t camera_http_get_supported_max_resolution() {
  return kResolutionTable[s_max_resolution_index].value;
}
