#include <Arduino.h>
#include <Wire.h>
#include <Servo.h>

// ===== Pin map (documentation v0.5) =====
#define PIN_DRIVE_L 4
#define PIN_DRIVE_R 5
#define PIN_LIFT     10
#define PIN_GRIP     11

#define PIN_LIFT_ENC_A 2
#define PIN_LIFT_ENC_B 7

#define PIN_ODO_L_A   3
#define PIN_ODO_L_B   8
#define PIN_ODO_R_A   12
#define PIN_ODO_R_B   A2

#define PIN_GRIP_ENC_A 6
#define PIN_GRIP_ENC_B 9

#define PIN_LINE_L A0
#define PIN_LINE_R A1
#define PIN_ESTOP  13

// ===== ICD addresses =====
#define REG_DRIVE   0x00
#define REG_ELEV    0x10
#define REG_GRIP    0x18
#define REG_BRAKE   0x1C
#define REG_HOME    0x1D
#define REG_SEQ     0x1E
#define REG_APPLY   0x1F

#define REG_STATUS0 0x40
#define REG_STATUS1 0x44
#define REG_LINES   0x48
#define REG_POWER   0x4E
#define REG_DRIVEFB 0x50
#define REG_AUXFB   0x58
#define REG_SENS    0x5C
#define REG_ODOM    0x62

#define REG_CFG_LINE 0x70
#define REG_CFG_LIFT 0x72
#define REG_CFG_GRIP 0x7A
#define REG_CFG_ODO  0x82

// ===== Types =====
struct __attribute__((packed)) Status0 { uint8_t state_id, seq_ack; uint16_t err_flags; };
struct __attribute__((packed)) Status1 { int16_t elev_mm, grip_pos_deg; };
struct __attribute__((packed)) Lines   { uint16_t L,R,thr; };
struct __attribute__((packed)) Power   { uint16_t vbatt_mV; uint8_t mps, estop; };
struct __attribute__((packed)) DriveFB { uint16_t left_us,right_us,res1,res2; };
struct __attribute__((packed)) AuxFB   { uint16_t lift_us,grip_us; };
struct __attribute__((packed)) Sens    { int16_t grip_enc_cnt,lift_enc_cnt; };
struct __attribute__((packed)) Odom    { int32_t L,R; };

struct __attribute__((packed)) DriveCommand { int16_t vx_mm_s, vy_mm_s, w_mrad_s; uint16_t t_ms; };
struct __attribute__((packed)) ElevCommand  { int16_t h_mm, v_mmps; uint8_t mode, rsv; };
struct __attribute__((packed)) GripCommand  { uint8_t cmd; int16_t arg_deg; uint8_t rsv; };

struct __attribute__((packed)) LiftConfig { uint16_t enc_per_mm; int16_t h1_mm, h2_mm, h3_mm; };
struct __attribute__((packed)) GripConfig { int16_t enc_zero; uint16_t enc_per_deg_q12; int16_t deg_min, deg_max; };
struct __attribute__((packed)) OdoConfig  { uint16_t cpr, gear_num, gear_den, wheel_diam_mm, track_mm; };

// ===== Globals =====
volatile long lift_enc = 0;
volatile long grip_enc = 0;
volatile long odoL = 0, odoR = 0;

Servo sDriveL, sDriveR, sLift, sGrip;

DriveCommand drive_cmd{0,0,0,0};
ElevCommand elev_cmd{0,0,0,0};
GripCommand grip_cmd{0,0,0};

uint16_t cfg_line_thr = 0;
LiftConfig cfg_lift{5,100,180,260};
GripConfig cfg_grip{0,4096,0,90};
OdoConfig  cfg_odo{192,16,1,160,600};

uint16_t fb_drive_left_us = 1500;
uint16_t fb_drive_right_us = 1500;
uint16_t fb_lift_us = 1500;
uint16_t fb_grip_us = 1500;

