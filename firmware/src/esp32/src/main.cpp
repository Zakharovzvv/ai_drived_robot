#include <Arduino.h>
#include "config.hpp"
#include "shelf_map.hpp"
#include "i2c_link.hpp"
#include "vision_color.hpp"

enum BTState { ST_INIT, ST_PICK, ST_GOPLACE, ST_PLACE };
BTState st = ST_INIT;
ColorID current_pick = C_NONE;
uint32_t t_state_ms = 0;

void setup(){
  Serial.begin(115200);
  delay(1000);
  Serial.println("[ESP32] Boot");
  // I2C
  i2c_init();
  // Camera
  if(!cam_init()) Serial.println("[ESP32] Camera init FAILED");
  // Shelf map
  if(!gShelf.loadNVS()){ gShelf.setDefault(); gShelf.saveNVS(); }
  Serial.print("[ESP32] SHELF_MAP: "); Serial.println(gShelf.toString());
  // Example configs
  i2c_cfg_line(0); // auto
  i2c_cfg_odo(192, 16, 1, 160, 600); // cpr/gear/wheel/track -- adjust!
  i2c_seq();
  t_state_ms = millis();
}

static void go_brake(){ i2c_cmd_brake(); }

static void drive_ms(int16_t vx,int16_t vy,int16_t w,int16_t t){
  i2c_cmd_drive(vx,vy,w,t);
  delay(t);
}

void loop(){
  shelf_cli_process(Serial);
  // Simple BT
  switch(st){
    case ST_INIT:{
      // Homing subsystems
      i2c_cmd_home();
      delay(600);
      st = ST_PICK; t_state_ms = millis();
    } break;
    case ST_PICK:{
      // Go to conveyor (placeholder: straight for 500ms)
      drive_ms(200,0,0,500);
      // Detect color
      current_pick = detect_cylinder_color();
      Serial.print("[BT] Detected color: "); Serial.println((int)current_pick);
      // Close grip and lift to carry height (example 120mm)
      i2c_cmd_grip(1 /*CLOSE*/, 0);
      i2c_cmd_elev(120, 100, 0);
      delay(300);
      st = ST_GOPLACE; t_state_ms = millis();
    } break;
    case ST_GOPLACE:{
      // In a real run we would pathfind by A* and line-follow; here we simulate forward drive
      drive_ms(200,0,0,800);
      st = ST_PLACE; t_state_ms = millis();
    } break;
    case ST_PLACE:{
      // Elevate based on shelf row (example mapping)
      int row=0,col=0;
      // Find first occurrence of color
      bool found=false;
      for(int r=0;r<3 && !found;r++)
        for(int c=0;c<3 && !found;c++)
          if(gShelf.map[r][c]==current_pick){ row=r; col=c; found=true; }
      int targetH = row==0? 100 : (row==1? 180 : 260); // example heights
      i2c_cmd_elev(targetH, 120, 0);
      delay(300);
      // Open
      i2c_cmd_grip(0 /*OPEN*/, 0);
      delay(150);
      go_brake();
      st = ST_PICK; t_state_ms = millis();
    } break;
  }

  // Telemetry print minimal
  static uint32_t tPrint=0;
  if(millis()-tPrint>500){
    Status0 s0; Odom od; Lines ln;
    if(read_STATUS0(s0) && read_ODOM(od) && read_LINES(ln)){
      Serial.printf("[TLM] st=%u err=0x%04X ODO(L=%ld R=%ld) L=%u R=%u\n",
        s0.state_id, s0.err_flags, (long)od.L, (long)od.R, ln.L, ln.R);
    }
    tPrint = millis();
  }
}