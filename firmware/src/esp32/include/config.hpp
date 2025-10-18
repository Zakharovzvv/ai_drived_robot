#pragma once
// ====== ESP32-S3 Master Config (pins, ICD addresses, thresholds) ======

// WiFi credentials must be supplied via build flags (see platformio.ini)
#ifndef WIFI_SSID
#error "WIFI_SSID is not defined; configure it via platformio.ini build_flags"
#endif
#ifndef WIFI_PASSWORD
#error "WIFI_PASSWORD is not defined; configure it via platformio.ini build_flags"
#endif

// I2C to UNO
#define I2C_SDA  8   // adjust to your wiring if needed
#define I2C_SCL  9
#define I2C_ADDR_UNO 0x12
#define I2C_FREQ 400000

// ICD addresses (see ICD doc v0.3)
namespace ICD {
  // Commands (ESP32 -> UNO)
  constexpr uint8_t DRIVE  = 0x00; // 8 bytes
  constexpr uint8_t ELEV   = 0x10; // 6 bytes
  constexpr uint8_t GRIP   = 0x18; // 4 bytes
  constexpr uint8_t BRAKE  = 0x1C; // 1 byte
  constexpr uint8_t HOME   = 0x1D; // 1 byte
  constexpr uint8_t SEQ    = 0x1E; // 1 byte
  constexpr uint8_t APPLY  = 0x1F; // 1 byte

  // Telemetry (UNO -> ESP32)
  constexpr uint8_t STATUS0= 0x40; // 4 bytes
  constexpr uint8_t STATUS1= 0x44; // 4 bytes
  constexpr uint8_t LINES  = 0x48; // 6 bytes
  constexpr uint8_t POWER  = 0x4E; // 4 bytes
  constexpr uint8_t DRIVEFB= 0x50; // 8 bytes
  constexpr uint8_t AUXFB  = 0x58; // 4 bytes
  constexpr uint8_t SENS   = 0x5C; // 4 bytes
  constexpr uint8_t ODOM   = 0x62; // 8 bytes

  // Config (rw; apply by SEQ)
  constexpr uint8_t CFG_LINE=0x70; // 2 bytes
  constexpr uint8_t CFG_LIFT=0x72; // 8 bytes
  constexpr uint8_t CFG_GRIP=0x7A; // 8 bytes
  constexpr uint8_t CFG_ODO =0x82; // 10 bytes
}

// HSV thresholds (tune on your lighting)
struct HSVRange { uint8_t hmin,hmax,smin,smax,vmin,vmax; };
struct ColorThresh {
  HSVRange R{0,15,  80,255, 40,255};     // red low
  HSVRange R2{220,255, 80,255, 40,255};  // red high wrap
  HSVRange G{60,95,  50,255, 40,255};
  HSVRange B{100,135,50,255, 40,255};
  HSVRange Y{20,45,  60,255, 50,255};
  HSVRange W{0,255,  0,40,   200,255};   // low sat, high value
  HSVRange K{0,255,  0,255,  0,40};      // low value
};
extern ColorThresh gThresh;

// Shelf map (fixed by rules). Stored in NVS. 3x3 rows bottom..top, columns left..right.
enum ColorID : uint8_t { C_NONE=0, C_RED, C_GREEN, C_BLUE, C_YELLOW, C_WHITE, C_BLACK };