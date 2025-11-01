#include "i2c_link.hpp"
#include "log_sink.hpp"
#include "camera_pins.hpp"

#include <cstring>

static TwoWire& g_i2c_bus = Wire;

namespace {

static uint32_t g_i2c_current_hz = 0;
static uint32_t g_i2c_primary_hz = I2C_FREQ;
static uint32_t g_i2c_fallback_hz = I2C_FREQ_FALLBACK;
static bool g_i2c_fallback_announced = false;
static bool g_i2c_using_fallback = false;
static uint8_t g_last_ping_error = 0xFF;
static uint8_t g_last_write_err_reg = 0xFF;
static uint8_t g_last_write_err_code = 0xFF;
static uint8_t g_last_read_err_reg = 0xFF;
static uint8_t g_last_read_err_code = 0xFF;
static bool g_i2c_ready = false;

void apply_i2c_frequency(uint32_t hz, bool announce = true){
  if(hz == 0){
    return;
  }
  if(g_i2c_current_hz == hz){
    g_i2c_using_fallback = (g_i2c_fallback_hz && hz == g_i2c_fallback_hz && g_i2c_fallback_hz != g_i2c_primary_hz);
    return;
  }
  if(g_i2c_ready){
    g_i2c_bus.setClock(hz);
  }
  g_i2c_current_hz = hz;
  g_i2c_using_fallback = (g_i2c_fallback_hz && hz == g_i2c_fallback_hz && g_i2c_fallback_hz != g_i2c_primary_hz);
  if(announce && g_i2c_ready){
    logf(
      "[I2C] clock set to %lu Hz (%s)",
      static_cast<unsigned long>(g_i2c_current_hz),
      g_i2c_using_fallback ? "fallback" : "primary"
    );
  }
}

void log_ping_error(uint8_t err){
  if(err == g_last_ping_error){
    return;
  }
  g_last_ping_error = err;
  if(err == 0){
    logf(
      "[I2C] ping ok @ %lu Hz%s",
      static_cast<unsigned long>(g_i2c_current_hz),
      g_i2c_using_fallback ? " (fallback)" : ""
    );
  }else{
    logf(
      "[I2C] ping err=%u @ %lu Hz%s",
      static_cast<unsigned>(err),
      static_cast<unsigned long>(g_i2c_current_hz),
      g_i2c_using_fallback ? " (fallback)" : ""
    );
  }
}

void maybe_switch_to_fallback(uint8_t err){
  if(err == 0){
    return;
  }
  if(!g_i2c_fallback_hz || g_i2c_fallback_hz == g_i2c_primary_hz){
    return;
  }
  if(g_i2c_current_hz == g_i2c_fallback_hz){
    return;
  }
  apply_i2c_frequency(g_i2c_fallback_hz);
  if(!g_i2c_fallback_announced){
    logf(
      "[I2C] fallback frequency %lu Hz after err=%u",
      static_cast<unsigned long>(g_i2c_fallback_hz),
      static_cast<unsigned>(err)
    );
    g_i2c_fallback_announced = true;
  }
}

void maybe_restore_primary_frequency(){
  if(!g_i2c_primary_hz){
    return;
  }
  if(g_i2c_current_hz == g_i2c_primary_hz){
    return;
  }
  apply_i2c_frequency(g_i2c_primary_hz);
  if(g_i2c_fallback_announced){
    log_line("[I2C] restored primary frequency after successful transaction");
    g_i2c_fallback_announced = false;
  }
}

bool finalize_register_select(uint8_t err){
  if(err == 0){
    return true;
  }
  maybe_switch_to_fallback(err);
  return false;
}

constexpr bool camera_uses_pin(int pin){
  return pin == camera_pins::kPinPwdn || pin == camera_pins::kPinReset || pin == camera_pins::kPinXclk ||
         pin == camera_pins::kPinSiod || pin == camera_pins::kPinSioc || pin == camera_pins::kPinY2 ||
         pin == camera_pins::kPinY3 || pin == camera_pins::kPinY4 || pin == camera_pins::kPinY5 ||
         pin == camera_pins::kPinY6 || pin == camera_pins::kPinY7 || pin == camera_pins::kPinY8 ||
         pin == camera_pins::kPinY9 || pin == camera_pins::kPinVsync || pin == camera_pins::kPinHref ||
         pin == camera_pins::kPinPclk;
}

static_assert(!camera_uses_pin(I2C_SDA), "I2C SDA pin conflicts with camera wiring");
static_assert(!camera_uses_pin(I2C_SCL), "I2C SCL pin conflicts with camera wiring");

}  // namespace

