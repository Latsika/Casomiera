"use strict";
const assert = require("node:assert/strict");
const { AutomaticRun, parseMessage } = require("../web/automatic-timing.js");
const participant = { key: "p1", mode: "individual", category: "girls" };
const message = (station, type, extra = {}) => ({
  station, type, id: "attempt-1", boot: station === "A" ? "11111111" : "22222222",
  generation: 1, ...extra
});
const run = new AutomaticRun();
run.prepare(participant, 1, "competition-1", "attempt-1");
participant.key = "changed";
assert.equal(run.current.participant.key, "p1");
assert.throws(() => run.prepare(participant, 1, "competition-1", "attempt-2"));
assert.equal(run.accept(message("A", "event", { id: "old-attempt", utcUs: "100" })), false);
run.accept(message("A", "armed"));
run.accept(message("B", "armed"));
assert.equal(run.current.phase, "armed");
// STOP can be delivered before START; timestamps determine the result.
run.accept(message("B", "event", { valid: true, utcUs: "1793451601123456", localUs: "20" }));
run.accept(message("A", "event", { valid: true, utcUs: "1793451600000000", localUs: "10" }));
assert.equal(run.current.elapsedUs, "1123456");
assert.equal(run.current.elapsedMs, 1123);
const restored = new AutomaticRun(JSON.parse(JSON.stringify(run.current)));
assert.equal(restored.current.elapsedUs, "1123456");
restored.accept(message("A", "error", { reason: "ACK_TIMEOUT" }));
assert.equal(restored.current.elapsedUs, "1123456");
restored.accept(message("A", "event", { valid: true, utcUs: "1793451600000000", localUs: "10" }));
assert.equal(restored.current.elapsedUs, "1123456");
restored.markSaved();
assert.equal(restored.busy, false);
assert.equal(restored.accept(message("B", "event", { valid: true, utcUs: "0" })), false);
const invalid = new AutomaticRun();
invalid.prepare({ key: "p2" }, 2, "competition-1", "attempt-1");
invalid.accept(message("A", "armed"));
invalid.accept(message("A", "event", { valid: true, utcUs: "100", boot: "33333333" }));
assert.equal(invalid.current.events.A, undefined);
invalid.accept(message("A", "event", { valid: false, utcUs: "100" }));
assert.equal(invalid.current.events.A, undefined);
invalid.cancel();
invalid.accept(message("A", "event", { valid: true, utcUs: "100" }));
assert.equal(invalid.current.events.A, undefined);
invalid.confirmCancellation();
assert.equal(invalid.busy, false);
assert.equal(parseMessage("AUTO {broken"), null);
assert.equal(parseMessage("AUTO " + JSON.stringify(message("C", "event"))), null);
assert.equal(parseMessage("AUTO " + JSON.stringify(message("A", "armed"))).station, "A");
console.log("Automatic timing state tests passed.");
