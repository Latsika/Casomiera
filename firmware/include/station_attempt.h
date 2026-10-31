#pragma once

#include <stdint.h>
#include <string.h>

namespace timing {

enum class StationPhase { Empty, Armed, Captured, Complete, Cancelled };

struct StationRecord {
    char id[41] = {};
    StationPhase phase = StationPhase::Empty;
    int64_t localUs = 0;
    int64_t utcUs = 0;
    uint32_t clockGeneration = 0;
    bool valid = false;
};

inline bool validAttemptId(const char* id) {
    const size_t length = strlen(id);
    if (length == 0 || length > 40) {
        return false;
    }
    for (size_t index = 0; index < length; ++index) {
        const char character = id[index];
        if (!((character >= 'a' && character <= 'z') ||
              (character >= 'A' && character <= 'Z') ||
              (character >= '0' && character <= '9') ||
              character == '-' || character == '_')) {
            return false;
        }
    }
    return true;
}

inline const char* stationPhaseName(StationPhase phase) {
    switch (phase) {
        case StationPhase::Empty: return "empty";
        case StationPhase::Armed: return "armed";
        case StationPhase::Captured: return "event";
        case StationPhase::Complete: return "complete";
        case StationPhase::Cancelled: return "cancelled";
    }
    return "error";
}

// A delivery failure never changes a record. Only an explicit archive command
// may release a completed/cancelled slot after the application saves its copy.
class StationLedger {
public:
    static constexpr size_t CAPACITY = 32;

    StationRecord* find(const char* id) {
        for (StationRecord& record : records_) {
            if (record.phase != StationPhase::Empty && strcmp(record.id, id) == 0) {
                return &record;
            }
        }
        return nullptr;
    }

    StationRecord* active() {
        return activeIndex_ < 0 ? nullptr : &records_[activeIndex_];
    }

    const char* arm(const char* id, uint32_t generation = 0) {
        if (!validAttemptId(id)) {
            return "INVALID_ID";
        }
        StationRecord* existing = find(id);
        if (existing != nullptr) {
            return existing == active() ? nullptr : "ID_ALREADY_USED";
        }
        if (active() != nullptr) {
            return "BUSY";
        }
        for (size_t index = 0; index < CAPACITY; ++index) {
            if (records_[index].phase == StationPhase::Empty) {
                records_[index] = {};
                strcpy(records_[index].id, id);
                records_[index].phase = StationPhase::Armed;
                records_[index].clockGeneration = generation;
                activeIndex_ = static_cast<int>(index);
                return nullptr;
            }
        }
        return "STORAGE_FULL";
    }

    bool capture(int64_t localUs, int64_t utcUs, uint32_t generation, bool valid) {
        StationRecord* record = active();
        if (record == nullptr || record->phase != StationPhase::Armed) {
            return false;
        }
        record->localUs = localUs;
        record->utcUs = utcUs;
        record->valid = valid && generation == record->clockGeneration;
        record->phase = StationPhase::Captured;
        return true;
    }

    const char* finish(const char* id, bool cancel) {
        StationRecord* record = find(id);
        if (record == nullptr) {
            return "ATTEMPT_MISMATCH";
        }
        if (cancel && record->phase == StationPhase::Complete) {
            return "ALREADY_COMPLETE";
        }
        if (!cancel && record->phase != StationPhase::Captured &&
            record->phase != StationPhase::Complete) {
            return "EVENT_MISSING";
        }
        record->phase = cancel ? StationPhase::Cancelled : StationPhase::Complete;
        if (record == active()) {
            activeIndex_ = -1;
        }
        return nullptr;
    }

    const char* archive(const char* id) {
        StationRecord* record = find(id);
        if (record == nullptr) {
            return "ATTEMPT_MISMATCH";
        }
        if (record->phase != StationPhase::Complete && record->phase != StationPhase::Cancelled) {
            return "ATTEMPT_ACTIVE";
        }
        *record = {};
        return nullptr;
    }

private:
    StationRecord records_[CAPACITY] = {};
    int activeIndex_ = -1;
};

inline bool stationLedgerSelfTest() {
    StationLedger ledger;
    if (ledger.arm("bad id") == nullptr || ledger.arm("one") != nullptr ||
        ledger.arm("two") == nullptr || ledger.arm("one") != nullptr ||
        ledger.finish("other", true) == nullptr ||
        !ledger.capture(100, 200, 0, true) || ledger.capture(101, 201, 0, true) ||
        ledger.find("one")->utcUs != 200 || ledger.archive("one") == nullptr ||
        ledger.finish("one", true) != nullptr || ledger.find("one")->utcUs != 200 ||
        ledger.arm("one") == nullptr || ledger.arm("two") != nullptr ||
        ledger.finish("two", false) == nullptr ||
        !ledger.capture(300, 400, 2, false) || ledger.finish("two", false) != nullptr ||
        ledger.find("two")->valid || ledger.find("one")->utcUs != 200 ||
        ledger.archive("two") != nullptr) {
        return false;
    }
    return true;
}

}  // namespace timing
