#include <Arduino.h>
#include "vision_color.hpp"
#include "config.hpp"
#include "camera_http.hpp"
#include "esp_camera.h"
#include "esp32-hal-psram.h"
#include "img_converters.h"
#include "esp_heap_caps.h"

ColorThresh gThresh;

// Freenove ESP32-S3 WROOM routes the camera like CAMERA_MODEL_ESP32S3_EYE.
static bool camera_setup() {
  camera_config_t base = {};
  base.ledc_channel = LEDC_CHANNEL_0;
  base.ledc_timer   = LEDC_TIMER_0;
  base.pin_d0       = 11;
  base.pin_d1       = 9;
  base.pin_d2       = 8;
  base.pin_d3       = 10;
  base.pin_d4       = 12;
  base.pin_d5       = 18;
  base.pin_d6       = 17;
  base.pin_d7       = 16;
  base.pin_xclk     = 15;
  base.pin_pclk     = 13;
  base.pin_vsync    = 6;
  base.pin_href     = 7;
  base.pin_sccb_sda = 4;
  base.pin_sccb_scl = 5;
  base.pin_pwdn     = -1;
  base.pin_reset    = -1;
  base.xclk_freq_hz = 10000000; // Stable for OV2640 on this board
  base.pixel_format = PIXFORMAT_JPEG;
  base.fb_count     = 1;
  base.grab_mode    = CAMERA_GRAB_WHEN_EMPTY;
  base.jpeg_quality = 12;

  const bool psramReady = (psramInit() && psramFound());
  base.fb_location = psramReady ? CAMERA_FB_IN_PSRAM : CAMERA_FB_IN_DRAM;

  static constexpr framesize_t kFrameCandidates[] = {
    FRAMESIZE_UXGA,
    FRAMESIZE_SXGA,
    FRAMESIZE_XGA,
    FRAMESIZE_SVGA,
    FRAMESIZE_VGA,
    FRAMESIZE_QVGA,
    FRAMESIZE_QQVGA,
  };

  framesize_t selected = FRAMESIZE_QQVGA;
  bool initialized = false;

  for (framesize_t candidate : kFrameCandidates) {
  const bool requiresPsram = candidate >= FRAMESIZE_VGA;
    if (!psramReady && requiresPsram) {
      continue;
    }

    camera_config_t attempt = base;
    attempt.frame_size = candidate;
    esp_err_t err = esp_camera_init(&attempt);
    if (err != ESP_OK) {
      Serial.printf(
        "[ESP32] Camera init failed for base frame %d (err=0x%x)\n",
        static_cast<int>(candidate),
        static_cast<uint32_t>(err)
      );
      continue;
    }

    camera_fb_t* fb = esp_camera_fb_get();
    if (!fb) {
        Serial.printf("[Vision] Initial test frame %ux%u, len=%u\n", fb->width, fb->height, (unsigned)fb->len);
      Serial.printf(
        "[ESP32] Camera init produced no frame for base frame %d\n",
        static_cast<int>(candidate)
      );
      esp_camera_deinit();
      continue;
    }
    esp_camera_fb_return(fb);

    selected = candidate;
    initialized = true;
    const char* label = camera_http_resolution_name(candidate);
    Serial.printf(
      "[ESP32] Camera buffers provisioned for base frame %s (%d) (psram=%s)\n",
      label ? label : "?",
      static_cast<int>(candidate),
      psramReady ? "yes" : "no"
    );
    break;
  }

  if (!initialized) {
    Serial.println("[ESP32] Camera init failed for all candidate frame sizes");
    return false;
  }

  camera_http_set_supported_max_resolution(selected);

  sensor_t* sensor = esp_camera_sensor_get();
  if (!sensor) {
    Serial.println("[ESP32] Camera sensor handle missing");
    return false;
  }

  sensor->set_framesize(sensor, FRAMESIZE_QQVGA);
  sensor->set_pixformat(sensor, PIXFORMAT_JPEG);
  sensor->set_vflip(sensor, 1);   // Module mounted upside-down
  sensor->set_hmirror(sensor, 0);
  sensor->set_brightness(sensor, 1);
  sensor->set_saturation(sensor, 0);

  return true;
}

