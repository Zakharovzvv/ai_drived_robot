#include <Wire.h>
#include <Servo.h>
#include "icd.h"
#include "config.h"
#include "mecanum.h"

// ===== Servo objects =====
Servo sFL, sFR, sRL, sRR, sELEV, sGRIP;

// ===== State =====
volatile long lift_enc_cnt = 0; // encoder counts (A as INT0)
volatile bool i2c_error = false;

// Shadow & active command blocks
DriveCmd shadow_drive{0,0,0,0}, active_drive{0,0,0,0};
int16_t shadow_elev_pos_mm=0; uint16_t shadow_elev_vmax=120, shadow_elev_amax=400;
uint8_t shadow_grip_mode=0; int16_t shadow_grip_pose_deg=0; uint8_t shadow_grip_spd=60;

DriveCmd last_set_drive{0,0,0,0};

// Configs
LiftCfg lift_cfg{ 10, 70, 200, 330 }; // defaults: 10 ticks/mm; H1=70,H2=200,H3=330
GripCfg grip_cfg{ 150, 850, 0, 90 }; // defaults: pot 150..850 -> 0..90 deg

// Line
uint16_t lineL=0, lineR=0, line_thr=0;

// I2C register view (sufficient size up to 0x81)
static uint8_t reg_mem[0x82] = {0};
static uint8_t reg_addr = 0; // current address pointer for onRequest

// Status
uint8_t state_id = ST_BOOT; uint8_t seq=0, seq_ack=0; uint16_t err_flags=0;
uint32_t last_cmd_ms = 0; bool brake_on=false; bool estop_in=false; bool mps_state=true;

// Helpers
void servoAllNeutral(){ sFL.writeMicroseconds(SERVO_US_NEU); sFR.writeMicroseconds(SERVO_US_NEU);
  sRL.writeMicroseconds(SERVO_US_NEU); sRR.writeMicroseconds(SERVO_US_NEU);
  sELEV.writeMicroseconds(SERVO_US_NEU); sGRIP.writeMicroseconds(SERVO_US_NEU);
}

void setWheelsUS(const WheelsUS &u){ sFL.writeMicroseconds(u.fl); sFR.writeMicroseconds(u.fr);
  sRL.writeMicroseconds(u.rl); sRR.writeMicroseconds(u.rr);
}

// Quadrature ISR (A on INT0)
void IRAM_ATTR isr_lift_enc(){
  // Read B to determine direction
  bool b = digitalRead(PIN_LIFT_ENC_B);
  lift_enc_cnt += b ? +1 : -1;
}

// Map pot raw to degrees
int16_t potRawToDeg(uint16_t raw){
  long cl = constrain((long)raw, grip_cfg.pot_min, grip_cfg.pot_max) - grip_cfg.pot_min;
  long span = max(1, (int)grip_cfg.pot_max - (int)grip_cfg.pot_min);
  float t = (float)cl / (float)span; // 0..1
  return (int16_t) (grip_cfg.deg_min + t * (grip_cfg.deg_max - grip_cfg.deg_min));
}

// Map deg to servo us around neutral using simple P controller direction
uint16_t gripControlUS(int16_t target_deg, int16_t current_deg){
  int16_t err = target_deg - current_deg; // deg
  // Gain maps degrees to servo delta microseconds
  const float Kp = 4.0f; // 4 us/deg → 90deg ~ 360us
  int delta = (int)(Kp * err);
  int us = (int)SERVO_US_NEU + delta;
  return (uint16_t)clamp_u16(us, SERVO_US_MIN, SERVO_US_MAX);
}

// Lift control using encoder position (mm target → enc counts)
int16_t encForMM(int16_t mm){ return (int16_t)( (long)mm * (long)lift_cfg.enc_per_mm ); }

uint16_t liftControlUS(int16_t target_mm){
  static long last_cnt = 0; static int16_t last_err=0; static uint32_t last_ms=0;
  long cur_cnt = lift_enc_cnt;
  int16_t cur_mm = (int16_t)(cur_cnt / (int)lift_cfg.enc_per_mm);
  int16_t err = target_mm - cur_mm;
  uint32_t now = millis(); float dt = (now-last_ms)/1000.0f; if(last_ms==0) dt=0.02f; last_ms=now;
  // Simple PD
  const float Kp=6.0f; const float Kd=20.0f;
  float derr = (err - last_err) / max(0.001f, dt); last_err = err;
  int cmd = (int)(SERVO_US_NEU + Kp*err + Kd*derr*0.01f);
  return (uint16_t)clamp_u16(cmd, SERVO_US_MIN, SERVO_US_MAX);
}

