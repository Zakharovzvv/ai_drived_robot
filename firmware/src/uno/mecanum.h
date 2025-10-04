#pragma once
#include <Arduino.h>
#include "config.h"

struct DriveCmd { int16_t vx, vy, wz_mrad_s; uint16_t t_ms; };

inline int16_t clamp_i16(int16_t v, int16_t lo, int16_t hi){ return v<lo?lo:(v>hi?hi:v); }
inline uint16_t clamp_u16(uint16_t v, uint16_t lo, uint16_t hi){ return v<lo?lo:(v>hi?hi:v); }

// Map normalized wheel command [-1..1] to servo microseconds
inline uint16_t normToServo(float x){
  x = constrain(x, -1.0f, 1.0f);
  return (uint16_t)(SERVO_US_NEU + x * (SERVO_US_MAX - SERVO_US_NEU));
}

struct WheelsUS { uint16_t fl, fr, rl, rr; };

// Convert (vx,vy,wz) to wheel microseconds with scaling
inline WheelsUS driveToServoUS(const DriveCmd &c){
  // Normalize inputs
  float vx = (float)clamp_i16(c.vx, -MAX_V_MM_S, MAX_V_MM_S) / MAX_V_MM_S; // -1..1
  float vy = (float)clamp_i16(c.vy, -MAX_V_MM_S, MAX_V_MM_S) / MAX_V_MM_S;
  float wz = (float)clamp_i16(c.wz_mrad_s, -MAX_W_MRAD_S, MAX_W_MRAD_S) / MAX_W_MRAD_S; // -1..1
  // Standard mecanum mixing (k=1)
  float fl = vx - vy - wz;
  float fr = vx + vy + wz;
  float rl = vx + vy - wz;
  float rr = vx - vy + wz;
  // Normalize max |val|
  float maxv = max( max(fabs(fl), fabs(fr)), max(fabs(rl), fabs(rr)) );
  if (maxv < 1e-6f) maxv = 1.0f;
  fl/=maxv; fr/=maxv; rl/=maxv; rr/=maxv;
  WheelsUS u{ normToServo(fl), normToServo(fr), normToServo(rl), normToServo(rr) };
  return u;
}
