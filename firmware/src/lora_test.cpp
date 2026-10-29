#include <Arduino.h>
#include <SPI.h>
#include <RadioLib.h>

// Heltec Wireless Tracker V2 with KCT8103L RF front end.
constexpr uint8_t RADIO_CS = 8;
constexpr uint8_t RADIO_IRQ = 14;
constexpr uint8_t RADIO_RESET = 12;
constexpr uint8_t RADIO_BUSY = 13;
constexpr uint8_t RADIO_SCK = 9;
constexpr uint8_t RADIO_MISO = 11;
constexpr uint8_t RADIO_MOSI = 10;
constexpr uint8_t FEM_POWER = 7;
constexpr uint8_t FEM_ENABLE = 4;
constexpr uint8_t FEM_DIRECTION = 5;
constexpr uint32_t SEND_INTERVAL_MS = 30000;

Module radioModule(RADIO_CS, RADIO_IRQ, RADIO_RESET, RADIO_BUSY);
SX1262 radio(&radioModule);

String commandLine;
bool discardLine = false;
int16_t radioState = RADIOLIB_ERR_UNKNOWN;
uint32_t sequenceNumber = 0;
uint32_t lastSendMs = 0;
bool hasSent = false;

void printStatus() {
    Serial.print(LORA_TEST_SENDER ? "LORA A " : "LORA B ");
    Serial.print(radioState == RADIOLIB_ERR_NONE ? "READY " : "ERROR ");
    Serial.println(radioState);
}

void sendTestPacket() {
    if (!LORA_TEST_SENDER) {
        Serial.println("ERROR RECEIVER_ONLY");
        return;
    }

    if (radioState != RADIOLIB_ERR_NONE) {
        printStatus();
        return;
    }

    if (hasSent && millis() - lastSendMs < SEND_INTERVAL_MS) {
        Serial.println("ERROR WAIT_30_SECONDS");
        return;
    }

    String packet =
        String("CASOMIERA_TEST ") + String(++sequenceNumber);

    hasSent = true;
    lastSendMs = millis();
    const int16_t result = radio.transmit(packet);

    if (result == RADIOLIB_ERR_NONE) {
        Serial.println("TX " + packet);
    } else {
        Serial.print("TX_ERROR ");
        Serial.println(result);
    }
}

void processUsbCommand() {
    commandLine.trim();

    if (commandLine == "STATUS") {
        printStatus();
    } else if (commandLine == "SEND") {
        sendTestPacket();
    } else if (!commandLine.isEmpty()) {
        Serial.println("ERROR INVALID_COMMAND");
    }
}

void pollUsb() {
    for (size_t count = 0; count < 64 && Serial.available(); ++count) {
        const char character = static_cast<char>(Serial.read());

        if (character == '\n') {
            if (discardLine) {
                Serial.println("ERROR LINE_TOO_LONG");
            } else {
                processUsbCommand();
            }
            commandLine = "";
            discardLine = false;
        } else if (character != '\r' && !discardLine) {
            if (commandLine.length() >= 32) {
                commandLine = "";
                discardLine = true;
            } else {
                commandLine += character;
            }
        }
    }
}

void pollReceiver() {
    if (LORA_TEST_SENDER || radioState != RADIOLIB_ERR_NONE ||
        digitalRead(RADIO_IRQ) == LOW) {
        return;
    }

    String packet;
    const int16_t result = radio.readData(packet);

    if (result == RADIOLIB_ERR_NONE) {
        if (packet.startsWith("CASOMIERA_TEST ")) {
            Serial.print("RX ");
            Serial.print(packet);
            Serial.print(" RSSI=");
            Serial.print(radio.getRSSI());
            Serial.print(" SNR=");
            Serial.println(radio.getSNR());
        } else {
            Serial.println("RX OTHER_PACKET");
        }
    } else {
        Serial.print("RX_ERROR ");
        Serial.println(result);
    }

    radioState = radio.startReceive();
    if (radioState != RADIOLIB_ERR_NONE) {
        printStatus();
    }
}

void setup() {
    Serial.begin(115200);
    commandLine.reserve(32);

    pinMode(FEM_ENABLE, OUTPUT);
    digitalWrite(FEM_ENABLE, LOW);
    pinMode(FEM_DIRECTION, OUTPUT);
    digitalWrite(FEM_DIRECTION, LORA_TEST_SENDER ? HIGH : LOW);
    pinMode(FEM_POWER, OUTPUT);
    digitalWrite(FEM_POWER, HIGH);
    delay(10);

    SPI.begin(RADIO_SCK, RADIO_MISO, RADIO_MOSI, RADIO_CS);

    // MHz, kHz, SF, coding rate, sync word, chip power,
    // preamble symbols, TCXO voltage.
    radioState = radio.begin(868.1, 125.0, 7, 5, 0x12, -9, 8, 1.8);

    if (radioState == RADIOLIB_ERR_NONE) {
        radioState = radio.setDio2AsRfSwitch(true);
    }

    if (radioState == RADIOLIB_ERR_NONE) {
        digitalWrite(FEM_ENABLE, HIGH);
        if (!LORA_TEST_SENDER) {
            radioState = radio.startReceive();
        }
    }

    if (radioState != RADIOLIB_ERR_NONE) {
        digitalWrite(FEM_ENABLE, LOW);
        digitalWrite(FEM_POWER, LOW);
    }

    printStatus();
}

void loop() {
    pollReceiver();
    pollUsb();
}
