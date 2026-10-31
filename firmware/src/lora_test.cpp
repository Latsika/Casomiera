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

constexpr uint8_t BUTTON_PIN = 6;
constexpr uint8_t GNSS_POWER_PIN = 3;
constexpr uint8_t GNSS_PPS_PIN = 36;
constexpr uint32_t BUTTON_DEBOUNCE_MS = 30;

volatile uint32_t ppsPulseCount = 0;
uint32_t buttonPressCount = 0;
uint32_t buttonChangedAtMs = 0;
int buttonRawLevel = HIGH;
bool buttonReleased = false;

constexpr uint8_t GNSS_UART_RX_PIN = 33;
constexpr uint32_t GNSS_UART_BAUD = 115200;
constexpr size_t MAX_GNSS_LINE_LENGTH = 160;

HardwareSerial gnssSerial(1);
String gnssLine;
String lastRmcUtc;
String lastRmcDate;
String lastRmcStatus;
uint32_t gnssByteCount = 0;
uint32_t rmcMessageCount = 0;
uint32_t rmcChecksumErrors = 0;
uint32_t gnssLongLines = 0;
uint32_t lastRmcAtMs = 0;

constexpr uint32_t GNSS_SCAN_DURATION_MS = 10000;
bool gnssScanActive = false;
uint32_t gnssScanStartedAtMs = 0;
uint32_t gnssScanMessages = 0;
uint32_t gnssScanChecksumErrors = 0;

int hexDigitValue(char character) {
    if (character >= '0' && character <= '9') {
        return character - '0';
    }
    if (character >= 'A' && character <= 'F') {
        return character - 'A' + 10;
    }
    if (character >= 'a' && character <= 'f') {
        return character - 'a' + 10;
    }
    return -1;
}

bool hasValidNmeaChecksum(const String& line) {
    const int separator = line.indexOf('*');
    if (!line.startsWith("$") || separator < 1 ||
        separator + 3 != static_cast<int>(line.length())) {
        return false;
    }

    const int highDigit = hexDigitValue(line[separator + 1]);
    const int lowDigit = hexDigitValue(line[separator + 2]);
    if (highDigit < 0 || lowDigit < 0) {
        return false;
    }

    uint8_t checksum = 0;
    for (int index = 1; index < separator; ++index) {
        checksum ^= static_cast<uint8_t>(line[index]);
    }

    return checksum == ((highDigit << 4) | lowDigit);
}

String nmeaField(const String& line, size_t fieldNumber) {
    int start = 0;
    for (size_t field = 0; field < fieldNumber; ++field) {
        const int separator = line.indexOf(',', start);
        if (separator < 0) {
            return "";
        }
        start = separator + 1;
    }

    int end = line.indexOf(',', start);
    if (end < 0) {
        end = line.indexOf('*', start);
    }
    return end < 0 ? String("") : line.substring(start, end);
}

void printSatelliteDiagnostic(const String& line) {
    if (!gnssScanActive || line.length() < 7 ||
        line[0] != '$' || line[6] != ',') {
        return;
    }

    const String messageType = line.substring(3, 6);
    if (messageType != "GGA" &&
        messageType != "GSA" &&
        messageType != "GSV") {
        return;
    }

    if (!hasValidNmeaChecksum(line)) {
        ++gnssScanChecksumErrors;
        return;
    }

    ++gnssScanMessages;

    if (messageType == "GGA") {
        Serial.print("GNSS_SCAN ");
        Serial.print(line.substring(1, 6));
        Serial.print(" FIX_QUALITY=");
        Serial.print(nmeaField(line, 6));
        Serial.print(" SATELLITES_USED=");
        Serial.print(nmeaField(line, 7));
        Serial.print(" HDOP=");
        Serial.println(nmeaField(line, 8));
    } else {
        Serial.print("GNSS_SCAN ");
        Serial.println(line);
    }
}

void processGnssLine(const String& line) {
    printSatelliteDiagnostic(line);
    if (line.length() < 7 || line[0] != '$' ||
        line.substring(3, 7) != "RMC,") {
        return;
    }

    if (!hasValidNmeaChecksum(line)) {
        ++rmcChecksumErrors;
        return;
    }

    lastRmcUtc = nmeaField(line, 1);
    lastRmcStatus = nmeaField(line, 2);
    lastRmcDate = nmeaField(line, 9);
    lastRmcAtMs = millis();
    ++rmcMessageCount;
}

