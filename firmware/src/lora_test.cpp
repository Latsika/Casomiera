#include <Arduino.h>
#include <esp_timer.h>
#include <SPI.h>
#include <RadioLib.h>
#include <esp_random.h>
#include <driver/gpio.h>
#include <nvs.h>
#include <esp_app_desc.h>
#include <esp_mac.h>
#include "gnss_clock.h"
#include "gnss_clock_tests.h"
#include "station_attempt.h"

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
volatile int64_t lastPpsAtUs = 0;
volatile int64_t lastPpsIntervalUs = 0;
portMUX_TYPE ppsLock = portMUX_INITIALIZER_UNLOCKED;

struct PpsSnapshot {
    uint32_t count = 0;
    int64_t pulseAtUs = 0;
    int64_t intervalUs = 0;
    int64_t observedAtUs = 0;
};

PpsSnapshot lastRmcPps;

PpsSnapshot readPpsSnapshot() {
    PpsSnapshot snapshot;
    portENTER_CRITICAL(&ppsLock);
    snapshot.count = ppsPulseCount;
    snapshot.pulseAtUs = lastPpsAtUs;
    snapshot.intervalUs = lastPpsIntervalUs;
    snapshot.observedAtUs = esp_timer_get_time();
    portEXIT_CRITICAL(&ppsLock);
    return snapshot;
}

uint32_t buttonPressCount = 0;
uint32_t buttonChangedAtMs = 0;
int buttonRawLevel = HIGH;
bool buttonReleased = false;
volatile bool buttonCaptureEnabled = false;
volatile int64_t pendingButtonAtUs = 0;
timing::GnssClock timingClock;
bool ppsConfigConfirmed = false;
int64_t previousGnssPollUs = 0;
const uint32_t timingBootId = esp_random();
char timingBoardId[13] = {};
char timingFirmwareHash[65] = {};
timing::StationLedger automaticLedger;
int64_t automaticArmedAtUs = 0;
int64_t testPulseStartedUs = 0;

void forwardAutomaticRecord(const timing::StationRecord& record);
void forwardAutomaticError(const String& id, const char* reason);
void queueRadioJob(const String& packet);
void closeRemoteAttempt(const String& id);
extern uint32_t radioCreditUs;
extern bool radioNeedsCredit;
bool radioCanPrepare();
bool armRequiresRadioCredit(const String& id, bool remoteRequest);

void printAutomaticRecord(const timing::StationRecord& record) {
    Serial.printf("AUTO {\"station\":\"%c\",\"boot\":\"%08lx\",\"type\":\"%s\","
                  "\"id\":\"%s\",\"localUs\":\"%lld\",\"utcUs\":\"%lld\","
                  "\"generation\":%lu,\"valid\":%s}\n",
        LORA_TEST_SENDER ? 'A' : 'B', static_cast<unsigned long>(timingBootId),
        timing::stationPhaseName(record.phase), record.id,
        static_cast<long long>(record.localUs), static_cast<long long>(record.utcUs),
        static_cast<unsigned long>(record.clockGeneration), record.valid ? "true" : "false");
    forwardAutomaticRecord(record);
}

void printAutomaticStatus() {
    const int64_t nowUs = esp_timer_get_time();
    Serial.printf("AUTO {\"station\":\"%c\",\"boot\":\"%08lx\",\"type\":\"status\","
                  "\"tracking\":%s,\"clock\":\"%s\",\"generation\":%lu,"
                  "\"accuracy\":\"unverified\",\"radioCreditUs\":%lu,"
                  "\"boardId\":\"%s\",\"firmwareHash\":\"%s\",\"radioCanPrepare\":%s}\n",
        LORA_TEST_SENDER ? 'A' : 'B', static_cast<unsigned long>(timingBootId),
        timingClock.tracking(nowUs) ? "true" : "false", timingClock.state(nowUs),
        static_cast<unsigned long>(timingClock.generation()), static_cast<unsigned long>(radioCreditUs),
        timingBoardId, timingFirmwareHash, radioCanPrepare() ? "true" : "false");
}

void printAutomaticError(const String& id, const char* reason) {
    // Echo only validated identifiers into the JSON protocol.
    Serial.printf("AUTO {\"station\":\"%c\",\"boot\":\"%08lx\",\"type\":\"error\","
                  "\"id\":\"%s\",\"reason\":\"%s\"}\n",
        LORA_TEST_SENDER ? 'A' : 'B', static_cast<unsigned long>(timingBootId),
        timing::validAttemptId(id.c_str()) ? id.c_str() : "-", reason);
    forwardAutomaticError(id, reason);
}

struct CapturedEvent {
    uint32_t number;
    int64_t localUs;
    int64_t utcUs;
    uint32_t clockGeneration;
    bool valid;
};

constexpr size_t EVENT_CAPACITY = 32;
CapturedEvent capturedEvents[EVENT_CAPACITY] = {};
size_t capturedEventCount = 0;

void printCapturedEvent(const CapturedEvent& event) {
    Serial.printf("EVENT STATION=%c BOOT=%08lx NUMBER=%lu LOCAL_US=%lld"
                  " UTC_US=%lld CLOCK_GENERATION=%lu VALID=%d ACCURACY=UNVERIFIED\n",
        LORA_TEST_SENDER ? 'A' : 'B', static_cast<unsigned long>(timingBootId),
        static_cast<unsigned long>(event.number), static_cast<long long>(event.localUs),
        static_cast<long long>(event.utcUs),
        static_cast<unsigned long>(event.clockGeneration), event.valid ? 1 : 0);
}

