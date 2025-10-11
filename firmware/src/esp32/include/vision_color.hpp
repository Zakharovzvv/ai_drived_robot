#pragma once
#include <Arduino.h>
#include "config.hpp"

bool cam_init();
ColorID detect_cylinder_color(); // returns C_*