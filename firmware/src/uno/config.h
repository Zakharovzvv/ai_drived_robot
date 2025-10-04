#pragma once
#include <Arduino.h>

// ==== Pins (match "Электрика v0.3") ====
// Servo (MC29)
static const uint8_t PIN_FL = 3;  // D3
static const uint8_t PIN_FR = 5;  // D5
static const uint8_t PIN_RL = 6;  // D6
static const uint8_t PIN_RR = 9;  // D9
static const uint8_t PIN_ELEV = 10; // D10
static const uint8_t PIN_GRIP = 11; // D11

// Line sensors (analog)
static const uint8_t PIN_LINE_L = A0;
static const uint8_t PIN_LINE_R = A1;

// Grip potentiometer (analog)
static const uint8_t PIN_GRIP_POT = A3;

// Lift encoder (quadrature)
static const uint8_t PIN_LIFT_ENC_A = 2;  // INT0
static const uint8_t PIN_LIFT_ENC_B = 7;  // digital (sampled in ISR)

// I2C pins are A4/A5

// E-STOP / MPS input
static const uint8_t PIN_ESTOP = 13; // D13

// ==== Motion limits/scales ====
static const int16_t MAX_V_MM_S = 400;    // vx, vy
static const int16_t MAX_W_MRAD_S = 2000; // wz in mrad/s

// Servo ranges
static const uint16_t SERVO_US_MIN = 1000;
static const uint16_t SERVO_US_MAX = 2000;
static const uint16_t SERVO_US_NEU = 1500;

// Lift encoder scale (ticks per mm) — set via CFG_LIFT in runtime
struct LiftCfg { uint16_t enc_per_mm; int16_t h1_mm, h2_mm, h3_mm; };
// Grip pot ↔ deg mapping — set via CFG_GRIP
struct GripCfg { uint16_t pot_min, pot_max; int16_t deg_min, deg_max; };

// Line threshold (0 = auto)
static uint16_t cfg_line_thr = 0;

// Safety/timeout
static const uint32_t CMD_TIMEOUT_MS = 200;
