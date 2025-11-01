#include <Arduino.h>
#include <Wire.h>

constexpr int kSdaPin = 8;
constexpr int kSclPin = 9;

void setup() {
  delay(1000);  // Задержка ПЕРЕД инициализацией Serial
  Serial.begin(9600);  // ТОТ ЖЕ baud что работал у вас!
  delay(1000);  // Задержка ПОСЛЕ Serial.begin
  
  Serial.println("=== STARTING ===");
  Serial.flush();
  
  Wire.begin(kSdaPin, kSclPin);
  
  Serial.println("=== WIRE INITIALIZED ===");
  Serial.println("\nI2C Scanner");
  Serial.print("Используемые контакты: SDA = ");
  Serial.print(kSdaPin);
  Serial.print(", SCL = ");
  Serial.println(kSclPin);
  Serial.flush();
}

void loop() {
  int nDevices = 0;

  Serial.println("Scanning...");

  for (byte address = 1; address < 127; ++address) {
    Wire.beginTransmission(address);
    byte error = Wire.endTransmission();

    if (error == 0) {
      Serial.print("I2C device found at address 0x");
      if (address < 16) {
        Serial.print("0");
      }
      Serial.print(address, HEX);
      Serial.print(" (SDA=");
      Serial.print(kSdaPin);
      Serial.print(", SCL=");
      Serial.print(kSclPin);
      Serial.println(")");

      ++nDevices;
    } else if (error == 4) {
      Serial.print("Unknown error at address 0x");
      if (address < 16) {
        Serial.print("0");
      }
      Serial.println(address, HEX);
    }
  }
  if (nDevices == 0) {
    Serial.println("No I2C devices found\n");
  } else {
    Serial.println("done\n");
  }
  delay(5000);
}
