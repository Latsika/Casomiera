"""Embed the tested automatic timing modules into the standalone v11 page."""

from pathlib import Path

firmware = Path(__file__).resolve().parents[1]
page = firmware.parent / "Casomiera_v11_OSTRA.html"
source = page.read_text(encoding="utf-8")
if "CASOMIERA_AUTOMATIC_CORE_BEGIN" in source:
    raise SystemExit("Automatic integration already exists; edit its marked blocks explicitly.")


def replace_once(before, after):
    global source
    if source.count(before) != 1:
        raise RuntimeError(f"Expected one integration point: {before[:90]!r}")
    source = source.replace(before, after, 1)


core = (firmware / "web/automatic-timing.js").read_text(encoding="utf-8")
ui = (firmware / "web/automatic-ui.js").read_text(encoding="utf-8")
replace_once("<script>\n(() => {", "<script>\n// CASOMIERA_AUTOMATIC_CORE_BEGIN\n" + core +
             "\n// CASOMIERA_AUTOMATIC_CORE_END\n</script>\n<script>\n(() => {")
replace_once("  function formatMs(ms){", "  // CASOMIERA_AUTOMATIC_UI_BEGIN\n" + ui +
             "\n  // CASOMIERA_AUTOMATIC_UI_END\n\n  function formatMs(ms){")
panel = '''      <div class="automaticPanel" style="margin:10px 0;padding:12px;border:1px solid #d7d9e0;border-radius:12px;">
        <label for="automaticMode">Spôsob merania</label>
        <select id="automaticMode">
          <option value="manual">Ručné meranie rozhodcov</option>
          <option value="combined">Automatické meranie A+B</option>
        </select>
        <div id="automaticControls" hidden>
          <div class="row" style="margin-top:8px;">
            <button class="btn soft" id="automaticConnectA" type="button">Pripojiť A cez USB</button>
            <button class="btn soft" id="automaticConnectB" type="button">Pripojiť B cez USB</button>
            <button class="btn soft" id="automaticRecover" type="button">Obnoviť zachytené údaje</button>
          </div>
          <div class="smallTxt" style="margin-top:8px;"><span id="automaticStationA">A: odpojená</span> · <span id="automaticStationB">B: odpojená</span></div>
          <div id="automaticNotice" class="smallTxt" role="status" aria-live="polite" style="margin-top:8px;"></div>
          <div class="smallTxt" style="margin-top:8px;">START: tlačidlo A · STOP: tlačidlo B. Zobrazenie: 0,001 s. Presnosť zostáva do overenia spoločným impulzom nepotvrdená.</div>
        </div>
      </div>

'''
replace_once('      <div class="timerBox" id="timerBox" data-judges="3">', panel +
             '      <div class="timerBox" id="timerBox" data-judges="3">')
replace_once('  function getConfiguredJudgeCount(){\n',
             '  function getConfiguredJudgeCount(){\n    if (isAutomaticMode()) return 1;\n')
replace_once('  function getValidIfReady(){\n    const times=rec.slice(0,getConfiguredJudgeCount());\n',
             '  function getValidIfReady(){\n    if (isAutomaticMode() && automaticRawMs() === null) return null;\n    const times=rec.slice(0,getConfiguredJudgeCount());\n')
replace_once('    updateCallPanel();\n    publishTimerLiveState();\n    refreshProjection();\n  }',
             '    updateCallPanel();\n    updateAutomaticUI();\n    publishTimerLiveState();\n    refreshProjection();\n  }')
replace_once('  function tick(){\n    if (!running) return;\n',
             '  function tick(){\n    if (!running) return;\n    if (isAutomaticMode() && !tStart) return;\n')
replace_once('  function startAll(){\n',
             '  function startAll(){\n    if (isAutomaticMode()) { prepareAutomaticAttempt().catch(showAutomaticError); return; }\n')
for function in ('stopJudge(i)', 'resetJudge(i)', 'setManualJudge(i)'):
    replace_once('  function ' + function + '{\n',
                 '  function ' + function + '{\n    if (isAutomaticMode()) return;\n')
replace_once('  function abortRun(){\n',
             '  function abortRun(){\n    if (isAutomaticMode()) { cancelAutomaticAttempt().catch(showAutomaticError); return; }\n')
replace_once('  function saveResult(){\n', '''  function saveResult(){
    const automatic = isAutomaticMode();
    const automaticAttempt = automatic ? automaticRun.current : null;
    if (automatic && automaticRawMs() === null) {
      alert("Najprv dokonči automatický pokus pre vybraného súťažiaceho."); return;
    }
    if (automatic && loadAll().some(record => record.electronic?.attemptId === automaticAttempt.id)) {
      alert("Tento automatický pokus už je uložený."); return;
    }
''')
replace_once('      judgeCount,timeRule,rawMeasuredMs,\n', '''      judgeCount: automatic ? null : judgeCount,
      timeRule: automatic ? null : timeRule,
      rawMeasuredMs,
      measurementMode: automatic ? "automatic_combined" : "manual",
      electronic: automatic ? {
        attemptId: automaticAttempt.id, competitionId: automaticAttempt.competitionId,
        start: automaticAttempt.events.A, stop: automaticAttempt.events.B,
        elapsedUs: automaticAttempt.elapsedUs, accuracy: automaticAttempt.accuracy
      } : null,
''')
replace_once('      t1: rec[0], t2: judgeCount>=2?rec[1]:null, t3: judgeCount>=3?rec[2]:null,',
             '      t1: automatic ? null : rec[0], t2: automatic ? null : (judgeCount>=2?rec[1]:null), t3: automatic ? null : (judgeCount>=3?rec[2]:null),')
