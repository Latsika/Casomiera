#include <Arduino.h>
#include <esp_random.h>
#include <esp_timer.h>

enum class AttemptState {
    Idle,
    Armed,
    Running,
    Finished,
    Cancelled
};

constexpr size_t MAX_LINE_LENGTH = 96;
constexpr size_t MAX_ATTEMPT_ID_LENGTH = 40;

AttemptState attemptState = AttemptState::Idle;
String attemptId;
String inputLine;
char bootId[17];
bool discardLine = false;
int64_t startedAtUs = 0;
int64_t elapsedUs = 0;

const char* stateName() {
    switch (attemptState) {
        case AttemptState::Idle: return "IDLE";
        case AttemptState::Armed: return "ARMED";
        case AttemptState::Running: return "RUNNING";
        case AttemptState::Finished: return "FINISHED";
        case AttemptState::Cancelled: return "CANCELLED";
    }
    return "UNKNOWN";
}

void sendMessage(const String& message) {
    Serial.print("V1 ");
    Serial.print(bootId);
    Serial.print(' ');
    Serial.println(message);
}

void sendError(const String& id, const char* reason) {
    sendMessage("ERROR " + id + " " + reason);
}

void sendStatus() {
    char duration[24];
    snprintf(
        duration,
        sizeof(duration),
        "%lld",
        static_cast<long long>(elapsedUs)
    );

    sendMessage(
        String("STATUS ") + stateName() + " " +
        (attemptId.isEmpty() ? "-" : attemptId) + " " + duration
    );
}

bool isValidAttemptId(const String& id) {
    if (id.isEmpty() || id.length() > MAX_ATTEMPT_ID_LENGTH) {
        return false;
    }

    for (size_t index = 0; index < id.length(); ++index) {
        const char character = id[index];
        const bool allowed =
            (character >= 'a' && character <= 'z') ||
            (character >= 'A' && character <= 'Z') ||
            (character >= '0' && character <= '9') ||
            character == '-' || character == '_';

        if (!allowed) {
            return false;
        }
    }
    return true;
}

void processCommand(const String& line) {
    if (line == "STATUS") {
        sendStatus();
        return;
    }

    const int separator = line.indexOf(' ');
    if (separator <= 0) {
        sendError("-", "INVALID_COMMAND");
        return;
    }

    const String command = line.substring(0, separator);
    const String id = line.substring(separator + 1);

    if (!isValidAttemptId(id)) {
        sendError("-", "INVALID_ID");
        return;
    }

    if (command == "ARM") {
        if (id == attemptId) {
            sendStatus();
            return;
        }

        if (attemptState == AttemptState::Armed ||
            attemptState == AttemptState::Running) {
            sendError(id, "BUSY");
            return;
        }

        attemptId = id;
        startedAtUs = 0;
        elapsedUs = 0;
        attemptState = AttemptState::Armed;
        sendMessage("READY " + id);
        return;
    }

    if (command != "TEST_START" &&
        command != "TEST_STOP" &&
        command != "CANCEL") {
        sendError(id, "INVALID_COMMAND");
        return;
    }

    if (id != attemptId) {
        sendError(id, "ATTEMPT_MISMATCH");
        return;
    }

    if (command == "CANCEL") {
        attemptState = AttemptState::Cancelled;
        startedAtUs = 0;
        elapsedUs = 0;
        sendMessage("CANCELLED " + id);
        return;
    }

    if (command == "TEST_START" &&
        attemptState == AttemptState::Armed) {
        startedAtUs = esp_timer_get_time();
        attemptState = AttemptState::Running;
        sendMessage("STARTED " + id);
        return;
    }

    if (command == "TEST_STOP" &&
        attemptState == AttemptState::Running) {
        elapsedUs = esp_timer_get_time() - startedAtUs;
        attemptState = AttemptState::Finished;

        char duration[24];
        snprintf(
            duration,
            sizeof(duration),
            "%lld",
            static_cast<long long>(elapsedUs)
        );

        sendMessage("FINISHED " + id + " " + duration);
        return;
    }

    sendError(id, "INVALID_STATE");
}

void setup() {
    Serial.begin(115200);

    snprintf(
        bootId,
        sizeof(bootId),
        "%08lx%08lx",
        static_cast<unsigned long>(esp_random()),
        static_cast<unsigned long>(esp_random())
    );

    inputLine.reserve(MAX_LINE_LENGTH);
}

void loop() {
    // Limit each pass so input processing does not monopolize the loop.
    for (size_t count = 0; count < 64 && Serial.available(); ++count) {
        const char character = static_cast<char>(Serial.read());

        if (character == '\n') {
            if (discardLine) {
                sendError("-", "LINE_TOO_LONG");
            } else {
                inputLine.trim();
                if (!inputLine.isEmpty()) {
                    processCommand(inputLine);
                }
            }

            inputLine = "";
            discardLine = false;
        } else if (character != '\r' && !discardLine) {
            if (inputLine.length() >= MAX_LINE_LENGTH) {
                inputLine = "";
                discardLine = true;
            } else {
                inputLine += character;
            }
        }
    }
}
