#pragma once
#include <Arduino.h>

struct HSVRange { uint8_t h1,h2; uint8_t s_min,v_min; }; // simple ring on hue

enum ColorID { COL_UNKNOWN=-1, COL_BLACK=0, COL_BLUE, COL_GREEN, COL_YELLOW, COL_RED, COL_WHITE };

struct ColorClassifierCfg {
  HSVRange blue{  90, 130, 80, 50 };
  HSVRange green{ 45,  90, 60, 50 };
  HSVRange yellow{ 20,  45, 60, 60 };
  HSVRange red1{   0,  15, 60, 50 }; // wrap via 0
  HSVRange red2{ 330, 360, 60, 50 };
  HSVRange white{  0, 360,  0, 85 }; // high V low S
  HSVRange black{  0, 360,  0,  0 }; // low V
};

struct RGB { uint8_t r,g,b; };
struct HSV { float h,s,v; };

inline HSV rgb2hsv(const RGB& c){
  float r=c.r/255.0f,g=c.g/255.0f,b=c.b/255.0f;
  float mx=max(r,max(g,b)), mn=min(r,min(g,b));
  float d=mx-mn; float h=0;
  if(d==0) h=0; else if(mx==r) h=60.0f*fmod(((g-b)/d),6.0f);
  else if(mx==g) h=60.0f*(((b-r)/d)+2.0f);
  else h=60.0f*(((r-g)/d)+4.0f);
  if(h<0) h+=360.0f;
  float s = (mx==0)?0:(d/mx);
  float v = mx;
  return {h,s*100.0f,v*100.0f};
}

inline bool hueIn(uint16_t h, uint16_t a, uint16_t b){ if(a<=b) return h>=a && h<=b; return (h>=a||h<=b); }

inline ColorID classifyHSV(const HSV& p, const ColorClassifierCfg& cfg){
  if(p.v < 15) return COL_BLACK;
  if(p.s < 15 && p.v>85) return COL_WHITE;
  uint16_t h = (uint16_t)p.h;
  if(hueIn(h, cfg.blue.h1, cfg.blue.h2) && p.s>cfg.blue.s_min && p.v>cfg.blue.v_min) return COL_BLUE;
  if(hueIn(h, cfg.green.h1, cfg.green.h2) && p.s>cfg.green.s_min && p.v>cfg.green.v_min) return COL_GREEN;
  if(hueIn(h, cfg.yellow.h1, cfg.yellow.h2) && p.s>cfg.yellow.s_min && p.v>cfg.yellow.v_min) return COL_YELLOW;
  if( (hueIn(h, cfg.red1.h1, cfg.red1.h2) || hueIn(h, cfg.red2.h1, cfg.red2.h2)) && p.s>60 && p.v>50) return COL_RED;
  return COL_UNKNOWN;
}
