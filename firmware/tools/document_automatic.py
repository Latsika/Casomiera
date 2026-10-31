"""Record implemented behavior and measured evidence without rewriting history."""

import json
import sys
from pathlib import Path

firmware = Path(__file__).resolve().parents[1]
project = firmware.parent
shared = json.loads((firmware / "test-results/shared-input.json").read_text(encoding="utf-8"))
radio = json.loads((firmware / "test-results/radio-workflow.json").read_text(encoding="utf-8"))
complete = json.loads((firmware / "test-results/end-to-end.json").read_text(encoding="utf-8"))
pending_hardware = "--pending-hardware" in sys.argv
if not all(report.get("passed") for report in (shared, radio, complete)):
    raise SystemExit("Passing physical and protocol reports are required before documenting success.")
for station in ("A", "B"):
    if not pending_hardware and radio["stations"][station]["firmwareHash"] != shared["stations"][station]["firmwareHash"]:
        raise SystemExit("Verification reports refer to different firmware builds.")
maximum = shared["maximumAbsoluteDifferenceUs"]
count = len(shared["samples"])
heading = "## Combined GNSS timing implementation and verification — 2026-10-31"
readme = f"""{heading}

The owner resumed development and authorized firmware, application, documentation,
commit and push work. This section supersedes earlier statements that combined
timing and HTML integration are unimplemented or waiting for a replacement board.

### Implemented behavior

- The existing standalone HTML application has manual judge timing and a selectable
  automatic combined A=START, B=STOP mode. Independent two-participant automatic
  timing remains future work.
- Combined mode supports both stations on separate USB ports, or A over LoRa with
  only B connected to the browser over USB. Use desktop Chrome or Edge.
- GPIO6 to GND is the button input on each station. An interrupt records the first
  falling edge; 30 ms stable-low qualification and stable release suppress bounce
  and held-button repeats without adding 30 ms to the timestamp.
- Five consecutive valid integer-second RMC/PPS observations establish tracking.
  PPS configuration is read automatically, including retries after cold startup.
  Invalid dates, discontinuities, stale references and long UART processing gaps
  prevent new clock-valid measurements. Local timer scaling uses measured PPS
  periods, and radio/USB/browser arrival times do not determine the result.
- Events retain integer microsecond timestamps. The application subtracts them
  with integer arithmetic and rounds once to milliseconds for the result display.
- A participant, competition and fresh attempt ID are bound before arming. Late
  messages and duplicate START events cannot replace the captured START.
- Switching measurement modes requires saving or explicitly cancelling the pending
  attempt. An operator cancellation also permits manual fallback when a station is
  unavailable; device cancellation is retained and retried after reconnection.
- Automatic times are stored separately from judge measurements, with raw event
  timestamps, source, firmware verification context and attempt ID in JSON. Results,
  CSV/PDF output and LIVE timing distinguish automatic measurements.
- Measured events are retained in board RAM until explicit archival. GET recovery
  returns the original data after a delivery failure or USB reconnection. The
  application saves pending data and cancelled-attempt history locally and in its
  JSON snapshot. A failed acknowledgement does not discard a measurement.

### Normal operation

1. Keep the GNSS antenna/display enclosure installed and provide good sky reception.
   Each station has its own GPIO6-to-GND button. Do not join GPIO6 between stations
   during normal A=START/B=STOP operation.
2. Close PlatformIO serial monitors. Open `Casomiera_v11_OSTRA.html` in Chrome/Edge
   and create/load the competition and its JSON backup as before.
3. Select **Automatické meranie A+B**. Choose **Obe stanice cez USB**, or
   **A cez LoRa, B cez USB**. Connect the indicated station(s) using the browser's
   USB chooser. Firmware identity is checked, so reversed station selection is
   rejected. Last verified mapping: A COM3, B COM5; recheck after reconnection.
4. Wait for the clock and board/build verification checks, select the participant,
   and choose **Pripraviť automatický pokus**. Wait for both station acknowledgements.
5. Press A's physical START button and B's physical STOP button. Enter penalty
   seconds, including zero, then save the result using the existing save action.
6. If delivery fails, reconnect and use **Obnoviť zachytené údaje**. Do not create a
   replacement attempt solely because an acknowledgement or USB connection failed.
   Explicit cancellation keeps the captured data in history and permits a new mode.

Manual operation, manual entry, judge-count settings, median/average/minimum/maximum
calculations and existing saved results remain available. Their existing browser
stopwatch behavior is preserved; the electronic input verification below is not a
claim of 1 ms accuracy for human-operated browser stopwatches.

### Verification and its limits

- Both `lora_A` and `lora_B` built and were uploaded successfully.
- The final recorded GPIO6 common-input test passed: **{count} impulses**, maximum
  absolute A/B difference **{maximum} microseconds** ({maximum / 1000:.3f} ms), against
  a 1000-microsecond acceptance threshold. See
  [shared-input.json](firmware/test-results/shared-input.json) for individual samples,
  board MAC identifiers and exact ELF firmware hashes.
- Four complete electrical-input/LoRa/USB/application calculations passed, including
  repeated-START rejection and identical record retrieval after reopening finish USB.
  See [end-to-end.json](firmware/test-results/end-to-end.json).
- Three radio prepare/GET/cancel/re-prepare cycles passed without a fixed 30-second
  delay. Tests also replay an archived ARM token and cancel a never-prepared attempt.
  See [radio-workflow.json](firmware/test-results/radio-workflow.json).
- Deterministic clock/ledger self-tests run on both boards. Node tests cover attempt
  binding, invalid events, late/duplicate messages, cancellation and retention.
- Isolated headless Chrome tests cover saved electronic results, replay of actual
  hardware records, JSON restore, offline cancellation/manual fallback, firmware
  verification guards, LoRa routing, exports and preserved manual median/settings.
- The HTML embeds the physical verification report and checks board IDs and firmware
  hashes before preparing an automatic attempt. A different/rebuilt firmware requires
  another physical test and regeneration of the embedded verification data.

This is observed relative agreement on the tested electrical inputs and firmware,
not an absolute UTC calibration or a certification of the entire competition system.
Optical gates, their electrical interfaces/delays, long-term temperature behavior,
the intended 200–300 metre range and GNSS-free indoor cable timing remain unverified
or unimplemented. The existing raw `SYNC=UNVERIFIED` diagnostic is intentional:
the preceding-PPS UTC association is a candidate validated for relative agreement
on this pair, not a separately traceable absolute UTC reference.

Board event retention is RAM-only and does not survive loss of power or reset.
The browser retains copies already received, but cannot recover an event that was
never delivered before a board lost power. Each board holds up to 32 unarchived
attempts and refuses to overwrite them when full. Do not reflash/reset an active
station as a communication-recovery step.

### Radio and diagnostic details

The tested 868.1 MHz, 125 kHz, SF7 and chip-power settings are retained. Automatic
messages use nonblocking transmission and coordinator boot/sequence tokens.
The old fixed 30-second SEND restriction applies only to the standalone test.
A conservative airtime ledger reserves blocks of at most one second from a
36-second allowance in NVS. Credit expires after 60 seconds; the allowance resets
only after a full quiet hour beyond the latest possible use of the last reservation.
Rebooting never replenishes credit. Flash reservations are scheduled away from PPS
and never while a station awaits its own armed input; captured timestamps are
already immutable. A long write or affected PPS invalidates the clock reference.
Repeated power cycles can therefore conservatively exhaust
credit; `RADIO_BUDGET` reports the state. `RADIO_RELEASE_BUDGET` returns unused
credit before maintenance when no attempt or radio job is active. This accounting
does not replace verification of the final antenna/power installation and local
radio requirements.

At 115200 baud with LF endings:

- `STATUS`, `GNSS_VERSION`, `GNSS_PPS_CONFIG`, `GNSS_SCAN`, `CLOCK_TEST`.
- `AUTO_STATUS`, `AUTO_ARM <id>`, `AUTO_GET <id>`, `AUTO_CANCEL <id>`,
  `AUTO_COMPLETE <id>`, `AUTO_ARCHIVE <id>` for local station control.
- On B, `REMOTE_STATUS` and `REMOTE_ARM/GET/CANCEL/COMPLETE/ARCHIVE <id>` route to A.
- `EVENTS` / `EVENT_CLEAR` access the separate bounded diagnostic event list.
- `TEST_PULSE` is a bench tool: a 60 ms open-drain GPIO6 pulse. It refuses to
  generate an edge on a station still waiting for its own armed event. It is not
  part of normal competition operation.

For common-input testing only, disconnect USB, join A GND to B GND and A GPIO6 to
B GPIO6, then reconnect USB. Never connect GND to GPIO6 or join supply pins.
Remove the GPIO6 interconnection before normal independent START/STOP button use.

### Reproducing checks

Use the existing PlatformIO Python environment; no new dependencies were installed.
The original `esp32-s3-devkitc-1` USB prototype environment and default selection are
preserved. Explicitly select the current A/B environments when building/uploading:

```powershell
pio run -e lora_A -e lora_B
pio run -e lora_A -e lora_B -t upload
python -B test/shared_input.py --count 24
python -B test/end_to_end.py
python -B test/radio_workflow.py
python -B tools/sync_automatic.py
node test/automatic-timing.test.cjs
node test/browser-automatic.cjs
```

Run these from `firmware/`. Physical scripts need the two confirmed common-input
wires, both USB connections and tracking GNSS clocks. Browser tests use an isolated
temporary profile and do not modify the owner's competition data. Regenerate the
embedded modules with `sync_automatic.py`; `integrate_automatic.py` is the one-time
integration script and intentionally refuses to apply itself twice.

Hardware/protocol references:
[Wireless Tracker V2 datasheet](https://resource.heltec.cn/download/Wireless_Tracker_V2/Wireless_Tracker_v2_Datasheet/Wireless%20Tracker%20v2.pdf)
and [Unicore UFirebird II protocol R1.4](https://resource.heltec.cn/download/Wireless_Tracker_V2/GNSS_AT_Datasheet/UFirebirdII%20Series%20Protocol%20Specification_EN_R1.4.pdf).
"""
if pending_hardware:
    pending_notice = """### Current completion status: hardware connection required

The latest source builds successfully for both stations, and its application tests
pass. Its final upload was attempted but could not run because Windows no longer
listed either USB board (COM3/COM5). The final radio-budget revision is therefore
**not uploaded or physically verified**. Do not describe the latest source as a
completed, fully verified 1 ms competition system.
Build/source hashes and report provenance are recorded in
[verification-status.json](firmware/test-results/verification-status.json).

The recorded physical results below are from earlier intermediate builds: the
latest shared-input report and the earlier complete/radio reports do not refer to
the same firmware hashes. They establish prior observed electrical agreement and
working protocol paths, not final-build acceptance. Earlier tests reached 5–8 us
relative agreement; the latest shared-input report records its own exact result.

Next: reconnect both boards, verify their MAC/port mapping, keep the common-input
wires for testing, upload the current source and rerun shared-input, end-to-end and
radio-workflow tests. Then regenerate the embedded HTML verification report and
run the application/browser tests. Good GNSS reception is required for physical
tests. Do not bypass the HTML board/build guard to use an unverified binary.

"""
    readme = readme.replace("### Implemented behavior", pending_notice + "### Implemented behavior", 1)
    readme = readme.replace("- Both `lora_A` and `lora_B` built and were uploaded successfully.",
        "- Both latest environments build successfully. Earlier builds were uploaded;\n  the final upload is pending reconnection, as described above.")
    readme = readme.replace("The final recorded GPIO6 common-input test passed:",
        "The latest intermediate GPIO6 common-input test passed:")
    readme = readme.replace("Tests also replay an archived ARM token and cancel a never-prepared attempt.",
        "The new archived-ARM replay and absent-attempt cancellation assertions still\n  require the final hardware run.")
