"use strict";
const assert = require("node:assert/strict");
const { IndependentRuns } = require("../web/independent-timing.js");
const participant = key => ({ key, displayName: key, mode: "individual", category: "girls" });
const message = (station, id, phase, startUs = "0", stopUs = "0", extra = {}) => ({
  kind: "independent", type: "independent", station, id, phase, boot: "12345678",
  startUs, stopUs, elapsedUs: (BigInt(stopUs) > 0n ? BigInt(stopUs) - BigInt(startUs) : 0n).toString(),
  inputFault: false, ...extra
});
const runs = new IndependentRuns();
runs.prepare("A", participant("alice"), 1, "competition", "a1");
assert.throws(() => runs.prepare("B", participant("alice"), 1, "competition", "b1"));
runs.prepare("B", participant("bob"), 1, "competition", "b1");
assert.equal(runs.busy, true);
assert.equal(runs.accept(message("A", "old", "finished", "100", "200")), false);
assert.equal(runs.accept({ ...message("A", "a1", "running", "100"), kind: undefined }), false);
runs.accept(message("A", "a1", "running", "1000000"));
runs.accept(message("B", "b1", "finished", "2000000", "3234567"));
assert.equal(runs.current.A.phase, "running");
assert.equal(runs.current.B.elapsedUs, "1234567");
assert.equal(runs.current.B.elapsedMs, 1235);
const restored = new IndependentRuns(runs.snapshot());
assert.deepEqual(restored.snapshot(), runs.snapshot());
restored.accept({ kind: "independent", type: "independent_error", station: "B", id: "b1", reason: "ACK_TIMEOUT" });
assert.equal(restored.current.B.phase, "finished");
assert.equal(restored.current.B.elapsedUs, "1234567");
restored.markSaved("B", "result-b");
assert.equal(restored.busyAt("B"), false);
assert.equal(restored.busyAt("A"), true);
assert.equal(restored.actions[0].operation, "COMPLETE");
restored.accept(message("B", "b1", "complete", "2000000", "3234567"));
assert.equal(restored.actions[0].stage, "archive");
restored.accept({ kind: "independent", type: "independent_ack", station: "B", id: "b1", operation: "ARCHIVE" });
assert.equal(restored.actions.length, 0);
restored.cancel("A");
assert.equal(restored.current.A.startUs, "1000000");
assert.equal(restored.busy, false);
restored.prepare("A", participant("carol"), 1, "competition", "a2");
// Late cancellation can recover a STOP but cannot replace the newer attempt.
restored.accept(message("A", "a1", "cancelled", "1000000", "1500000"));
assert.equal(restored.current.A.id, "a2");
assert.equal(restored.current.A.startUs, null);
assert.equal(restored.history.find(item => item.id === "a1").stopUs, "1500000");
assert.equal(restored.actions.find(item => item.id === "a1").stage, "archive");
restored.accept(message("A", "a2", "armed"));
restored.accept(message("A", "a2", "finished", "1000", "2500"));
assert.equal(restored.current.A.elapsedMs, 2);
restored.accept(message("A", "a2", "running", "1000"));
assert.equal(restored.current.A.phase, "finished");
restored.accept(message("A", "a2", "finished", "1001", "2500"));
assert.equal(restored.current.A.phase, "recovery");
assert.equal(restored.current.A.startUs, "1000");
assert.equal(restored.current.A.stopUs, "2500");
assert.throws(() => restored.markSaved("A", "bad"));

for (const invalid of [
  message("A", "x", "finished", "0", "200"),
  message("A", "x", "finished", "200", "100"),
  message("A", "x", "finished", "100", "200", { elapsedUs: "99" }),
  message("A", "x", "finished", "100", "86400000101"),
  message("A", "x", "running", "100", "0", { boot: "87654321" }),
  message("A", "x", "running", "100", "0", { inputFault: true })
]) {
  const model = new IndependentRuns();
  model.prepare("A", participant("test"), 1, "competition", "x", { boot: "12345678" });
  model.accept(invalid);
  assert.equal(model.current.A.phase, "recovery", JSON.stringify(invalid));
}
const tampered = runs.snapshot();
tampered.current.B.elapsedUs = "1";
assert.throws(() => new IndependentRuns(tampered));
assert.throws(() => new IndependentRuns({ current: { A: null, B: null }, history: [], actions: [{ station: "X" }] }));
console.log("Independent timing tests passed: two concurrent attempts, immutable timestamps, recovery, cancellation, settlement, invalid data and restored backups.");
