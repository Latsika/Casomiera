  // Embedded in the application closure; shares USB discovery, never GPS attempts.
  const INDEPENDENT_STORAGE_KEY = "casomiera_v11_independent";
  let independentRuns = new CasomieraIndependent.IndependentRuns();
  let independentDraft = { A: { participant: "", penalty: "" }, B: { participant: "", penalty: "" } };
  let independentLayout = { count: 1, singleStation: "A" };
  let independentStorageError = false;
  let independentUiReady = false;
  let independentServiceAt = 0;
  let independentServiceBusy = false;
  const independentNotices = { A: "", B: "" };
  const independentLiveStarted = { A: null, B: null };
  const independentCallAssignments = { A: "", B: "" };
  let independentProjection = null;
  try {
    const retained = JSON.parse(localStorage.getItem(INDEPENDENT_STORAGE_KEY) || "null");
    if (retained) {
      independentRuns = new CasomieraIndependent.IndependentRuns(retained.runs);
      if (retained.draft) independentDraft = retained.draft;
      independentLayout = normalizeIndependentLayout(retained.layout, independentRuns);
    }
  } catch {
    independentStorageError = true;
    if (independentRuns.busyAt("B")) independentLayout = { count: 2, singleStation: "A" };
  }

  function isIndependentMode() { return automaticMode === "independent"; }
  function independentPending() { return independentStorageError || independentRuns.busy; }
  function independentStations(layout = independentLayout) {
    return layout.count === 2 ? ["A", "B"] : [layout.singleStation];
  }

  function normalizeIndependentLayout(value, runs) {
    // Legacy backups with a pending B attempt must keep both panels visible.
    const layout = value == null ? { count: runs.busyAt("B") ? 2 : 1, singleStation: "A" } :
      { count: value.count, singleStation: value.singleStation };
    if (![1, 2].includes(layout.count) || !["A", "B"].includes(layout.singleStation)) {
      throw new Error("Neplatný počet súťažiacich alebo výber stanice v zálohe.");
    }
    for (const station of ["A", "B"]) {
      if (runs.busyAt(station) && !independentStations(layout).includes(station)) {
        throw new Error("Najprv ulož alebo zruš pokus stanice " + station + "; zmena by ho skryla.");
      }
    }
    return layout;
  }

  function setIndependentLayout(count, singleStation) {
    if (independentPending()) throw new Error("Najprv ulož alebo zruš rozpracované nezávislé pokusy.");
    const next = normalizeIndependentLayout({ count, singleStation }, independentRuns);
    const previous = independentLayout;
    independentLayout = next;
    try { persistIndependent(); } catch (error) { independentLayout = previous; throw error; }
    automaticModeRequests.A = automaticModeRequests.B = 0;
    automaticDiscoveryAt = 0;
    updateAutomaticUI();
    autoPersistToFile();
    discoverAutomaticPorts(true);
    synchronizeAutomaticModes().catch(showAutomaticError);
  }

  function independentSnapshot() {
    if (independentStorageError) throw new Error("Poškodená záloha nezávislého merania; najprv obnov pôvodný JSON.");
    return { runs: independentRuns.snapshot(), draft: JSON.parse(JSON.stringify(independentDraft)),
      layout: { ...independentLayout } };
  }
  function persistIndependent() {
    localStorage.setItem(INDEPENDENT_STORAGE_KEY, JSON.stringify(independentSnapshot()));
  }

  function validateIndependentRestore(value, competitionId) {
    const recovered = new CasomieraIndependent.IndependentRuns(value?.runs || null);
    // Device acknowledgement queues are independent of the chosen JSON's age.
    for (const action of independentRuns.actions) {
      const incomingAction = recovered.actions.find(item => item.station === action.station && item.id === action.id);
      if (incomingAction && incomingAction.operation !== action.operation) {
        throw new Error("Záloha obsahuje konfliktné potvrdenie pokusu " + action.id + ".");
      }
      if (!incomingAction) recovered.actions.push({ ...action });
      else if (action.stage === "archive") incomingAction.stage = "archive";
      const retained = independentRuns.current[action.station]?.id === action.id ? independentRuns.current[action.station] :
        independentRuns.history.find(item => item.station === action.station && item.id === action.id);
      if (retained && !recovered.history.some(item => item.station === action.station && item.id === action.id)) {
        recovered.retain(retained);
      }
    }
    for (const station of ["A", "B"]) {
      const existing = independentRuns.current[station];
      const incoming = recovered.current[station];
      if (independentRuns.busyAt(station) &&
          (incoming?.id !== existing.id || competitionId !== existing.competitionId)) {
        throw new Error("Najprv ulož alebo zruš nezávislý pokus stanice " + station + ".");
      }
      if (independentRuns.busyAt(station)) {
        if (["saved", "cancelled"].includes(incoming.phase) ||
            incoming.participant.key !== existing.participant.key ||
            incoming.participant.mode !== existing.participant.mode ||
            incoming.participant.category !== existing.participant.category ||
            incoming.attemptNo !== existing.attemptNo ||
            (incoming.boot && existing.boot && incoming.boot !== existing.boot)) {
          throw new Error("Záloha mení kontext aktívneho pokusu stanice " + station + ".");
        }
        // Restoring an older JSON must not erase timestamps already received.
        for (const field of ["startUs", "stopUs"]) {
          if (incoming[field] && existing[field] && incoming[field] !== existing[field]) {
            throw new Error("Záloha obsahuje konfliktný čas stanice " + station + ".");
          }
          if (!incoming[field]) incoming[field] = existing[field];
        }
        incoming.boot ||= existing.boot;
        incoming.participant = JSON.parse(JSON.stringify(existing.participant));
        if (incoming.stopUs) {
          const elapsed = BigInt(incoming.stopUs) - BigInt(incoming.startUs);
          incoming.elapsedUs = elapsed.toString();
          incoming.elapsedMs = Number((elapsed + 500n) / 1000n);
        }
        incoming.phase = existing.phase === "recovery" ? "recovery" :
          incoming.stopUs ? "finished" : incoming.startUs ? "running" : incoming.phase;
      }
    }
    normalizeIndependentLayout(value?.layout, recovered);
    return recovered;
  }

  function restoreIndependentSnapshot(value, recovered) {
    // Old JSON files contain no independent state; pending device cleanup survives.
    if (!value) {
      recovered.history = JSON.parse(JSON.stringify(independentRuns.history));
      recovered.actions = JSON.parse(JSON.stringify(independentRuns.actions));
    }
    independentRuns = recovered;
    independentLayout = normalizeIndependentLayout(value?.layout, recovered);
    independentDraft = value?.draft || { A: { participant: "", penalty: "" }, B: { participant: "", penalty: "" } };
    for (const station of ["A", "B"]) {
      const draft = independentDraft[station];
      independentDraft[station] = {
        participant: String(draft?.participant || ""),
        penalty: String(draft?.penalty ?? "")
      };
      if (independentLiveStarted[station]?.id !== recovered.current[station]?.id) independentLiveStarted[station] = null;
    }
    independentStorageError = false;
    persistIndependent();
  }

  function independentStatus(station) {
    return automaticPorts[station]?.status;
  }

  function independentStationReady(station) {
    const connection = automaticPorts[station];
    const status = connection?.status;
    const expected = globalThis.CasomieraTimingValidation?.stations?.[station];
    return independentStations().includes(station) && !independentStorageError && status?.independentProtocol === 1 &&
      status.mode === "independent" && status.inputsReady === true &&
      status.boardId === expected?.boardId && typeof status.firmwareHash === "string" &&
      Date.now() - connection.seenAt < 5000;
  }

  async function sendIndependent(station, command) {
    // Independent operation is always direct USB, irrespective of the GPS transport.
    const connection = automaticPorts[station];
    if (!connection?.port?.writable) throw new Error("Stanica " + station + " nie je pripojená cez USB.");
    const next = connection.writes.catch(() => {}).then(async () => {
      const writer = connection.port.writable.getWriter();
      try { await writer.write(new TextEncoder().encode(command + "\n")); }
      finally { writer.releaseLock(); }
    });
    connection.writes = next;
    return next;
  }

  function independentParticipant(station) {
    const key = independentDraft[station].participant;
    return getParticipantsForAllViews().find(participant => participant.key === key && participant.timeEnabled !== false);
  }

  async function prepareIndependent(station) {
    if (!isIndependentMode() || independentStorageError) throw new Error("Nezávislé meranie nie je pripravené.");
    updateCallPanel();
    if (!independentStations().includes(station)) throw new Error("Stanica nie je vybraná pre aktuálne meranie.");
    if (!independentStationReady(station)) throw new Error("Počkaj na potvrdenie režimu a uvoľni oba vstupy stanice " + station + ".");
    const participant = independentParticipant(station);
    if (!participant) throw new Error("Vyber súťažiaceho pre stanicu " + station + ".");
    const attemptNo = getUsedAttemptsForKey(participant.key, participant.mode, participant.category) + 1;
    if (attemptNo > getConfiguredAttemptsLimit()) throw new Error("Súťažiaci už má všetky pokusy.");
    const attempt = independentRuns.prepare(station, participant, attemptNo, automaticCompetitionId,
      crypto.randomUUID(), independentStatus(station));
    independentLiveStarted[station] = null;
    independentDraft[station].penalty = "";
    independentNotices[station] = "Pripravujem pokus.";
    persistIndependent();
    autoPersistToFile();
    updateIndependentUI();
    await sendIndependent(station, "INDEP_ARM " + attempt.id);
  }

  async function cancelIndependent(station) {
    independentRuns.cancel(station);
    persistIndependent();
    autoPersistToFile();
    independentNotices[station] = "Pokus zrušený; zachytené údaje zostávajú v histórii.";
    updateCallPanel();
    updateIndependentUI();
    await serviceIndependent(true);
  }

  async function recoverIndependent(station) {
    const attempt = independentRuns.current[station];
    if (attempt && independentRuns.busyAt(station)) await sendIndependent(station, "INDEP_GET " + attempt.id);
    await serviceIndependent(true);
  }

  async function configureIndependent(station) {
    if (independentRuns.busyAt(station)) throw new Error("Najprv ulož alebo zruš pokus.");
    const low = Number($("independentLow" + station).value);
    const release = Number($("independentRelease" + station).value);
    if (!Number.isInteger(low) || low < 0 || low > 30000 ||
        !Number.isInteger(release) || release < 1000 || release > 1000000) {
      throw new Error("Potvrdenie LOW: 0–30000 µs; stabilné uvoľnenie: 1000–1000000 µs.");
    }
    await sendIndependent(station, "INDEP_CONFIG " + low + " " + release);
  }

  function handleIndependentMessage(message) {
    if (message.kind !== "independent") return false;
    if (independentStorageError) return true;
    if (!independentRuns.accept(message)) return true;
    const current = independentRuns.current[message.station];
    if (current?.id === message.id && message.type !== "independent_error") independentNotices[message.station] = "";
    if (current?.id === message.id && current.startUs && independentLiveStarted[message.station]?.id !== current.id) {
      independentLiveStarted[message.station] = { id: current.id, at: Date.now() };
    }
    persistIndependent();
    autoPersistToFile();
    updateIndependentUI();
    return true;
  }

  async function serviceIndependent(force = false) {
    if (independentStorageError || independentServiceBusy || (!force && Date.now() - independentServiceAt < 2000)) return;
    independentServiceAt = Date.now();
    independentServiceBusy = true;
    try {
      for (const action of [...independentRuns.actions]) {
        if (!automaticPorts[action.station]) continue;
        const operation = action.stage === "archive" ? "ARCHIVE" : action.operation;
        await sendIndependent(action.station, "INDEP_" + operation + " " + action.id);
      }
      if (!isIndependentMode()) return;
      for (const station of independentStations()) {
        const attempt = independentRuns.current[station];
        if (!automaticPorts[station] || !attempt || !independentRuns.busyAt(station) ||
            independentStatus(station)?.mode !== "independent") continue;
        const operation = attempt.phase === "preparing" ? "ARM" : "GET";
        await sendIndependent(station, "INDEP_" + operation + " " + attempt.id);
      }
    } catch (error) {
      // Delivery failure retains the original attempt and raw timestamps.
      automaticConnectionNotice = String(error?.message || error);
    } finally { independentServiceBusy = false; }
  }

  function saveIndependentResult(station) {
    if (independentStorageError) throw new Error("Najprv obnov zálohu nezávislého merania.");
    const attempt = independentRuns.current[station];
    if (attempt?.phase !== "finished" || attempt.competitionId !== automaticCompetitionId) throw new Error("Chýba dokončený pokus tejto súťaže.");
    const list = loadAll();
    const existing = list.find(record => record.electronic?.attemptId === attempt.id);
    if (existing) {
      independentRuns.markSaved(station, existing.id);
    } else {
      const rawPenalty = independentDraft[station].penalty.trim();
      const penaltyMs = parsePenaltySecondsToMs(rawPenalty);
      if (!rawPenalty || penaltyMs === null) throw new Error("Zadaj trestné sekundy vrátane nuly.");
      const participant = attempt.participant;
      const present = getParticipantsForAllViews().some(item => item.key === participant.key &&
        item.mode === participant.mode && item.category === participant.category);
      if (!present || getUsedAttemptsForKey(participant.key, participant.mode, participant.category) + 1 !== attempt.attemptNo ||
          attempt.attemptNo > getConfiguredAttemptsLimit()) throw new Error("Zmenil sa súťažiaci alebo počet pokusov; zachytený čas zostal uložený.");
      const advantageSeconds = participant.mode === "team" ? getAdvantageSeconds(participant) : 0;
      const advantageMs = Math.round(advantageSeconds * 1000);
      const record = {
        id: crypto.randomUUID(), mode: participant.mode, category: participant.category,
        participantKey: participant.key, displayName: participant.displayName, subLine: participant.subLine,
        teamOrder: Number(participant.teamOrder) || null, attemptNo: attempt.attemptNo,
        t1: null, t2: null, t3: null, judgeCount: null, timeRule: null,
        rawMeasuredMs: attempt.elapsedMs, measurementMode: "automatic_independent",
        electronic: { station, attemptId: attempt.id, competitionId: attempt.competitionId,
          start: { localUs: attempt.startUs, boot: attempt.boot }, stop: { localUs: attempt.stopUs, boot: attempt.boot },
          elapsedUs: attempt.elapsedUs, boardId: attempt.boardId, firmwareHash: attempt.firmwareHash,
          inputLowUs: attempt.inputLowUs, inputReleaseUs: attempt.inputReleaseUs,
          clock: "local_esp_timer", accuracy: "unverified_local_clock" },
        advantageSeconds, advantageMs, penaltySeconds: penaltyMs / 1000, penaltyMs,
        valid: Math.max(0, attempt.elapsedMs - advantageMs + penaltyMs),
        stamp: nowStamp(), createdAt: new Date().toISOString()
      };
      list.push(record);
      saveAll(list);
      independentRuns.markSaved(station, record.id);
    }
    persistIndependent();
    autoPersistToFile();
    renderTable();
    updateCallPanel();
    updateIndependentUI();
    serviceIndependent(true);
  }

  function independentDisplayMs(station) {
    if (!independentRuns.busyAt(station)) return 0;
    const attempt = independentRuns.current[station];
    if (attempt?.elapsedMs != null) return attempt.elapsedMs;
    const animation = independentLiveStarted[station];
    return attempt?.startUs && animation?.id === attempt.id ? Math.max(0, Date.now() - animation.at) : 0;
  }

  function buildIndependentLiveState() {
    return {
      measurementMode: "automatic_independent",
      competitionText: el.compTitle?.textContent || "Časomiera",
      participantCount: independentLayout.count,
      independent: independentStations().map(station => {
        const attempt = independentRuns.busyAt(station) ? independentRuns.current[station] : null;
        return { station, name: (attempt?.participant || independentParticipant(station))?.displayName || "—", phase: attempt?.phase || "idle",
          elapsedMs: attempt?.elapsedMs ?? null,
          startedAt: attempt && independentLiveStarted[station]?.id === attempt.id ? independentLiveStarted[station].at : null };
      }),
      updatedAt: Date.now()
    };
  }

  function updateIndependentLiveProjection(state) {
    if (!IS_TIMER_DISPLAY_MODE) return;
    const clocks = $("timerLiveClocks");
    const participants = Array.isArray(state.independent) ? state.independent.slice(0, 2) : [];
    const count = participants.length === 1 ? 1 : 2;
    clocks.dataset.judges = String(count);
    $("timerLiveCompetitor").textContent = count === 1
      ? participants[0].name : "Nezávislé meranie A/B";
    $("timerLiveCompetition").textContent = String(state.competitionText || "Časomiera");
    $("timerLiveStatus").textContent = count === 1
      ? "Nezávislá stanica " + participants[0].station : "Dve nezávislé stanice";
    for (let index = 0; index < 3; ++index) {
      const card = clocks.querySelector('[data-judge="' + (index + 1) + '"]');
      card.hidden = index >= count;
      const station = participants[index];
      if (!station) continue;
      card.querySelector(".timerLiveJudgeLabel").textContent = station.station + " · " + station.name;
      card.classList.toggle("is-stopped", Number.isFinite(station.elapsedMs));
    }
    renderIndependentLiveClocks();
  }

  function renderIndependentLiveClocks() {
    if (!independentProjection) return;
    const participants = independentProjection.independent?.slice(0, 2) || [];
    for (let index = 0; index < participants.length; ++index) {
      const station = participants[index];
      if (!station) continue;
      const elapsed = Number.isFinite(station.elapsedMs) ? station.elapsedMs :
        station.startedAt ? Math.max(0, Date.now() - station.startedAt) : 0;
      $("timerLiveClock" + (index + 1)).textContent = formatMs(elapsed) + " s";
    }
  }

  function independentCallCandidates() {
    const candidates = getCallCandidatesCurrentView();
    return candidates.slice(getCallIndex(candidates));
  }

  function synchronizeIndependentParticipants(shown = independentCallCandidates()) {
    if (!independentUiReady || !isIndependentMode() || independentStorageError) return;
    const reserved = new Set(["A", "B"].filter(station => independentRuns.busyAt(station))
      .map(station => independentRuns.current[station].participant.key));
    let changed = false;
    independentStations().forEach((station, index) => {
      if (independentRuns.busyAt(station)) {
        const attempt = independentRuns.current[station];
        independentCallAssignments[station] = attempt.participant.key + ":" + attempt.attemptNo;
        return;
      }
      // Keep the microphone slots authoritative; never substitute another queued person.
      const candidate = shown[index];
      const key = candidate && !reserved.has(candidate.key) ? candidate.key : "";
      const assignment = key ? key + ":" + candidate.nextAttempt : "";
      if (independentDraft[station].participant === key && independentCallAssignments[station] === assignment) return;
      independentCallAssignments[station] = assignment;
      independentDraft[station] = { participant: key, penalty: "" };
      independentLiveStarted[station] = null;
      independentNotices[station] = "";
      changed = true;
    });
    if (changed) { persistIndependent(); autoPersistToFile(); }
  }

  function getNextIndependentCandidate() {
    const occupied = new Set(independentStations().map(station => independentRuns.busyAt(station)
      ? independentRuns.current[station].participant.key : independentDraft[station].participant).filter(Boolean));
    return independentCallCandidates().slice(independentLayout.count)
      .find(candidate => !occupied.has(candidate.key)) || null;
  }

  function updateIndependentParticipants() {
    const limit = getConfiguredAttemptsLimit();
    el.activeCompetitorName.textContent = independentStations().map(station => {
      const busy = independentRuns.busyAt(station);
      const attempt = independentRuns.current[station];
      const participant = busy ? attempt.participant : independentParticipant(station);
      if (!participant) return station + ": —";
      const number = busy ? attempt.attemptNo :
        getUsedAttemptsForKey(participant.key, participant.mode, participant.category) + 1;
      const prefix = independentLayout.count === 2 ? station + ": " : "";
      return prefix + participant.displayName + " (pokus " + Math.min(number, limit) + "/" + limit + ")";
    }).join(" · ");
    el.liveNextCompetitorName.textContent = formatCallCandidate(getNextIndependentCandidate());
  }

  function updateIndependentUI() {
    if (!independentUiReady) return;
    const enabled = isIndependentMode();
    synchronizeIndependentParticipants();
    document.body.classList.toggle("measurement-independent", enabled);
    $("independentPanels").hidden = !enabled;
    $("independentPanels").dataset.count = String(independentLayout.count);
    $("independentLayoutControls").hidden = !enabled;
    $("independentCount").value = String(independentLayout.count);
    $("independentSingleStation").value = independentLayout.singleStation;
    $("independentSingleStationField").hidden = independentLayout.count !== 1;
    $("independentCount").disabled = independentPending();
    $("independentSingleStation").disabled = independentPending();
    for (const station of ["A", "B"]) {
      const selectedStation = independentStations().includes(station);
      $("independentStation" + station).hidden = !enabled || !selectedStation;
      const attempt = independentRuns.current[station];
      const busy = independentRuns.busyAt(station);
      const select = $("independentParticipant" + station);
      const participants = getParticipantsForAllViews().filter(item => item.timeEnabled !== false);
      const options = [{ key: "", displayName: "Vyber súťažiaceho" }, ...participants];
      const signature = JSON.stringify(options.map(item => [item.key, item.displayName, item.mode, item.subLine]));
      if (select.dataset.options !== signature) {
        select.replaceChildren(...options.map(item => {
          const option = document.createElement("option");
          option.value = item.key;
          const team = item.mode === "individual" ? parseTeamNameFromIndividualSubLine(item.subLine) : "";
          option.textContent = item.displayName + (team ? " · " + team : "");
          return option;
        }));
        select.dataset.options = signature;
      }
      select.value = busy ? attempt.participant.key : independentDraft[station].participant;
      select.disabled = enabled || busy || independentStorageError;
      $("independentClock" + station).textContent = formatMs(independentDisplayMs(station));
      $("independentPenalty" + station).value = independentDraft[station].penalty;
      $("independentPrepare" + station).disabled = !selectedStation || busy || !independentStationReady(station) || !independentParticipant(station);
      $("independentCancel" + station).disabled = !busy;
      const rawPenalty = independentDraft[station].penalty.trim();
      $("independentSave" + station).disabled = attempt?.phase !== "finished" ||
        !rawPenalty || parsePenaltySecondsToMs(rawPenalty) === null;
      $("independentRecover" + station).disabled = !attempt || !automaticPorts[station];
      $("independentConfigure" + station).disabled = busy || independentStatus(station)?.mode !== "independent";
      const error = attempt?.errors.at(-1)?.reason;
      const labels = { preparing: "Pripravujem pokus", armed: "Čakám na ŠTART", running: "Čakám na STOP",
        finished: "Čas zachytený; doplň trest a ulož výsledok", recovery: "Údaje vyžadujú kontrolu",
        cancelled: "Pokus zrušený", saved: "Výsledok uložený" };
      $("independentNotice" + station).textContent = independentStorageError ? "Poškodená lokálna záloha. Obnov JSON." :
        (independentNotices[station] || labels[attempt?.phase] || "Vyber súťažiaceho a priprav pokus.") +
        (error ? " · " + error : "") +
        " · ŠTART GPIO6; STOP GPIO17. Čas pochádza z miestnych hodín; presnosť ešte nie je fyzicky overená." +
        (independentStatus(station)?.mode === "independent"
          ? " Aktívna kvalifikácia: LOW " + independentStatus(station).inputLowUs +
            " µs, uvoľnenie " + independentStatus(station).inputReleaseUs + " µs." : "");
      $("independentInfo" + station).dataset.tone = error || independentStorageError ? "warning" :
        attempt?.phase === "finished" ? "ok" : "busy";
    }
    if (enabled) {
      updateIndependentParticipants();
      publishTimerLiveState();
    }
  }

  function initializeIndependentUI() {
    if (IS_DISPLAY_MODE) return;
    independentUiReady = true;
    const updateLayout = () => {
      try { setIndependentLayout(Number($("independentCount").value), $("independentSingleStation").value); }
      catch (error) { showAutomaticError(error); updateIndependentUI(); }
    };
    $("independentCount").addEventListener("change", updateLayout);
    $("independentSingleStation").addEventListener("change", updateLayout);
    for (const station of ["A", "B"]) {
      const guard = action => () => Promise.resolve().then(action).catch(error => {
        independentNotices[station] = String(error?.message || error);
        // Operator errors remain in the adjacent information tooltip.
        $("independentNotice" + station).textContent = independentNotices[station];
        $("independentInfo" + station).dataset.tone = "warning";
      });
      $("independentParticipant" + station).addEventListener("change", () => {
        independentDraft[station].participant = $("independentParticipant" + station).value;
        persistIndependent(); autoPersistToFile(); updateIndependentUI();
      });
      $("independentPenalty" + station).addEventListener("input", () => {
        independentDraft[station].penalty = $("independentPenalty" + station).value;
        persistIndependent(); autoPersistToFile(); updateIndependentUI();
      });
      $("independentPrepare" + station).addEventListener("click", guard(() => prepareIndependent(station)));
      $("independentCancel" + station).addEventListener("click", guard(() => cancelIndependent(station)));
      $("independentRecover" + station).addEventListener("click", guard(() => recoverIndependent(station)));
      $("independentSave" + station).addEventListener("click", guard(() => saveIndependentResult(station)));
      $("independentConfigure" + station).addEventListener("click", guard(() => configureIndependent(station)));
      const attempt = independentRuns.current[station];
      const saved = attempt && loadAll().find(record => record.electronic?.attemptId === attempt.id);
      if (attempt?.phase === "finished" && saved) independentRuns.markSaved(station, saved.id);
    }
    if (!independentStorageError) persistIndependent();
    setInterval(() => {
      if (!isIndependentMode()) return;
      for (const station of ["A", "B"]) $("independentClock" + station).textContent = formatMs(independentDisplayMs(station));
    }, 100);
    updateIndependentUI();
  }
