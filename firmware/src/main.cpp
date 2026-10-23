#include <Arduino.h>

void setup() {
    Serial.begin(115200);
    delay(1500);
    Serial.println("HELTEC CASOMIERA");
    Serial.println("Firmware: TEST 0.1");
    Serial.println("USB communication: OK");
}

void loop() {
    Serial.println("HELTEC IS RUNNING");
    delay(1000);
}