agents = f"""{heading}

- Work resumed at the owner's request, including automatic A+B HTML integration.
- Current implementation: `lora_A` / `lora_B` in `src/lora_test.cpp`; portable clock
  and station ledger headers in `include/`; standalone HTML has manual and combined
  automatic modes with dual USB or A LoRa + B USB. Independent mode and GNSS-free
  cable timing remain future work. Preserve the original USB prototype environment.
- GPIO6 falling-edge ISR captures the timestamp before 30 ms qualification.
  Five valid sequential epochs establish tracking; stale/invalid references fail
  closed. UART gaps invalidate acquisition. Read-only CFGTP is retried after cold
  boot. Confirmed module: UC6580I-00, R6.0.0.0Build3700, CFGTP 1000000/500000/1/0/0/0.
- Final common-input report: {count} pulses, maximum absolute difference {maximum} us
  against a 1000 us criterion. Four full GPIO/LoRa/USB/application cycles and USB
  recovery passed. Radio tests cover immediate cancellation/re-preparation,
  archived-ARM replay rejection and cancellation of absent attempts.
- These are relative electrical-input measurements, not absolute UTC traceability,
  optical-gate accuracy, long-term temperature validation or 200–300 m range proof.
  Raw SYNC=UNVERIFIED remains deliberate. Do not broaden the accuracy claim.
- Physical reports are in `firmware/test-results/`. HTML validates the specific
  station MAC IDs and ELF hashes against the embedded report; never bypass this
  guard after firmware changes. Rebuild/upload, rerun physical checks, then run
  `tools/sync_automatic.py` and browser tests. Role mapping remains A COM3/MAC
  44:1B:F6:F8:E9:A4, B COM5/MAC 44:1B:F6:F8:EA:AC; recheck after reconnection.
- Inputs must be released before arming. The common GPIO6/GND interconnection is
  strictly a bench arrangement; normal operation uses a separate button per station.
- LoRa uses nonblocking CT2 frames with boot/sequence/attempt rejection. Radio
  airtime credit is reserved in <=1-second blocks in NVS, expires after 60 seconds,
  and is never renewed by reboot. Writes are PPS-guarded and forbidden while the
  station awaits its own armed event. Use RADIO_RELEASE_BUDGET before maintenance
  uploads when idle to avoid losing unused credit at restart.
- Station records are RAM-only, capacity 32, retained until explicit archive.
  Browser pending data, cancellation queue and history survive page reload/JSON
  restore. A delivery timeout must never erase a timestamp. Board power/reset
  recovery remains limited; do not reflash a station with an unsaved active event.
- Deterministic self-tests run via CLOCK_TEST. Node/browser tests use the real
  application modules, isolated browser storage and recorded hardware fixtures.
  Manual judge settings/calculations and saved records must remain independent.
"""
if pending_hardware:
    agents = agents.replace("- Work resumed at the owner's request, including automatic A+B HTML integration.",
        "- Work resumed at the owner's request, including automatic A+B HTML integration.\n- Latest firmware builds, but final upload/physical acceptance is pending.\n  Both USB boards disappeared from Windows; only Bluetooth COM6/COM7 remained.\n  Do not claim final-source 1 ms accuracy or a finished competition system.\n  Shared-input and earlier complete/radio reports currently have different hashes.\n  Next hardware work: reconnect, upload, rerun physical reports, sync HTML and\n  run browser tests. Read-only inspection and independent software work can proceed.")
    agents = agents.replace("- Final common-input report:", "- Intermediate common-input report:")
    agents = agents.replace("  archived-ARM replay rejection and cancellation of absent attempts.",
        "  The new archived-ARM replay and absent-attempt assertions still need hardware.")
