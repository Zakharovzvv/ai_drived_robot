#pragma once
#include <Arduino.h>

// I2C slave address
static const uint8_t I2C_ADDR = 0x12;

// Register map (offsets)
namespace REG {
  enum : uint8_t {
    DRIVE    = 0x00, // 8B: int16 vx, vy, wz; uint16 t_ms
    ELEV     = 0x10, // 6B: int16 pos_mm; uint16 vmax; uint16 amax
    GRIP     = 0x18, // 4B: uint8 mode; int16 pose_deg; uint8 spd_pct
    BRAKE    = 0x1C, // 1B: uint8 on
    HOME     = 0x1D, // 1B: uint8 mask
    SEQ      = 0x1E, // 1B: uint8 seq
    APPLY    = 0x1F, // 1B: uint8 mask (optional)

    STATUS0  = 0x40, // 4B: state_id, seq_ack, err_flags(2B)
    STATUS1  = 0x44, // 4B: elev_mm(int16), grip_pos_deg(int16)
    LINES    = 0x48, // 6B: lineL(uint16), lineR(uint16), line_thr(uint16)
    POWER    = 0x4E, // 4B: vbatt_mV(uint16), mps_state(uint8), estop_state(uint8)
    DRIVEFB  = 0x50, // 8B: fl_us, fr_us, rl_us, rr_us (uint16)
    AUXFB    = 0x58, // 4B: lift_us, grip_us (uint16)
    SENS     = 0x5C, // 4B: pot_raw(uint16), lift_enc_cnt(int16)
    FWINFO   = 0x60, // 4B: proto_ver, fw_major, fw_minor, fw_patch

    CFG_LINE = 0x70, // 2B: line_thr (0=auto)
    CFG_LIFT = 0x72, // 8B: enc_per_mm(uint16), h1_mm(int16), h2_mm(int16), h3_mm(int16)
    CFG_GRIP = 0x7A, // 8B: pot_min(uint16), pot_max(uint16), deg_min(int16), deg_max(int16)
  };
}

// Status/state IDs
enum : uint8_t {
  ST_BOOT=0, ST_IDLE, ST_DRIVE, ST_ELEV_MOVE, ST_GRIP_MOVE, ST_HOMING, ST_BRAKE
};

// Error flags
enum : uint16_t {
  ERR_TIMEOUT   = 0x0001,
  ERR_I2C       = 0x0002,
  ERR_ESTOP     = 0x0004,
  ERR_LIFT_HOME = 0x0008,
  ERR_LIFT_STALL= 0x0010,
  ERR_GRIP_RANGE= 0x0020,
  ERR_DRIVE_RNG = 0x0040,
  ERR_CFG       = 0x0080,
  WARN_LOW_BATT = 0x0100,
};