void onButtonEdge() {
    portENTER_CRITICAL_ISR(&ppsLock);
    if (buttonCaptureEnabled) {
        pendingButtonAtUs = esp_timer_get_time();
        buttonCaptureEnabled = false;
    }
    portEXIT_CRITICAL_ISR(&ppsLock);
}

constexpr uint8_t GNSS_UART_RX_PIN = 33;
constexpr uint8_t GNSS_UART_TX_PIN = 34;
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

String pendingGnssQuery;
uint32_t gnssQueryStartedAtMs = 0;
constexpr uint32_t GNSS_QUERY_TIMEOUT_MS = 3000;
uint32_t lastPpsConfigRequestMs = 0;
void startGnssQuery(const char* query);

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
    if (!pendingGnssQuery.isEmpty() &&
        (line.startsWith(String("$") + pendingGnssQuery + ",") ||
         line.startsWith("$FAIL,"))) {
        if (hasValidNmeaChecksum(line)) {
            if (pendingGnssQuery == "CFGTP") {
                ppsConfigConfirmed = line == "$CFGTP,1000000,500000,1,0,0,0*73";
                if (!ppsConfigConfirmed) {
                    timingClock.invalidate("PPS_CONFIGURATION_UNCONFIRMED");
                }
            }
            Serial.print("GNSS_QUERY RESPONSE ");
            Serial.println(line);
            pendingGnssQuery = "";
        } else {
            Serial.println("GNSS_QUERY ERROR CHECKSUM");
        }
        return;
    }

    printSatelliteDiagnostic(line);
    if (line.length() < 7 || line[0] != '$' ||
        line.substring(3, 7) != "RMC,") {
        return;
    }

    if (!hasValidNmeaChecksum(line)) {
        ++rmcChecksumErrors;
        return;
    }

    lastRmcPps = readPpsSnapshot();
    lastRmcUtc = nmeaField(line, 1);
    lastRmcStatus = nmeaField(line, 2);
    lastRmcDate = nmeaField(line, 9);
    lastRmcAtMs = millis();
    ++rmcMessageCount;
    int64_t epochUs = 0;
    if (!ppsConfigConfirmed) {
        timingClock.invalidate("PPS_CONFIGURATION_UNCONFIRMED");
    } else if (lastRmcStatus != "A" ||
               !timing::parseRmcEpoch(lastRmcUtc.c_str(), lastRmcDate.c_str(), epochUs)) {
        timingClock.invalidate("INVALID_RMC");
    } else {
        timingClock.observe(epochUs, lastRmcPps.count, lastRmcPps.pulseAtUs,
                           lastRmcPps.intervalUs, lastRmcPps.observedAtUs);
    }
}

void pollGnss() {
    const int64_t nowUs = esp_timer_get_time();
    if (previousGnssPollUs != 0 && nowUs - previousGnssPollUs > 20000) {
        timingClock.invalidate("UART_PROCESSING_GAP");
        // Discard an uncertain buffered epoch; reacquire from fresh input.
        while (gnssSerial.available()) {
            gnssSerial.read();
        }
        gnssLine = "";
    }
    previousGnssPollUs = nowUs;
    if (!pendingGnssQuery.isEmpty() &&
        millis() - gnssQueryStartedAtMs >= GNSS_QUERY_TIMEOUT_MS) {
        Serial.print("GNSS_QUERY TIMEOUT ");
        Serial.println(pendingGnssQuery);
        pendingGnssQuery = "";
    }

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
    // A cold GNSS receiver may not answer the first power-on query.
    if (!ppsConfigConfirmed && rmcMessageCount != 0 && pendingGnssQuery.isEmpty() &&
        millis() - lastPpsConfigRequestMs >= 3000) {
        lastPpsConfigRequestMs = millis();
        startGnssQuery("CFGTP");
    }
}

void initializeGnssDiagnostics() {
    gnssLine.reserve(MAX_GNSS_LINE_LENGTH);
    gnssSerial.setRxBufferSize(2048);
    gnssSerial.begin(
        GNSS_UART_BAUD, SERIAL_8N1,
        GNSS_UART_RX_PIN, GNSS_UART_TX_PIN);
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
    portENTER_CRITICAL_ISR(&ppsLock);
    const int64_t nowUs = esp_timer_get_time();
    if (ppsPulseCount != 0) {
        lastPpsIntervalUs = nowUs - lastPpsAtUs;
    }
    lastPpsAtUs = nowUs;
    ppsPulseCount = ppsPulseCount + 1;
    portEXIT_CRITICAL_ISR(&ppsLock);
}

void initializeInputDiagnostics() {
    pinMode(BUTTON_PIN, INPUT_PULLUP);
    buttonRawLevel = digitalRead(BUTTON_PIN);
    buttonChangedAtMs = millis();
    attachInterrupt(digitalPinToInterrupt(BUTTON_PIN), onButtonEdge, FALLING);

    pinMode(GNSS_PPS_PIN, INPUT);
    attachInterrupt(
        digitalPinToInterrupt(GNSS_PPS_PIN), onPpsPulse, RISING);

    pinMode(GNSS_POWER_PIN, OUTPUT);
    digitalWrite(GNSS_POWER_PIN, HIGH);
}