for name, section in (("README.md", readme), ("AGENTS.md", agents)):
    target = project / name
    content = target.read_text(encoding="utf-8")
    if name == "README.md":
        content = content.replace("Status reviewed: 2026-10-28.", "Status reviewed: 2026-10-31.")
        content = content.replace("- `firmware/`: PlatformIO Arduino firmware; USB timing prototype tested on both boards.",
            "- `firmware/`: PlatformIO Arduino firmware, USB diagnostics and combined GNSS timing prototype; see current verification status below.")
        content = content.replace("Electronic timing is not implemented in the current v11 application.",
            "The current v11 application supports manual timing and combined automatic A+B\nbutton timing. See the latest implementation and verification section below.\nIndependent automatic stations and GNSS-free cable timing remain planned.")
        content = content.replace("These three modes are requirements for future implementation.\nThe current firmware and HTML application do not yet implement them.",
            "Manual and combined automatic button timing are implemented as described in\nthe latest verification section below. Independent two-participant automatic\ntiming remains a requirement for future implementation.")
    if heading in content:
        content = content[:content.index(heading)].rstrip()
    target.write_bytes((content.rstrip() + "\n\n" + section.rstrip() + "\n").replace("\n", "\r\n").encode("utf-8"))
    print(f"Updated {target}")