// ===== I2C handlers =====
void onReceive(int len){
  if(len<=0) return;
  reg_addr = Wire.read();
  len--;
  for(int i=0;i<len && reg_addr<sizeof(reg_mem);++i,++reg_addr){
    reg_mem[reg_addr] = Wire.read();
  }
  // Side effects for written registers
  // Read back important blocks into shadow
  // DRIVE
  memcpy(&shadow_drive, &reg_mem[REG::DRIVE], sizeof(DriveCmd));
  // ELEV
  memcpy(&shadow_elev_pos_mm, &reg_mem[REG::ELEV], 2); // pos_mm
  memcpy(&shadow_elev_vmax, &reg_mem[REG::ELEV+2], 2);
  memcpy(&shadow_elev_amax, &reg_mem[REG::ELEV+4], 2);
  // GRIP
  shadow_grip_mode = reg_mem[REG::GRIP+0];
  memcpy(&shadow_grip_pose_deg, &reg_mem[REG::GRIP+1], 2);
  shadow_grip_spd = reg_mem[REG::GRIP+3];
  // BRAKE
  brake_on = reg_mem[REG::BRAKE];
  // HOME handled in loop
  // SEQ
  seq = reg_mem[REG::SEQ];
}

void onRequest(){
  // Serve from reg_mem at current reg_addr
  uint8_t *src = &reg_mem[reg_addr];
  int n = min(32, (int)sizeof(reg_mem) - (int)reg_addr);
  Wire.write(src, n);
  reg_addr += n;
}

// ===== Setup/loop =====
void setup(){
  pinMode(PIN_ESTOP, INPUT_PULLUP); // expecting external pull-up/down - adjust if needed
  pinMode(PIN_LIFT_ENC_B, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(PIN_LIFT_ENC_A), isr_lift_enc, CHANGE);

  sFL.attach(PIN_FL); sFR.attach(PIN_FR); sRL.attach(PIN_RL); sRR.attach(PIN_RR);
  sELEV.attach(PIN_ELEV); sGRIP.attach(PIN_GRIP);
  servoAllNeutral();

  Wire.begin((int)I2C_ADDR);
  Wire.onReceive(onReceive);
  Wire.onRequest(onRequest);

  // Init reg space
  memset(reg_mem, 0, sizeof(reg_mem));
  reg_mem[REG::FWINFO+0] = 1; // proto_ver
  reg_mem[REG::FWINFO+1] = 1; // fw_major
  reg_mem[REG::FWINFO+2] = 0; // minor
  reg_mem[REG::FWINFO+3] = 0; // patch

  state_id = ST_IDLE; seq_ack = 0; err_flags=0; last_cmd_ms = millis();
}