int16_t target_h_mm = 0;
uint8_t lift_mode = 0;
int16_t lift_v_mmps = 120;
int16_t target_grip_deg = 0;

uint32_t last_cmd_ms = 0;
bool brake_on = false;
uint8_t state_id = 1;
uint8_t seq_ack = 0;
uint16_t err_flags = 0;

volatile uint8_t reg_ptr = 0;
volatile uint8_t pd_last_state = 0;

// ===== Helpers =====
static inline int constrain_us(int us){ return us<1000?1000:(us>2000?2000:us); }
static inline int16_t clampi(int16_t v,int16_t lo,int16_t hi){ return v<lo?lo:(v>hi?hi:v); }
static inline int to_us(int16_t mmps){ long d = (long)mmps * 300L / 400L; return constrain_us(1500 + (int)d); }

static inline int16_t lift_cnt_to_mm(long cnt){ uint16_t enc = cfg_lift.enc_per_mm ? cfg_lift.enc_per_mm : 1; return (int16_t)(cnt / (long)enc); }
static inline int16_t grip_cnt_to_deg(long cnt){ if(!cfg_grip.enc_per_deg_q12) return 0; long delta = cnt - (long)cfg_grip.enc_zero; long scaled = (delta << 12) / (long)cfg_grip.enc_per_deg_q12; return (int16_t)scaled; }

static void set_all_neutral(){
  sDriveL.writeMicroseconds(1500);
  sDriveR.writeMicroseconds(1500);
  sLift.writeMicroseconds(1500);
  sGrip.writeMicroseconds(1500);
  fb_drive_left_us = fb_drive_right_us = fb_lift_us = fb_grip_us = 1500;
}

static void validate_configs(){
  if(cfg_lift.enc_per_mm == 0) err_flags |= 0x0010; else err_flags &= ~0x0010;
  if(cfg_grip.enc_per_deg_q12 == 0) err_flags |= 0x0020; else err_flags &= ~0x0020;
}

// ===== Quadrature ISR =====
void lift_isr_A(){ bool a=digitalRead(PIN_LIFT_ENC_A); bool b=digitalRead(PIN_LIFT_ENC_B); lift_enc += (a==b)? +1 : -1; }
ISR(PCINT2_vect){
  uint8_t current = PIND;
  uint8_t changed = current ^ pd_last_state;
  pd_last_state = current;
  if(changed & _BV(PD6)){
    bool a = current & _BV(PD6);
    bool b = PINB & _BV(PB1);
    grip_enc += (a==b)? +1 : -1;
  }
}

void odoL_isr_A(){ bool a=digitalRead(PIN_ODO_L_A); bool b=digitalRead(PIN_ODO_L_B); odoL += (a==b)? +1 : -1; }
ISR(PCINT0_vect){
  static uint8_t lastA = 0;
  uint8_t a = (PINB & _BV(PB4)) ? 1 : 0;
  if(a != lastA){
    lastA = a;
    bool b = (PINC & _BV(2)) ? 1 : 0;
    odoR += (a==b)? +1 : -1;
  }
}
ISR(PCINT1_vect){ /* unused */ }