bool cam_init(){
  return camera_setup();
}

static void rgb2hsv(uint8_t r, uint8_t g, uint8_t b, uint8_t& h, uint8_t& s, uint8_t& v){
  uint8_t maxc = max(r, max(g,b));
  uint8_t minc = min(r, min(g,b));
  v = maxc;
  uint8_t delta = maxc - minc;
  s = (maxc==0) ? 0 : (uint8_t)(255UL*delta/maxc);
  if(delta==0){ h=0; return; }
  int16_t hh;
  if(maxc==r) hh = 43 * (g - b) / delta;
  else if(maxc==g) hh = 85 + 43 * (b - r) / delta;
  else hh = 171 + 43 * (r - g) / delta;
  if(hh<0) hh += 255;
  h = (uint8_t)hh;
}

static bool inRange(const HSVRange& R, uint8_t h,uint8_t s,uint8_t v){
  return (h>=R.hmin && h<=R.hmax && s>=R.smin && s<=R.smax && v>=R.vmin && v<=R.vmax);
}

ColorID detect_cylinder_color(){
  if(esp_camera_sensor_get() == nullptr) return C_NONE;
  camera_fb_t* fb = esp_camera_fb_get();
  if(!fb) return C_NONE;

  const int W = fb->width;
  const int H = fb->height;
  const size_t rgbSize = static_cast<size_t>(W) * static_cast<size_t>(H) * 3;
  uint8_t* rgb = static_cast<uint8_t*>(heap_caps_malloc(rgbSize, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
  if(!rgb){
    Serial.println("[ESP32] detect_cylinder_color: RGB buffer alloc failed");
    esp_camera_fb_return(fb);
    return C_NONE;
  }

  if(!fmt2rgb888(fb->buf, fb->len, fb->format, rgb)){
    Serial.printf("[ESP32] detect_cylinder_color: fmt2rgb888 failed (fmt=%d)\n", fb->format);
    heap_caps_free(rgb);
    esp_camera_fb_return(fb);
    return C_NONE;
  }
  esp_camera_fb_return(fb);

  // Sample a central circular ROI ~40x40 px
  const int cx = W/2, cy = H*3/4; // lower center
  int x0=max(0,cx-20), x1=min(W-1,cx+20);
  int y0=max(0,cy-20), y1=min(H-1,cy+20);
  uint32_t cnt=0, nR=0, nG=0, nB=0, nY=0, nW=0, nK=0;
  for(int y=y0;y<=y1;y++){
    uint8_t* row = rgb + static_cast<size_t>(y) * W * 3;
    for(int x=x0;x<=x1;x++){
      uint8_t* px = row + x*3;
      uint8_t r = px[0];
      uint8_t g = px[1];
      uint8_t b = px[2];
      uint8_t h,s,v; rgb2hsv(r,g,b,h,s,v);
      cnt++;
      if(inRange(gThresh.R,h,s,v) || inRange(gThresh.R2,h,s,v)) nR++;
      else if(inRange(gThresh.G,h,s,v)) nG++;
      else if(inRange(gThresh.B,h,s,v)) nB++;
      else if(inRange(gThresh.Y,h,s,v)) nY++;
      else if(inRange(gThresh.W,h,s,v)) nW++;
      else if(inRange(gThresh.K,h,s,v)) nK++;
    }
  }
  heap_caps_free(rgb);
  uint32_t best = max({nR,nG,nB,nY,nW,nK});
  if(best < cnt/10) return C_NONE; // too uncertain
  if(best==nR) return C_RED;
  if(best==nG) return C_GREEN;
  if(best==nB) return C_BLUE;
  if(best==nY) return C_YELLOW;
  if(best==nW) return C_WHITE;
  if(best==nK) return C_BLACK;
  return C_NONE;
}