"use strict";
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { pathToFileURL } = require("node:url");

const workspace = path.resolve(__dirname, "..");
const original = fs.readFileSync(path.join(workspace, "..", "Casomiera_v11_OSTRA.html"), "utf8").replaceAll("\r\n", "\n");
for (const [name, filename] of [["CORE", "automatic-timing.js"], ["UI", "automatic-ui.js"]]) {
  const embedded = original.split(`// CASOMIERA_AUTOMATIC_${name}_BEGIN`)[1]?.split(`// CASOMIERA_AUTOMATIC_${name}_END`)[0]?.trim();
  assert.equal(embedded, fs.readFileSync(path.join(workspace, "web", filename), "utf8").replaceAll("\r\n", "\n").trim(), "Embedded modules must match the tested sources.");
}
for (const [index, match] of [...original.matchAll(/<script>([\s\S]*?)<\/script>/g)].entries()) {
  new vm.Script(match[1], { filename: `application-inline-${index}` });
}
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "casomiera-test-"));
const hooks = `
  globalThis.__timingTest = {
    applySnapshot, buildSnapshot, saveResult, getValidIfReady, getConfiguredJudgeCount, persistCompetitionSettings,
    prepareAutomaticAttempt, applyAutomaticProgress, automaticRun, persistAutomatic, cancelAutomaticAttempt,
    setManualJudge, confirmPendingParticipantSelection, getFlatRowsForExport,
    get results() { return loadAll(); },
    get currentMode() { return automaticMode; },
    select(key) { selectedParticipantKey = key; pendingParticipantKey = key; setUI(); },
    mode(value) { automaticMode = value; setUI(); },
    transport(value) { automaticTransport = value; automaticRemoteStatus = { tracking: true, ...globalThis.CasomieraTimingValidation.stations.A }; setUI(); },
    ready() { return automaticStationsReady(); },
    setFakeBuild(station, hash) { automaticPorts[station].status.firmwareHash = hash; },
    sendAutomatic, acceptAutomaticCancellation,
    disconnectFixtures() { automaticPorts.A = automaticPorts.B = null; },
    receive(value) { automaticRun.accept(value); persistAutomatic(); applyAutomaticProgress(); },
    mockStations() {
      globalThis.CasomieraTimingValidation = { passed: true, criterionUs: 1000, sampleCount: 24,
        maximumAbsoluteDifferenceUs: 5, stations: { A: { boardId: "test-a", firmwareHash: "test-a-build" }, B: { boardId: "test-b", firmwareHash: "test-b-build" } } };
      for (const station of ["A", "B"]) automaticPorts[station] = {
        status: { tracking: true, radioCreditUs: 1000000, radioCanPrepare: true, ...globalThis.CasomieraTimingValidation.stations[station] }, seenAt: Date.now(), writes: Promise.resolve(),
        port: { writable: { getWriter() { return { async write(data) { (globalThis.__testWrites ||= []).push({ station, command: new TextDecoder().decode(data) }); }, releaseLock() {} }; } } }
      };
    }
  };
`;
const instrumented = original.replace("  initializeAutomaticUI();\n})();", hooks + "\n  initializeAutomaticUI();\n})();");
assert.notEqual(instrumented, original);
const fixturePath = path.join(temporary, "app.html");
fs.writeFileSync(fixturePath, instrumented);
const chrome = spawn("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--remote-debugging-port=9237", `--user-data-dir=${path.join(temporary, "profile")}`, "about:blank"
], { windowsHide: true, stdio: "ignore" });
let socket;
let nextId = 0;
const pending = new Map();
const errors = [];
const watchdog = setTimeout(() => {
  console.error("Browser test timed out.");
  chrome.kill();
  process.exit(1);
}, 45000);