TwoWire& i2c_bus(){
  return g_i2c_bus;
}

bool i2c_init(){
  g_i2c_ready = false;
  g_last_ping_error = 0xFF;
  g_last_write_err_reg = 0xFF;
  g_last_write_err_code = 0xFF;
  g_last_read_err_reg = 0xFF;
  g_last_read_err_code = 0xFF;
  g_i2c_fallback_announced = false;
  i2c_reset_frequencies(false);

  if(!g_i2c_bus.begin(I2C_SDA, I2C_SCL, g_i2c_primary_hz)){
    logf("[I2C] begin failed (SDA=%d SCL=%d)", I2C_SDA, I2C_SCL);
    return false;
  }

  delay(100);
  g_i2c_ready = true;
  apply_i2c_frequency(g_i2c_primary_hz);
  logf(
    "[I2C] init complete (primary=%lu Hz fallback=%lu Hz)",
    static_cast<unsigned long>(g_i2c_primary_hz),
    static_cast<unsigned long>(g_i2c_fallback_hz)
  );
  return true;
}

bool i2c_is_ready(){
  return g_i2c_ready;
}

bool i2c_ping_uno(){
  if(!g_i2c_ready){
    if(g_last_ping_error != 0xFE){
      g_last_ping_error = 0xFE;
      log_line("[I2C] ping skipped (bus not ready)");
    }
    return false;
  }
  g_i2c_bus.beginTransmission(I2C_ADDR_UNO);
  uint8_t err = g_i2c_bus.endTransmission();
  log_ping_error(err);
  if(err == 0){
    maybe_restore_primary_frequency();
  }else{
    maybe_switch_to_fallback(err);
  }
  return (err == 0);
}

static bool write_reg(uint8_t reg, const uint8_t* buf, size_t n){
  if(!g_i2c_ready){
    if(!(g_last_write_err_reg == reg && g_last_write_err_code == 0xFD)){
      g_last_write_err_reg = reg;
      g_last_write_err_code = 0xFD;
      logf("[I2C] write skipped (bus not ready) reg=0x%02X", static_cast<unsigned>(reg));
    }
    return false;
  }
  g_i2c_bus.beginTransmission(I2C_ADDR_UNO);
  g_i2c_bus.write(reg);
  g_i2c_bus.write(buf, n);
  uint8_t err = g_i2c_bus.endTransmission();
  if(err != 0){
    if(!(g_last_write_err_reg == reg && g_last_write_err_code == err)){
      g_last_write_err_reg = reg;
      g_last_write_err_code = err;
      logf(
        "[I2C] write err=%u reg=0x%02X @ %lu Hz",
        static_cast<unsigned>(err),
        static_cast<unsigned>(reg),
        static_cast<unsigned long>(g_i2c_current_hz)
      );
    }
    maybe_switch_to_fallback(err);
    return false;
  }
  g_last_write_err_reg = 0xFF;
  g_last_write_err_code = 0xFF;
  maybe_restore_primary_frequency();
  return true;
}