void pollGnss() {
    if (gnssScanActive &&
        millis() - gnssScanStartedAtMs >= GNSS_SCAN_DURATION_MS) {
        gnssScanActive = false;
        Serial.print("GNSS_SCAN END MESSAGES=");
        Serial.print(gnssScanMessages);
        Serial.print(" CHECKSUM_ERRORS=");
        Serial.println(gnssScanChecksumErrors);
    }

    for (size_t count = 0; count < 256 && gnssSerial.available(); ++count) {
        const char character = static_cast<char>(gnssSerial.read());
        ++gnssByteCount;

        if (character == '$') {
            gnssLine = "$";
        } else if (character == '\n') {
            if (!gnssLine.isEmpty()) {
                processGnssLine(gnssLine);
                gnssLine = "";
            }
        } else if (character != '\r' && !gnssLine.isEmpty()) {
            if (gnssLine.length() >= MAX_GNSS_LINE_LENGTH) {
                ++gnssLongLines;
                gnssLine = "";
            } else {
                gnssLine += character;
            }
        }
    }
}

void initializeGnssDiagnostics() {
    gnssLine.reserve(MAX_GNSS_LINE_LENGTH);
    gnssSerial.setRxBufferSize(2048);
    gnssSerial.begin(
        GNSS_UART_BAUD, SERIAL_8N1, GNSS_UART_RX_PIN, -1);
}

void printGnssDiagnostics() {
    Serial.print("GNSS UART_BYTES=");
    Serial.print(gnssByteCount);
    Serial.print(" RMC_COUNT=");
    Serial.print(rmcMessageCount);
    Serial.print(" CHECKSUM_ERRORS=");
    Serial.print(rmcChecksumErrors);
    Serial.print(" LONG_LINES=");
    Serial.print(gnssLongLines);

    if (rmcMessageCount == 0) {
        Serial.print(" RMC=NONE");
    } else {
        Serial.print(" UTC_HHMMSS=");
        Serial.print(lastRmcUtc.isEmpty() ? "-" : lastRmcUtc);
        Serial.print(" DATE_DDMMYY=");
        Serial.print(lastRmcDate.isEmpty() ? "-" : lastRmcDate);
        Serial.print(" RMC_STATUS=");
        Serial.print(lastRmcStatus.isEmpty() ? "-" : lastRmcStatus);
        Serial.print(" AGE_MS=");
        Serial.print(millis() - lastRmcAtMs);
    }

    Serial.println(" SYNC=UNVERIFIED");
}

void onPpsPulse() {
    ++ppsPulseCount;
}

void initializeInputDiagnostics() {
    pinMode(BUTTON_PIN, INPUT_PULLUP);
    buttonRawLevel = digitalRead(BUTTON_PIN);
    buttonChangedAtMs = millis();

    pinMode(GNSS_PPS_PIN, INPUT);
    attachInterrupt(
        digitalPinToInterrupt(GNSS_PPS_PIN), onPpsPulse, RISING);

    pinMode(GNSS_POWER_PIN, OUTPUT);
    digitalWrite(GNSS_POWER_PIN, HIGH);
}

void pollDiagnosticButton() {
    const int level = digitalRead(BUTTON_PIN);
    const uint32_t nowMs = millis();

    if (level != buttonRawLevel) {
        buttonRawLevel = level;
        buttonChangedAtMs = nowMs;
    }

    if (nowMs - buttonChangedAtMs < BUTTON_DEBOUNCE_MS) {
        return;
    }

    if (level == HIGH) {
        buttonReleased = true;
        return;
    }

    if (!buttonReleased) {
        return;
    }

    buttonReleased = false;
    ++buttonPressCount;

    Serial.print(
        LORA_TEST_SENDER ? "BUTTON A PRESSED " : "BUTTON B PRESSED ");
    Serial.println(buttonPressCount);
}

void printInputDiagnostics() {
    const uint32_t pulses = ppsPulseCount;

    Serial.print("DIAG BUTTON_PRESSES=");
    Serial.print(buttonPressCount);
    Serial.print(" PPS_PULSES=");
    Serial.println(pulses);
}

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
    printInputDiagnostics();
    printGnssDiagnostics();
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
    } else if (commandLine == "GNSS_SCAN") {
        gnssScanMessages = 0;
        gnssScanChecksumErrors = 0;
        gnssScanStartedAtMs = millis();
        gnssScanActive = true;
        Serial.println("GNSS_SCAN BEGIN DURATION_MS=10000");
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
    initializeInputDiagnostics();
    initializeGnssDiagnostics();

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
    pollGnss();
    pollDiagnosticButton();
    pollReceiver();
    pollUsb();
}
