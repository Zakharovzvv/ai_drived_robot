
# Firmware projects (UNO + ESP32-S3)

This folder contains two PlatformIO projects you can open in VS Code (PlatformIO extension) and use to build/flash the boards.


- `firmware/uno/` — Arduino UNO project

  - Board: `uno` (Atmega328P)
  - Open `firmware/uno/` in PlatformIO or use the PlatformIO "Open Project" command. Source is under `firmware/uno/src/`.


- `firmware/esp32/` — ESP32-S3 project

  - Board: `esp32-s3-devkitc-1` (adjust `board` in `platformio.ini` if different)
  - Source is under `firmware/esp32/src/`.


## How to build & upload (VS Code + PlatformIO extension)

1. Install PlatformIO extension in VS Code.
2. Open the workspace root.
3. In the Explorer, right-click the project folder (`firmware/uno` or `firmware/esp32`) and choose "Open Project in PlatformIO" or use the PlatformIO Home to open the project.
4. Build with the build button, and upload with the upload button. Use the Monitor to view serial output.


## Notes

- UNO uses built-in `Wire` and `Servo` libraries.
- ESP32 expects Arduino core for ESP32; PSRAM optional.
- If your board uses non-default I2C pins, set SDA/SCL in `main.cpp` (defines `I2C_SDA` / `I2C_SCL`).
