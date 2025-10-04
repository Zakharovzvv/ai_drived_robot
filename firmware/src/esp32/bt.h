#pragma once
#include <Arduino.h>
#include "i2c_link.h"

enum BTState{ BT_INIT, BT_SCAN_SHELF, BT_LOOP, BT_FINISH };

struct BTContext{
  I2CLink *link;
  uint8_t seq=1; uint8_t last_seq_ack=0;
  // targets etc.
  int step=0; uint32_t t0=0;
};

bool bt_tick(BTContext& ctx);
