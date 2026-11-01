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
  assert.equal(usbChecks.length, 7, JSON.stringify(usbChecks));
  console.log("USB discovery passed: " + usbChecks.join(", ") + ".");
  await evaluate("(" + function () { document.getElementById("competitionGate").classList.remove("visible"); document.querySelector('[data-work-target="time"]').click(); __timingTest.mode("combined"); }.toString() + ")()");
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