// ===== I2C Handlers =====
void onReceiveHandler(int len){
  if(len<=0) return;
  uint8_t start = Wire.read();
  reg_ptr = start;
  len--;
  uint8_t idx = 0;
  while(len-- > 0){
    uint8_t v = Wire.read();
    switch(start){
      case REG_DRIVE:
        ((uint8_t*)&drive_cmd)[idx] = v;
        if(idx == 7){
          last_cmd_ms = millis();
          brake_on = false;
        }
      break;
      case REG_ELEV:
        ((uint8_t*)&elev_cmd)[idx] = v;
      break;
      case REG_GRIP:
        ((uint8_t*)&grip_cmd)[idx] = v;
      break;
      case REG_BRAKE:
        brake_on = true;
      break;
      case REG_HOME:
        lift_enc = 0;
        grip_enc = cfg_grip.enc_zero;
      break;
      case REG_SEQ:
        seq_ack++;
        validate_configs();
      break;
      case REG_APPLY:
        /* reserved */
      break;
      case REG_CFG_LINE:
        ((uint8_t*)&cfg_line_thr)[idx] = v;
      break;
      case REG_CFG_LIFT:
        ((uint8_t*)&cfg_lift)[idx] = v;
      break;
      case REG_CFG_GRIP:
        ((uint8_t*)&cfg_grip)[idx] = v;
      break;
      case REG_CFG_ODO:
        ((uint8_t*)&cfg_odo)[idx] = v;
      break;
    }
    idx++;
  }
}

void onRequestHandler(){
  switch(reg_ptr){
    case REG_STATUS0:{
      Status0 s{state_id, seq_ack, err_flags};
      Wire.write((uint8_t*)&s, sizeof(s));
    } break;
    case REG_STATUS1:{
      int16_t elev_mm = lift_cnt_to_mm(lift_enc);
      int16_t grip_deg = grip_cnt_to_deg(grip_enc);
      Status1 s{elev_mm, grip_deg};
      Wire.write((uint8_t*)&s, sizeof(s));
    } break;
    case REG_LINES:{
      Lines s{(uint16_t)analogRead(PIN_LINE_L), (uint16_t)analogRead(PIN_LINE_R), cfg_line_thr};
      Wire.write((uint8_t*)&s, sizeof(s));
    } break;
    case REG_POWER:{
      uint16_t vbatt = 7400;
      uint8_t mps = digitalRead(PIN_ESTOP)==HIGH;
      uint8_t estop = !mps;
      Power s{vbatt,mps,estop};
      Wire.write((uint8_t*)&s, sizeof(s));
    } break;
    case REG_DRIVEFB:{
      DriveFB s{fb_drive_left_us, fb_drive_right_us, 0, 0};
      Wire.write((uint8_t*)&s, sizeof(s));
    } break;
    case REG_AUXFB:{
      AuxFB s{fb_lift_us, fb_grip_us};
      Wire.write((uint8_t*)&s, sizeof(s));
    } break;
    case REG_SENS:{
      Sens s{(int16_t)grip_enc, (int16_t)lift_enc};
      Wire.write((uint8_t*)&s, sizeof(s));
    } break;
    case REG_ODOM:{
      Odom s{odoL, odoR};
      Wire.write((uint8_t*)&s, sizeof(s));
    } break;
    default:{
      uint8_t zero = 0;
      Wire.write(&zero, 1);
    } break;
  }
}

// ===== Control =====
static void apply_drive(){
  if(brake_on){
    state_id = 6;
    set_all_neutral();
    return;
  }
  uint32_t now = millis();
  uint16_t hold_ms = drive_cmd.t_ms ? drive_cmd.t_ms : 200;
  if(now - last_cmd_ms > hold_ms){
    state_id = 1;
    set_all_neutral();
    return;
  }
  int16_t vx = drive_cmd.vx_mm_s;
  int16_t w = drive_cmd.w_mrad_s;
  int32_t track = cfg_odo.track_mm ? cfg_odo.track_mm : 600;
  int32_t rot = ((int32_t)w * track) / 2000L;
  int16_t left_mmps = (int16_t)clampi(vx - rot, -500, 500);
  int16_t right_mmps = (int16_t)clampi(vx + rot, -500, 500);
  int left_us = to_us(left_mmps);
  int right_us = to_us(right_mmps);
  sDriveL.writeMicroseconds(left_us);
  sDriveR.writeMicroseconds(right_us);
  fb_drive_left_us = left_us;
  fb_drive_right_us = right_us;
  state_id = 2;
}

