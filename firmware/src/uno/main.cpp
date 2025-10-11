#include <Arduino.h>
#include <Wire.h>
#include <Servo.h>

// ====== Pin map (matches documentation v0.4) ======
#define PIN_FL 4
#define PIN_FR 5
#define PIN_RL 6
#define PIN_RR 9
#define PIN_LIFT 10
#define PIN_GRIP 11

#define PIN_LIFT_ENC_A 2   // INT0
#define PIN_LIFT_ENC_B 7   // PCINT2

#define PIN_ODO_L_A   3    // INT1
#define PIN_ODO_L_B   8    // PCINT0
#define PIN_ODO_R_A   12   // PCINT0
#define PIN_ODO_R_B   A2   // PCINT1

#define PIN_LINE_L A0
#define PIN_LINE_R A1
#define PIN_GRIP_POT A3
#define PIN_ESTOP    13     // MPS/E-STOP input

// ====== ICD addresses ======
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

// ====== Types ======
struct __attribute__((packed)) Status0 { uint8_t state_id, seq_ack; uint16_t err_flags; };
struct __attribute__((packed)) Status1 { int16_t elev_mm, grip_pos_deg; };
struct __attribute__((packed)) Lines   { uint16_t L,R,thr; };
struct __attribute__((packed)) Power   { uint16_t vbatt_mV; uint8_t mps, estop; };
struct __attribute__((packed)) DriveFB { uint16_t fl,fr,rl,rr; };
struct __attribute__((packed)) AuxFB   { uint16_t lift,grip; };
struct __attribute__((packed)) Sens    { uint16_t pot_raw; int16_t lift_enc_cnt; };
struct __attribute__((packed)) Odom    { int32_t L,R; };

// ====== Globals ======
volatile long lift_enc = 0;
volatile long odoL = 0, odoR = 0;

Servo sFL,sFR,sRL,sRR,sLift,sGrip;

// Configs
uint16_t cfg_line_thr = 0; // 0=auto
uint16_t cfg_lift_enc_per_mm = 5; // example
int16_t cfg_h1=100, cfg_h2=180, cfg_h3=260;
uint16_t cfg_pot_min=100, cfg_pot_max=900;
int16_t cfg_deg_min=0, cfg_deg_max=90;
uint16_t cfg_odo_cpr=192, cfg_odo_gear_num=16, cfg_odo_gear_den=1, cfg_odo_wheel=160, cfg_odo_track=600;

// Drive state
int16_t cmd_vx=0, cmd_vy=0, cmd_w=0;
uint16_t cmd_t_ms=0;
uint32_t last_cmd_ms=0;
bool brake_on=false;

// Status
uint8_t state_id=1; // IDLE
uint8_t seq_ack=0;
uint16_t err_flags=0;

// Register pointer for I2C
volatile uint8_t reg_ptr=0;

// ====== Helpers ======
static inline int constrain_us(int us){ return us<1000?1000:(us>2000?2000:us); }

static void set_all_neutral(){
  sFL.writeMicroseconds(1500);
  sFR.writeMicroseconds(1500);
  sRL.writeMicroseconds(1500);
  sRR.writeMicroseconds(1500);
  sLift.writeMicroseconds(1500);
  sGrip.writeMicroseconds(1500);
}

// ====== Quadrature ISR ======
void lift_isr_A(){ bool a=digitalRead(PIN_LIFT_ENC_A); bool b=digitalRead(PIN_LIFT_ENC_B); lift_enc += (a==b)? +1 : -1; }
ISR(PCINT2_vect){ // for D7 (Lift B), not strictly needed if we edge on A
  // do nothing special; A ISR reads B state
}

void odoL_isr_A(){ bool a=digitalRead(PIN_ODO_L_A); bool b=digitalRead(PIN_ODO_L_B); odoL += (a==b)? +1 : -1; }
ISR(PCINT0_vect){ // D8..D13 changes -> handle ODO_R_A and ODO_L_B edges
  // Left B change doesn't update count alone (we edge on A)
  // Right A edge handling:
  static uint8_t lastA = 0;
  uint8_t a = (PINB & _BV(4)) ? 1 : 0; // D12 -> PB4
  if(a != lastA){
    lastA = a;
    bool b = (PINC & _BV(2)) ? 1 : 0;  // A2 -> PC2
    odoR += (a==b)? +1 : -1;
  }
}
ISR(PCINT1_vect){ // A0..A5 (we track A2 as B for right)
  // handled via PCINT0 as we sample B in that ISR
}

