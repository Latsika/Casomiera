#pragma once

#include <stdint.h>
#include <stddef.h>
#include <string.h>

namespace timing {

inline int decimalPair(const char* text) {
    if (text[0] < '0' || text[0] > '9' ||
        text[1] < '0' || text[1] > '9') {
        return -1;
    }
    return (text[0] - '0') * 10 + text[1] - '0';
}

inline bool leapYear(int year) {
    return year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
}

// Only integral UTC seconds can label a 1 Hz PPS edge. Leap seconds
// and malformed/fractional epochs are rejected rather than guessed.
inline bool parseRmcEpoch(const char* utc, const char* date, int64_t& epochUs) {
    const size_t length = strlen(utc);
    if (strlen(date) != 6 || length < 6 || length > 16) {
        return false;
    }
    if (length != 6) {
        if (length < 8 || utc[6] != '.') {
            return false;
        }
        for (size_t index = 7; index < length; ++index) {
            if (utc[index] != '0') {
                return false;
            }
        }
    }
    const int hour = decimalPair(utc);
    const int minute = decimalPair(utc + 2);
    const int second = decimalPair(utc + 4);
    const int day = decimalPair(date);
    const int month = decimalPair(date + 2);
    const int shortYear = decimalPair(date + 4);
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59 ||
        second < 0 || second > 59 || month < 1 || month > 12 || shortYear < 0) {
        return false;
    }
    const int year = 2000 + shortYear;
    const int monthDays[] = {31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};
    const int daysInMonth = monthDays[month - 1] +
        ((month == 2 && leapYear(year)) ? 1 : 0);
    if (day < 1 || day > daysInMonth) {
        return false;
    }
    int64_t days = 10957;  // Days from 1970-01-01 to 2000-01-01.
    for (int previousYear = 2000; previousYear < year; ++previousYear) {
        days += leapYear(previousYear) ? 366 : 365;
    }
    for (int previousMonth = 1; previousMonth < month; ++previousMonth) {
        days += monthDays[previousMonth - 1];
        if (previousMonth == 2 && leapYear(year)) {
            ++days;
        }
    }
    days += day - 1;
    epochUs = ((days * 24 + hour) * 3600 + minute * 60 + second) * 1000000;
    return true;
}

struct ClockAnchor {
    int64_t localUs = 0;
    int64_t utcUs = 0;
    int64_t intervalUs = 0;
    uint32_t pulseCount = 0;
};

class GnssClock {
public:
    static constexpr uint32_t REQUIRED_SAMPLES = 5;
    static constexpr int64_t MAX_AGE_US = 1500000;
    static constexpr int64_t MAX_RMC_DELAY_US = 250000;

    void invalidate(const char* reason) {
        if (samples_ != 0) {
            ++generation_;
        }
        samples_ = 0;
        anchorCount_ = 0;
        reason_ = reason;
    }

    bool observe(int64_t utcUs, uint32_t pulseCount, int64_t pulseAtUs,
                 int64_t intervalUs, int64_t processedAtUs) {
        if (pulseAtUs <= 0 || intervalUs < 999000 || intervalUs > 1001000 ||
            processedAtUs < pulseAtUs ||
            processedAtUs - pulseAtUs > MAX_RMC_DELAY_US) {
            invalidate("INVALID_PPS_OR_RMC_DELAY");
            return false;
        }
        if (samples_ != 0) {
            const ClockAnchor& previous = anchors_[(anchorCount_ - 1) % HISTORY];
            if (pulseCount == previous.pulseCount && utcUs == previous.utcUs) {
                return false;  // A duplicate cannot refresh clock validity.
            }
            if (static_cast<uint32_t>(pulseCount - previous.pulseCount) != 1 ||
                utcUs - previous.utcUs != 1000000 ||
                pulseAtUs <= previous.localUs ||
                pulseAtUs - previous.localUs != intervalUs) {
                invalidate("EPOCH_DISCONTINUITY");
            }
        }
        ClockAnchor& anchor = anchors_[anchorCount_ % HISTORY];
        anchor = {pulseAtUs, utcUs, intervalUs, pulseCount};
        // Keep a bounded count without changing the circular write position.
        ++anchorCount_;
        if (anchorCount_ == 0) {
            invalidate("HISTORY_COUNTER_WRAP");
            return false;
        }
        if (samples_ < REQUIRED_SAMPLES) {
            ++samples_;
        }
        lastProcessedUs_ = processedAtUs;
        reason_ = samples_ >= REQUIRED_SAMPLES ? "TRACKING" : "ACQUIRING";
        return true;
    }

    bool tracking(int64_t nowUs) const {
        if (samples_ < REQUIRED_SAMPLES || nowUs < lastProcessedUs_) {
            return false;
        }
        const ClockAnchor& latest = anchors_[(anchorCount_ - 1) % HISTORY];
        return nowUs - lastProcessedUs_ <= MAX_AGE_US &&
            nowUs - latest.localUs <= MAX_AGE_US;
    }

    bool toUtc(int64_t eventLocalUs, int64_t nowUs, int64_t& eventUtcUs) const {
        if (!tracking(nowUs) || eventLocalUs > nowUs) {
            return false;
        }
        const uint32_t available = anchorCount_ < HISTORY ? anchorCount_ : HISTORY;
        for (uint32_t offset = 0; offset < available; ++offset) {
            const ClockAnchor& anchor = anchors_[(anchorCount_ - 1 - offset) % HISTORY];
            const int64_t delta = eventLocalUs - anchor.localUs;
            if (delta < 0) {
                continue;
            }
            if (delta > MAX_AGE_US) {
                return false;
            }
            // Calibrate the local timer against the latest complete PPS period.
            eventUtcUs = anchor.utcUs +
                (delta * 1000000 + anchor.intervalUs / 2) / anchor.intervalUs;
            return true;
        }
        return false;
    }

    uint32_t samples() const { return samples_; }
    uint32_t generation() const { return generation_; }
    const char* state(int64_t nowUs) const {
        if (samples_ >= REQUIRED_SAMPLES && !tracking(nowUs)) {
            return "STALE";
        }
        return reason_;
    }

private:
    static constexpr uint32_t HISTORY = 8;
    ClockAnchor anchors_[HISTORY] = {};
    uint32_t anchorCount_ = 0;
    uint32_t samples_ = 0;
    uint32_t generation_ = 0;
    int64_t lastProcessedUs_ = 0;
    const char* reason_ = "NO_REFERENCE";
};

}  // namespace timing
