# Project working agreement

## Communication and preparation
- Use Slovak for communication with the owner in the Casomiera project.
- Use English for documentation, code, and comments.
- Explain work briefly in plain language.
- Read README.md and applicable instructions before working.
- Clarify the outcome, scope, constraints, and success criteria.
- Prefer focused questions over guesses.
- Recommend a suitable primary role before starting work.
- Use local role profiles when available.
- Role profiles do not authorize parallel agents.

## Approval
- Read-only inspection may proceed without approval.
- Before each file creation, modification, deletion, or move, show
  its path, purpose, and proposed content or diff, then ask for approval.
- Approval covers only the proposed change to that file.
- Obtain approval again if the proposed content materially changes.
- Explain file changes before running commands that perform them.
- Ask before installation, commit, push, deployment, or destructive
  actions unless that specific action was explicitly authorized.
- Never interpret silence as approval.
- Respect tool permissions.

## Project guidance
- Use README.md as the primary project documentation.
- Preserve offline operation and manual timing.
- Preserve existing behavior unless the agreed task requires changing it.
- Follow established conventions and keep changes focused.
- Avoid unnecessary dependencies and unrelated refactoring.
- Preserve unrelated user changes and protect sensitive information.
- Verify relevant behavior and report any unverified areas.
- Keep durable technical notes in this file, without conversation logs.

## Finishing work
- Explain the result, verification, and remaining issues.
- Offer: document only; document and commit; or document, commit, and push.
- Allow the user to finish without further changes.
- Obtain approval for each documentation edit.
- Commit only agreed files.
- Identify the remote and branch before pushing.

## Session synchronization checks
- At the start of each project session, check for differences between
  the local repository and origin/master. Report unavailable checks.
- Review incoming and outgoing AGENTS.md changes with the owner.
- Obtain approval before applying, committing, or pushing changes.
- Preserve unrelated local changes and resolve conflicts with the owner.

## Protected global instructions
- Treat ~/.codex/AGENTS.md as the authoritative global instructions.
- Project agents must not modify that file.
- GLOBAL-AGENTS.md is a reference snapshot, not a second source of authority.
- At session start, compare the snapshot with the local global file.
- Report differences; never synchronize global settings automatically.
- Proposed global changes must be approved and applied to the owner's
  PC first, outside project work.
- Only then, with approval, refresh the repository snapshot.
- Never copy repository instructions over the owner's global file.
- If the local global file is unavailable, report that limitation.

## Firmware handover — 2026-10-23

- Both owner-confirmed Heltec Wireless Tracker V2 ESP32-S3 boards passed
  the TEST 0.1 USB test, demonstrated by owner-provided terminal screenshots.
- Firmware uses PlatformIO Arduino with board `esp32-s3-devkitc-1`,
  115200 baud, and USB CDC enabled in `firmware/platformio.ini`.
- Tested Windows ports: first board COM3, second board COM5.
  Recheck ports after reconnection; close monitors before uploading.
- TEST 0.1 only prints USB messages; it does not control the display or LED.
- LoRa, GNSS, sensors, timing accuracy, and cable operation remain unverified.
- Physical A/B station labels were recommended but are not confirmed.

## Firmware handover — 2026-10-28

- The USB timing prototype supersedes TEST 0.1. The owner uploaded it
  to both boards and supplied passing serial test responses.
- Both boards passed prepare/start/stop/status, repeated-start rejection,
  mismatched-attempt rejection, busy rejection, and cancellation tests.
- Commands: STATUS, ARM <id>, TEST_START <id>, TEST_STOP <id>, CANCEL <id>.
  Use 115200 baud and LF line endings. No periodic messages are printed.
- Responses use V1 and a per-boot ID, not a permanent hardware ID.
  Durations are in microseconds; running STATUS is not a live stopwatch.
- Use new attempt IDs for new attempts. Physical A/B labels and current
  COM ports remain unconfirmed.
- Accuracy, restart/disconnection recovery, LoRa, GNSS, physical inputs,
  cable operation, and browser integration remain unverified.
- Next recommended work: verify peripheral pin assignments and plan
  physical button tests before connecting sensors.

## Attempt reset requirement — 2026-10-29

- The 30-second SEND interval belongs to the standalone LoRa test.
  Remove this fixed test restriction from the final timing firmware.
- After cancellation or a false start, the operator must be able to
  prepare a new attempt immediately, without a fixed 30-second wait.
- Use a new attempt ID and reject delayed messages from cancelled attempts.
- Design radio traffic to support this workflow within applicable
  radio transmission limits.

## Measurement recovery requirement — 2026-10-29

- Preserve measured event timestamps and results when delivery or
  acknowledgement fails; allow the same data to be sent again.
- Apply this requirement to the final firmware and the timing HTML
  application. An acknowledgement timeout alone must not discard a time
  or automatically require a replacement attempt.
- The retention, retransmission, and recovery method remains to be agreed.

## LoRa test — owner confirmation recorded 2026-10-31

- The owner confirmed successful A-to-B test packet delivery and
  B-to-A acknowledgements at approximately 80 metres, with station B
  inside a neighbour's house.
- Station B's display showed the received test packet count.
- This confirmation supersedes earlier statements that standalone
  LoRa communication and the receiver display remain unverified.
- Timing integration, the intended 200–300 metre range, and
  measurement accuracy remain unverified.

## Three measurement modes — requirements recorded 2026-10-31

- Preserve manual judge timing, manual entry, and existing calculations.
- Combined automatic mode: A records START by optical gate or physical
  button; B records STOP by optical gate or physical button.
- Independent automatic mode: each board records its own START by
  optical gate or physical button and STOP by a separate physical button.