static bool read_reg(uint8_t reg, uint8_t* buf, size_t n){
  if(!g_i2c_ready){
    if(!(g_last_read_err_reg == reg && g_last_read_err_code == 0xFD)){
      g_last_read_err_reg = reg;
      g_last_read_err_code = 0xFD;
      logf("[I2C] read skipped (bus not ready) reg=0x%02X", static_cast<unsigned>(reg));
    }
    return false;
  }
  g_i2c_bus.beginTransmission(I2C_ADDR_UNO);
  g_i2c_bus.write(reg);
  uint8_t err = g_i2c_bus.endTransmission(false);
  if(!finalize_register_select(err)){
    if(err != 0 && !(g_last_read_err_reg == reg && g_last_read_err_code == err)){
      g_last_read_err_reg = reg;
      g_last_read_err_code = err;
      logf(
        "[I2C] read err=%u reg=0x%02X @ %lu Hz",
        static_cast<unsigned>(err),
        static_cast<unsigned>(reg),
        static_cast<unsigned long>(g_i2c_current_hz)
      );
    }
    return false;
  }
  size_t r = g_i2c_bus.requestFrom(static_cast<uint8_t>(I2C_ADDR_UNO), static_cast<uint8_t>(n), static_cast<uint8_t>(true));
  if(r != n){
    if(!(g_last_read_err_reg == reg && g_last_read_err_code == 0xFE)){
      g_last_read_err_reg = reg;
      g_last_read_err_code = 0xFE;
      logf(
        "[I2C] read short reg=0x%02X got=%u expected=%u",
        static_cast<unsigned>(reg),
        static_cast<unsigned>(r),
        static_cast<unsigned>(n)
      );
    }
    maybe_switch_to_fallback(0xFE);
    return false;
  }
  g_last_read_err_reg = 0xFF;
  g_last_read_err_code = 0xFF;
  for(size_t i = 0; i < n; ++i){
    buf[i] = g_i2c_bus.read();
  }
  maybe_restore_primary_frequency();
  return true;
}

bool i2c_read(uint8_t addr, uint8_t* buf, size_t n){ return read_reg(addr, buf, n); }
bool i2c_write(uint8_t addr, const uint8_t* buf, size_t n){ return write_reg(addr, buf, n); }

bool i2c_cmd_drive(int16_t vx,int16_t vy,int16_t w,int16_t t_ms){
  uint8_t b[8];
  memcpy(b + 0, &vx, 2);
  memcpy(b + 2, &vy, 2);
  memcpy(b + 4, &w, 2);
  memcpy(b + 6, &t_ms, 2);
  return write_reg(ICD::DRIVE, b, 8);
}

bool i2c_cmd_elev(int16_t h_mm,int16_t v_mmps,uint8_t mode){
  uint8_t b[6];
  memcpy(b + 0, &h_mm, 2);
  memcpy(b + 2, &v_mmps, 2);
  b[4] = mode;
  b[5] = 0;
  return write_reg(ICD::ELEV, b, 6);
}

bool i2c_cmd_grip(uint8_t cmd,int16_t arg_deg){
  uint8_t b[4];
  b[0] = cmd;
  memcpy(b + 1, &arg_deg, 2);
  b[3] = 0;
  return write_reg(ICD::GRIP, b, 4);
}

bool i2c_cfg_line(uint16_t thr){
  return write_reg(ICD::CFG_LINE, reinterpret_cast<uint8_t*>(&thr), 2);
}

bool i2c_cfg_lift(uint16_t enc_per_mm,int16_t h1,int16_t h2,int16_t h3){
  uint8_t b[8];
  memcpy(b + 0, &enc_per_mm, 2);
  memcpy(b + 2, &h1, 2);
  memcpy(b + 4, &h2, 2);
  memcpy(b + 6, &h3, 2);
  return write_reg(ICD::CFG_LIFT, b, 8);
}

bool i2c_cfg_grip(int16_t enc_zero,uint16_t enc_per_deg_q12,int16_t deg_min,int16_t deg_max){
  uint8_t b[8];
  memcpy(b + 0, &enc_zero, 2);
  memcpy(b + 2, &enc_per_deg_q12, 2);
  memcpy(b + 4, &deg_min, 2);
  memcpy(b + 6, &deg_max, 2);
  return write_reg(ICD::CFG_GRIP, b, 8);
}

