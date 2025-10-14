#include <Arduino.h>
#include "vision_color.hpp"
#include "config.hpp"
#include "log_sink.hpp"
#include "esp_camera.h"
#include "esp32-hal-psram.h"

ColorThresh gThresh;

// Freenove ESP32-S3 WROOM routes the camera like CAMERA_MODEL_ESP32S3_EYE.
static bool camera_setup() {
  camera_config_t config = {};
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer   = LEDC_TIMER_0;
  config.pin_d0       = 11;
  config.pin_d1       = 9;
  config.pin_d2       = 8;
  config.pin_d3       = 10;
  config.pin_d4       = 12;
  config.pin_d5       = 18;
  config.pin_d6       = 17;
  config.pin_d7       = 16;
  config.pin_xclk     = 15;
  config.pin_pclk     = 13;
  config.pin_vsync    = 6;
  config.pin_href     = 7;
  config.pin_sccb_sda = 4;
  config.pin_sccb_scl = 5;
  config.pin_pwdn     = -1;
  config.pin_reset    = -1;
  config.xclk_freq_hz = 10000000; // Stable for OV2640 on this board
  config.pixel_format = PIXFORMAT_RGB565;
  config.frame_size   = FRAMESIZE_QQVGA; // 160x120 keeps detection lightweight
  config.fb_count     = 1;
  config.grab_mode    = CAMERA_GRAB_WHEN_EMPTY;
  config.fb_location  = psramFound() ? CAMERA_FB_IN_PSRAM : CAMERA_FB_IN_DRAM;
  config.jpeg_quality = 12;

  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) {
    logf("[ESP32] Camera init failed (0x%x)", static_cast<uint32_t>(err));
    return false;
  }

  sensor_t* sensor = esp_camera_sensor_get();
  if (!sensor) {
    log_line("[ESP32] Camera sensor handle missing");
    return false;
  }

  sensor->set_framesize(sensor, FRAMESIZE_QQVGA);
  sensor->set_pixformat(sensor, PIXFORMAT_RGB565);
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
  if(fb->format != PIXFORMAT_RGB565){
    logf("[ESP32] Unexpected frame format %d", fb->format);
    esp_camera_fb_return(fb);
    return C_NONE;
  }
  // Sample a central circular ROI ~40x40 px
  const int W = fb->width, H = fb->height;
  const int cx = W/2, cy = H*3/4; // lower center
  int x0=max(0,cx-20), x1=min(W-1,cx+20);
  int y0=max(0,cy-20), y1=min(H-1,cy+20);
  uint32_t cnt=0, nR=0, nG=0, nB=0, nY=0, nW=0, nK=0;
  for(int y=y0;y<=y1;y++){
    uint16_t* row = (uint16_t*)(fb->buf + y*fb->width*2);
    for(int x=x0;x<=x1;x++){
      uint16_t px = row[x];
      uint8_t r = ((px>>11)&0x1F)<<3;
      uint8_t g = ((px>>5)&0x3F)<<2;
      uint8_t b = (px&0x1F)<<3;
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
  esp_camera_fb_return(fb);
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