void pollDiagnosticButton() {
    if (testPulseStartedUs != 0 && esp_timer_get_time() - testPulseStartedUs >= 60000) {
        gpio_set_level(static_cast<gpio_num_t>(BUTTON_PIN), 1);
        gpio_set_direction(static_cast<gpio_num_t>(BUTTON_PIN), GPIO_MODE_INPUT);
        gpio_pullup_en(static_cast<gpio_num_t>(BUTTON_PIN));
        testPulseStartedUs = 0;
    }
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
        portENTER_CRITICAL(&ppsLock);
        if (digitalRead(BUTTON_PIN) == HIGH) {
            pendingButtonAtUs = 0;
            buttonCaptureEnabled = true;
        }
        portEXIT_CRITICAL(&ppsLock);
        buttonReleased = true;
        return;
    }

    if (!buttonReleased) {
        return;
    }

    buttonReleased = false;
    ++buttonPressCount;

    int64_t eventLocalUs = 0;
    portENTER_CRITICAL(&ppsLock);
    eventLocalUs = pendingButtonAtUs;
    pendingButtonAtUs = 0;
    portEXIT_CRITICAL(&ppsLock);
    CapturedEvent event = {};
    event.number = buttonPressCount;
    event.localUs = eventLocalUs;
    event.clockGeneration = timingClock.generation();
    event.valid = eventLocalUs > 0 &&
        timingClock.toUtc(eventLocalUs, esp_timer_get_time(), event.utcUs);
    if (event.localUs >= automaticArmedAtUs &&
        automaticLedger.capture(event.localUs, event.utcUs, event.clockGeneration, event.valid)) {
        printAutomaticRecord(*automaticLedger.active());
    }
    if (capturedEventCount < EVENT_CAPACITY) {
        capturedEvents[capturedEventCount++] = event;
        printCapturedEvent(event);
    } else {
        Serial.println("EVENT ERROR STORAGE_FULL PREVIOUS_EVENTS_RETAINED");
    }

    Serial.print(
        LORA_TEST_SENDER ? "BUTTON A PRESSED " : "BUTTON B PRESSED ");
    Serial.println(buttonPressCount);
}

