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
for (const [family, name, filename] of [["AUTOMATIC", "CORE", "automatic-timing.js"], ["AUTOMATIC", "UI", "automatic-ui.js"],
  ["INDEPENDENT", "CORE", "independent-timing.js"], ["INDEPENDENT", "UI", "independent-ui.js"]]) {
  const embedded = original.split("// CASOMIERA_" + family + "_" + name + "_BEGIN")[1]?.split("// CASOMIERA_" + family + "_" + name + "_END")[0]?.trim();
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
    getRecordedMeasuredMs, exportCSVCurrentView, exportPDFCurrentView,
    get results() { return loadAll(); },
    get currentMode() { return automaticMode; },
    select(key) { selectedParticipantKey = key; pendingParticipantKey = key; setUI(); },
    mode(value) { automaticMode = value; setUI(); },
    transport(value) {
      automaticTransport = normalizeAutomaticTransport(value);
      const remote = automaticRemoteStation();
      automaticRemoteStatus = remote ? { tracking: true, ...globalThis.CasomieraTimingValidation.stations[remote] } : null;
      setUI();
    },
    get transportValue() { return automaticTransport; },
    setRemoteBuild(hash) { automaticRemoteStatus.firmwareHash = hash; },
    disconnectStation(station) { automaticPorts[station] = null; },
    async readFixture(station, messages) {
      const connection = automaticPorts[station];
      let delivered = false;
      let forwarded = null;
      connection.port.readable = { getReader() { return {
        async read() {
          if (delivered) { forwarded = automaticRemoteStatus; return { done: true }; }
          delivered = true;
          return { value: new TextEncoder().encode(messages.map(message => "AUTO " + JSON.stringify(message)).join("\\n") + "\\n"), done: false };
        },
        releaseLock() {}
      }; } };
      connection.port.close = async () => {};
      await readAutomatic(station, connection);
      return forwarded;
    },
    discoverAutomaticPorts, authorizeAutomaticPort,
    get connections() { return Object.fromEntries(Object.entries(automaticPorts).map(([station, connection]) => [station, connection?.status || null])); },
    get connectionNotice() { return automaticConnectionNotice; },
    async closeUsbFixtures() {
      if (automaticDiscoveryTask) await automaticDiscoveryTask;
      const connections = Object.values(automaticPorts).filter(Boolean);
      await Promise.all(connections.map(async connection => { try { await connection.reader?.cancel(); } catch {} }));
      await Promise.all(connections.map(connection => connection.readTask));
      automaticPorts.A = automaticPorts.B = null;
      automaticRemoteStatus = null;
      automaticPortFailures.clear();
    },
    get independent() { return independentRuns; },
    prepareIndependent, cancelIndependent, saveIndependentResult, serviceIndependent,
    synchronizeAutomaticModes, independentStationReady, buildIndependentLiveState,
    setIndependentLayout, independentStations, applyTimerLiveState,
    updateCallPanel, postponeSuggestedCall, reorderSuggestedCall, getCallCandidatesCurrentView, setCallIndex,
    get independentDraft() { return JSON.parse(JSON.stringify(independentDraft)); },
    selectIndependent(station, key, penalty = "") {
      const candidates = getCallCandidatesCurrentView();
      const slot = independentStations().indexOf(station);
      setCallIndex(Math.max(0, candidates.findIndex(candidate => candidate.key === key) - slot), candidates);
      updateCallPanel();
      independentDraft[station].penalty = penalty;
      updateIndependentUI();
    },
    penaltyIndependent(station, value) { independentDraft[station].penalty = value; },
    ackMode(mode) {
      for (const station of ["A", "B"]) if (automaticPorts[station]) {
        automaticPorts[station].status.mode = mode;
        automaticPorts[station].seenAt = Date.now();
      }
      setUI();
    },
    mockIndependentStations() {
      globalThis.__timingTest.mockStations();
      for (const station of ["A", "B"]) {
        Object.assign(automaticPorts[station].status, {
          boot: station === "A" ? "11111111" : "22222222", mode: "combined", independentProtocol: 1,
          tracking: false, radioCanPrepare: false, inputsReady: true, inputLowUs: 1000, inputReleaseUs: 30000
        });
        automaticModeRequests[station] = 0;
      }
      globalThis.__independentConnections = { ...automaticPorts };
      setUI();
    },
    independentEvent(station, phase, startUs = "0", stopUs = "0", id = null) {
      const current = independentRuns.current[station];
      handleIndependentMessage({ kind: "independent", type: "independent", station,
        boot: station === "A" ? "11111111" : "22222222", id: id || current.id, phase, startUs, stopUs,
        elapsedUs: stopUs !== "0" ? (BigInt(stopUs) - BigInt(startUs)).toString() : "0", inputFault: false });
    },
    async settleIndependent() {
      await new Promise(resolve => setTimeout(resolve, 0));
      await serviceIndependent(true);
      for (const action of [...independentRuns.actions]) {
        const attempt = independentRuns.current[action.station]?.id === action.id ? independentRuns.current[action.station] :
          independentRuns.history.find(item => item.station === action.station && item.id === action.id);
        globalThis.__timingTest.independentEvent(action.station, action.operation === "CANCEL" ? "cancelled" : "complete",
          attempt.startUs || "0", attempt.stopUs || "0", action.id);
      }
      await serviceIndependent(true);
      for (const action of [...independentRuns.actions]) handleIndependentMessage({
        kind: "independent", type: "independent_ack", station: action.station, id: action.id, operation: "ARCHIVE" });
    },
    reconnectIndependent(station) {
      automaticPorts[station] = globalThis.__independentConnections[station];
      automaticPorts[station].seenAt = Date.now();
    },
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

async function call(method, params = {}, sessionId) {
  const id = ++nextId;
  const response = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  socket.send(JSON.stringify({ id, method, params, sessionId }));
  return response;
}
async function evaluate(expression, sessionId) {
  const result = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
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
  assert.equal(await evaluate("document.getElementById('measurementSettings').hidden"), true);
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
  for (const [transport, usb, remote] of [["wireless", "B", "A"], ["wireless_a_usb", "A", "B"]]) {
    const routed = await evaluate(`(async () => {
      const t = __timingTest;
      t.mockStations();
      t.transport("${transport}");
      t.disconnectStation("${remote}");
      const ready = t.ready();
      const remoteButtonHidden = !document.getElementById("automaticConnect${remote}");
      const usbButtonVisible = !!document.querySelector('#automaticTransport option[value="authorize_usb"]');
      await t.sendAutomatic("${remote}", "AUTO_GET remote-test");
      const remoteWrite = globalThis.__testWrites.at(-1);
      await t.sendAutomatic("${usb}", "AUTO_GET local-test");
      const localWrite = globalThis.__testWrites.at(-1);
      t.setRemoteBuild("unverified-remote-build");
      const wrongRemoteBuildBlocked = !t.ready();
      t.transport("${transport}");
      await t.prepareAutomaticAttempt();
      const armWrites = globalThis.__testWrites.slice(-2);
      const snapshot = t.buildSnapshot();
      t.applySnapshot(snapshot);
      const restoredTransport = t.transportValue;
      const restoredAttemptTransport = t.automaticRun.current.transport;
      await t.cancelAutomaticAttempt();
      for (const station of ["A", "B"]) t.acceptAutomaticCancellation({ station, type: "cancelled", id: snapshot.automatic.pending.id });
      const status = { station: "${remote}", boot: "12345678", type: "status", tracking: true,
        ...globalThis.CasomieraTimingValidation.stations["${remote}"] };
      const forwarded = await t.readFixture("${usb}", [status]);
      t.mockStations();
      t.transport("dual_usb");
      let wrongPortRejected = false;
      try { await t.readFixture("${usb}", [status]); }
      catch (error) { wrongPortRejected = error.message.includes("Vybraný port"); }
      return { ready, remoteButtonHidden, usbButtonVisible, remoteWrite, localWrite,
        wrongRemoteBuildBlocked, restoredTransport, restoredAttemptTransport, armWrites, forwarded, wrongPortRejected };
    })()`);
    assert.equal(routed.ready, true);
    assert.equal(routed.remoteButtonHidden, true);
    assert.equal(routed.usbButtonVisible, true);
    assert.deepEqual(routed.remoteWrite, { station: usb, command: "REMOTE_GET remote-test\n" });
    assert.deepEqual(routed.localWrite, { station: usb, command: "AUTO_GET local-test\n" });
    assert.equal(routed.wrongRemoteBuildBlocked, true);
    assert.equal(routed.restoredTransport, transport);
    assert.equal(routed.restoredAttemptTransport, transport);
    assert.equal(routed.armWrites[0].station, usb);
    assert.match(routed.armWrites[0].command, /^REMOTE_ARM /);
    assert.equal(routed.armWrites[1].station, usb);
    assert.match(routed.armWrites[1].command, /^AUTO_ARM /);
    assert.equal(routed.forwarded.station, remote);
    assert.equal(routed.wrongPortRejected, true);
  }
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
  const independentResult = await evaluate("(" + (async function () {
    const t = __timingTest;
    const participants = [
      { key: "independent-a", displayName: "Independent Alice", mode: "individual", category: "girls", timeEnabled: true, startNumber: 1 },
      { key: "independent-b", displayName: "Independent Bob", mode: "individual", category: "boys", timeEnabled: true, startNumber: 2 },
      { key: "independent-c", displayName: "Independent Claire", mode: "individual", category: "girls", timeEnabled: true, startNumber: 3 }
    ];
    t.applySnapshot({ competitionName: "Independent integration", attemptsLimit: 3, judgeCount: 3, timeRule: "median",
      participants, results: [], mode: "individual", viewCat: "girls",
      automatic: { competitionId: "independent-integration", mode: "independent", transport: "wireless",
        pending: null, cancellations: [], history: [] } });
    t.setIndependentLayout(2, "A");
    t.mockIndependentStations();
    const blockedUntilConfirmed = !t.independentStationReady("A");
    await t.synchronizeAutomaticModes();
    const modesRequested = globalThis.__testWrites.slice(-2).every(item => item.command === "AUTO_MODE independent" + String.fromCharCode(10));
    const stillBlockedWithoutAck = !t.independentStationReady("A");
    t.ackMode("independent");
    const readyWithoutGnss = t.independentStationReady("A") && t.independentStationReady("B");
    t.selectIndependent("A", participants[0].key);
    t.selectIndependent("B", participants[1].key);
    await t.prepareIndependent("A");
    await t.prepareIndependent("B");
    const transportIsUsb = document.getElementById("automaticTransport").value === "dual_usb";
    t.independentEvent("A", "running", "1000000");
    t.independentEvent("B", "running", "2000000");
    const check = (condition, message) => { if (!condition) throw new Error(message); };
    const toggle = document.getElementById("measurementSettingsToggle");
    const settings = document.getElementById("measurementSettings");
    const retainedBeforeToggle = JSON.stringify(t.buildSnapshot().independent);
    check(settings.hidden && toggle.getAttribute("aria-expanded") === "false", "Measurement settings must start collapsed.");
    toggle.click();
    check(!settings.hidden && toggle.getAttribute("aria-expanded") === "true", "Arrow must expand measurement settings.");
    check(document.getElementById("independentCount").closest("#measurementSettings") &&
      document.getElementById("automaticTransport").closest("#measurementSettings"), "All station settings must be inside the collapsible area.");
    toggle.click();
    check(settings.hidden && toggle.getAttribute("aria-expanded") === "false", "Arrow must collapse measurement settings.");
    check(retainedBeforeToggle === JSON.stringify(t.buildSnapshot().independent) &&
      t.independent.current.A.phase === "running" && t.independent.current.B.phase === "running",
      "Collapsing settings must retain station selections, penalties and running attempts.");
    check(!document.getElementById("automaticMode").closest("#measurementSettings"), "Mode selection must remain outside the collapsed area.");
    const activeInfo = document.getElementById("activeCompetitorName");
    const nextInfo = document.getElementById("liveNextCompetitorName");
    check(getComputedStyle(activeInfo.closest(".activeCompetitor")).display !== "none" &&
      getComputedStyle(nextInfo.closest(".liveNextBox")).display !== "none", "Participant information must remain visible in independent mode.");
    check(activeInfo.textContent.includes("A: Independent Alice (pokus 1/3)") &&
      activeInfo.textContent.includes("B: Independent Bob (pokus 1/3)"), "Active information must describe both independent attempts.");
    check(nextInfo.textContent.includes("Independent Claire"), "Next participant must exclude both selected competitors.");
    const setPenalty = (station, value) => {
      const input = document.getElementById("independentPenalty" + station);
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    const saveA = document.getElementById("independentSaveA");
    setPenalty("A", "0");
    check(saveA.disabled, "A penalty must not enable saving a running measurement.");
    t.independentEvent("A", "finished", "1000000", "3234567");
    for (const value of ["", " ", "invalid", "-1"]) {
      setPenalty("A", value);
      check(saveA.disabled, "Missing or invalid penalty must disable saving: " + value);
    }
    let blankRejected = false;
    setPenalty("A", "");
    try { t.saveIndependentResult("A"); } catch { blankRejected = true; }
    check(blankRejected && t.results.length === 0, "Direct saving must reject an empty penalty without losing the time.");
    for (const value of ["0", "1.5", "1,5"]) {
      setPenalty("A", value);
      check(!saveA.disabled, "Valid explicit penalty must enable saving: " + value);
    }
    setPenalty("A", "");
    check(saveA.disabled, "Clearing an entered penalty must immediately disable saving.");
    setPenalty("A", "0");
    check(document.getElementById("independentSaveB").disabled, "A's penalty must not enable saving B.");
    t.saveIndependentResult("A");
    const otherStillRunning = t.independent.current.B.phase === "running";
    const snapshot = t.buildSnapshot();
    snapshot.independent.runs.current.B.startUs = null;
    snapshot.independent.runs.current.B.phase = "armed";
    snapshot.independent.runs.actions = [];
    snapshot.independent.runs.history = [];
    t.applySnapshot(snapshot);
    const restoredStart = t.independent.current.B.startUs;
    t.independentEvent("B", "finished", "2000000", "4000500");
    t.penaltyIndependent("B", "1.5");
    t.saveIndependentResult("B");
    await t.settleIndependent();
    const saved = JSON.parse(JSON.stringify(t.results));
    const exportRows = t.getFlatRowsForExport();
    const actionsSettled = t.independent.actions.length === 0;
    const live = t.buildIndependentLiveState();
    const selector = document.getElementById("automaticMode");
    selector.value = "combined";
    selector.dispatchEvent(new Event("change"));
    await t.synchronizeAutomaticModes();
    t.ackMode("combined");
    const returnedToGps = t.currentMode === "combined";
    const gpsStillRequiresGnss = !t.ready();
    selector.value = "independent";
    selector.dispatchEvent(new Event("change"));
    t.ackMode("independent");
    t.selectIndependent("A", participants[0].key);
    await t.prepareIndependent("A");
    const cancelledId = t.independent.current.A.id;
    t.independentEvent("A", "running", "6000000");
    t.disconnectStation("A");
    await t.cancelIndependent("A");
    const offlineCopy = t.independent.current.A.startUs;
    t.reconnectIndependent("A");
    t.independentEvent("A", "cancelled", "6000000", "7000000", cancelledId);
    await t.settleIndependent();
    const recoveredCancellation = t.independent.history.find(item => item.id === cancelledId);
    t.mode("manual");
    return { blockedUntilConfirmed, modesRequested, stillBlockedWithoutAck, readyWithoutGnss, transportIsUsb,
      otherStillRunning, restoredStart, saved, exportRows, actionsSettled, returnedToGps, gpsStillRequiresGnss,
      offlineCopy, recoveredCancellation, live };
  }).toString() + ")()");
  assert.equal(independentResult.blockedUntilConfirmed, true);
  assert.equal(independentResult.modesRequested, true);
  assert.equal(independentResult.stillBlockedWithoutAck, true);
  assert.equal(independentResult.readyWithoutGnss, true);
  assert.equal(independentResult.transportIsUsb, true);
  assert.equal(independentResult.otherStillRunning, true);
  assert.equal(independentResult.restoredStart, "2000000");
  assert.equal(independentResult.saved.length, 2);
  assert.equal(independentResult.saved[0].measurementMode, "automatic_independent");
  assert.equal(independentResult.saved[0].valid, 2235);
  assert.equal(independentResult.saved[0].electronic.station, "A");
  assert.equal(independentResult.saved[0].t1, null);
  assert.equal(independentResult.saved[1].valid, 3501);
  assert.equal(independentResult.saved[1].electronic.station, "B");
  assert.equal(independentResult.exportRows[0].judgeCount, 0);
  assert.equal(independentResult.actionsSettled, true);
  assert.equal(independentResult.returnedToGps, true);
  assert.equal(independentResult.gpsStillRequiresGnss, true);
  assert.equal(independentResult.offlineCopy, "6000000");
  assert.equal(independentResult.recoveredCancellation.stopUs, "7000000");
  assert.equal(independentResult.recoveredCancellation.phase, "cancelled");
  assert.equal(independentResult.live.independent.length, 2);
  console.log("Independent UI passed: runtime mode confirmation, concurrent participants without GNSS, separate save/penalties, JSON restore, exports, offline recovery and return to GPS.");
  const singleResults = await evaluate("(" + (async function () {
    const t = __timingTest;
    const checks = [];
    const check = (condition, message) => { if (!condition) throw new Error(message); };
    t.mode("independent");
    for (const station of ["A", "B"]) {
      const other = station === "A" ? "B" : "A";
      t.setIndependentLayout(1, station);
      t.mockIndependentStations();
      t.disconnectStation(other);
      globalThis.__testWrites = [];
      await t.synchronizeAutomaticModes();
      check(globalThis.__testWrites.length > 0 && globalThis.__testWrites.every(item => item.station === station), "Mode confirmation required the absent station.");
      t.ackMode("independent");
      check(t.independentStationReady(station) && !t.independentStationReady(other), "Single station must be ready without its peer or GNSS.");
      check(!document.getElementById("independentStation" + station).hidden && document.getElementById("independentStation" + other).hidden, "Wrong measurement panel visible.");
      check(document.getElementById("automaticConnectionInfo").dataset.tone === "ok", "Absent peer incorrectly blocks readiness.");
      t.selectIndependent(station, station === "A" ? "independent-a" : "independent-b");
      await t.prepareIndependent(station);
      const activeName = document.getElementById("activeCompetitorName").textContent;
      check(activeName.includes(station === "A" ? "Independent Alice" : "Independent Bob") && activeName.includes("pokus 2/3"),
        "Single-station information must show the selected participant and the correct attempt.");
      check(document.getElementById("independentCount").disabled && document.getElementById("independentSingleStation").disabled, "Active attempt must lock layout.");
      const selector = document.getElementById("independentSingleStation");
      selector.value = other;
      selector.dispatchEvent(new Event("change"));
      check(selector.value === station && t.independentStations()[0] === station, "Layout change hid an active attempt.");
      const invalid = t.buildSnapshot();
      invalid.independent.layout.singleStation = other;
      let rejected = false;
      try { t.applySnapshot(invalid); } catch { rejected = true; }
      check(rejected, "JSON restore hid an active attempt.");
      t.independentEvent(station, "running", "10000000");
      check(t.buildIndependentLiveState().independent[0].startedAt > 0, "New attempt LIVE clock did not restart.");
      t.independentEvent(station, "finished", "10000000", "11234567");
      const snapshot = t.buildSnapshot();
      t.applySnapshot(snapshot);
      check(t.buildSnapshot().independent.layout.singleStation === station, "Selected station was not restored.");
      const live = t.buildIndependentLiveState();
      check(live.participantCount === 1 && live.independent.length === 1 && live.independent[0].station === station, "LIVE must contain only the selected station.");
      t.penaltyIndependent(station, "0");
      t.saveIndependentResult(station);
      await t.settleIndependent();
      check(globalThis.__testWrites.every(item => item.station === station), "Single measurement sent a command to the absent station.");
      check(!document.getElementById("independentCount").disabled, "Saved attempt left layout locked.");
      checks.push(live);
    }
    t.setIndependentLayout(2, "A");
    check(!document.getElementById("independentStationA").hidden && !document.getElementById("independentStationB").hidden, "Two-participant layout did not restore both panels.");
    check(t.results.length === 4, "Changing layout lost saved results.");
    checks.push(t.buildIndependentLiveState());
    t.mode("manual");
    return checks;
  }).toString() + ")()");
  const target = await call("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await call("Target.attachToTarget", { targetId: target.targetId, flatten: true });
  await call("Page.enable", {}, sessionId);
  await call("Page.navigate", { url: pathToFileURL(fixturePath).href + "?view=timer" }, sessionId);
  for (let retry = 0; retry < 100; retry++) {
    if (await evaluate("!!window.__timingTest", sessionId)) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  for (const state of singleResults) {
    const projected = await evaluate("(() => { __timingTest.applyTimerLiveState(" + JSON.stringify(state) + "); return { count: document.getElementById('timerLiveClocks').dataset.judges, cards: [...document.querySelectorAll('#timerLiveClocks .timerLiveCard')].map(card => ({ hidden: card.hidden, label: card.querySelector('.timerLiveJudgeLabel').textContent })), time: document.getElementById('timerLiveClock1').textContent }; })()", sessionId);
    assert.equal(projected.count, String(state.independent.length));
    assert.equal(projected.cards.filter(card => !card.hidden).length, state.independent.length);
    for (const [index, participant] of state.independent.entries()) {
      assert.ok(projected.cards[index].label.startsWith(participant.station + " "));
    }
    assert.equal(projected.time, ((state.independent[0].elapsedMs || 0) / 1000).toFixed(3) + " s");
  }
  await call("Target.closeTarget", { targetId: target.targetId });
  console.log("Single-station UI and actual LIVE window passed: A alone, B alone, two clocks, retained results and locked active layouts.");
  await evaluate("(" + (async function () {
    const t = __timingTest;
    const check = (condition, message) => { if (!condition) throw new Error(message); };
    const participants = ["Alice", "Bob", "Claire", "David"].map((name, index) => ({
      key: "queue-" + index, displayName: name, mode: "individual", category: "girls", timeEnabled: true, startNumber: index + 1
    }));
    t.applySnapshot({ competitionName: "Independent microphone queue", attemptsLimit: 2, judgeCount: 3,
      timeRule: "median", participants, results: [], mode: "individual", viewCat: "girls",
      callIndexMap: {}, callManualOrder: {},
      automatic: { competitionId: "queue-integration", mode: "independent", transport: "dual_usb", pending: null, cancellations: [], history: [] } });
    t.setIndependentLayout(2, "A");
    t.mockIndependentStations();
    t.ackMode("independent");
    const called = () => ["callNowItem", "callNext1Item"].map(id => document.getElementById(id).dataset.candidateKey);
    const selected = () => t.independentStations().map(station => document.getElementById("independentParticipant" + station).value);
    const checkPair = message => check(JSON.stringify(selected()) === JSON.stringify(called()), message);
    checkPair("Initial independent selections must follow the two visible microphone slots.");
    check(selected()[0] === "queue-0" && selected()[1] === "queue-1", "Initial pair must use consecutive calling slots.");
    check(t.postponeSuggestedCall(0), "Postponing the first participant must work.");
    checkPair("Postponing the first participant did not update both measurement selections.");
    check(selected()[0] === "queue-1" && selected()[1] === "queue-2", "Wrong pair after first postponement.");
    check(t.postponeSuggestedCall(1), "Postponing the second participant must work.");
    checkPair("Postponing the second participant did not update the second measurement selection.");
    check(selected()[1] === "queue-3", "Second postponement must promote the next queued participant.");
    check(t.reorderSuggestedCall(1, 0), "Calling order swap must work.");
    checkPair("Reordering the microphone slots did not update both measurement selections.");
    check(selected()[0] === "queue-3" && selected()[1] === "queue-1", "Wrong pair after reordering.");
    const penalty = document.getElementById("independentPenaltyA");
    penalty.value = "5";
    penalty.dispatchEvent(new Event("input"));
    t.postponeSuggestedCall(0);
    checkPair("Postponing a participant with a draft penalty did not update the pair.");
    check(document.getElementById("independentPenaltyA").value === "", "New participant inherited another person's penalty.");
    const live = t.buildIndependentLiveState();
    check(live.independent[0].name === "Bob" && live.independent[0].elapsedMs === null,
      "LIVE must show the newly assigned participant without a previous result.");
    await t.prepareIndependent("A");
    const prepared = JSON.stringify(t.independent.current.A);
    t.postponeSuggestedCall(0);
    check(JSON.stringify(t.independent.current.A) === prepared && selected()[0] === "queue-1",
      "Queue change replaced a prepared attempt's participant.");
    t.independentEvent("A", "running", "1000000");
    const running = JSON.stringify(t.independent.current.A);
    const alertsBefore = (window.__alerts || []).length;
    t.reorderSuggestedCall(1, 0);
    check(JSON.stringify(t.independent.current.A) === running, "Reordering replaced a running attempt.");
    check((window.__alerts || []).length === alertsBefore, "Independent queue reordering incorrectly triggered legacy activation errors.");
    check(selected()[1] === called()[1], "Idle station must still follow its microphone slot while the peer runs.");
    // Move the running participant into B's microphone slot: keep B empty instead of duplicating A.
    const queue = t.getCallCandidatesCurrentView();
    const runningIndex = queue.findIndex(candidate => candidate.key === "queue-1");
    t.setCallIndex(Math.max(0, runningIndex - 1), queue);
    t.updateCallPanel();
    check(called()[1] === "queue-1" && selected()[1] === "" && document.getElementById("independentPrepareB").disabled,
      "A running participant must not be assigned to the idle peer.");
    t.independentEvent("A", "finished", "1000000", "2500000");
    const finished = JSON.stringify(t.independent.current.A);
    t.postponeSuggestedCall(0);
    check(JSON.stringify(t.independent.current.A) === finished, "Postponement replaced an unsaved measured result.");
    t.penaltyIndependent("A", "0");
    t.saveIndependentResult("A");
    await t.settleIndependent();
    checkPair("Saving a result must refresh selections from the currently displayed calling slots.");
    check(t.results[0].participantKey === "queue-1" && t.results[0].valid === 1500,
      "Queue changes must never reassign a recorded result.");
    check(document.getElementById("independentClockA").textContent === "0.000", "New participant must not inherit the prior time.");
    await t.prepareIndependent("B");
    t.independentEvent("B", "running", "3000000");
    const cancelledId = t.independent.current.B.id;
    t.postponeSuggestedCall(1);
    await t.cancelIndependent("B");
    await t.settleIndependent();
    checkPair("Cancelling a result must refresh the current calling slots.");
    check(t.independent.history.some(attempt => attempt.id === cancelledId && attempt.startUs === "3000000"),
      "Cancellation must retain original timestamps after queue replacement.");
    for (const station of ["A", "B"]) {
      t.setIndependentLayout(1, station);
      check(selected()[0] === called()[0], "Single station must follow Teraz na rade.");
      t.postponeSuggestedCall(0);
      check(selected()[0] === called()[0], "Single station must update immediately after postponement.");
    }
    t.setIndependentLayout(2, "A");
    const last = t.getCallCandidatesCurrentView();
    t.setCallIndex(last.length - 1, last);
    t.updateCallPanel();
    check(selected()[0] === called()[0] && selected()[1] === "" && document.getElementById("independentPrepareB").disabled,
      "An absent second calling slot must clear B without inventing a participant.");
    t.mode("manual");
  }).toString() + ")()");
  console.log("Microphone queue passed: initial pair, first/second postponement, reordering, single A/B, live labels, busy attempt protection, duplicate prevention, save/cancel refresh and an empty second slot.");
  await evaluate("(" + (async function () {
    const t = __timingTest;
    const check = (condition, message) => { if (!condition) throw new Error(message); };
    const participants = ["Independent results", "Combined results", "Manual results"].map((displayName, index) => ({
      key: "results-" + index, displayName, mode: "individual", category: "girls", timeEnabled: true, startNumber: index + 1
    }));
    const record = (person, attemptNo, values) => ({
      id: "results-" + person + "-" + attemptNo, participantKey: participants[person].key,
      displayName: participants[person].displayName, mode: "individual", category: "girls", attemptNo,
      t1: null, t2: null, t3: null, advantageSeconds: 0, penaltySeconds: 0,
      createdAt: "2026-11-01T12:00:00.000Z", stamp: "1. 11. 2026", ...values
    });
    const results = [
      record(0, 1, { measurementMode: "automatic_independent", rawMeasuredMs: 12345, valid: 14345, penaltySeconds: 2, electronic: { station: "A", elapsedUs: "12345000" } }),
      record(0, 2, { measurementMode: "automatic_independent", rawMeasuredMs: 9950, valid: 10950, penaltySeconds: 1, electronic: { station: "B", elapsedUs: "9950000" } }),
      record(1, 1, { measurementMode: "automatic_combined", rawMeasuredMs: 20001, valid: 18501, advantageSeconds: 1.5, electronic: { elapsedUs: "20001000" } }),
      record(1, 2, { measurementMode: "automatic_combined", valid: 23235, penaltySeconds: 2, electronic: { elapsedUs: "21234567" } }),
      record(2, 1, { t1: 10000, t2: 11000, t3: 12000, judgeCount: 3, timeRule: "median", valid: 12000, penaltySeconds: 1 }),
      record(2, 2, { t1: 14000, t2: 10000, judgeCount: 2, timeRule: "average", valid: 11000, advantageSeconds: 1.5, penaltySeconds: 0.5 })
    ];
    t.applySnapshot({ competitionName: "Saved attempt display regression", attemptsLimit: 3, judgeCount: 3,
      timeRule: "median", participants, results, mode: "individual", viewCat: "girls",
      resultsView: { mode: "individual", category: "all" },
      automatic: { competitionId: "saved-results", mode: "manual", transport: "dual_usb", pending: null, cancellations: [], history: [] } });
    const retained = JSON.stringify(t.results);
    const expected = {
      "Independent results": { measured: ["12.345", "9.950"], final: ["14.345", "10.950"], best: "10.950" },
      "Combined results": { measured: ["20.001", "21.235"], final: ["18.501", "23.235"], best: "18.501" },
      "Manual results": { measured: ["11.000", "12.000"], final: ["12.000", "11.000"], best: "11.000" }
    };
    const checkTable = tbody => {
      const rows = [...tbody.querySelectorAll("tr")];
      check(rows.length === 3, "All participants must appear in the result table.");
      for (const row of rows) {
        const name = row.querySelector(".nameMain").textContent;
        const measured = [...row.querySelectorAll(".measured-time .line")].map(line => line.textContent);
        const final = [...row.querySelectorAll(".attempt-time .line")].map(line => line.textContent);
        check(JSON.stringify(measured) === JSON.stringify(expected[name].measured), "Missing measured attempts for " + name);
        check(JSON.stringify(final) === JSON.stringify(expected[name].final), "Missing final attempts for " + name);
        check(row.querySelector(".validBadge").textContent === expected[name].best, "Best-time ranking changed for " + name);
        const judgeOne = [...row.children[3].querySelectorAll(".line")].map(line => line.textContent);
        check(JSON.stringify(judgeOne) === JSON.stringify(name === "Manual results" ? ["10.000", "14.000"] : ["—", "—"]),
          "Electronic time must not be presented as a judge's time.");
      }
    };
    checkTable(document.getElementById("tbody"));
    const flat = t.getFlatRowsForExport();
    check(flat.length === 6 && flat.every(row => Number.isFinite(row.rawMeasuredMs) && Number.isFinite(row.valid)),
      "Every export row needs its own measured and final time.");
    check(t.getRecordedMeasuredMs({ measurementMode: "automatic_independent", rawMeasuredMs: 0 }) === 0, "A zero measured time must be preserved.");
    check(t.getRecordedMeasuredMs({ measurementMode: "automatic_combined", electronic: { elapsedUs: "broken" } }) === null,
      "Missing electronic data must not manufacture a zero time.");
    check(t.getRecordedMeasuredMs({ t1: 1000, t2: null, t3: null }) === null, "Missing judge times must not manufacture a measurement.");
    const blobs = [];
    const createUrl = URL.createObjectURL;
    const revokeUrl = URL.revokeObjectURL;
    const click = HTMLAnchorElement.prototype.click;
    let csv;
    try {
      URL.createObjectURL = blob => { blobs.push(blob); return "blob:results-test"; };
      URL.revokeObjectURL = () => {};
      HTMLAnchorElement.prototype.click = () => {};
      t.exportCSVCurrentView();
      check(blobs.length === 1, "CSV export did not create its output.");
      csv = await blobs[0].text();
    } finally {
      URL.createObjectURL = createUrl;
      URL.revokeObjectURL = revokeUrl;
      HTMLAnchorElement.prototype.click = click;
    }
    const lines = csv.replace(/^\uFEFF/, "").trim().split(/\r?\n/);
    const headers = lines[0].split(";");
    const measuredIndex = headers.indexOf("Nameraný čas (s)");
    const finalIndex = headers.indexOf("Výsledný čas pokusu (s)");
    check(measuredIndex >= 0 && finalIndex >= 0 && lines.length === 7, "CSV must include both time columns and all six attempts.");
    for (const line of lines.slice(1)) {
      const fields = line.split(";").map(value => value.slice(1, -1).replaceAll('""', '"'));
      const expectation = expected[fields[2]];
      const attempt = Number(fields[1]) - 1;
      check(fields.length === headers.length && fields[measuredIndex] === expectation.measured[attempt] &&
        fields[finalIndex] === expectation.final[attempt], "CSV lost an attempt's measured or final time.");
    }
    const print = window.print;
    let printCalls = 0;
    try {
      window.print = () => { printCalls++; };
      t.exportPDFCurrentView();
      check(printCalls === 1, "PDF export must open the print flow.");
      checkTable(document.querySelector("#printArea tbody"));
      check(document.querySelectorAll("#printArea th").length === 11, "PDF header must match its additional time columns.");
    } finally { window.print = print; }
    check(JSON.stringify(t.results) === retained, "Displaying or exporting existing records must not rewrite saved measurements.");
  }).toString() + ")()");
  console.log("Result display passed: all attempts, both electronic modes, legacy durations and judge calculations, penalties/advantages, preserved best ranking, CSV/PDF and unchanged saved data.");
  const usbChecks = await evaluate("(" + (async function () {
    const t = __timingTest;
    const checks = [];
    const check = (condition, message) => { if (!condition) throw new Error(message); };
    const waitFor = async predicate => {
      for (let retry = 0; retry < 200; retry++) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      throw new Error("USB fixture did not reach the expected state.");
    };
    t.mode("manual");
    await t.closeUsbFixtures();
    t.mockStations();
    const report = globalThis.CasomieraTimingValidation;
    await t.closeUsbFixtures();
    t.applySnapshot({ competitionName: "USB discovery fixture", attemptsLimit: 3, judgeCount: 3, timeRule: "median",
      participants: [{ key: "usb-p1", displayName: "USB Participant", mode: "individual", category: "girls", timeEnabled: true, startNumber: 1 }],
      results: [], mode: "individual", viewCat: "girls",
      automatic: { competitionId: "usb-discovery", mode: "manual", transport: "dual_usb", pending: null, cancellations: [], history: [] },
      draft: { selectedParticipantKey: "usb-p1" } });
    const originalSerial = navigator.serial;
    const serial = new EventTarget();
    serial.ports = [];
    serial.promptCount = 0;
    serial.getPorts = async () => serial.ports;
    serial.requestPort = async () => {
      serial.promptCount++;
      if (serial.cancel) throw new DOMException("Cancelled", "NotFoundError");
      serial.ports.push(serial.next);
      return serial.next;
    };
    Object.defineProperty(navigator, "serial", { configurable: true, value: serial });
    const writes = [];
    function makePort(station, overrides = {}, info = { usbVendorId: 0x303a, usbProductId: 0x1001 }) {
      const port = {
        opens: 0, closes: 0, opened: false, busy: false, silent: false, controller: null,
        status: { station, boot: station === "A" ? "11111111" : "22222222", type: "status", tracking: true,
          generation: 1, radioCreditUs: 1000000, radioCanPrepare: true, ...report.stations[station], ...overrides },
        getInfo() { return info; },
        async open() {
          this.opens++;
          if (this.busy) throw new DOMException("Port in use", "NetworkError");
          if (this.opened) throw new DOMException("Already open", "InvalidStateError");
          this.opened = true;
          this.readable = new ReadableStream({ start: controller => { this.controller = controller; } });
          this.writable = { getWriter: () => ({
            write: async bytes => {
              const command = new TextDecoder().decode(bytes).trim();
              writes.push({ station, command });
              if (this.silent) return;
              const remote = station === "A" ? "B" : "A";
              const remoteStatus = { station: remote, boot: this.status.boot, type: "status", tracking: true,
                generation: 1, ...report.stations[remote] };
              const status = command === "AUTO_STATUS" ? this.status : command === "REMOTE_STATUS" ? remoteStatus : null;
              if (command === "AUTO_STATUS") {
                // A queued peer status must never swap the physical USB port's role.
                this.controller.enqueue(new TextEncoder().encode("AUTO " + JSON.stringify(remoteStatus) + String.fromCharCode(10)));
              }
              if (status) this.controller.enqueue(new TextEncoder().encode("AUTO " + JSON.stringify(status) + String.fromCharCode(10)));
            },
            releaseLock() {}
          }) };
        },
        async close() { this.closes++; this.opened = false; },
        unplug() { this.controller.close(); }
      };
      return port;
    }
    async function reset(transport, ports) {
      t.mode("manual");
      await t.closeUsbFixtures();
      serial.ports = ports;
      t.transport(transport);
      t.mode("combined");
      await t.discoverAutomaticPorts(true);
    }
    try {
      const a = makePort("A"), b = makePort("B");
      const foreign = makePort("A", {}, { usbVendorId: 0x9999, usbProductId: 0x1001 });
      const unknown = makePort("A", { boardId: "unknown-board" });
      const unusedDuplicate = makePort("A");
      await reset("dual_usb", [foreign, unknown, b, a, unusedDuplicate]);
      check(t.connections.A?.boardId === report.stations.A.boardId && t.connections.B?.boardId === report.stations.B.boardId,
        "Ports enumerated B/A must be assigned by firmware identity.");
      check(foreign.opens === 0 && unknown.closes === 1 && unusedDuplicate.opens === 0, "Unrelated/unknown/additional devices must not replace the required stations.");
      check(serial.promptCount === 0 && t.ready(), "Previously authorized devices must connect without a picker.");
      check(writes.every(item => item.command === "AUTO_STATUS"), "Discovery must only query identity.");
      checks.push("identity-based discovery without prompts");
      for (const transport of ["wireless", "wireless_a_usb"]) {
        await reset(transport, [a, b]);
        const usb = transport === "wireless" ? "B" : "A";
        const remote = usb === "A" ? "B" : "A";
        check(!!t.connections[usb] && !t.connections[remote] && t.ready(), "Wireless mode must attach only its selected USB coordinator.");
      }
      checks.push("both USB/LoRa directions");
      await reset("dual_usb", []);
      check(!t.connections.A && !t.connections.B && serial.promptCount === 0 && t.connectionNotice.includes("Povoliť"), "Missing authorization must not invoke the picker automatically.");
      const select = document.getElementById("automaticTransport");
      for (const port of [a, b]) {
        serial.next = port;
        select.value = "authorize_usb";
        select.dispatchEvent(new Event("change"));
        await waitFor(() => !!t.connections[port.status.station]);
      }
      check(serial.promptCount === 2 && t.transportValue === "dual_usb" && select.value === "dual_usb", "Permission action must preserve the chosen transport and identify each granted device.");
      serial.cancel = true;
      await t.authorizeAutomaticPort();
      check(t.ready() && t.connectionNotice.includes("zrušený"), "Cancelling a chooser must preserve connected devices.");
      serial.cancel = false;
      checks.push("first-time and cancelled permissions");
      const busy = makePort("A");
      busy.busy = true;
      await reset("wireless_a_usb", [busy]);
      check(busy.closes === 0 && !t.connections.A && t.connectionNotice.includes("sériový monitor"), "An externally occupied port must report a problem without closing it.");
      busy.busy = false;
      await t.discoverAutomaticPorts(true);
      check(!!t.connections.A && t.ready(), "A previously occupied port must be recoverable.");
      checks.push("occupied-port recovery");
      const badBuild = makePort("A", { firmwareHash: "not-the-tested-build" });
      await reset("wireless_a_usb", [badBuild]);
      check(!!t.connections.A && !t.ready(), "An identified board with an unverified firmware must not arm.");
      checks.push("firmware verification guard");
      const silent = makePort("A");
      silent.silent = true;
      await reset("wireless_a_usb", [silent]);
      check(!t.connections.A && silent.closes === 1 && t.connectionNotice.includes("neodpovedalo"), "An unresponsive candidate must time out and release its port.");
      checks.push("bounded identity timeout");
      for (const station of ["A", "B"]) {
        t.mode("manual");
        await t.closeUsbFixtures();
        t.setIndependentLayout(1, station);
        const other = station === "A" ? "B" : "A";
        const properties = { mode: "independent", independentProtocol: 1, inputsReady: true, tracking: false };
        const selected = makePort(station, properties);
        const unselected = makePort(other, properties);
        serial.ports = [unselected, selected];
        t.mode("independent");
        await t.discoverAutomaticPorts(true);
        check(t.independentStationReady(station) && !t.connections[other] && unselected.closes === 1,
          "Single-station discovery must skip the unselected board and connect the selected identity without GNSS.");
        selected.unplug();
        await waitFor(() => !t.connections[station]);
        serial.ports = [selected];
        await t.discoverAutomaticPorts(true);
        check(t.independentStationReady(station) && !t.connectionNotice.includes("Chýba"),
          "A single physical USB station must reconnect without requiring its absent peer.");
      }
      t.mode("manual");
      await t.closeUsbFixtures();
      t.setIndependentLayout(2, "A");
      checks.push("single A or B identity discovery and reconnect");
      await reset("dual_usb", [a, b]);
      t.select("usb-p1");
      await t.prepareAutomaticAttempt();
      const id = t.automaticRun.current.id;
      const message = (station, type, extra = {}) => ({ station, type, id, boot: station === "A" ? "11111111" : "22222222", generation: 1, ...extra });
      for (const station of ["A", "B"]) t.receive(message(station, "armed"));
      t.receive(message("A", "event", { valid: true, localUs: "100", utcUs: "1793451600000000" }));
      t.receive(message("B", "event", { valid: true, localUs: "200", utcUs: "1793451601000000" }));
      const beforeDisconnect = JSON.stringify(t.automaticRun.current.events);
      const start = writes.length;
      a.unplug();
      await waitFor(() => !t.connections.A);
      serial.dispatchEvent(new Event("connect"));
      await t.discoverAutomaticPorts(true);
      check(!!t.connections.A && t.automaticRun.current.id === id &&
        JSON.stringify(t.automaticRun.current.events) === beforeDisconnect && t.automaticRun.current.elapsedUs === "1000000",
        "USB reconnection must retain the captured attempt and timestamps.");
      check(writes.slice(start).some(item => item.command === "AUTO_GET " + id) &&
        !writes.slice(start).some(item => item.command.startsWith("AUTO_ARM ")), "Reconnection must request the original records without replacing a finished attempt.");
      check(!select.querySelector('[value="authorize_usb"]').disabled &&
        select.querySelector('[value="dual_usb"]').disabled, "Permission renewal must remain usable while transport changes are locked.");
      checks.push("automatic reconnect with immutable result");
      await t.cancelAutomaticAttempt();
    } finally {
      t.mode("manual");
      await t.closeUsbFixtures();
      Object.defineProperty(navigator, "serial", { configurable: true, value: originalSerial });
    }
    return checks;
  }).toString() + ")()");
  assert.equal(usbChecks.length, 8, JSON.stringify(usbChecks));
  console.log("USB discovery passed: " + usbChecks.join(", ") + ".");
  await evaluate("(" + function () {
    document.getElementById("competitionGate").classList.remove("visible");
    document.querySelector('[data-work-target="time"]').click();
    __timingTest.mode("combined");
    if (document.getElementById("measurementSettings").hidden) document.getElementById("measurementSettingsToggle").click();
  }.toString() + ")()");
  for (const width of [1100, 390]) {
    await call("Emulation.setDeviceMetricsOverride", { width, height: 844, deviceScaleFactor: 1, mobile: false });
    for (const tooltipId of ["measurementStatusInfo", "measurementModeInfo", "automaticConnectionDetails"]) {
      await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: 1, y: 1 });
      const anchor = await evaluate("(" + function (id) {
        const tooltip = document.getElementById(id);
        const button = tooltip.parentElement.querySelector("button");
        button.scrollIntoView({ block: "center", behavior: "instant" });
        const rect = button.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      }.toString() + ")(" + JSON.stringify(tooltipId) + ")");
      await call("Input.dispatchMouseEvent", { type: "mouseMoved", ...anchor });
      const hovered = await evaluate("(" + function (id) {
        const tooltip = document.getElementById(id);
        const rect = tooltip.getBoundingClientRect();
        const button = tooltip.parentElement.querySelector("button");
        const anchor = button.getBoundingClientRect();
        return { visible: getComputedStyle(tooltip).visibility === "visible", hovered: tooltip.parentElement.matches(":hover"),
          anchor: {x:anchor.x,y:anchor.y}, hit: document.elementFromPoint(anchor.x + anchor.width/2, anchor.y + anchor.height/2)?.outerHTML.slice(0,180),
          fits: rect.left >= 11 && rect.right <= innerWidth - 11 && rect.top >= 0 && rect.bottom <= innerHeight };
      }.toString() + ")(" + JSON.stringify(tooltipId) + ")");
      assert.equal(hovered.visible, true, tooltipId + " must appear on hover: " + JSON.stringify(hovered));
      assert.equal(hovered.fits, true, tooltipId + " must fit the viewport.");
      await call("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape" });
      assert.equal(await evaluate("getComputedStyle(document.getElementById(" + JSON.stringify(tooltipId) + ")).visibility"), "hidden");
      await evaluate("document.getElementById(" + JSON.stringify(tooltipId) + ").parentElement.querySelector('button').focus()");
      assert.equal(await evaluate("getComputedStyle(document.getElementById(" + JSON.stringify(tooltipId) + ")).visibility"), "visible");
      await call("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape" });
    }
  }
  assert.equal(await evaluate("(" + function () { return !!document.getElementById("status").closest('[role="tooltip"]') && !document.getElementById("automaticConnectA") && !document.getElementById("automaticConnectB"); }.toString() + ")()"), true);
  console.log("Measurement panel passed: adjacent information icons, hover/focus/Escape behavior, desktop/mobile bounds and consolidated USB dropdown.");
  for (const measurementMode of ["combined", "independent", "manual"]) {
    await evaluate("__timingTest.mode(" + JSON.stringify(measurementMode) + ")");
    const state = await evaluate("(() => { const toggle = document.getElementById('measurementSettingsToggle'); if (toggle.getAttribute('aria-expanded') === 'true') toggle.click(); return { hidden: document.getElementById('measurementSettings').hidden, modeVisible: document.getElementById('automaticMode').getBoundingClientRect().height > 0, toggleHidden: toggle.hidden }; })()");
    assert.equal(state.hidden, true);
    assert.equal(state.modeVisible, true);
    assert.equal(state.toggleHidden, measurementMode === "manual");
  }
  console.log("Collapsible settings passed: default collapsed, visible mode selector, accessible toggle and unchanged running attempts/settings.");
  assert.equal(errors.length, 0, JSON.stringify(errors));
  console.log("Browser integration passed: automatic and recorded hardware results, firmware verification guard, both LoRa directions and forwarded identity checks, snapshot recovery, exports, and preserved manual median/settings.");
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (socket?.readyState === WebSocket.OPEN) {
    try { await call("Browser.close"); } catch {}
    socket.close();
  }
  chrome.kill();
  clearTimeout(watchdog);
});