// ====== I2C Handlers ======
uint8_t read_buffer[16]; // enough for max block

void onReceiveHandler(int len){
  if(len<=0) return;
  reg_ptr = Wire.read(); len--;
  // write if payload exists
  for(int i=0;i<len;i++){
    uint8_t v = Wire.read();
    // DEMUX by starting register and index
    switch(reg_ptr){
      case REG_DRIVE: {
        ((uint8_t*)&cmd_vx)[i] = v;
        if(i==7){ last_cmd_ms=millis(); }
      } break;
      case REG_ELEV: ((uint8_t*)&cfg_h1)[i]=v; break; // reuse fields; below we decode
      case REG_GRIP: ((uint8_t*)&cfg_deg_min)[i]=v; break;
      case REG_BRAKE: brake_on=true; break;
      case REG_HOME: { lift_enc=0; } break;
      case REG_SEQ: { seq_ack++; } break;
      case REG_APPLY: { /*no-op*/ } break;
      case REG_CFG_LINE: ((uint8_t*)&cfg_line_thr)[i]=v; break;
      case REG_CFG_LIFT: ((uint8_t*)&cfg_lift_enc_per_mm)[i]=v; break;
      case REG_CFG_GRIP: ((uint8_t*)&cfg_pot_min)[i]=v; break;
      case REG_CFG_ODO: ((uint8_t*)&cfg_odo_cpr)[i]=v; break;
    }
  }
}

void onRequestHandler(){
  // prepare block by reg_ptr
  switch(reg_ptr){
    case REG_STATUS0: {
      Status0 s{state_id, seq_ack, err_flags};
      Wire.write((uint8_t*)&s, sizeof(s));
    } break;
    case REG_STATUS1: {
      int16_t elev_mm = (int16_t)(lift_enc / (int32_t)cfg_lift_enc_per_mm);
      int16_t grip_deg = map(analogRead(PIN_GRIP_POT), cfg_pot_min,cfg_pot_max, cfg_deg_min,cfg_deg_max);
      Status1 s{elev_mm, grip_deg};
      Wire.write((uint8_t*)&s, sizeof(s));
    } break;
    case REG_LINES: {
      uint16_t L=analogRead(PIN_LINE_L), R=analogRead(PIN_LINE_R);
      Lines s{L,R,cfg_line_thr};
      Wire.write((uint8_t*)&s, sizeof(s));
    } break;
    case REG_POWER: {
      uint16_t vbatt = 7400; uint8_t mps = digitalRead(PIN_ESTOP)==HIGH; uint8_t estop = !mps;
      Power s{vbatt,mps,estop}; Wire.write((uint8_t*)&s, sizeof(s));
    } break;
    case REG_DRIVEFB: {
      DriveFB s{1500,1500,1500,1500}; Wire.write((uint8_t*)&s, sizeof(s));
    } break;
    case REG_AUXFB: {
      AuxFB s{1500,1500}; Wire.write((uint8_t*)&s, sizeof(s));
    } break;
    case REG_SENS: {
      Sens s{(uint16_t)analogRead(PIN_GRIP_POT), (int16_t)lift_enc};
      Wire.write((uint8_t*)&s, sizeof(s));
    } break;
    case REG_ODOM: {
      Odom s{(int32_t)odoL, (int32_t)odoR};
      Wire.write((uint8_t*)&s, sizeof(s));
    } break;
    default: {
      uint8_t zero=0; Wire.write(&zero, 1);
    } break;
  }
}

// ====== Drive mixing (mecanum) ======
static inline int16_t clampi(int16_t v,int16_t lo,int16_t hi){ return v<lo?lo:(v>hi?hi:v); }
static int to_us(int16_t v){ // v in mm/s -> microseconds delta from 1500 (simple linear map)
  // crude mapping: 0.4 m/s -> +/- 300 us
  long d = (long)v * 300 / 400;
  return constrain_us(1500 + (int)d);
}
void apply_drive(){
  // If brake or timeout, neutral
  if(brake_on || (millis()-last_cmd_ms>200)){ set_all_neutral(); return; }
  // mecanum inverse kinematics:
  // wheel speeds are combinations of vx, vy, w
  int16_t fl = cmd_vx - cmd_vy - cmd_w;
  int16_t fr = cmd_vx + cmd_vy + cmd_w;
  int16_t rl = cmd_vx + cmd_vy - cmd_w;
  int16_t rr = cmd_vx - cmd_vy + cmd_w;
  sFL.writeMicroseconds(to_us(fl));
  sFR.writeMicroseconds(to_us(fr));
  sRL.writeMicroseconds(to_us(rl));
  sRR.writeMicroseconds(to_us(rr));
}

