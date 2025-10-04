#pragma once
#include <Arduino.h>
inline void pack16(uint8_t* p, int16_t v){ memcpy(p,&v,2);} 
inline void packu16(uint8_t* p, uint16_t v){ memcpy(p,&v,2);} 