bool i2c_cfg_odo(uint16_t cpr,uint16_t gear_num,uint16_t gear_den,uint16_t wheel_mm,uint16_t track_mm){
  uint8_t b[10];
  memcpy(b + 0, &cpr, 2);
  memcpy(b + 2, &gear_num, 2);
  memcpy(b + 4, &gear_den, 2);
  memcpy(b + 6, &wheel_mm, 2);
  memcpy(b + 8, &track_mm, 2);
  return write_reg(ICD::CFG_ODO, b, 10);
}

bool i2c_seq(){
  uint8_t b = 1;
  return write_reg(ICD::SEQ, &b, 1);
}

bool read_STATUS0(Status0& o){ return read_reg(ICD::STATUS0, reinterpret_cast<uint8_t*>(&o), 4); }
bool read_STATUS1(Status1& o){ return read_reg(ICD::STATUS1, reinterpret_cast<uint8_t*>(&o), 4); }
bool read_LINES(Lines& o){ return read_reg(ICD::LINES, reinterpret_cast<uint8_t*>(&o), 6); }
bool read_POWER(Power& o){ return read_reg(ICD::POWER, reinterpret_cast<uint8_t*>(&o), 4); }
bool read_DRIVEFB(DriveFB& o){ return read_reg(ICD::DRIVEFB, reinterpret_cast<uint8_t*>(&o), 8); }
bool read_AUXFB(AuxFB& o){ return read_reg(ICD::AUXFB, reinterpret_cast<uint8_t*>(&o), 4); }
bool read_SENS(Sens& o){ return read_reg(ICD::SENS, reinterpret_cast<uint8_t*>(&o), 4); }
bool read_ODOM(Odom& o){ return read_reg(ICD::ODOM, reinterpret_cast<uint8_t*>(&o), 8); }

}  // namespace

I2CDiagnostics i2c_get_diagnostics(){
  I2CDiagnostics diag{};
  diag.ready = g_i2c_ready;
  diag.primary_hz = g_i2c_primary_hz;
  diag.fallback_hz = g_i2c_fallback_hz;
  diag.current_hz = g_i2c_current_hz;
  diag.using_fallback = g_i2c_using_fallback;
  diag.last_ping_err = g_last_ping_error;
  diag.last_write_err_reg = g_last_write_err_reg;
  diag.last_write_err_code = g_last_write_err_code;
  diag.last_read_err_reg = g_last_read_err_reg;
  diag.last_read_err_code = g_last_read_err_code;
  return diag;
}

bool i2c_configure_frequencies(uint32_t primary_hz, uint32_t fallback_hz, bool apply_now){
  if(primary_hz < 1000 || primary_hz > 1000000){
    return false;
  }
  if(fallback_hz && (fallback_hz < 1000 || fallback_hz > 1000000)){
    return false;
  }

  g_i2c_primary_hz = primary_hz;
  g_i2c_fallback_hz = fallback_hz;
  g_i2c_fallback_announced = false;

  if(!g_i2c_ready && g_i2c_current_hz == 0){
    g_i2c_current_hz = g_i2c_primary_hz;
  }
  g_i2c_using_fallback = (g_i2c_fallback_hz && g_i2c_current_hz == g_i2c_fallback_hz && g_i2c_fallback_hz != g_i2c_primary_hz);

  if(apply_now && g_i2c_ready){
    uint32_t target = g_i2c_using_fallback ? g_i2c_fallback_hz : g_i2c_primary_hz;
    if(target == 0){
      target = g_i2c_primary_hz;
    }
    apply_i2c_frequency(target);
  }
  return true;
}

void i2c_reset_frequencies(bool apply_now){
  i2c_configure_frequencies(I2C_FREQ, I2C_FREQ_FALLBACK, apply_now);
}
