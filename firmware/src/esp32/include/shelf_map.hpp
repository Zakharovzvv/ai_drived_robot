#pragma once
#include <Arduino.h>
#include "config.hpp"

struct ShelfMap {
  // row 0..2 bottom..top ; col 0..2 left..right
  ColorID map[3][3];
  void setDefault();
  void fromString(const String& s);
  String toString() const;
  bool loadNVS();
  bool saveNVS() const;
};
extern ShelfMap gShelf;
bool shelf_cli_handle(const String& cmd, Stream& io);
void shelf_cli_process(Stream& io);