void printInputDiagnostics() {
    const uint32_t pulses = ppsPulseCount;
    portENTER_CRITICAL(&ppsLock);
    const int64_t pendingEdge = pendingButtonAtUs;
    const bool captureEnabled = buttonCaptureEnabled;
    portEXIT_CRITICAL(&ppsLock);

    Serial.print("DIAG BUTTON_PRESSES=");
    Serial.print(buttonPressCount);
    Serial.print(" PPS_PULSES=");
    Serial.print(pulses);
    Serial.printf(" GPIO6_LEVEL=%d BUTTON_RELEASED=%d CAPTURE_ENABLED=%d EDGE_PENDING_US=%lld\n",
        digitalRead(BUTTON_PIN), buttonReleased ? 1 : 0, captureEnabled ? 1 : 0,
        static_cast<long long>(pendingEdge));
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
bool receiverDisplayDirty = false;

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

void printGnssTimingDiagnostics() {
    if (rmcMessageCount == 0) {
        Serial.println("GNSS_TIMING RMC=NONE SYNC=UNVERIFIED");
        return;
    }

    Serial.print("GNSS_TIMING RMC_COUNT=");
    Serial.print(rmcMessageCount);
    Serial.print(" PPS_AT_RMC=");
    Serial.print(lastRmcPps.count);

    if (lastRmcPps.count == 0) {
        Serial.print(" PPS=NONE");
    } else {
        Serial.printf(
            " PPS_LOCAL_US=%lld RMC_PROCESSED_LOCAL_US=%lld"
            " RMC_AFTER_PPS_US=%lld",
            static_cast<long long>(lastRmcPps.pulseAtUs),
            static_cast<long long>(lastRmcPps.observedAtUs),
            static_cast<long long>(
                lastRmcPps.observedAtUs - lastRmcPps.pulseAtUs));

        if (lastRmcPps.count >= 2) {
            Serial.printf(
                " PPS_INTERVAL_US=%lld",
                static_cast<long long>(lastRmcPps.intervalUs));
        } else {
            Serial.print(" PPS_INTERVAL_US=UNAVAILABLE");
        }
    }

    // UART buffering can delay RMC processing.
    // This observation does not establish UTC-to-PPS association.
    Serial.println(" SYNC=UNVERIFIED");
}

void printStatus() {
    Serial.print(LORA_TEST_SENDER ? "LORA A " : "LORA B ");
    Serial.print(radioState == RADIOLIB_ERR_NONE ? "READY " : "ERROR ");
    Serial.println(radioState);
    printInputDiagnostics();
    printGnssDiagnostics();
    printGnssTimingDiagnostics();
    Serial.printf("CLOCK STATE=%s SAMPLES=%lu GENERATION=%lu PPS_CONFIG=%d"
                  " ASSOCIATION=PRECEDING_PPS_CANDIDATE ACCURACY=UNVERIFIED\n",
        timingClock.state(esp_timer_get_time()),
        static_cast<unsigned long>(timingClock.samples()),
        static_cast<unsigned long>(timingClock.generation()), ppsConfigConfirmed ? 1 : 0);
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
    if (automaticLedger.active() != nullptr) {
        Serial.println("ERROR AUTOMATIC_ATTEMPT_ACTIVE");
        return;
    }
    if (hasSent && millis() - lastSendMs < SEND_INTERVAL_MS) {
        Serial.println("ERROR WAIT_30_SECONDS");
        return;
    }
    hasSent = true;
    lastSendMs = millis();
    queueRadioJob(String("CASOMIERA_TEST ") + String(++sequenceNumber));
    Serial.println("TEST_PACKET QUEUED");
}

void handleAutomaticOperation(const String& operation, const String& id, bool remoteRequest = false) {
    if (!timing::validAttemptId(id.c_str())) {
        printAutomaticError(id, "INVALID_ID");
        return;
    }
    // Cancellation is idempotent even when preparation failed on this station.
    // The coordinator must be able to cancel a partially prepared attempt.
    if (operation == "AUTO_CANCEL" && automaticLedger.find(id.c_str()) == nullptr) {
        closeRemoteAttempt(id);
        timing::StationRecord acknowledgement = {};
        strcpy(acknowledgement.id, id.c_str());
        acknowledgement.phase = timing::StationPhase::Cancelled;
        acknowledgement.clockGeneration = timingClock.generation();
        printAutomaticRecord(acknowledgement);
        return;
    }
    const char* error = nullptr;
    if (operation == "AUTO_ARM") {
        timing::StationRecord* existing = automaticLedger.find(id.c_str());
        if (existing == nullptr && !timingClock.tracking(esp_timer_get_time())) {
            error = "CLOCK_NOT_TRACKING";
        } else if (existing == nullptr && (!buttonReleased || digitalRead(BUTTON_PIN) != HIGH || !buttonCaptureEnabled)) {
            error = "RELEASE_BUTTON";
        } else if (existing == nullptr && armRequiresRadioCredit(id, remoteRequest) && radioCreditUs < 500000) {
            radioNeedsCredit = true;
            error = "RADIO_CREDIT_PENDING";
        } else {
            error = automaticLedger.arm(id.c_str(), timingClock.generation());
            if (error == nullptr && existing == nullptr) {
                automaticArmedAtUs = esp_timer_get_time();
            }
        }
    } else if (operation == "AUTO_CANCEL" || operation == "AUTO_COMPLETE") {
        error = automaticLedger.finish(id.c_str(), operation == "AUTO_CANCEL");
        if (error == nullptr && operation == "AUTO_CANCEL") closeRemoteAttempt(id);
    } else if (operation == "AUTO_ARCHIVE") {
        error = automaticLedger.archive(id.c_str());
        if (error == nullptr) {
            closeRemoteAttempt(id);
            Serial.println("AUTO_ARCHIVE OK");
            return;
        }
    } else if (operation != "AUTO_GET") {
        error = "INVALID_COMMAND";
    }
    timing::StationRecord* record = automaticLedger.find(id.c_str());
    if (error != nullptr || record == nullptr) {
        printAutomaticError(id, error == nullptr ? "ATTEMPT_MISMATCH" : error);
    } else {
        printAutomaticRecord(*record);
    }
}

// The radio transports immutable event timestamps. It never sets the clock.
String radioJobs[8];
size_t radioJobCount = 0;
bool radioTransmitting = false;
uint32_t radioTransmitStartedMs = 0;
uint32_t remoteSequence = 0;
String remoteAttemptId;
uint32_t remoteCoordinatorBoot = 0;
bool remoteAttemptClosed = false;
uint32_t retiredCoordinatorBoots[8] = {};
size_t retiredCoordinatorCount = 0;

void closeRemoteAttempt(const String& id) {
    if (LORA_TEST_SENDER && remoteAttemptId == id) remoteAttemptClosed = true;
}

struct RadioBudget {
    int64_t lastReservationSecond;
    uint32_t chargedUs;
};
RadioBudget radioBudget = {};
nvs_handle_t radioBudgetHandle = 0;
bool radioBudgetAvailable = false;
uint32_t radioCreditUs = 0;
bool radioNeedsCredit = false;
int64_t radioCreditGrantedAtUs = 0;
uint32_t lastBudgetTryMs = 0;

bool armRequiresRadioCredit(const String& id, bool remoteRequest) {
    return remoteRequest || (!LORA_TEST_SENDER && remoteAttemptId == id);
}

bool radioCanPrepare() {
    if (!radioBudgetAvailable) return false;
    if (radioCreditUs >= 500000) return true;
    int64_t utcUs = 0;
    const int64_t nowUs = esp_timer_get_time();
    if (!timingClock.toUtc(nowUs, nowUs, utcUs)) return false;
    return radioBudget.chargedUs <= 35500000 ||
        utcUs / 1000000 - radioBudget.lastReservationSecond > 3661;
}

void initializeRadioBudget() {
    radioBudgetAvailable = nvs_open("timing_airtime", NVS_READWRITE, &radioBudgetHandle) == ESP_OK;
    if (radioBudgetAvailable) {
        size_t size = sizeof(radioBudget);
        const esp_err_t result = nvs_get_blob(radioBudgetHandle, "budget", &radioBudget, &size);
        if (result == ESP_ERR_NVS_NOT_FOUND) {
            radioBudget = {};
        } else if (result != ESP_OK || size != sizeof(radioBudget) ||
                   radioBudget.chargedUs > 36000000) {
            radioBudgetAvailable = false;
        }
    }
}

void reserveRadioBudget() {
    // A reservation has a bounded lifetime. An hour reset is then measured
    // after its latest possible transmission, rather than its allocation time.
    if (radioCreditUs != 0 && esp_timer_get_time() - radioCreditGrantedAtUs > 60000000) {
        radioCreditUs = 0;
    }
    const timing::StationRecord* active = automaticLedger.active();
    if (!radioBudgetAvailable || radioCreditUs >= 500000 ||
        (!radioNeedsCredit && radioJobCount == 0) ||
        (active != nullptr && active->phase == timing::StationPhase::Armed) ||
        !buttonReleased || (lastBudgetTryMs != 0 && millis() - lastBudgetTryMs < 1000)) {
        return;
    }
    const int64_t nowUs = esp_timer_get_time();
    int64_t utcUs = 0;
    if (!timingClock.toUtc(nowUs, nowUs, utcUs)) {
        return;
    }
    const PpsSnapshot before = readPpsSnapshot();
    const int64_t pulseAgeUs = nowUs - before.pulseAtUs;
    // Write only well away from a PPS edge. This station is either idle or has
    // already captured its immutable event, so flash cannot delay its measurement.
    if (pulseAgeUs < 100000 || pulseAgeUs > 700000) return;
    lastBudgetTryMs = millis();
    RadioBudget updated = radioBudget;
    const int64_t second = utcUs / 1000000;
    // Reset only after an entire quiet hour since the last reservation. Unused
    // credit is charged after restart, so rebooting cannot replenish airtime.
    const bool expired = updated.lastReservationSecond == 0 || second - updated.lastReservationSecond > 3661;
    if (expired) {
        updated.chargedUs = 0;
    }
    if (second < updated.lastReservationSecond || updated.chargedUs >= 36000000) {
        return;
    }
    const uint32_t remainingUs = 36000000 - updated.chargedUs;
    const uint32_t reservationUs = remainingUs < 1000000 ? remainingUs : 1000000;
    if (reservationUs < 500000) return;
    updated.chargedUs += reservationUs;
    updated.lastReservationSecond = second;
    const int64_t writeStartedUs = esp_timer_get_time();
    if (nvs_set_blob(radioBudgetHandle, "budget", &updated, sizeof(updated)) == ESP_OK &&
        nvs_commit(radioBudgetHandle) == ESP_OK) {
        radioBudget = updated;
        radioCreditUs = (expired ? 0 : radioCreditUs) + reservationUs;
        radioCreditGrantedAtUs = esp_timer_get_time();
        radioNeedsCredit = false;
    } else {
        radioBudgetAvailable = false;
    }
    const PpsSnapshot after = readPpsSnapshot();
    if (after.observedAtUs - writeStartedUs > 20000 || before.count != after.count ||
        after.observedAtUs - before.pulseAtUs > 800000) {
        timingClock.invalidate("RADIO_BUDGET_WRITE_GAP");
    }
}

void queueRadioJob(const String& packet) {
    if (packet.length() > 240) {
        Serial.println("RADIO ERROR PACKET_TOO_LONG");
        return;
    }
    for (size_t index = 0; index < radioJobCount; ++index) {
        if (radioJobs[index] == packet) {
            return;
        }
    }
    if (radioJobCount == 8) {
        Serial.println("RADIO ERROR QUEUE_FULL DATA_RETAINED");
        return;
    }
    radioJobs[radioJobCount++] = packet;
}

void forwardAutomaticRecord(const timing::StationRecord& record) {
    if (!LORA_TEST_SENDER || remoteCoordinatorBoot == 0 || remoteAttemptId != record.id) {
        return;
    }
    char packet[220];
    snprintf(packet, sizeof(packet), "CT2 R %08lx %08lx %08lx %s %s %lld %lld %lu %d",
        static_cast<unsigned long>(remoteCoordinatorBoot), static_cast<unsigned long>(remoteSequence),
        static_cast<unsigned long>(timingBootId), timing::stationPhaseName(record.phase), record.id,
        static_cast<long long>(record.localUs), static_cast<long long>(record.utcUs),
        static_cast<unsigned long>(record.clockGeneration), record.valid ? 1 : 0);
    queueRadioJob(packet);
}

void forwardAutomaticError(const String& id, const char* reason) {
    if (!LORA_TEST_SENDER || remoteCoordinatorBoot == 0 || id != remoteAttemptId) {
        return;
    }
    char packet[180];
    snprintf(packet, sizeof(packet), "CT2 X %08lx %08lx %08lx %s %s",
        static_cast<unsigned long>(remoteCoordinatorBoot), static_cast<unsigned long>(remoteSequence),
        static_cast<unsigned long>(timingBootId), id.c_str(), reason);
    queueRadioJob(packet);
}

void handleRemoteCommand(const String& operation, const String& id) {
    if (LORA_TEST_SENDER || (operation != "STATUS" && !timing::validAttemptId(id.c_str()))) {
        printAutomaticError(id, "INVALID_REMOTE_COMMAND");
        return;
    }
    if ((operation == "ARM" || operation == "CANCEL") && id != remoteAttemptId) {
        remoteAttemptId = id;
        ++remoteSequence;
    }
    if (operation != "STATUS" && id != remoteAttemptId) {
        printAutomaticError(id, "REMOTE_ATTEMPT_MISMATCH");
        return;
    }
    char packet[150];
    snprintf(packet, sizeof(packet), "CT2 C %08lx %08lx %s %s",
        static_cast<unsigned long>(timingBootId), static_cast<unsigned long>(remoteSequence),
        operation.c_str(), operation == "STATUS" ? "-" : id.c_str());
    queueRadioJob(packet);
}

void receiveTimingPacket(const String& packet) {
    unsigned long coordinator = 0, sequence = 0, peerBoot = 0, generation = 0;
    char operation[24] = {}, id[41] = {}, reason[48] = {};
    int consumed = 0, valid = 0;
    long long localUs = 0, utcUs = 0;
    if (LORA_TEST_SENDER && sscanf(packet.c_str(), "CT2 C %8lx %8lx %23s %40s%n",
        &coordinator, &sequence, operation, id, &consumed) == 4 &&
        consumed == static_cast<int>(packet.length())) {
        if (strcmp(operation, "STATUS") == 0) {
            char response[220];
            snprintf(response, sizeof(response), "CT2 S %08lx %08lx %08lx %d %lu %s %s",
                coordinator, sequence, static_cast<unsigned long>(timingBootId),
                timingClock.tracking(esp_timer_get_time()) ? 1 : 0,
                static_cast<unsigned long>(timingClock.generation()), timingBoardId, timingFirmwareHash);
            queueRadioJob(response);
            return;
        }
        if (!timing::validAttemptId(id)) {
            return;
        }
        if (strcmp(operation, "ARM") == 0 || strcmp(operation, "CANCEL") == 0) {
            const bool newToken = remoteCoordinatorBoot != coordinator || sequence > remoteSequence;
            for (size_t index = 0; index < retiredCoordinatorCount; ++index) {
                if (retiredCoordinatorBoots[index] == coordinator) return;
            }
            if (remoteCoordinatorBoot == coordinator &&
                (sequence < remoteSequence || (sequence == remoteSequence && remoteAttemptId != id))) {
                return;  // Reject delayed commands from replaced/cancelled attempts.
            }
            if (!newToken && remoteAttemptClosed && strcmp(operation, "ARM") == 0) return;
            if (remoteCoordinatorBoot != 0 && remoteCoordinatorBoot != coordinator) {
                if (automaticLedger.active() != nullptr && strcmp(automaticLedger.active()->id, id) != 0) return;
                if (retiredCoordinatorCount == 8) return;
                retiredCoordinatorBoots[retiredCoordinatorCount++] = remoteCoordinatorBoot;
            }
            if (strcmp(operation, "ARM") == 0 && sequence > remoteSequence && remoteCoordinatorBoot == coordinator && automaticLedger.active() != nullptr &&
                strcmp(automaticLedger.active()->id, id) != 0) {
                automaticLedger.finish(automaticLedger.active()->id, true);
            }
            remoteCoordinatorBoot = coordinator;
            remoteSequence = sequence;
            remoteAttemptId = id;
            if (newToken) remoteAttemptClosed = false;
        }
        if (remoteCoordinatorBoot != coordinator || remoteSequence != sequence || remoteAttemptId != id) return;
        if (strcmp(operation, "ARM") != 0 && strcmp(operation, "GET") != 0 &&
            strcmp(operation, "CANCEL") != 0 && strcmp(operation, "COMPLETE") != 0 &&
            strcmp(operation, "ARCHIVE") != 0) return;
        handleAutomaticOperation(String("AUTO_") + operation, id, true);
        if (strcmp(operation, "CANCEL") == 0) remoteAttemptClosed = true;
        if (strcmp(operation, "ARCHIVE") == 0 && automaticLedger.find(id) == nullptr) {
            remoteAttemptClosed = true;
        }
        return;
    }
    if (LORA_TEST_SENDER) return;
    char peerBoard[13] = {}, peerFirmware[65] = {};
    consumed = 0;
    if (sscanf(packet.c_str(), "CT2 S %8lx %8lx %8lx %d %lu %12s %64s%n",
        &coordinator, &sequence, &peerBoot, &valid, &generation, peerBoard, peerFirmware, &consumed) == 7 &&
        consumed == static_cast<int>(packet.length()) && coordinator == timingBootId && (valid == 0 || valid == 1) &&
        strlen(peerBoard) == 12 && strspn(peerBoard, "0123456789abcdef") == 12 &&
        strlen(peerFirmware) == 64 && strspn(peerFirmware, "0123456789abcdef") == 64) {
        Serial.printf("AUTO {\"station\":\"A\",\"boot\":\"%08lx\",\"type\":\"status\","
                      "\"tracking\":%s,\"generation\":%lu,\"accuracy\":\"unverified\","
                      "\"boardId\":\"%s\",\"firmwareHash\":\"%s\"}\n",
            peerBoot, valid ? "true" : "false", generation, peerBoard, peerFirmware);
        return;
    }
    consumed = 0;
    if (sscanf(packet.c_str(), "CT2 R %8lx %8lx %8lx %23s %40s %lld %lld %lu %d%n",
        &coordinator, &sequence, &peerBoot, operation, id, &localUs, &utcUs, &generation, &valid, &consumed) == 9 &&
        consumed == static_cast<int>(packet.length()) && coordinator == timingBootId && sequence == remoteSequence &&
        remoteAttemptId == id && timing::validAttemptId(id) && (valid == 0 || valid == 1) &&
        (strcmp(operation, "armed") == 0 || strcmp(operation, "event") == 0 ||
         strcmp(operation, "complete") == 0 || strcmp(operation, "cancelled") == 0)) {
        Serial.printf("AUTO {\"station\":\"A\",\"boot\":\"%08lx\",\"type\":\"%s\","
                      "\"id\":\"%s\",\"localUs\":\"%lld\",\"utcUs\":\"%lld\",\"generation\":%lu,\"valid\":%s}\n",
            peerBoot, operation, id, localUs, utcUs, generation, valid ? "true" : "false");
        return;
    }
    consumed = 0;
    if (sscanf(packet.c_str(), "CT2 X %8lx %8lx %8lx %40s %47s%n",
        &coordinator, &sequence, &peerBoot, id, reason, &consumed) == 5 &&
        consumed == static_cast<int>(packet.length()) && coordinator == timingBootId && sequence == remoteSequence &&
        remoteAttemptId == id && timing::validAttemptId(id) && timing::validAttemptId(reason)) {
        Serial.printf("AUTO {\"station\":\"A\",\"boot\":\"%08lx\",\"type\":\"error\",\"id\":\"%s\",\"reason\":\"%s\"}\n",
            peerBoot, id, reason);
    }
}

void pollTimingRadio() {
    reserveRadioBudget();
    if (radioState != RADIOLIB_ERR_NONE) return;
    if (radioTransmitting) {
        if (digitalRead(RADIO_IRQ) == HIGH || millis() - radioTransmitStartedMs > 1500) {
            const bool timeout = digitalRead(RADIO_IRQ) == LOW;
            radio.finishTransmit();
            radioTransmitting = false;
            if (timeout) Serial.println("RADIO TX_TIMEOUT DATA_RETAINED");
            if (selectRadioDirection(false)) radioState = radio.startReceive();
        }
        return;
    }
    if (digitalRead(RADIO_IRQ) == HIGH) {
        String packet;
        const int16_t result = radio.readData(packet);
        radioState = radio.startReceive();
        if (result == RADIOLIB_ERR_NONE && packet.startsWith("CT2 ")) {
            receiveTimingPacket(packet);
        } else if (result == RADIOLIB_ERR_NONE && LORA_TEST_SENDER && packet.startsWith("ACK CASOMIERA_TEST ")) {
            Serial.println(packet == String("ACK CASOMIERA_TEST ") + String(sequenceNumber)
                ? String("ACK_RECEIVED ") + packet.substring(4)
                : String("ACK_UNEXPECTED ") + packet);
        } else if (result == RADIOLIB_ERR_NONE && packet.startsWith("CASOMIERA_TEST ") && !LORA_TEST_SENDER) {
#if !LORA_TEST_SENDER
            ++receivedPacketCount;
            lastReceivedPacket = packet;
            receiverDisplayDirty = true;
#endif
            Serial.println("RX " + packet);
            queueRadioJob(String("ACK ") + packet);
        }
    }
    if (radioJobCount == 0) return;
    const uint32_t airtimeUs = static_cast<uint32_t>(radio.getTimeOnAir(radioJobs[0].length()));
    if (airtimeUs == 0 || airtimeUs > radioCreditUs) return;
    if (!selectRadioDirection(true)) return;
    const int16_t result = radio.startTransmit(radioJobs[0]);
    // Charge attempted transmissions conservatively even if the driver fails.
    radioCreditUs -= airtimeUs;
    if (result != RADIOLIB_ERR_NONE) {
        Serial.println("RADIO TX_ERROR DATA_RETAINED");
        selectRadioDirection(false);
        radioState = radio.startReceive();
    } else {
        radioTransmitting = true;
        radioTransmitStartedMs = millis();
    }
    for (size_t index = 1; index < radioJobCount; ++index) radioJobs[index - 1] = radioJobs[index];
    radioJobs[--radioJobCount] = "";
}

void startGnssQuery(const char* query) {
    if (!pendingGnssQuery.isEmpty()) {
        Serial.println("GNSS_QUERY ERROR BUSY");
        return;
    }

    pendingGnssQuery = query;
    gnssQueryStartedAtMs = millis();

    // Parameter-free queries only read receiver information.
    // Input checksums are optional in the Unicore protocol.
    gnssSerial.print("$");
    gnssSerial.print(query);
    gnssSerial.print("\r\n");

    Serial.print("GNSS_QUERY SENT ");
    Serial.println(query);
}

void processUsbCommand() {
    commandLine.trim();

    if (commandLine == "STATUS") {
        printStatus();
    } else if (commandLine == "AUTO_STATUS") {
        printAutomaticStatus();
    } else if (commandLine.startsWith("REMOTE_")) {
        const int separator = commandLine.indexOf(' ');
        const String operation = commandLine.substring(7, separator < 0 ? commandLine.length() : separator);
        const String id = separator < 0 ? "" : commandLine.substring(separator + 1);
        handleRemoteCommand(operation, id);
    } else if (commandLine == "RADIO_BUDGET") {
        Serial.printf("RADIO_BUDGET CREDIT_US=%lu CHARGED_US=%lu AVAILABLE=%d QUEUED=%u\n",
            static_cast<unsigned long>(radioCreditUs), static_cast<unsigned long>(radioBudget.chargedUs),
            radioBudgetAvailable ? 1 : 0, static_cast<unsigned>(radioJobCount));
    } else if (commandLine == "RADIO_RELEASE_BUDGET") {
        if (automaticLedger.active() != nullptr || radioTransmitting || radioJobCount != 0 || !radioBudgetAvailable) {
            Serial.println("RADIO_BUDGET ERROR BUSY_OR_UNAVAILABLE");
        } else {
            RadioBudget updated = radioBudget;
            updated.chargedUs -= radioCreditUs;
            timingClock.invalidate("RADIO_BUDGET_RELEASE");
            if (nvs_set_blob(radioBudgetHandle, "budget", &updated, sizeof(updated)) == ESP_OK &&
                nvs_commit(radioBudgetHandle) == ESP_OK) {
                radioBudget = updated;
                radioCreditUs = 0;
                lastBudgetTryMs = millis();
                Serial.println("RADIO_BUDGET RELEASED");
            } else {
                radioBudgetAvailable = false;
                radioCreditUs = 0;
                Serial.println("RADIO_BUDGET ERROR STORAGE");
            }
        }
    } else if (commandLine == "TEST_PULSE") {
        if (!buttonReleased || testPulseStartedUs != 0 ||
            (automaticLedger.active() != nullptr && automaticLedger.active()->phase == timing::StationPhase::Armed) ||
            digitalRead(BUTTON_PIN) != HIGH) {
            Serial.println("TEST_PULSE ERROR NOT_READY");
        } else {
            // Open drain only sinks the shared test input; it never drives it high.
            const gpio_num_t pin = static_cast<gpio_num_t>(BUTTON_PIN);
            gpio_set_level(pin, 1);
            gpio_set_direction(pin, GPIO_MODE_INPUT_OUTPUT_OD);
            gpio_pullup_en(pin);
            testPulseStartedUs = esp_timer_get_time();
            gpio_set_level(pin, 0);
            Serial.println("TEST_PULSE BEGIN");
        }
    } else if (commandLine.startsWith("AUTO_")) {
        const int separator = commandLine.indexOf(' ');
        const String operation = separator < 0 ? commandLine : commandLine.substring(0, separator);
        const String id = separator < 0 ? "" : commandLine.substring(separator + 1);
        handleAutomaticOperation(operation, id);
    } else if (commandLine == "CLOCK_TEST") {
        Serial.println(timing::clockSelfTest() && timing::stationLedgerSelfTest()
            ? "CLOCK_TEST PASS" : "CLOCK_TEST FAIL");
    } else if (commandLine == "EVENTS") {
        for (size_t index = 0; index < capturedEventCount; ++index) {
            printCapturedEvent(capturedEvents[index]);
        }
        Serial.printf("EVENTS END COUNT=%u\n", static_cast<unsigned>(capturedEventCount));
    } else if (commandLine == "EVENT_CLEAR") {
        capturedEventCount = 0;
        Serial.println("EVENTS CLEARED");
    } else if (commandLine == "GNSS_VERSION") {
        startGnssQuery("PDTINFO");
    } else if (commandLine == "GNSS_PPS_CONFIG") {
        startGnssQuery("CFGTP");
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
            if (commandLine.length() >= 96) {
                commandLine = "";
                discardLine = true;
            } else {
                commandLine += character;
            }
        }
    }
}

