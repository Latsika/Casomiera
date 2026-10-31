#pragma once

#include "gnss_clock.h"

namespace timing {

// Run the actual portable clock implementation with deterministic inputs.
inline bool clockSelfTest() {
    int64_t value = 0;
    if (!parseRmcEpoch("000000.00", "010100", value) || value != 946684800000000LL ||
        !parseRmcEpoch("235959.00", "311299", value) || value != 4102444799000000LL ||
        !parseRmcEpoch("000000.00", "290224", value) ||
        parseRmcEpoch("000000.00", "290223", value) ||
        parseRmcEpoch("000000.00", "310426", value) ||
        parseRmcEpoch("240000.00", "311026", value) ||
        parseRmcEpoch("235960.00", "311026", value) ||
        parseRmcEpoch("120000.01", "311026", value) ||
        parseRmcEpoch("120000.", "311026", value) ||
        parseRmcEpoch("", "311026", value) ||
        parseRmcEpoch("120000.00", "", value)) {
        return false;
    }
    int64_t beforeMidnight = 0;
    int64_t afterMidnight = 0;
    if (!parseRmcEpoch("235959.00", "311026", beforeMidnight) ||
        !parseRmcEpoch("000000.00", "011126", afterMidnight) ||
        afterMidnight - beforeMidnight != 1000000) {
        return false;
    }
    GnssClock clock;
    if (clock.toUtc(1000000, 1100000, value)) {
        return false;
    }
    for (uint32_t index = 1; index <= 5; ++index) {
        const int64_t pulse = index * 1000004LL;
        if (!clock.observe(100000000 + index * 1000000LL, index,
                           pulse, 1000004, pulse + 40000)) {
            return false;
        }
        if (index < 5 && clock.tracking(pulse + 50000)) {
            return false;
        }
    }
    if (!clock.toUtc(5500022, 5600022, value) || value != 105500000 ||
        clock.toUtc(5600023, 5600022, value) ||
        clock.toUtc(5500022, 7000021, value)) {
        return false;
    }
    // Duplicate input cannot extend the freshness deadline.
    if (clock.observe(105000000, 5, 5000020, 1000004, 5200020) ||
        clock.tracking(6600020)) {
        return false;
    }
    const uint32_t generation = clock.generation();
    clock.observe(107000000, 6, 6000024, 1000004, 6040024);
    if (clock.tracking(6050024) || clock.samples() != 1 ||
        clock.generation() == generation) {
        return false;
    }
    clock.observe(108000000, 7, 7000028, 1000004, 7400028);
    if (clock.samples() != 0) {
        return false;
    }
    // Pulse counter wrap is allowed; lost pulses are not.
    GnssClock wrappingClock;
    for (uint32_t index = 0; index < 5; ++index) {
        wrappingClock.observe(100000000 + index * 1000000LL,
            0xFFFFFFFDu + index, (index + 1) * 1000000LL,
            1000000, (index + 1) * 1000000LL + 40000);
    }
    if (!wrappingClock.tracking(5100000)) {
        return false;
    }
    wrappingClock.invalidate("TEST_INVALID_RMC");
    return !wrappingClock.toUtc(5100000, 5200000, value);
}

}  // namespace timing
