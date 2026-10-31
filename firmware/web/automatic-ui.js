  // Embedded inside the existing application closure by the integration script.
  const AUTO_PENDING_KEY = "casomiera_v11_automatic_pending";
  const AUTO_HISTORY_KEY = "casomiera_v11_automatic_history";
  const AUTO_COMPETITION_KEY = "casomiera_v11_automatic_competition";
  const AUTO_CANCEL_KEY = "casomiera_v11_automatic_cancellations";
  let automaticCancellations = [];
  try {
    const retained = JSON.parse(localStorage.getItem(AUTO_CANCEL_KEY) || "[]");
    if (Array.isArray(retained)) automaticCancellations = retained.filter(item => /^[A-Za-z0-9_-]{1,40}$/.test(item.id || ""));
  } catch {}
  let cancellationServiceBusy = false;
  let automaticMode = "manual";
  let automaticTransport = "dual_usb";
  let automaticRemoteStatus = null;
  function newAutomaticCompetitionId() {
    return globalThis.crypto?.randomUUID ? crypto.randomUUID() :
      "competition_" + Date.now() + "_" + Math.random().toString(36).slice(2);
  }
  let automaticCompetitionId = localStorage.getItem(AUTO_COMPETITION_KEY) || newAutomaticCompetitionId();
  localStorage.setItem(AUTO_COMPETITION_KEY, automaticCompetitionId);
  let restoredAutomatic = null;
  try { restoredAutomatic = JSON.parse(localStorage.getItem(AUTO_PENDING_KEY) || "null"); } catch {}
  let automaticStorageError = false;
  let automaticRun;
  try { automaticRun = new CasomieraAutomatic.AutomaticRun(restoredAutomatic); }
  catch { automaticStorageError = true; automaticRun = new CasomieraAutomatic.AutomaticRun(); }
  const automaticPorts = { A: null, B: null };
  let automaticNotice = "Pripoj stanice A a B cez USB.";
  let automaticRetryAt = 0;
  let automaticPulseAt = 0;
  let automaticUiReady = false;

  function isAutomaticMode() { return automaticMode === "combined"; }
  function automaticPending() { return automaticRun.busy; }
  function measurementRuleDescription(record) {
    return record.measurementMode === "automatic_combined" ? "Automatické A+B" :
      `${normalizeJudgeCount(record.judgeCount ?? 3)} rozhodcovia; výpočet: ${RULE_LABELS[normalizeTimeRule(record.timeRule ?? "median")]}`;
  }

  function persistAutomatic() {
    localStorage.setItem(AUTO_PENDING_KEY, JSON.stringify(automaticRun.current));
  }

  function persistAutomaticCancellations() {
    localStorage.setItem(AUTO_CANCEL_KEY, JSON.stringify(automaticCancellations));
  }

  function acceptAutomaticCancellation(message) {
    if (message.type !== "cancelled") return;
    const pending = automaticCancellations.find(item => item.id === message.id);
    if (pending) {
      // A cancellation reply may carry an event whose original delivery failed.
      // Save that raw event before acknowledging/archiving the device record.
      if (/^\d+$/.test(String(message.localUs)) && BigInt(message.localUs) > 0n) {
        const raw = { boot: message.boot, localUs: String(message.localUs), utcUs: String(message.utcUs),
          generation: message.generation, valid: message.valid === true };
        if (automaticRun.current?.id === message.id) {
          (automaticRun.current.cancelledEvents ||= {})[message.station] ||= raw;
          persistAutomatic();
        }
        let history = JSON.parse(localStorage.getItem(AUTO_HISTORY_KEY) || "[]");
        const context = history.find(item => item.id === message.id);
        if (!context) throw new Error("Chýba uložená história rušeného pokusu; údaje na doske nearchivujem.");
        (context.cancelledEvents ||= {})[message.station] ||= raw;
        localStorage.setItem(AUTO_HISTORY_KEY, JSON.stringify(history));
      }
      (pending.acknowledged ||= {})[message.station] = true;
      persistAutomaticCancellations();
    }
  }

  function archiveAutomaticContext() {
    if (!automaticRun.current) return;
    let history = [];
    try { history = JSON.parse(localStorage.getItem(AUTO_HISTORY_KEY) || "[]"); } catch {}
    if (!Array.isArray(history)) history = [];
    const copy = JSON.parse(JSON.stringify(automaticRun.current));
    const index = history.findIndex(item => item.id === copy.id);
    if (index < 0) history.push(copy); else history[index] = copy;
    // Do not silently evict retained measurements when storage becomes full.
    localStorage.setItem(AUTO_HISTORY_KEY, JSON.stringify(history));
  }

  function showAutomaticError(error) {
    automaticNotice = String(error?.message || error);
    updateAutomaticUI();
  }

  async function sendAutomatic(station, command) {
    const remote = station === "A" && automaticTransport === "wireless";
    const connection = automaticPorts[remote ? "B" : station];
    if (remote) command = command.replace(/^AUTO_/, "REMOTE_");
    if (!connection?.port?.writable) throw new Error(`Stanica ${station} nie je pripojená.`);
    const next = connection.writes.catch(() => {}).then(async () => {
      const writer = connection.port.writable.getWriter();
      try { await writer.write(new TextEncoder().encode(command + "\n")); }
      finally { writer.releaseLock(); }
    });
    connection.writes = next;
    return next;
  }

  async function connectAutomatic(station) {
    if (!navigator.serial) throw new Error("USB meranie vyžaduje Chrome alebo Edge na PC.");
    if (automaticPorts[station]) throw new Error(`Stanica ${station} je už pripojená.`);
    const port = await navigator.serial.requestPort({ filters: [{ usbVendorId: 0x303a, usbProductId: 0x1001 }] });
    if (Object.values(automaticPorts).some(value => value?.port === port)) {
      throw new Error("Tento USB port už používa druhá stanica.");
    }
    await port.open({ baudRate: 115200 });
    const connection = { port, reader: null, writes: Promise.resolve(), status: null, seenAt: 0 };
    automaticPorts[station] = connection;
    readAutomatic(station, connection).catch(showAutomaticError);
    await sendAutomatic(station, "AUTO_STATUS");
    if (station === "B" && automaticTransport === "wireless") {
      await sendAutomatic("A", "AUTO_STATUS");
    }
    automaticNotice = `Overujem identitu stanice ${station}…`;
    updateAutomaticUI();
  }

  async function readAutomatic(station, connection) {
    const reader = connection.port.readable.getReader();
    connection.reader = reader;
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          const message = CasomieraAutomatic.parseMessage(line);
          if (!message) continue;
          const forwarded = station === "B" && message.station === "A" && automaticTransport === "wireless";
          if (message.station !== station && !forwarded) {
            throw new Error(`Vybraný port patrí stanici ${message.station}, nie ${station}.`);
          }
          connection.seenAt = Date.now();
          acceptAutomaticCancellation(message);
          if (message.type === "status") {
            if (forwarded) automaticRemoteStatus = message;
            else connection.status = message;
          } else if (automaticRun.accept(message)) {
            persistAutomatic();
            applyAutomaticProgress();
          }
          updateAutomaticUI();
        }
        if (buffer.length > 2048) buffer = "";
      }
    } finally {
      reader.releaseLock();
      automaticPorts[station] = null;
      try { await connection.writes; await connection.port.close(); } catch {}
      automaticNotice = `Stanica ${station} bola odpojená. Zachytené časy zostávajú uložené; pripoj ju a obnov údaje.`;
      updateAutomaticUI();
    }
  }

  function automaticStationsReady() {
    const stations = automaticTransport === "wireless" ? ["B"] : ["A", "B"];
    return !!automaticValidation() && stations.every(station => {
      const connection = automaticPorts[station];
      return connection?.status?.tracking === true && Date.now() - connection.seenAt < 5000 &&
        (automaticTransport !== "wireless" || connection.status.radioCanPrepare === true);
    });
  }

  function automaticValidation() {
    const report = globalThis.CasomieraTimingValidation;
    if (!report?.passed || report.criterionUs !== 1000 || report.sampleCount < 24 ||
        report.maximumAbsoluteDifferenceUs > 1000) return null;
    for (const station of ["A", "B"]) {
      const status = station === "A" && automaticTransport === "wireless"
        ? automaticRemoteStatus : automaticPorts[station]?.status;
      const tested = report.stations?.[station];
      if (!tested || !status || status.boardId !== tested.boardId || status.firmwareHash !== tested.firmwareHash) return null;
    }
    return report;
  }

  async function prepareAutomaticAttempt() {
    if (automaticStorageError) throw new Error("Uložený automatický pokus je poškodený. Najprv obnov jeho JSON zálohu.");
    const selected = getSelectedParticipantInfo();
    if (!selected) throw new Error("Najprv vyber súťažiaceho.");
    if (automaticRun.busy || rec.some(value => value !== null)) {
      throw new Error("Najprv ulož alebo zruš rozpracované meranie.");
    }
    if (!automaticStationsReady()) throw new Error("Pripoj obe overené stanice s platnou časovou základňou; musí súhlasiť aj verzia firmvéru.");
    // Clear old device arming before preparing a new ID. USB writes are ordered;
    // the radio protocol additionally rejects older coordinator tokens.
    for (const pending of automaticCancellations) {
      await Promise.all(["A", "B"].map(station => sendAutomatic(station, `AUTO_CANCEL ${pending.id}`)));
    }
    const attemptNo = getUsedAttemptsForKey(selected.key, selected.mode, selected.category) + 1;
    if (attemptNo > getConfiguredAttemptsLimit()) throw new Error("Súťažiaci už má všetky pokusy.");
    const attempt = automaticRun.prepare(selected, attemptNo, automaticCompetitionId);
    attempt.transport = automaticTransport;
    attempt.accuracy = "relative_1ms_bench_verified";
    attempt.verification = JSON.parse(JSON.stringify(automaticValidation()));
    // Persist the participant binding before allowing either hardware input.
    persistAutomatic();
    running = true;
    tStart = 0;
    rec[0] = rec[1] = rec[2] = null;
    if (el.penaltySeconds) el.penaltySeconds.value = "";
    automaticNotice = "Pripravujem obe stanice…";
    setUI();
    await Promise.all(["A", "B"].map(station => sendAutomatic(station, `AUTO_ARM ${attempt.id}`)));
  }

  function applyAutomaticProgress() {
    const attempt = automaticRun.current;
    if (!attempt || !isAutomaticMode()) return;
    if (attempt.competitionId !== automaticCompetitionId) {
      automaticNotice = "Uložený pokus patrí inej súťaži. Najprv obnov príslušnú zálohu.";
      return;
    }
    if (automaticRun.busy) {
      const bound = getParticipantsForAllViews().find(participant => participant.key === attempt.participant.key &&
        participant.mode === attempt.participant.mode && participant.category === attempt.participant.category);
      if (!bound) {
        automaticNotice = "Súťažiaci uloženého pokusu chýba. Obnov príslušnú zálohu súťaže.";
        updateAutomaticUI();
        return;
      }
      mode = bound.mode;
      viewCat = bound.category;
      selectedParticipantKey = bound.key;
      pendingParticipantKey = bound.key;
      setTabsUI();
    }
    if (attempt.phase === "finished") {
      running = false;
      rec[0] = attempt.elapsedMs;
      rec[1] = rec[2] = null;
      if (raf) cancelAnimationFrame(raf);
      raf = null;
      automaticNotice = `Čas ${formatMs(attempt.elapsedMs)} s je zachytený. Doplň trest a ulož výsledok.`;
    } else if (!["saved", "cancelled"].includes(attempt.phase)) {
      running = true;
      if (attempt.events.A && !tStart) {
        // This is only a live animation; the official result uses board timestamps.
        tStart = Date.now();
        if (raf) cancelAnimationFrame(raf);
        raf = requestAnimationFrame(tick);
      }
      const labels = { preparing: "Čakám na potvrdenie oboch staníc.", armed: "Pripravené: čakám na fyzický START na A.",
        running: "Meranie prebieha: čakám na fyzický STOP na B.", recovery: "Údaje vyžadujú kontrolu. Zachytené časy zostali uložené.",
        cancelling: "Ruším pokus na oboch staniciach…" };
      automaticNotice = labels[attempt.phase] || "Obnovujem údaje pokusu.";
      const lastError = attempt.errors.at(-1);
      if (lastError && ["preparing", "recovery"].includes(attempt.phase)) {
        const descriptions = {
          CLOCK_NOT_TRACKING: "čakám na platnú časovú základňu",
          RADIO_CREDIT_PENDING: "pripravujem dostupný rádiový čas",
          RELEASE_BUTTON: "uvoľni tlačidlo pred prípravou",
          STORAGE_FULL: "pamäť zachytených pokusov je plná; najprv obnov a ulož staršie údaje",
          INVALID_EVENT_CLOCK: "zachytený vstup nemal platnú časovú základňu",
          CLOCK_OR_BOOT_CHANGED: "počas pokusu sa zmenil stav hodín alebo sa doska reštartovala"
        };
        automaticNotice = `Stanica ${lastError.station}: ${descriptions[lastError.reason] || "údaje vyžadujú kontrolu"}. Zachytené údaje zostávajú uložené.`;
      }
    }
    setUI();
    autoPersistToFile();
  }

  async function cancelAutomaticAttempt() {
    const attempt = automaticRun.current;
    if (!attempt || !automaticRun.busy) return;
    automaticRun.cancel();
    persistAutomatic();
    archiveAutomaticContext();
    if (!automaticCancellations.some(item => item.id === attempt.id)) {
      automaticCancellations.push({ id: attempt.id, acknowledged: {} });
      persistAutomaticCancellations();
    }
    const results = await Promise.allSettled(["A", "B"].map(station =>
      sendAutomatic(station, `AUTO_CANCEL ${attempt.id}`)));
    // An explicit operator cancellation must also permit manual fallback when
    // a station is unavailable. Keep raw events and pending device cancellation.
    automaticRun.confirmCancellation();
    archiveAutomaticContext();
    persistAutomatic();
    running = false;
    rec[0] = rec[1] = rec[2] = null;
    tStart = 0;
    automaticNotice = results.some(result => result.status === "rejected")
      ? "Pokus bol zrušený lokálne. Môžeš prepnúť na ručné meranie; zrušenie na nedostupných staniciach sa zopakuje po pripojení."
      : "Pokus bol zrušený. Nový môžeš pripraviť ihneď; zachytené údaje zostávajú v histórii.";
    setUI();
    autoPersistToFile();
  }

  async function serviceAutomaticCancellations() {
    if (cancellationServiceBusy || automaticRun.busy || automaticCancellations.length === 0) return;
    cancellationServiceBusy = true;
    try {
      const pending = automaticCancellations[0];
      const acknowledged = pending.acknowledged?.A && pending.acknowledged?.B;
      for (const station of ["A", "B"]) {
        await sendAutomatic(station, `AUTO_CANCEL ${pending.id}`);
      }
      if (acknowledged) {
        for (const station of ["A", "B"]) await sendAutomatic(station, `AUTO_ARCHIVE ${pending.id}`);
        automaticCancellations.shift();
        persistAutomaticCancellations();
      }
    } catch {
      // A disconnected device does not prevent manual operation or erase data.
    } finally { cancellationServiceBusy = false; }
  }

  async function recoverAutomaticAttempt() {
    const attempt = automaticRun.current;
    if (!attempt || !automaticRun.busy) return;
    for (const station of ["A", "B"]) {
      if (!automaticPorts[station] && !(station === "A" && automaticTransport === "wireless" && automaticPorts.B)) continue;
      const operation = attempt.phase === "cancelling" ? "AUTO_CANCEL" : "AUTO_GET";
      await sendAutomatic(station, `${operation} ${attempt.id}`);
    }
  }

  function automaticRawMs() {
    const attempt = automaticRun.current;
    const selected = getSelectedParticipantInfo();
    return attempt?.phase === "finished" && selected?.key === attempt.participant.key &&
      selected.mode === attempt.participant.mode && selected.category === attempt.participant.category &&
      attempt.competitionId === automaticCompetitionId ? attempt.elapsedMs : null;
  }

  function updateAutomaticUI() {
    if (!automaticUiReady) return;
    const enabled = isAutomaticMode();
    $("automaticMode").value = automaticMode;
    $("automaticMode").disabled = automaticRun.busy || running || rec.some(value => value !== null);
    $("automaticTransport").value = automaticTransport;
    $("automaticTransport").disabled = automaticRun.busy || running || rec.some(value => value !== null);
    $("automaticControls").hidden = !enabled;
    $("automaticNotice").textContent = automaticNotice;
    const verified = automaticValidation();
    $("automaticAccuracy").textContent = verified
      ? `Na tejto dvojici a verzii firmvéru bola overená vzájomná zhoda do 1 ms (${verified.sampleCount} impulzov, najväčší rozdiel ${verified.maximumAbsoluteDifferenceUs} µs). Optické brány týmto testom overené neboli.`
      : "Pre túto dvojicu a verziu firmvéru zatiaľ nie je platný protokol overenia do 1 ms. Automatický pokus sa nedá pripraviť.";
    for (const station of ["A", "B"]) {
      const connection = automaticPorts[station];
      $("automaticConnect" + station).disabled = !!connection;
      $("automaticStation" + station).textContent = !connection ? `${station}: odpojená` :
        `${station}: ${connection.status?.tracking ? "časová základňa pripravená" : "čakám na GNSS/PPS"}`;
    }
    $("automaticConnectA").hidden = automaticTransport === "wireless";
    if (automaticTransport === "wireless") {
      $("automaticStationA").textContent = `A cez LoRa: ${automaticRemoteStatus?.tracking ? "časová základňa pripravená" : "overí sa pri príprave pokusu"}`;
    }
    $("automaticRecover").disabled = !automaticRun.busy;
    for (const control of [el.tabIndividual, el.tabTeam, el.tabGirls, el.tabBoys, el.tabMix]) {
      if (control) control.disabled = automaticRun.busy;
    }
    if (enabled) {
      for (let index = 0; index < 3; ++index) {
        el.stop[index].disabled = true;
        el.setBtn[index].disabled = true;
        el.reset[index].disabled = true;
        el.manual[index].disabled = true;
      }
      el.start.textContent = "Pripraviť automatický pokus";
      el.start.disabled = automaticRun.busy || !getSelectedParticipantInfo() || !automaticStationsReady();
      el.abort.disabled = !automaticRun.busy;
      el.confirmParticipant.disabled = automaticRun.busy || !getPendingParticipantInfo();
      el.judgeCount.disabled = true;
      el.timeRule.disabled = true;
      el.status.textContent = automaticNotice;
      if (automaticRun.busy) {
        const name = automaticRun.current.participant.displayName;
        el.activeCompetitorName.textContent = name || automaticRun.current.participant.key;
      }
    } else {
      el.start.innerHTML = 'Štart <span class="kbdHint">(medzerník)</span>';
    }
    const title = el.t[0]?.closest(".judge")?.querySelector("h3");
    if (title) title.textContent = enabled ? "Automatické A+B" : "Rozhodca 1";
  }

  function initializeAutomaticUI() {
    if (IS_DISPLAY_MODE) return;
    automaticUiReady = true;
    $("automaticTransport").addEventListener("change", () => {
      if (automaticRun.busy || running || rec.some(value => value !== null)) { updateAutomaticUI(); return; }
      automaticTransport = $("automaticTransport").value === "wireless" ? "wireless" : "dual_usb";
      automaticRemoteStatus = null;
      if (automaticTransport === "wireless" && automaticPorts.B) sendAutomatic("A", "AUTO_STATUS").catch(showAutomaticError);
      updateAutomaticUI();
    });
    $("automaticMode").addEventListener("change", () => {
      if (automaticRun.busy || running || rec.some(value => value !== null)) {
        showAutomaticError("Najprv ulož alebo zruš rozpracované meranie.");
        updateAutomaticUI();
        return;
      }
      automaticMode = $("automaticMode").value === "combined" ? "combined" : "manual";
      tStart = 0;
      setUI();
    });
    for (const station of ["A", "B"]) {
      $("automaticConnect" + station).addEventListener("click", () => connectAutomatic(station).catch(showAutomaticError));
    }
    $("automaticRecover").addEventListener("click", () => recoverAutomaticAttempt().catch(showAutomaticError));
    if (automaticRun.busy) {
      automaticMode = "combined";
      automaticTransport = automaticRun.current.transport === "wireless" ? "wireless" : "dual_usb";
      automaticNotice = "Našiel sa rozpracovaný automatický pokus. Pripoj stanice a obnov údaje.";
      running = true;
    }
    const pending = automaticRun.current;
    if (pending?.phase === "finished" && loadAll().some(record => record.electronic?.attemptId === pending.id)) {
      automaticRun.markSaved();
      persistAutomatic();
      running = false;
      rec[0] = rec[1] = rec[2] = null;
    }
    setInterval(() => {
      if (Date.now() - automaticPulseAt >= 2000) {
        automaticPulseAt = Date.now();
        for (const station of (automaticTransport === "wireless" ? ["B"] : ["A", "B"])) {
          if (automaticPorts[station]) sendAutomatic(station, "AUTO_STATUS").catch(showAutomaticError);
        }
        serviceAutomaticCancellations();
      }
      const attempt = automaticRun.current;
      if (attempt?.phase === "cancelling" && attempt.cancelled.A && attempt.cancelled.B) {
        automaticRun.confirmCancellation();
        archiveAutomaticContext();
        persistAutomatic();
        running = false;
        rec[0] = rec[1] = rec[2] = null;
        tStart = 0;
        automaticNotice = "Pokus bol zrušený. Nový môžeš pripraviť ihneď.";
        for (const station of ["A", "B"]) {
          if (automaticPorts[station] || (station === "A" && automaticTransport === "wireless" && automaticPorts.B)) sendAutomatic(station, `AUTO_ARCHIVE ${attempt.id}`).catch(showAutomaticError);
        }
        setUI();
      }
      const retryInterval = automaticTransport === "wireless" && attempt?.phase !== "preparing" && attempt?.phase !== "cancelling" ? 10000 : 2000;
      if (automaticRun.busy && Date.now() - automaticRetryAt >= retryInterval) {
        automaticRetryAt = Date.now();
        if (attempt.phase === "preparing") {
          for (const station of ["A", "B"]) {
            if (automaticPorts[station] || (station === "A" && automaticTransport === "wireless" && automaticPorts.B)) sendAutomatic(station, `AUTO_ARM ${attempt.id}`).catch(showAutomaticError);
          }
        } else {
          recoverAutomaticAttempt().catch(showAutomaticError);
        }
      }
      updateAutomaticUI();
    }, 500);
    applyAutomaticProgress();
    setUI();
  }