void setup() {
    Serial.setTxBufferSize(8192);
    Serial.begin(115200);
    Serial.setTxTimeoutMs(0);
    uint8_t mac[6] = {};
    esp_efuse_mac_get_default(mac);
    for (size_t index = 0; index < 6; ++index) {
        snprintf(timingBoardId + index * 2, 3, "%02x", mac[index]);
    }
    const esp_app_desc_t* description = esp_app_get_description();
    for (size_t index = 0; index < 32; ++index) {
        snprintf(timingFirmwareHash + index * 2, 3, "%02x", description->app_elf_sha256[index]);
    }
    commandLine.reserve(96);
    initializeInputDiagnostics();
    initializeGnssDiagnostics();
    initializeRadioBudget();

    pinMode(FEM_ENABLE, OUTPUT);
    digitalWrite(FEM_ENABLE, LOW);
    pinMode(FEM_DIRECTION, OUTPUT);
    digitalWrite(FEM_DIRECTION, LOW);
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
        radioState = radio.startReceive();
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
    startGnssQuery("CFGTP");
}

void loop() {
    pollGnss();
    pollDiagnosticButton();
    pollTimingRadio();
    pollUsb();
#if !LORA_TEST_SENDER
    if (receiverDisplayDirty && automaticLedger.active() == nullptr && !radioTransmitting) {
        // Refresh the standalone-test display outside automatic measurements.
        timingClock.invalidate("DISPLAY_REFRESH");
        updateReceiverDisplay();
        receiverDisplayDirty = false;
    }
#endif
}
