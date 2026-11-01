#pragma once

#include <stdint.h>

namespace timing {

// The qualifier preserves the first edge across contact bounce. Stable release
// is required before another event. It is separate from the GNSS input path.
class IndependentInput {
public:
    void reset(bool low, int64_t nowUs) {
        low_ = low;
        changedUs_ = nowUs;
        firstUs_ = 0;
        ready_ = false;
        emitted_ = false;
    }

    void configure(uint32_t lowUs, uint32_t releaseUs) {
        minimumLowUs_ = lowUs;
        releaseUs_ = releaseUs;
    }

    int64_t observe(bool low, int64_t atUs) {
        // Qualify a pulse which ended before the main loop could poll it.
        const int64_t captured = poll(atUs);
        if (low == low_) return captured;
        low_ = low;
        changedUs_ = atUs;
        if (low && ready_) {
            firstUs_ = atUs;
            emitted_ = false;
            ready_ = false;
        }
        return captured;
    }

    int64_t poll(int64_t nowUs) {
        if (!low_ && nowUs - changedUs_ >= releaseUs_) {
            ready_ = true;
            firstUs_ = 0;
            emitted_ = false;
        }
        if (low_ && firstUs_ > 0 && !emitted_ && nowUs - changedUs_ >= minimumLowUs_) {
            emitted_ = true;
            return firstUs_;
        }
        return 0;
    }

    bool released() const { return ready_ && !low_; }

private:
    bool low_ = false;
    bool ready_ = false;
    bool emitted_ = false;
    int64_t changedUs_ = 0;
    int64_t firstUs_ = 0;
    // Configurable qualification is not a claim about an untested optical sensor.
    uint32_t minimumLowUs_ = 1000;
    uint32_t releaseUs_ = 30000;
};

inline bool independentInputSelfTest() {
    IndependentInput input;
    input.reset(false, 100);
    input.poll(30100);
    if (!input.released() || input.observe(true, 40000) || input.poll(40999) ||
        input.poll(41000) != 40000 || input.poll(50000)) return false;
    input.observe(false, 60000);
    input.poll(90000);
    input.observe(true, 100000);
    return input.observe(false, 102000) == 100000;
}

}  // namespace timing
