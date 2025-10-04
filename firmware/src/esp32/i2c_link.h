#pragma once
#include <Arduino.h>
#include <Wire.h>

struct I2CLink {
  uint8_t addr = 0x12;
  bool begin(int sda=-1, int scl=-1, uint32_t freq=400000) {
    if(sda!=-1 && scl!=-1) Wire.begin(sda, scl, freq); else Wire.begin();
    Wire.setClock(freq);
    return true;
  }
  bool writeBlock(uint8_t reg, const uint8_t* data, size_t len){
    Wire.beginTransmission(addr);
    Wire.write(reg);
    Wire.write(data, len);
    return Wire.endTransmission()==0;
  }
  bool readBlock(uint8_t reg, uint8_t* buf, size_t len){
    Wire.beginTransmission(addr);
    Wire.write(reg);
    if(Wire.endTransmission(false)!=0) return false; // repeated start
    size_t n = Wire.requestFrom((int)addr, (int)len);
    for(size_t i=0;i<n;i++) buf[i]=Wire.read();
    return n==len;
  }
};
