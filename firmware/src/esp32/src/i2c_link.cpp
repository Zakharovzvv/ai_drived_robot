#include "i2c_link.hpp"

bool i2c_init(){
  Wire.begin(I2C_SDA, I2C_SCL, I2C_FREQ);
  return true;
}
static bool write_reg(uint8_t reg, const uint8_t* buf, size_t n){
  Wire.beginTransmission(I2C_ADDR_UNO);
  Wire.write(reg);
  Wire.write(buf, n);
  return Wire.endTransmission()==0;
}
static bool read_reg(uint8_t reg, uint8_t* buf, size_t n){
  Wire.beginTransmission(I2C_ADDR_UNO);
  Wire.write(reg);
  if(Wire.endTransmission(false)!=0) return false;
  size_t r = Wire.requestFrom(I2C_ADDR_UNO, (uint8_t)n);
  if(r!=n) return false;
  for(size_t i=0;i<n;i++) buf[i]=Wire.read();
  return true;
}

bool i2c_read(uint8_t addr, uint8_t* buf, size_t n){ return read_reg(addr, buf, n); }
bool i2c_write(uint8_t addr, const uint8_t* buf, size_t n){ return write_reg(addr, buf, n); }

bool i2c_cmd_drive(int16_t vx,int16_t vy,int16_t w,int16_t t_ms){
  uint8_t b[8];
  memcpy(b+0,&vx,2); memcpy(b+2,&vy,2); memcpy(b+4,&w,2); memcpy(b+6,&t_ms,2);
  return write_reg(ICD::DRIVE,b,8);
}
bool i2c_cmd_elev(int16_t h_mm,int16_t v_mmps,uint8_t mode){
  uint8_t b[6]; memcpy(b+0,&h_mm,2); memcpy(b+2,&v_mmps,2); b[4]=mode; b[5]=0;
  return write_reg(ICD::ELEV,b,6);
}
bool i2c_cmd_grip(uint8_t cmd,int16_t arg_deg){
  uint8_t b[4]; b[0]=cmd; memcpy(b+1,&arg_deg,2); b[3]=0;
  return write_reg(ICD::GRIP,b,4);
}
bool i2c_cfg_line(uint16_t thr){ return write_reg(ICD::CFG_LINE,(uint8_t*)&thr,2); }
bool i2c_cfg_lift(uint16_t enc_per_mm,int16_t h1,int16_t h2,int16_t h3){
  uint8_t b[8]; memcpy(b+0,&enc_per_mm,2); memcpy(b+2,&h1,2); memcpy(b+4,&h2,2); memcpy(b+6,&h3,2);
  return write_reg(ICD::CFG_LIFT,b,8);
}
bool i2c_cfg_grip(uint16_t potmin,uint16_t potmax,int16_t dmin,int16_t dmax){
  uint8_t b[8]; memcpy(b+0,&potmin,2); memcpy(b+2,&potmax,2); memcpy(b+4,&dmin,2); memcpy(b+6,&dmax,2);
  return write_reg(ICD::CFG_GRIP,b,8);
}
bool i2c_cfg_odo(uint16_t cpr,uint16_t gear_num,uint16_t gear_den,uint16_t wheel_mm,uint16_t track_mm){
  uint8_t b[10];
  memcpy(b+0,&cpr,2); memcpy(b+2,&gear_num,2); memcpy(b+4,&gear_den,2); memcpy(b+6,&wheel_mm,2); memcpy(b+8,&track_mm,2);
  return write_reg(ICD::CFG_ODO,b,10);
}
bool i2c_seq(){ uint8_t b=1; return write_reg(ICD::SEQ,&b,1); }

bool read_STATUS0(Status0& o){ return read_reg(ICD::STATUS0,(uint8_t*)&o,4); }
bool read_STATUS1(Status1& o){ return read_reg(ICD::STATUS1,(uint8_t*)&o,4); }
bool read_LINES(Lines& o){ return read_reg(ICD::LINES,(uint8_t*)&o,6); }
bool read_POWER(Power& o){ return read_reg(ICD::POWER,(uint8_t*)&o,4); }
bool read_DRIVEFB(DriveFB& o){ return read_reg(ICD::DRIVEFB,(uint8_t*)&o,8); }
bool read_AUXFB(AuxFB& o){ return read_reg(ICD::AUXFB,(uint8_t*)&o,4); }
bool read_SENS(Sens& o){ return read_reg(ICD::SENS,(uint8_t*)&o,4); }
bool read_ODOM(Odom& o){ return read_reg(ICD::ODOM,(uint8_t*)&o,8); }