void loop(){
  uint32_t now = millis();

  // Read inputs
  estop_in = digitalRead(PIN_ESTOP)==HIGH; // adjust logic to wiring
  if(estop_in){ err_flags |= ERR_ESTOP; }

  lineL = analogRead(PIN_LINE_L); lineR = analogRead(PIN_LINE_R);
  if(cfg_line_thr==0){ // simple auto threshold from running min/max (bootstrap)
    static uint16_t minL=1023,minR=1023,maxL=0,maxR=0;
    minL=min(minL,lineL); minR=min(minR,lineR); maxL=max(maxL,lineL); maxR=max(maxR,lineR);
    line_thr = ( (minL+maxL)/2 + (minR+maxR)/2 )/2;
  } else line_thr = cfg_line_thr;

  uint16_t pot_raw = analogRead(PIN_GRIP_POT);
  int16_t grip_deg = potRawToDeg(pot_raw);

  // Timeout
  if((now - last_cmd_ms) > CMD_TIMEOUT_MS){ brake_on = true; err_flags |= ERR_TIMEOUT; }

  // Apply SEQ commit
  if(seq != seq_ack){
    // New commands available
    seq_ack = seq; last_cmd_ms = now; err_flags &= ~ERR_TIMEOUT;
    // Optionally snapshot to active
    active_drive = shadow_drive;
  }

  // BRAKE / E-STOP
  if(brake_on || estop_in){ state_id = ST_BRAKE; servoAllNeutral(); }
  else {
    // DRIVE execution (time-based)
    static uint32_t drive_until_ms = 0;
    if(active_drive.t_ms>0){ drive_until_ms = now + active_drive.t_ms; active_drive.t_ms = 0; }
    if((int32_t)(drive_until_ms - now) > 0){
      WheelsUS u = driveToServoUS(active_drive);
      setWheelsUS(u);
      state_id = ST_DRIVE;
      // Feedback into regs
      memcpy(&reg_mem[REG::DRIVEFB+0], &u.fl, 2);
      memcpy(&reg_mem[REG::DRIVEFB+2], &u.fr, 2);
      memcpy(&reg_mem[REG::DRIVEFB+4], &u.rl, 2);
      memcpy(&reg_mem[REG::DRIVEFB+6], &u.rr, 2);
    } else {
      // neutral wheels when no command
      setWheelsUS({SERVO_US_NEU,SERVO_US_NEU,SERVO_US_NEU,SERVO_US_NEU});
      if(state_id==ST_DRIVE) state_id = ST_IDLE;
    }

    // ELEV control (run every loop towards shadow_elev_pos_mm)
    uint16_t elev_us = liftControlUS(shadow_elev_pos_mm);
    sELEV.writeMicroseconds(elev_us);

    // GRIP control
    uint16_t grip_us = SERVO_US_NEU;
    if(shadow_grip_mode==0){ // OPEN
      grip_us = gripControlUS(grip_cfg.deg_min, grip_deg);
    } else if(shadow_grip_mode==1){ // CLOSE
      grip_us = gripControlUS(grip_cfg.deg_max, grip_deg);
    } else { // POSE
      grip_us = gripControlUS(shadow_grip_pose_deg, grip_deg);
    }
    sGRIP.writeMicroseconds(grip_us);

    // State label preference
    if(shadow_elev_pos_mm!=0) state_id = ST_ELEV_MOVE;
    if(shadow_grip_mode!=255) state_id = ST_GRIP_MOVE; // use 255 as NOP if needed
  }

  // Populate telemetry registers
  reg_mem[REG::STATUS0+0] = state_id;
  reg_mem[REG::STATUS0+1] = seq_ack;
  memcpy(&reg_mem[REG::STATUS0+2], &err_flags, 2);
  memcpy(&reg_mem[REG::STATUS1+0], &shadow_elev_pos_mm, 2);
  memcpy(&reg_mem[REG::STATUS1+2], &grip_deg, 2);
  memcpy(&reg_mem[REG::LINES+0], &lineL, 2);
  memcpy(&reg_mem[REG::LINES+2], &lineR, 2);
  memcpy(&reg_mem[REG::LINES+4], &line_thr, 2);
  uint16_t vbatt_mv = 7400; // TODO: measure via divider if present
  reg_mem[REG::POWER+0] = vbatt_mv & 0xFF; reg_mem[REG::POWER+1] = vbatt_mv>>8;
  reg_mem[REG::POWER+2] = mps_state?1:0; reg_mem[REG::POWER+3] = estop_in?1:0;

  // Aux feedback
  uint16_t elev_us =  sELEV.readMicroseconds();
  uint16_t grip_us =  sGRIP.readMicroseconds();
  memcpy(&reg_mem[REG::AUXFB+0], &elev_us, 2);
  memcpy(&reg_mem[REG::AUXFB+2], &grip_us, 2);
  memcpy(&reg_mem[REG::SENS+0], &pot_raw, 2);
  int16_t enc_short = (int16_t)lift_enc_cnt; memcpy(&reg_mem[REG::SENS+2], &enc_short, 2);

  // Apply HOME if requested
  uint8_t home_mask = reg_mem[REG::HOME];
  if(home_mask){
    // Simple homing routines (placeholder: set current as zero)
    if(home_mask & 0x01){ noInterrupts(); lift_enc_cnt=0; interrupts(); }
    if(home_mask & 0x02){ /* grip home: set current pot as deg_min */ grip_cfg.pot_min = analogRead(PIN_GRIP_POT); }
    reg_mem[REG::HOME]=0; // clear
  }

  delay(5); // ~200 Hz loop
}
