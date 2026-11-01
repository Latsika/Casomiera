#pragma once

#include "station_attempt.h"

namespace timing {

enum class IndependentPhase { Empty, Armed, Running, Finished, Complete, Cancelled };

inline const char* independentPhaseName(IndependentPhase phase) {
    switch (phase) {
        case IndependentPhase::Armed: return "armed";
        case IndependentPhase::Running: return "running";
        case IndependentPhase::Finished: return "finished";
        case IndependentPhase::Complete: return "complete";
        case IndependentPhase::Cancelled: return "cancelled";
        default: return "empty";
    }
}

struct IndependentRecord {
    char id[41] = {};
    IndependentPhase phase = IndependentPhase::Empty;
    int64_t armedUs = 0;
    int64_t startUs = 0;
    int64_t stopUs = 0;
    bool inputFault = false;
};

class IndependentLedger {
public:
    static constexpr size_t CAPACITY = 32;

    IndependentRecord* find(const char* id) {
        for (auto& record : records_) {
            if (record.phase != IndependentPhase::Empty && strcmp(record.id, id) == 0) return &record;
        }
        return nullptr;
    }

    IndependentRecord* active() { return activeIndex_ < 0 ? nullptr : &records_[activeIndex_]; }

    const char* arm(const char* id, int64_t nowUs) {
        if (!validAttemptId(id)) return "INVALID_ID";
        auto* existing = find(id);
        if (existing) return existing == active() ? nullptr : "ID_ALREADY_USED";
        for (const auto& retired : retiredIds_) {
            if (strcmp(retired, id) == 0) return "ID_ALREADY_USED";
        }
        if (active()) return "BUSY";
        for (size_t index = 0; index < CAPACITY; ++index) {
            if (records_[index].phase != IndependentPhase::Empty) continue;
            auto& record = records_[index];
            record = {};
            strcpy(record.id, id);
            record.armedUs = nowUs;
            record.phase = IndependentPhase::Armed;
            activeIndex_ = index;
            return nullptr;
        }
        return "STORAGE_FULL";
    }

    bool captureStart(int64_t atUs) {
        auto* record = active();
        if (!record || record->phase != IndependentPhase::Armed || record->inputFault ||
            atUs <= 0 || atUs < record->armedUs) return false;
        record->startUs = atUs;
        record->phase = IndependentPhase::Running;
        return true;
    }

    bool captureStop(int64_t atUs) {
        auto* record = active();
        if (!record || record->phase != IndependentPhase::Running || record->inputFault ||
            atUs <= record->startUs || atUs - record->startUs > 86400000000LL) return false;
        record->stopUs = atUs;
        record->phase = IndependentPhase::Finished;
        return true;
    }

    void invalidateInput() {
        auto* record = active();
        if (record && (record->phase == IndependentPhase::Armed ||
                       record->phase == IndependentPhase::Running)) record->inputFault = true;
    }

    const char* finish(const char* id, bool cancel) {
        auto* record = find(id);
        if (!record) {
            if (!cancel) return "ATTEMPT_MISMATCH";
            // Retain cancellation of an absent attempt so a delayed ARM cannot revive it.
            remember(id);
            return nullptr;
        }
        if (cancel && record->phase == IndependentPhase::Complete) return "ALREADY_COMPLETE";
        if (!cancel && record->phase != IndependentPhase::Finished &&
            record->phase != IndependentPhase::Complete) return "EVENT_MISSING";
        record->phase = cancel ? IndependentPhase::Cancelled : IndependentPhase::Complete;
        if (record == active()) activeIndex_ = -1;
        return nullptr;
    }

    const char* archive(const char* id) {
        auto* record = find(id);
        if (!record) return nullptr;  // Retrying an acknowledged archive is harmless.
        if (record->phase != IndependentPhase::Complete && record->phase != IndependentPhase::Cancelled) return "ATTEMPT_ACTIVE";
        remember(id);
        *record = {};
        return nullptr;
    }

private:
    IndependentRecord records_[CAPACITY] = {};
    // Bounded replay protection in addition to retained records and browser attempt binding.
    char retiredIds_[64][41] = {};
    size_t retiredIndex_ = 0;
    int activeIndex_ = -1;

    void remember(const char* id) {
        strcpy(retiredIds_[retiredIndex_], id);
        retiredIndex_ = (retiredIndex_ + 1) % 64;
    }
};

inline bool independentLedgerSelfTest() {
    IndependentLedger ledger;
    if (ledger.arm("one", 10) || ledger.captureStop(20) || ledger.captureStart(9) ||
        !ledger.captureStart(20) || ledger.captureStart(21) || !ledger.captureStop(30) ||
        ledger.find("one")->startUs != 20 || ledger.archive("one") == nullptr ||
        ledger.finish("one", false) || ledger.archive("one") || ledger.arm("one", 40) == nullptr ||
        ledger.finish("missing", true) || ledger.arm("missing", 40) == nullptr ||
        ledger.arm("two", 40) || !ledger.captureStart(50)) return false;
    ledger.invalidateInput();
    return !ledger.captureStop(60) && ledger.finish("two", true) == nullptr &&
        ledger.find("two")->startUs == 50;
}

}  // namespace timing
