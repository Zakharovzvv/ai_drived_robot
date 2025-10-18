#pragma once

#include <esp_camera.h>

namespace camera_pins {

constexpr int kPinPwdn = -1;
constexpr int kPinReset = -1;
constexpr int kPinXclk = 15;
constexpr int kPinSiod = 4;
constexpr int kPinSioc = 5;
constexpr int kPinY2 = 11;
constexpr int kPinY3 = 9;
constexpr int kPinY4 = 8;
constexpr int kPinY5 = 10;
constexpr int kPinY6 = 12;
constexpr int kPinY7 = 18;
constexpr int kPinY8 = 17;
constexpr int kPinY9 = 16;
constexpr int kPinVsync = 6;
constexpr int kPinHref = 7;
constexpr int kPinPclk = 13;

inline void assign(camera_config_t& config) {
  config.pin_pwdn = kPinPwdn;
  config.pin_reset = kPinReset;
  config.pin_xclk = kPinXclk;
  config.pin_sccb_sda = kPinSiod;
  config.pin_sccb_scl = kPinSioc;
  config.pin_d0 = kPinY2;
  config.pin_d1 = kPinY3;
  config.pin_d2 = kPinY4;
  config.pin_d3 = kPinY5;
  config.pin_d4 = kPinY6;
  config.pin_d5 = kPinY7;
  config.pin_d6 = kPinY8;
  config.pin_d7 = kPinY9;
  config.pin_vsync = kPinVsync;
  config.pin_href = kPinHref;
  config.pin_pclk = kPinPclk;
}

}  // namespace camera_pins
