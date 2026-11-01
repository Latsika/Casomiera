#pragma once

#include <stddef.h>
#include <stdint.h>
#include "independent_input.h"

namespace timing {

struct IndependentQualifiedEvent {
    uint8_t input = 0;
    int64_t atUs = 0;
};

struct IndependentCaptureDiagnostics {
    uint32_t edges[2] = {};
    uint32_t falling[2] = {};
    int64_t lastEdgeUs[2] = {};
    uint32_t qualified[2] = {};
    uint32_t droppedEvents = 0;
    uint32_t overflows = 0;
    uint8_t queuedEvents = 0;
    bool overflowPending = false;
    bool released[2] = {};
};

// Callers serialize observe/poll/reset/read operations across ISR and task code.
// Only qualified events enter the queue; raw contact chatter uses constant space.
class IndependentCapture {
public:
    static constexpr size_t CAPACITY = 64;

    void reset(bool startLow, bool stopLow, int64_t nowUs, uint32_t lowUs, uint32_t releaseUs) {
        head_ = tail_ = count_ = 0;
        overflowPending_ = false;
        for (uint8_t input = 0; input < 2; ++input) {
            inputs_[input].configure(lowUs, releaseUs);
            inputs_[input].reset(input == 0 ? startLow : stopLow, nowUs);
        }
        // Preserve diagnostic counters when the operator reapplies configuration.
    }

    void observe(uint8_t input, bool low, int64_t atUs) {
        if (input > 1) return;
        ++diagnostics_.edges[input];
        if (low) ++diagnostics_.falling[input];
        diagnostics_.lastEdgeUs[input] = atUs;
        // A held START may qualify before a STOP pulse ends while the task is busy.
        poll(atUs);
        enqueue(input, inputs_[input].observe(low, atUs));
    }

    void poll(int64_t nowUs) {
        for (uint8_t input = 0; input < 2; ++input) enqueue(input, inputs_[input].poll(nowUs));
    }

    bool take(IndependentQualifiedEvent& event) {
        if (count_ == 0) return false;
        event = events_[tail_];
        tail_ = (tail_ + 1) % CAPACITY;
        --count_;
        return true;
    }

    bool takeOverflow() {
        const bool overflow = overflowPending_;
        overflowPending_ = false;
        return overflow;
    }

    bool released(uint8_t input) const { return input < 2 && inputs_[input].released(); }

    IndependentCaptureDiagnostics diagnostics() const {
        auto result = diagnostics_;
        result.queuedEvents = static_cast<uint8_t>(count_);
        result.overflowPending = overflowPending_;
        result.released[0] = released(0);
        result.released[1] = released(1);
        return result;
    }

private:
    IndependentInput inputs_[2];
    IndependentQualifiedEvent events_[CAPACITY];
    IndependentCaptureDiagnostics diagnostics_;
    size_t head_ = 0;
    size_t tail_ = 0;
    size_t count_ = 0;
    bool overflowPending_ = false;

    void enqueue(uint8_t input, int64_t atUs) {
        if (atUs <= 0) return;
        ++diagnostics_.qualified[input];
        if (count_ == CAPACITY) {
            ++diagnostics_.droppedEvents;
            if (!overflowPending_) ++diagnostics_.overflows;
            overflowPending_ = true;
            return;
        }
        events_[head_] = {input, atUs};
        head_ = (head_ + 1) % CAPACITY;
        ++count_;
    }
};

inline bool independentCaptureSelfTest() {
    IndependentQualifiedEvent event;
    IndependentCapture capture;
    capture.reset(false, false, 100, 1000, 30000);
    capture.poll(30100);
    if (!capture.released(0) || !capture.released(1)) return false;
    // Ten thousand raw transitions with no task drain would overflow the old queue.
    for (uint8_t input = 0; input < 2; ++input) {
        const int64_t firstUs = 40000 + input * 10000;
        capture.observe(input, true, firstUs);
        for (int64_t offset = 1; offset <= 5000; ++offset) {
            capture.observe(input, offset % 2 == 0, firstUs + offset);
        }
        capture.observe(input, true, firstUs + 6000);
        capture.poll(firstUs + 7000);
    }
    const auto storm = capture.diagnostics();
    if (storm.edges[0] < 5000 || storm.edges[1] < 5000 || storm.droppedEvents ||
        storm.qualified[0] != 1 || storm.qualified[1] != 1 || capture.takeOverflow()) return false;
    if (!capture.take(event) || event.input != 0 || event.atUs != 40000 ||
        !capture.take(event) || event.input != 1 || event.atUs != 50000 || capture.take(event)) return false;
    capture.poll(58000);
    if (capture.take(event)) return false; // Holding either input must not repeat.
    capture.observe(0, false, 60000);
    capture.observe(1, false, 60000);
    capture.poll(90000);
    if (!capture.released(0) || !capture.released(1)) return false;

    // Both complete pulses can end before the task next runs.
    capture.reset(false, false, 100, 1000, 30000);
    capture.poll(30100);
    capture.observe(0, true, 40000);
    capture.observe(1, true, 40500);
    capture.observe(1, false, 42000);
    capture.observe(0, false, 43000);
    if (!capture.take(event) || event.input != 0 || event.atUs != 40000 ||
        !capture.take(event) || event.input != 1 || event.atUs != 40500 || capture.take(event)) return false;

    // A rejected glitch must not become the timestamp of the next valid press.
    capture.reset(false, false, 100, 1000, 30000);
    capture.poll(30100);
    capture.observe(0, true, 40000);
    capture.observe(0, false, 40100);
    capture.poll(70100);
    if (capture.take(event)) return false;
    capture.observe(0, true, 80000);
    capture.poll(81000);
    if (!capture.take(event) || event.atUs != 80000 || capture.take(event)) return false;

    // Separate stations can finish in either order, with their own timestamps.
    for (uint8_t first = 0; first < 2; ++first) {
        IndependentCapture stations[2];
        for (auto& station : stations) {
            station.reset(false, false, 100, 1000, 30000);
            station.poll(30100);
            station.observe(0, true, 40000);
            station.poll(41000);
            if (!station.take(event) || event.input != 0 || event.atUs != 40000) return false;
        }
        stations[first].observe(1, true, 50000);
        stations[first].poll(51000);
        if (!stations[first].take(event) || event.input != 1 || event.atUs != 50000 ||
            stations[1 - first].take(event)) return false;
        stations[1 - first].observe(1, true, 60000);
        stations[1 - first].poll(61000);
        if (!stations[1 - first].take(event) || event.input != 1 || event.atUs != 60000) return false;
    }

    // Exhaustion by genuinely qualified events remains visible and fails closed.
    capture.reset(false, false, 100, 0, 1000);
    capture.poll(1100);
    for (size_t index = 0; index < IndependentCapture::CAPACITY + 3; ++index) {
        const int64_t atUs = 10000 + static_cast<int64_t>(index) * 4000;
        capture.observe(0, true, atUs);
        capture.observe(0, false, atUs + 100);
        capture.poll(atUs + 1100);
    }
    const auto full = capture.diagnostics();
    if (full.queuedEvents != IndependentCapture::CAPACITY || full.droppedEvents != 3 ||
        !capture.takeOverflow() || capture.takeOverflow()) return false;
    size_t delivered = 0;
    while (capture.take(event)) ++delivered;
    capture.reset(false, false, 400000, 1000, 30000);
    capture.poll(430000);
    return delivered == IndependentCapture::CAPACITY && capture.released(0) && capture.released(1) &&
        capture.diagnostics().droppedEvents == 3 && !capture.takeOverflow();
}

}  // namespace timing