async function call(method, params = {}) {
  const id = ++nextId;
  const response = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  socket.send(JSON.stringify({ id, method, params }));
  return response;
}
async function evaluate(expression) {
  const result = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function main() {
  console.log("Starting isolated browser integration test...");
  let endpoint;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch("http://127.0.0.1:9237/json/new?about:blank", { method: "PUT" });
      endpoint = await response.json();
      break;
    } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  if (!endpoint) throw new Error("Headless browser did not start.");
  socket = new WebSocket(endpoint.webSocketDebuggerUrl);
  await once(socket, "open");
  socket.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails);
    const waiter = pending.get(message.id);
    if (waiter) {
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
      else waiter.resolve(message.result);
    }
  });
  await call("Runtime.enable");
  await call("Page.enable");
  await call("Page.addScriptToEvaluateOnNewDocument", { source: "window.alert = message => { (window.__alerts ||= []).push(message); }; window.confirm = () => true;" });
  await call("Page.navigate", { url: pathToFileURL(fixturePath).href });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await evaluate("!!window.__timingTest")) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(await evaluate("!!window.__timingTest"), true, JSON.stringify(errors));
  assert.equal(await evaluate("__timingTest.getConfiguredJudgeCount()"), 3);
  const result = await evaluate(`(async () => {
    const t = __timingTest;
    const participant = { key: "test-p1", mode: "individual", category: "girls", displayName: "Test Participant", subLine: "", timeEnabled: true, startNumber: 1 };
    t.applySnapshot({ competitionName: "Isolated automated test", attemptsLimit: 3, judgeCount: 3, timeRule: "median", participants: [participant], results: [], mode: "individual", viewCat: "girls", draft: { selectedParticipantKey: participant.key } });
    t.select(participant.key);
    t.mode("combined");
    t.mockStations();
    t.setFakeBuild("A", "unverified-build");
    const wrongBuildBlocked = !t.ready();
    t.setFakeBuild("A", "test-a-build");
    t.transport("wireless");
    await t.sendAutomatic("A", "AUTO_GET route-test");
    const route = globalThis.__testWrites.at(-1);
    t.transport("dual_usb");
    await t.prepareAutomaticAttempt();
    const id = t.automaticRun.current.id;
    const msg = (station, type, extra = {}) => ({ station, type, id, boot: station === "A" ? "11111111" : "22222222", generation: 1, ...extra });
    t.receive(msg("A", "armed"));
    t.receive(msg("B", "armed"));
    const armed = t.automaticRun.current.phase;
    const switchLocked = document.getElementById("automaticMode").disabled;
    t.receive(msg("B", "event", { valid: true, utcUs: "1793451601123456", localUs: "200" }));
    t.receive(msg("A", "event", { valid: true, utcUs: "1793451600000000", localUs: "100" }));
    document.getElementById("penaltySeconds").value = "1.5";
    const valid = t.getValidIfReady();
    const beforeSave = t.buildSnapshot();
    t.persistCompetitionSettings();
    const retainedManualCount = Number(localStorage.getItem("casomiera_ostra_v11_judge_count"));
    t.applySnapshot(beforeSave);
    const restoredMs = t.getValidIfReady();
    t.saveResult();
    const saved = t.results[0];
    const exportRow = t.getFlatRowsForExport()[0];
    t.mode("manual");
    const manualCount = t.getConfiguredJudgeCount();
    t.select(participant.key);
    for (let i = 0; i < 3; i++) { document.getElementById("m" + (i + 1)).value = ["2.000", "2.100", "2.200"][i]; t.setManualJudge(i); }
    document.getElementById("penaltySeconds").value = "0";
    const manualValid = t.getValidIfReady();
    t.saveResult();
    return { armed, switchLocked, wrongBuildBlocked, route, retainedManualCount, restoredMs, valid, beforeSave, saved, exportRow, manualCount, manualValid, results: t.results, alerts: window.__alerts || [] };
  })()`);
  assert.equal(result.armed, "armed");
  assert.equal(result.switchLocked, true);
  assert.equal(result.wrongBuildBlocked, true);
  assert.deepEqual(result.route, { station: "B", command: "REMOTE_GET route-test\n" });
  assert.equal(result.retainedManualCount, 3);
  assert.equal(result.restoredMs, 2623);
  assert.equal(result.valid, 2623);
  assert.equal(result.saved.measurementMode, "automatic_combined");
  assert.equal(result.saved.electronic.elapsedUs, "1123456");
  assert.equal(result.saved.t1, null);
  assert.equal(result.saved.t2, null);
  assert.equal(result.saved.t3, null);
  assert.equal(result.beforeSave.automatic.pending.phase, "finished");
  assert.equal(result.beforeSave.judgeCount, 3);
  assert.equal(result.exportRow.measurementMode, "automatic_combined");
  assert.equal(result.manualCount, 3);
  assert.equal(result.manualValid, 2100);
  assert.equal(result.results.length, 2, JSON.stringify(result.alerts));
  assert.equal(result.results[1].measurementMode, "manual");
  assert.equal(result.results[1].t1, 2000);
  const hardwarePath = path.join(workspace, "test-results", "end-to-end.json");
  if (fs.existsSync(hardwarePath)) {
    const cycles = JSON.parse(fs.readFileSync(hardwarePath, "utf8")).cycles;
    for (const cycle of cycles) {
      const hardware = await evaluate(`(() => {
        const t = __timingTest;
        const cycle = ${JSON.stringify(cycle)};
        const p = { key: "hardware-fixture", mode: "individual", category: "girls", displayName: "Hardware Replay", timeEnabled: true, startNumber: 1 };
        const model = new CasomieraAutomatic.AutomaticRun();
        model.prepare(p, 1, "hardware-fixture-competition", cycle.id);
        t.applySnapshot({ competitionName: "Hardware replay", attemptsLimit: 1, judgeCount: 3, timeRule: "median", participants: [p], results: [], mode: "individual", viewCat: "girls", automatic: { competitionId: "hardware-fixture-competition", mode: "combined", pending: model.current }, draft: { selectedParticipantKey: p.key } });
        for (const message of cycle.messages) t.receive(message);
        document.getElementById("penaltySeconds").value = "0";
        t.saveResult();
        return t.results[0];
      })()`);
      assert.equal(hardware.electronic.elapsedUs, cycle.computed.elapsedUs);
      assert.equal(hardware.rawMeasuredMs, cycle.computed.elapsedMs);
      assert.equal(hardware.measurementMode, "automatic_combined");
    }
    const cancellation = await evaluate(`(async () => {
      const t = __timingTest;
      const cycle = ${JSON.stringify(cycles[0])};
      const p = { key: "offline-cancellation", mode: "individual", category: "girls", displayName: "Offline Cancellation", timeEnabled: true, startNumber: 1 };
      const model = new CasomieraAutomatic.AutomaticRun();
      model.prepare(p, 1, "offline-cancellation-competition", cycle.id);
      t.applySnapshot({ competitionName: "Offline cancellation", attemptsLimit: 1, judgeCount: 3, timeRule: "median", participants: [p], results: [], mode: "individual", viewCat: "girls", automatic: { competitionId: "offline-cancellation-competition", mode: "combined", pending: model.current }, draft: { selectedParticipantKey: p.key } });
      for (const message of cycle.messages.slice(0, 3)) t.receive(message);
      t.disconnectFixtures();
      await t.cancelAutomaticAttempt();
      t.acceptAutomaticCancellation({ ...cycle.stop, type: "cancelled" });
      const snapshot = t.buildSnapshot();
      t.mode("manual");
      return { phase: t.automaticRun.current.phase, count: t.getConfiguredJudgeCount(), snapshot, modeLocked: document.getElementById("automaticMode").disabled };
    })()`);
    assert.equal(cancellation.phase, "cancelled");
    assert.equal(cancellation.count, 3);
    assert.equal(cancellation.modeLocked, false);
    assert.ok(cancellation.snapshot.automatic.pending.events.A);
    assert.equal(cancellation.snapshot.automatic.cancellations.length, 1);
    assert.ok(cancellation.snapshot.automatic.pending.cancelledEvents.B.utcUs);
  }
  assert.equal(errors.length, 0, JSON.stringify(errors));
  console.log("Browser integration passed: automatic and recorded hardware results, firmware verification guard, LoRa routing, snapshot recovery, exports, and preserved manual median/settings.");
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (socket?.readyState === WebSocket.OPEN) {
    try { await call("Browser.close"); } catch {}
    socket.close();
  }
  chrome.kill();
  clearTimeout(watchdog);
});
