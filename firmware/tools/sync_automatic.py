"""Refresh embedded modules without changing unrelated application code."""

from pathlib import Path
import json
import re

firmware = Path(__file__).resolve().parents[1]
page = firmware.parent / "Casomiera_v11_OSTRA.html"
source = page.read_text(encoding="utf-8")
for name, filename, indent in (("CORE", "automatic-timing.js", ""), ("UI", "automatic-ui.js", "  ")):
    begin = indent + "// CASOMIERA_AUTOMATIC_" + name + "_BEGIN\n"
    end = indent + "// CASOMIERA_AUTOMATIC_" + name + "_END"
    if source.count(begin) != 1 or source.count(end) != 1:
        raise RuntimeError("Expected unique automatic module markers.")
    prefix, remainder = source.split(begin, 1)
    _, suffix = remainder.split(end, 1)
    source = prefix + begin + (firmware / "web" / filename).read_text(encoding="utf-8") + "\n" + end + suffix
source = source.replace("pending: automaticRun.current, history:",
                        "pending: automaticRun.current ? JSON.parse(JSON.stringify(automaticRun.current)) : null, history:")
if 'id="automaticTransport"' not in source:
    source = source.replace('<div id="automaticControls" hidden>', '''<div id="automaticControls" hidden>
          <label for="automaticTransport">Spojenie staníc</label>
          <select id="automaticTransport">
            <option value="dual_usb">Obe stanice cez USB</option>
            <option value="wireless">A cez LoRa, B cez USB</option>
          </select>''', 1)
source = source.replace("mode: automaticMode, pending:", "mode: automaticMode, transport: automaticTransport, pending:")
if '    automaticTransport = incomingAutomatic?.transport' not in source:
    source = source.replace('    automaticRun.current = recovered.current;\n',
        '    automaticRun.current = recovered.current;\n    automaticStorageError = false;\n    automaticTransport = incomingAutomatic?.transport === "wireless" ? "wireless" : "dual_usb";\n', 1)
source = source.replace('<div class="smallTxt" style="margin-top:8px;">START: tlačidlo A · STOP: tlačidlo B. Zobrazenie: 0,001 s. Presnosť zostáva do overenia spoločným impulzom nepotvrdená.</div>',
    '<div class="smallTxt" style="margin-top:8px;">START: tlačidlo A · STOP: tlačidlo B. Zobrazenie: 0,001 s.</div>\n          <div id="automaticAccuracy" class="smallTxt" style="margin-top:8px;"></div>')
report_path = firmware / "test-results/shared-input.json"
verification = None
if report_path.exists():
    report = json.loads(report_path.read_text(encoding="utf-8"))
    if report.get("passed") and report.get("stations"):
        verification = {key: report[key] for key in ("createdAt", "criterionUs", "passed", "maximumAbsoluteDifferenceUs", "stations")}
        verification["sampleCount"] = len(report["samples"])
block = "// CASOMIERA_VALIDATION_BEGIN\nglobalThis.CasomieraTimingValidation = " + json.dumps(verification, ensure_ascii=False) + ";\n// CASOMIERA_VALIDATION_END"
if "// CASOMIERA_VALIDATION_BEGIN" in source:
    source = re.sub(r"// CASOMIERA_VALIDATION_BEGIN.*?// CASOMIERA_VALIDATION_END", lambda match: block, source, count=1, flags=re.S)
else:
    source = source.replace("// CASOMIERA_AUTOMATIC_CORE_END", "// CASOMIERA_AUTOMATIC_CORE_END\n" + block, 1)
source = source.replace("elapsedUs: automaticAttempt.elapsedUs, accuracy: automaticAttempt.accuracy", "elapsedUs: automaticAttempt.elapsedUs, accuracy: automaticAttempt.accuracy, verification: automaticAttempt.verification")
# Keep repeated synchronization idempotent.
source = source.replace(", verification: automaticAttempt.verification, verification: automaticAttempt.verification", ", verification: automaticAttempt.verification")
source = source.replace('localStorage.setItem(JUDGE_COUNT_KEY, String(getConfiguredJudgeCount()));',
    'localStorage.setItem(JUDGE_COUNT_KEY, String(normalizeJudgeCount(el.judgeCount.value)));')
source = source.replace('incomingAutomatic?.competitionId || crypto.randomUUID()', 'incomingAutomatic?.competitionId || newAutomaticCompetitionId()')
source = source.replace('transport: automaticTransport, pending:', 'transport: automaticTransport, cancellations: JSON.parse(JSON.stringify(automaticCancellations)), pending:')
if 'automaticCancellations = Array.isArray(incomingAutomatic?.cancellations)' not in source:
    source = source.replace('    automaticRun.current = recovered.current;\n',
        '    automaticRun.current = recovered.current;\n    automaticCancellations = Array.isArray(incomingAutomatic?.cancellations) ? incomingAutomatic.cancellations : [];\n    persistAutomaticCancellations();\n', 1)
source = source.replace('  function activateNextAutomatic(){\n    if (automaticPending()) { alert("Najprv ulož alebo zruš automatický pokus."); return; }',
    '  function activateNextAutomatic(){\n    if (automaticPending()) return;')
old_title = '${normalizeJudgeCount(a.judgeCount??3)} rozhodcovia; výpočet: ${RULE_LABELS[normalizeTimeRule(a.timeRule??\'median\')]}'
source = source.replace(old_title, '${escapeHtml(measurementRuleDescription(a))}')
if 'measurementMode:isAutomaticMode()' not in source:
    source = source.replace('  function buildTimerLiveState(){\n    return {',
        '  function buildTimerLiveState(){\n    return {\n      measurementMode:isAutomaticMode() ? "automatic_combined" : "manual",', 1)
    source = source.replace('  function applyTimerLiveState(state){\n    if (!state) return;',
        '  function applyTimerLiveState(state){\n    if (!state) return;\n    automaticMode = state.measurementMode === "automatic_combined" ? "combined" : "manual";', 1)
    source = source.replace('      card.hidden = i >= count;',
        '      const label = card.querySelector(".timerLiveJudgeLabel");\n      if (label) label.textContent = state.measurementMode === "automatic_combined" ? "Automatické A+B" : `Rozhodca ${i + 1}`;\n      card.hidden = i >= count;', 1)
page.write_bytes(source.replace("\n", "\r\n").encode("utf-8"))
print("Embedded automatic modules synchronized.")