replace_once('    saveAll(list);\n\n    running = false;', '''    saveAll(list);
    if (automatic) {
      automaticRun.markSaved();
      persistAutomatic();
      archiveAutomaticContext();
      for (const station of ["A", "B"]) {
        sendAutomatic(station, `AUTO_COMPLETE ${automaticAttempt.id}`)
          .then(() => sendAutomatic(station, `AUTO_ARCHIVE ${automaticAttempt.id}`)).catch(showAutomaticError);
      }
    }

    running = false;''')
# Store the original judge settings independently of the electronic display.
replace_once('      judgeCount: getConfiguredJudgeCount(),\n      timeRule: getConfiguredTimeRule(),',
             '      judgeCount: normalizeJudgeCount(el.judgeCount.value),\n      timeRule: getConfiguredTimeRule(),\n      automatic: { competitionId: automaticCompetitionId, mode: automaticMode, pending: automaticRun.current, history: JSON.parse(localStorage.getItem(AUTO_HISTORY_KEY) || "[]") },')
replace_once('  function applySnapshot(snapshot){\n', '''  function applySnapshot(snapshot){
    const incomingAutomatic = snapshot?.automatic;
    if (automaticRun.busy && incomingAutomatic?.pending?.id !== automaticRun.current.id) {
      throw new Error("Najprv dokonči alebo zruš rozpracovaný automatický pokus.");
    }
    const recovered = new CasomieraAutomatic.AutomaticRun(incomingAutomatic?.pending || null);
    automaticCompetitionId = incomingAutomatic?.competitionId || crypto.randomUUID();
    localStorage.setItem(AUTO_COMPETITION_KEY, automaticCompetitionId);
    automaticRun.current = recovered.current;
    automaticMode = incomingAutomatic?.mode === "combined" || recovered.busy ? "combined" : "manual";
    persistAutomatic();
    localStorage.setItem(AUTO_HISTORY_KEY, JSON.stringify(Array.isArray(incomingAutomatic?.history) ? incomingAutomatic.history : []));
''')
replace_once('    refreshPodium();\n  }\n\n  function handleLoadBackupFile',
             '    refreshPodium();\n    if (automaticUiReady) applyAutomaticProgress();\n  }\n\n  function handleLoadBackupFile')
# Freeze participant and competition mutations while an electronic result is pending.
for declaration in ('function activateCallParticipantByKey(key){', 'function activateNextAutomatic(){',
                    'function confirmPendingParticipantSelection(){', 'function deleteParticipant(participantKey){',
                    'function clearCurrentView(){', 'function clearAll(){', 'function resetForNewCompetition(title){'):
    replace_once('  ' + declaration + '\n', '  ' + declaration + '\n    if (automaticPending()) { alert("Najprv ulož alebo zruš automatický pokus."); return; }\n')
# Keep device measurements visibly separate from judge measurements in exports.
replace_once('          judgeCount: normalizeJudgeCount(a.judgeCount??3),',
             '          measurementMode: a.measurementMode || "manual",\n          elapsedUs: a.electronic?.elapsedUs || "",\n          judgeCount: a.measurementMode === "automatic_combined" ? 0 : normalizeJudgeCount(a.judgeCount??3),')
replace_once('        RULE_LABELS[r.timeRule],',
             '        r.measurementMode === "automatic_combined" ? "Automatické A+B" : RULE_LABELS[r.timeRule],')
replace_once('"Trest (s)","Čas zápisu"]', '"Trest (s)","Čas zápisu","Spôsob merania","Elektronický čas (us)"]')
replace_once('        r.stamp || ""\n      ].map',
             '        r.stamp || "",\n        r.measurementMode,\n        r.elapsedUs\n      ].map')
old_label = '${normalizeJudgeCount(a.judgeCount??3)}× ${RULE_LABELS[normalizeTimeRule(a.timeRule??\'median\')]}';
source = source.replace(old_label, '${a.measurementMode === "automatic_combined" ? "Automatické A+B" : `${normalizeJudgeCount(a.judgeCount??3)}× ${RULE_LABELS[normalizeTimeRule(a.timeRule??\'median\')]}`}')
replace_once('})();\n</script>\n</body>', '  initializeAutomaticUI();\n})();\n</script>\n</body>')
page.write_bytes(source.replace('\r\n', '\n').replace('\n', '\r\n').encode('utf-8'))
print(f"Integrated automatic timing into {page}")