// ====== Lift & Grip control (simplified) ======
int16_t target_h_mm = 0;
int16_t lift_v_mmps = 120;
uint8_t lift_mode = 0; // 0=position

void control_lift(){
  int16_t h_mm = (int16_t)(lift_enc / (int32_t)cfg_lift_enc_per_mm);
  int16_t err = target_h_mm - h_mm;
  int16_t u = clampi(err*3, -300, 300); // crude P gain
  sLift.writeMicroseconds(constrain_us(1500 + u));
}
int16_t target_grip_deg = 0;
uint8_t grip_cmd = 0; // 0 open 1 close 2 pose
void control_grip(){
  int val = analogRead(PIN_GRIP_POT);
  int deg = map(val, cfg_pot_min,cfg_pot_max, cfg_deg_min,cfg_deg_max);
  int err = (grip_cmd==2 ? (target_grip_deg - deg) : (grip_cmd==1 ? +30 : -30));
  int u = clampi(err*6, -300, 300);
  sGrip.writeMicroseconds(constrain_us(1500 + u));
}

// ====== Setup/Loop ======
void setup(){
  pinMode(PIN_ESTOP, INPUT_PULLUP);
  pinMode(PIN_LIFT_ENC_A, INPUT_PULLUP);
  pinMode(PIN_LIFT_ENC_B, INPUT_PULLUP);
  pinMode(PIN_ODO_L_A, INPUT_PULLUP);
  pinMode(PIN_ODO_L_B, INPUT_PULLUP);
  pinMode(PIN_ODO_R_A, INPUT_PULLUP);
  pinMode(PIN_ODO_R_B, INPUT_PULLUP);

  sFL.attach(PIN_FL); sFR.attach(PIN_FR); sRL.attach(PIN_RL); sRR.attach(PIN_RR);
  sLift.attach(PIN_LIFT); sGrip.attach(PIN_GRIP);
  set_all_neutral();

  // Encoders
  attachInterrupt(digitalPinToInterrupt(PIN_LIFT_ENC_A), lift_isr_A, CHANGE);
  attachInterrupt(digitalPinToInterrupt(PIN_ODO_L_A), odoL_isr_A, CHANGE);
  // Enable PCINT for D8..D13
  PCICR |= _BV(PCIE0); // enable PCINT0 for port B
  PCMSK0 |= _BV(PCINT4) | _BV(PCINT0); // PB4(D12)=A for right, PB0(D8)=left B (not used)
  // Enable PCINT for A0..A5
  PCICR |= _BV(PCIE1);
  PCMSK1 |= _BV(PCINT10); // PC2(A2)=B for right

  // I2C
  Wire.begin(0x12);
  Wire.onReceive(onReceiveHandler);
  Wire.onRequest(onRequestHandler);

  Serial.begin(115200);
  Serial.println(F("[UNO] Boot"));
}

void loop(){
  // parse command blocks written into variables
  // DRIVE block is already in cmd_vx/cmd_vy/cmd_w and last_cmd_ms updated in onReceive handler

  // ELEV block (reuse fields cfg_h1.. etc.) — decode: h_mm, v_mmps, mode
  // Not elegant but compact within this example
  int16_t h_mm  = cfg_h1; int16_t v_mmps = cfg_h2; uint8_t mode = (uint8_t)cfg_h3;
  target_h_mm = h_mm; lift_v_mmps = v_mmps; lift_mode = mode;

  // GRIP block: cmd, arg
  uint8_t gcmd = (uint8_t)cfg_deg_min; int16_t garg = cfg_deg_max;
  grip_cmd = gcmd; target_grip_deg = garg;

  // Apply controls
  apply_drive();
  control_lift();
  control_grip();
}