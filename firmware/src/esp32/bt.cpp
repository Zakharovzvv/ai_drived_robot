#include "bt.h"
#include "i2c_link.h"
#include "vision_color.h"

static bool commitSEQ(BTContext& c){ return c.link->writeBlock(0x1E, &c.seq, 1); }

// Helpers to send commands
static void cmdDrive(BTContext& c, int16_t vx,int16_t vy,int16_t wz,uint16_t t){
  uint8_t p[8]; memcpy(&p[0],&vx,2); memcpy(&p[2],&vy,2); memcpy(&p[4],&wz,2); memcpy(&p[6],&t,2);
  c.link->writeBlock(0x00,p,8); c.seq++; commitSEQ(c);
}
static void cmdElev(BTContext& c, int16_t pos_mm, uint16_t vmax=120,uint16_t amax=400){
  uint8_t p[6]; memcpy(&p[0],&pos_mm,2); memcpy(&p[2],&vmax,2); memcpy(&p[4],&amax,2);
  c.link->writeBlock(0x10,p,6); c.seq++; commitSEQ(c);
}
static void cmdGrip(BTContext& c, uint8_t mode, int16_t pose_deg=0,uint8_t spd=60){
  uint8_t p[4]; p[0]=mode; memcpy(&p[1],&pose_deg,2); p[3]=spd;
  c.link->writeBlock(0x18,p,4); c.seq++; commitSEQ(c);
}
static void cmdBrake(BTContext& c, uint8_t on){ c.link->writeBlock(0x1C,&on,1); c.seq++; commitSEQ(c);} 
static void cmdHome(BTContext& c, uint8_t mask){ c.link->writeBlock(0x1D,&mask,1); c.seq++; commitSEQ(c);} 

// Very simple demo BT: homing -> small move -> open/close test -> idle
bool bt_tick(BTContext& ctx){
  switch(ctx.step){
    case 0: // BRAKE off, homing
      cmdBrake(ctx,0); delay(10);
      cmdHome(ctx, 0x01 | 0x02); // lift+grip
      ctx.t0 = millis(); ctx.step=1; break;
    case 1: // wait a bit
      if(millis()-ctx.t0 > 500){ ctx.step=2; }
      break;
    case 2: // open grip
      cmdGrip(ctx, 0); // OPEN
      ctx.t0=millis(); ctx.step=3; break;
    case 3:
      if(millis()-ctx.t0>300){ ctx.step=4; }
      break;
    case 4: // move forward 300ms
      cmdDrive(ctx, 200, 0, 0, 300);
      ctx.t0=millis(); ctx.step=5; break;
    case 5:
      if(millis()-ctx.t0>500){ ctx.step=6; }
      break;
    case 6: // close grip test
      cmdGrip(ctx, 1); ctx.t0=millis(); ctx.step=7; break;
    case 7:
      if(millis()-ctx.t0>400){ ctx.step=8; }
      break;
    case 8: // lift to H1 sample (100mm)
      cmdElev(ctx, 100); ctx.t0=millis(); ctx.step=9; break;
    case 9:
      if(millis()-ctx.t0>800){ ctx.step=10; }
      break;
    default:
      return true; // finished
  }
  return false;
}
