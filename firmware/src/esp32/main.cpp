#include <Arduino.h>
#include <Wire.h>
#include "i2c_link.h"
#include "bt.h"

I2CLink link;
BTContext bt{ &link };

// Pins: use board defaults or set explicitly
#define I2C_SDA -1
#define I2C_SCL -1

void setup(){
  Serial.begin(115200);
  delay(200);
  link.begin(I2C_SDA, I2C_SCL, 400000);
  Serial.println("ESP32 RBM master started");
}

void loop(){
  static uint32_t last=0; if(millis()-last<25) return; last=millis();

  // Read STATUS to monitor seq_ack and errors
  uint8_t st[8]; if(link.readBlock(0x40, st, sizeof(st))){
    uint8_t state_id=st[0], seq_ack=st[1]; uint16_t err = st[2] | (st[3]<<8);
    if(err){ Serial.printf("ERR=0x%04X\n", err); }
    bt.last_seq_ack = seq_ack;
  }
  bool done = bt_tick(bt);
  if(done){ delay(2000); /* stop for demo */ }

    uint8_t s1[4], ln[6];
  if(link.readBlock(0x44, s1, sizeof(s1)) && link.readBlock(0x48, ln, sizeof(ln))){
    int16_t elev = (int16_t)(s1[0] | (s1[1]<<8));
    int16_t grip = (int16_t)(s1[2] | (s1[3]<<8));
    uint16_t L = (uint16_t)(ln[0] | (ln[1]<<8));
    uint16_t R = (uint16_t)(ln[2] | (ln[3]<<8));
    uint16_t thr = (uint16_t)(ln[4] | (ln[5]<<8));
    Serial.printf("elev=%d,grip=%d,L=%u,R=%u,thr=%u\n", elev, grip, L, R, thr);
  }
}
