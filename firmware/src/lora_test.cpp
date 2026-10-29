#include <Arduino.h>
#include <SPI.h>
#include <RadioLib.h>

#if !LORA_TEST_SENDER
#include <Adafruit_ST7735.h>
#endif

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

#if !LORA_TEST_SENDER
constexpr uint8_t DISPLAY_CS = 38;
constexpr uint8_t DISPLAY_DC = 40;
constexpr uint8_t DISPLAY_RESET = 39;
constexpr uint8_t DISPLAY_SCK = 41;
constexpr uint8_t DISPLAY_MOSI = 42;
constexpr uint8_t DISPLAY_BACKLIGHT = 21;
constexpr uint8_t DISPLAY_POWER = 3;

SPIClass displaySpi(HSPI);
Adafruit_ST7735 display(
    &displaySpi, DISPLAY_CS, DISPLAY_DC, DISPLAY_RESET);

uint32_t receivedPacketCount = 0;
String lastReceivedPacket = "NONE";

void updateReceiverDisplay() {
    display.fillScreen(ST77XX_BLACK);
    display.setTextColor(ST77XX_WHITE);
    display.setTextSize(1);
    display.setCursor(0, 0);

    if (radioState == RADIOLIB_ERR_NONE) {
        display.print("LORA B READY");
    } else {
        display.print("LORA B ERROR ");
        display.print(radioState);
    }

    display.setTextSize(2);
    display.setCursor(0, 20);
    display.print("RX ");
    display.print(receivedPacketCount);

    display.setTextSize(1);
    display.setCursor(0, 46);
    display.print("LAST PACKET:");
    display.setCursor(0, 58);
    display.print(lastReceivedPacket);
    display.setCursor(0, 70);
    display.print("RESET CLEARS COUNT");
}

void initializeReceiverDisplay() {
    pinMode(DISPLAY_POWER, OUTPUT);
    digitalWrite(DISPLAY_POWER, HIGH);
    pinMode(DISPLAY_BACKLIGHT, OUTPUT);
    digitalWrite(DISPLAY_BACKLIGHT, HIGH);
    delay(80);

    displaySpi.begin(
        DISPLAY_SCK, -1, DISPLAY_MOSI, DISPLAY_CS);
    display.initR(INITR_MINI160x80);
    display.setRotation(1);

    // Match the manufacturer's V2 panel orientation and color order.
    const uint8_t orientation =
        ST77XX_MADCTL_MY | ST77XX_MADCTL_MV | ST7735_MADCTL_BGR;
    display.sendCommand(ST77XX_MADCTL, &orientation, 1);
    display.setTextWrap(false);
}
#endif

void printStatus() {
    Serial.print(LORA_TEST_SENDER ? "LORA A " : "LORA B ");
    Serial.print(radioState == RADIOLIB_ERR_NONE ? "READY " : "ERROR ");
    Serial.println(radioState);
}

bool selectRadioDirection(bool transmitting) {
    radioState = radio.standby();
    if (radioState != RADIOLIB_ERR_NONE) {
        printStatus();
        return false;
    }

    digitalWrite(FEM_ENABLE, LOW);
    digitalWrite(FEM_DIRECTION, transmitting ? HIGH : LOW);
    digitalWrite(FEM_ENABLE, HIGH);
    delayMicroseconds(10);
    return true;
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

    if (!selectRadioDirection(true)) {
        return;
    }

    String packet =
        String("CASOMIERA_TEST ") + String(++sequenceNumber);

    hasSent = true;
    lastSendMs = millis();
    const int16_t result = radio.transmit(packet);

    if (result == RADIOLIB_ERR_NONE) {
        Serial.println("TX " + packet);
        if (!selectRadioDirection(false)) {
            return;
        }

        String acknowledgement;
        const int16_t receiveResult =
            radio.receive(acknowledgement, 0, 2000);

        if (receiveResult == RADIOLIB_ERR_NONE) {
            if (acknowledgement == String("ACK ") + packet) {
                Serial.println("ACK_RECEIVED " + packet);
            } else {
                Serial.println("ACK_UNEXPECTED " + acknowledgement);
            }
        } else if (receiveResult == RADIOLIB_ERR_RX_TIMEOUT) {
            Serial.println("ACK_TIMEOUT " + packet);
        } else {
            Serial.print("ACK_RX_ERROR ");
            Serial.println(receiveResult);
        }

        selectRadioDirection(true);
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
#if !LORA_TEST_SENDER
            ++receivedPacketCount;
            lastReceivedPacket = packet;
#endif
            Serial.print("RX ");
            Serial.print(packet);
            Serial.print(" RSSI=");
            Serial.print(radio.getRSSI());
            Serial.print(" SNR=");
            Serial.println(radio.getSNR());

            if (!selectRadioDirection(true)) {
                return;
            }

            // Allow A to switch from transmitting to receiving.
            delay(100);
            String acknowledgement = String("ACK ") + packet;
            const int16_t acknowledgementResult =
                radio.transmit(acknowledgement);

            if (acknowledgementResult == RADIOLIB_ERR_NONE) {
                Serial.println("ACK_TX " + packet);
            } else {
                Serial.print("ACK_TX_ERROR ");
                Serial.println(acknowledgementResult);
            }

            if (!selectRadioDirection(false)) {
                return;
            }
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
#if !LORA_TEST_SENDER
    updateReceiverDisplay();
#endif
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

#if !LORA_TEST_SENDER
    initializeReceiverDisplay();
    updateReceiverDisplay();
#endif
    printStatus();
}

void loop() {
    pollReceiver();
    pollUsb();
}
