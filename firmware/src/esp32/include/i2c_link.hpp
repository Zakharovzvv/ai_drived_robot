#pragma once
#include <Arduino.h>
#include <Wire.h>
#include "config.hpp"

struct Status0 { uint8_t state_id, seq_ack; uint16_t err_flags; } __attribute__((packed));
struct Status1 { int16_t elev_mm, grip_deg; } __attribute__((packed));
struct Lines   { uint16_t L, R, thr; } __attribute__((packed));
struct Power   { uint16_t vbatt_mV; uint8_t mps, estop; } __attribute__((packed));
struct DriveFB { uint16_t left_us,right_us,res1,res2; } __attribute__((packed));
struct AuxFB   { uint16_t lift,grip; } __attribute__((packed));
struct Sens    { int16_t grip_enc_cnt; int16_t lift_enc_cnt; } __attribute__((packed));
struct Odom    { int32_t  L,R; } __attribute__((packed));

bool i2c_init();
bool i2c_read(uint8_t addr, uint8_t* buf, size_t n);
bool i2c_write(uint8_t addr, const uint8_t* buf, size_t n);

inline bool i2c_cmd_brake(){ uint8_t b=0xA5; return i2c_write(ICD::BRAKE, &b, 1); }
inline bool i2c_cmd_home(){  uint8_t b=0x5A; return i2c_write(ICD::HOME, &b, 1); }
bool i2c_cmd_drive(int16_t vx,int16_t vy,int16_t w,int16_t t_ms);
bool i2c_cmd_elev(int16_t h_mm,int16_t v_mmps,uint8_t mode);
bool i2c_cmd_grip(uint8_t cmd,int16_t arg_deg);
bool i2c_cfg_line(uint16_t thr);
bool i2c_cfg_lift(uint16_t enc_per_mm,int16_t h1,int16_t h2,int16_t h3);
bool i2c_cfg_grip(int16_t enc_zero,uint16_t enc_per_deg_q12,int16_t deg_min,int16_t deg_max);
bool i2c_cfg_odo(uint16_t cpr,uint16_t gear_num,uint16_t gear_den,uint16_t wheel_mm,uint16_t track_mm);
bool i2c_seq();
bool i2c_ping_uno();

bool read_STATUS0(Status0& o);
bool read_STATUS1(Status1& o);
bool read_LINES(Lines& o);
bool read_POWER(Power& o);
bool read_DRIVEFB(DriveFB& o);
bool read_AUXFB(AuxFB& o);
bool read_SENS(Sens& o);
bool read_ODOM(Odom& o);