static void control_lift(){
  if(cfg_lift.enc_per_mm == 0){
    fb_lift_us = 1500;
    sLift.writeMicroseconds(fb_lift_us);
    err_flags |= 0x0010;
    return;
  }
  if(lift_mode == 1){
    int16_t u_vel = clampi(lift_v_mmps, -300, 300);
    fb_lift_us = constrain_us(1500 + u_vel);
    sLift.writeMicroseconds(fb_lift_us);
    return;
  }
  long cnt = lift_enc;
  int16_t h_mm = lift_cnt_to_mm(cnt);
  int16_t err = target_h_mm - h_mm;
  int16_t u = clampi(err * 3, -300, 300);
  fb_lift_us = constrain_us(1500 + u);
  sLift.writeMicroseconds(fb_lift_us);
}

static void control_grip(){
  if(cfg_grip.enc_per_deg_q12 == 0){
    fb_grip_us = 1500;
    sGrip.writeMicroseconds(fb_grip_us);
    err_flags |= 0x0020;
    return;
  }
  int16_t grip_deg = grip_cnt_to_deg(grip_enc);
  int16_t err = target_grip_deg - grip_deg;
  int16_t u = clampi(err * 6, -300, 300);
  fb_grip_us = constrain_us(1500 + u);
  sGrip.writeMicroseconds(fb_grip_us);
}

// ===== Setup/Loop =====
void setup(){
  pinMode(PIN_ESTOP, INPUT_PULLUP);
  pinMode(PIN_LIFT_ENC_A, INPUT_PULLUP);
  pinMode(PIN_LIFT_ENC_B, INPUT_PULLUP);
  pinMode(PIN_ODO_L_A, INPUT_PULLUP);
  pinMode(PIN_ODO_L_B, INPUT_PULLUP);
  pinMode(PIN_ODO_R_A, INPUT_PULLUP);
  pinMode(PIN_ODO_R_B, INPUT_PULLUP);
  pinMode(PIN_GRIP_ENC_A, INPUT_PULLUP);
  pinMode(PIN_GRIP_ENC_B, INPUT_PULLUP);

  sDriveL.attach(PIN_DRIVE_L);
  sDriveR.attach(PIN_DRIVE_R);
  sLift.attach(PIN_LIFT);
  sGrip.attach(PIN_GRIP);
  set_all_neutral();
  target_grip_deg = cfg_grip.deg_min;

  attachInterrupt(digitalPinToInterrupt(PIN_LIFT_ENC_A), lift_isr_A, CHANGE);
  attachInterrupt(digitalPinToInterrupt(PIN_ODO_L_A), odoL_isr_A, CHANGE);

  PCICR |= _BV(PCIE0);
  PCMSK0 |= _BV(PCINT4) | _BV(PCINT0);
  PCICR |= _BV(PCIE1);
  PCMSK1 |= _BV(PCINT10);
  PCICR |= _BV(PCIE2);
  PCMSK2 |= _BV(PCINT22);
  pd_last_state = PIND;

  Wire.begin(0x12);
  Wire.setClock(400000); // align with ESP32 master frequency
  Wire.onReceive(onReceiveHandler);
  Wire.onRequest(onRequestHandler);

  validate_configs();

  Serial.begin(115200);
  Serial.println(F("[UNO] Boot"));
}

void loop(){
  target_h_mm = elev_cmd.h_mm;
  lift_v_mmps = elev_cmd.v_mmps;
  lift_mode = elev_cmd.mode;

  int16_t desired_grip = target_grip_deg;
  switch(grip_cmd.cmd){
    case 0: desired_grip = cfg_grip.deg_min; break;
    case 1: desired_grip = cfg_grip.deg_max; break;
    case 2: desired_grip = clampi(grip_cmd.arg_deg, cfg_grip.deg_min, cfg_grip.deg_max); break;
    default: break;
  }
  target_grip_deg = desired_grip;

  apply_drive();
  control_lift();
  control_grip();
}