- In independent mode, both boards connect to the same PC through
  separate USB connections and can time two participants concurrently.
- Configure modes and input sources through the timing application.
- Keep each independent station's participant, attempt ID, state,
  cancellation, and result separate.
- Independent timing uses each board's local clock; it does not require
  LoRa or GNSS synchronization.
- Retain synchronized timestamps for combined wireless timing.
- Ignore further START events after a valid start.
- Preserve saved results when switching modes and retain measured
  timestamps/results when delivery or acknowledgement fails.
- Recommended rule: allow mode changes only when no attempt is active.
- Separate START/STOP inputs, electrical interfaces, firmware support,
  application integration, and accuracy remain to be implemented
  or verified. These requirements are not completed functionality.

## Button and GNSS diagnostic handover — 2026-10-31

- The owner confirmed repeated presses and held-button handling on A and B:
  one event per press, with release required before another event.
- External buttons use GPIO6 to GND with INPUT_PULLUP.
- GPIO36 pulse detection was observed on both boards; UTC-to-PPS
  association, synchronization, and timing accuracy remain unverified.
- lora_test.cpp adds receive-only GNSS UART diagnostics on GPIO33 at
  115200 baud. STATUS reports checksum-verified RMC counts, raw UTC,
  date and status, message age, checksum errors, and oversized lines.
- SYNC=UNVERIFIED is intentional. Do not treat RMC validity or PPS
  presence alone as proof of synchronization.
- Verify fresh GNSS messages outdoors on both boards before implementing
  UTC-to-PPS association. Avoid SEND during this diagnostic test because
  existing radio acknowledgement waiting delays UART processing.
- Combined A-to-B timing and application integration remain unimplemented.

## Work on hold — handover 2026-10-31

- Owner paused project work pending availability of a new Heltec board.
- Resume combined A=START, B=STOP work before splitting application modes.
- Current lora_A/lora_B firmware includes button, PPS, RMC, and 10-second
  GNSS_SCAN diagnostics. Both environments built and uploaded successfully.
- Last verified mapping: A COM3, MAC 44:1B:F6:F8:E9:A4;
  B COM5, MAC 44:1B:F6:F8:EA:AC. Recheck ports and board roles on return.
- Both external buttons passed repeated-press and held-button handling.
- Outdoor B: valid RMC time/date, increasing PPS, 3D fix, and GGA reporting
  up to 30 satellites used in the observed tests.
- Outdoor A: checksum-valid GNSS messages, all reported GSV groups at
  zero satellites, GGA quality 0, RMC V, empty UTC/date, PPS count stuck at 2.
- Removing A from the breadboard and changing its outdoor position did
  not resolve the issue. Do not label the board defective without evidence.
- No GNSS configuration/reset commands were sent by our diagnostic code.
- SYNC=UNVERIFIED remains intentional; UTC-to-PPS association and combined
  timing are not implemented. Preserve indoor cable operation requirements.
- Builds retain a compiler warning about volatile counter increment.
- Next: verify the new board and compare outdoor GNSS on both stations,
  then implement and validate UTC-to-PPS association.
- Do not store the support email draft; the owner requested manual copying.

## GNSS antenna clarification and retest — 2026-10-31

- Owner identified A's earlier reception problem: removing the display
  for soldering also removed the GNSS antenna in its plastic enclosure.
  Do not interpret the earlier results as evidence of a defective board.
- Later outdoor STATUS outputs showed RMC status A and valid time/date
  on both boards, with zero checksum errors and oversized lines.
- A: PPS 226 to 250 over 24 seconds of GNSS time.
  B: PPS 257 to 277 over 20 seconds of GNSS time.
- This supersedes the unresolved-cause assessment and the requirement
  to wait for a replacement board before further GNSS investigation.
- Project work remains paused until the owner requests continuation.
- Next development step: implement and validate UTC-to-PPS association
  before combined A=START, B=STOP timing and application mode work.
- SYNC=UNVERIFIED remains intentional. Inter-board synchronization
  and measurement accuracy have not been demonstrated.

## Combined GNSS timing implementation and verification — 2026-10-31

- Work resumed at the owner's request, including automatic A+B HTML integration.
- Latest firmware builds, but final upload/physical acceptance is pending.
  Both USB boards disappeared from Windows; only Bluetooth COM6/COM7 remained.
  Do not claim final-source 1 ms accuracy or a finished competition system.
  Shared-input and earlier complete/radio reports currently have different hashes.
  Next hardware work: reconnect, upload, rerun physical reports, sync HTML and
  run browser tests. Read-only inspection and independent software work can proceed.
- Current implementation: `lora_A` / `lora_B` in `src/lora_test.cpp`; portable clock
  and station ledger headers in `include/`; standalone HTML has manual and combined
  automatic modes with dual USB or A LoRa + B USB. Independent mode and GNSS-free
  cable timing remain future work. Preserve the original USB prototype environment.
- GPIO6 falling-edge ISR captures the timestamp before 30 ms qualification.
  Five valid sequential epochs establish tracking; stale/invalid references fail
  closed. UART gaps invalidate acquisition. Read-only CFGTP is retried after cold
  boot. Confirmed module: UC6580I-00, R6.0.0.0Build3700, CFGTP 1000000/500000/1/0/0/0.
- Intermediate common-input report: 24 pulses, maximum absolute difference 6 us
  against a 1000 us criterion. Four full GPIO/LoRa/USB/application cycles and USB
  recovery passed. Radio tests cover immediate cancellation/re-preparation,
  The new archived-ARM replay and absent-attempt assertions still need hardware.
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
