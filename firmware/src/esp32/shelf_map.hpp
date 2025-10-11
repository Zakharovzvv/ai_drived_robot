#pragma once
#include <Arduino.h>

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
void shelf_cli_process(Stream& io);