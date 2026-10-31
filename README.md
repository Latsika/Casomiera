# Casomiera — DHZ Ruskov

An offline competition management and timing application for DHZ Ruskov.
The project also includes a planned electronic timing extension.

Status reviewed: 2026-10-31.

## Project files

- `Casomiera_v11_OSTRA.html`: current production-designated application.
- `firmware/`: PlatformIO Arduino firmware, USB diagnostics and combined GNSS timing prototype; see current verification status below.
- `Časomiera pre súťaže.pdf`: initial development history, 112 pages.
- `Pokračovanie časomiery.pdf`: subsequent development history, 49 pages.

The PDFs contain historical proposals, changes, and reported test results.
Later explicit decisions supersede earlier proposals.
This README records the current understanding of the project.

## Current application

The application is distributed as one HTML file containing HTML, CSS,
and JavaScript. Core competition operation must remain available offline
and without electronic timing hardware.

The documented v11 feature set includes:

- Individual and team registration, categories, and start numbers.
- Registration for timed competition, elimination competition, or both.
- Multiple attempts, penalties, and bonus points.
- Automatic calling order, manual selection, reordering, and postponement.
- One, two, or three judges.
- Official time calculated as median, average, minimum, or maximum.
- Manual stopwatch operation and manual entry of measured times.
- Independently filtered start lists and results, including individual MIX views.
- Elimination brackets, a bronze match, and a separate winner position.
- LIVE windows for timing, results, brackets, and medal ceremonies.
- CSV export and printing to PDF.
- JSON backup and restore, with backup status and last successful save time.

Work modes separate registration, timing, brackets, results, and podiums.
LIVE timing shows the active competitor and the configured number of clocks.

## Running the application

Open `Casomiera_v11_OSTRA.html` in a browser.
Chrome or Edge on the competition PC are the intended desktop environment.

The documented workflow creates or loads a competition JSON file.
Direct automatic JSON file writing depends on browser support and permission.
Where direct file writing is unavailable, local storage and manual JSON export
are the fallback; local browser storage is not a substitute for a backup file.

LIVE windows are intended for another monitor or projector attached to
the same computer. Public viewing on spectators' phones remains future work.

These operating instructions come from the development history.
They have not yet been verified in a browser during this project review.

## Confirmed competition rules

- Preserve manual operation without additional hardware.
- Preserve all individual judge measurements.
- Select the official-time calculation according to competition settings.
- Allow elimination-bracket byes only in the first round.
- Include the final winner and a separate match for third place.
- Medal presentations must not modify competition results.
- Keep LIVE presentation independent of the operator's work mode.

## Electronic timing — planned extension

The current v11 application supports manual timing and combined automatic A+B
button timing. See the latest implementation and verification section below.
Independent automatic stations and GNSS-free cable timing remain planned.

Two Heltec boards were received by the owner on 2026-10-20.
The owner confirmed Heltec Wireless Tracker V2 boards with ESP32-S3.
The photographed board is labelled Wireless Tracker (Rev. 2.0).
The intended radio band is EU 868 MHz; radio configuration, accessories,
and peripheral pin assignments remain to be verified.

Earlier Raspberry Pi Pico and LILYGO proposals are superseded.

The approved target system has:

- Two stations: A at the start and B at the finish.
- Approximately 200–300 metres between stations.
- Retroreflective optical gates: one powered sensor and one passive reflector.
- Typical gate width of 1–5 metres, with a required maximum reserve of 10 metres.
- Outdoor wireless operation using LoRa and GNSS time synchronization.
- Indoor cable operation without requiring GNSS reception.
- Cable operation as an outdoor fallback.
- USB communication between the finish station and the competition PC.
- Battery or external power; final power design remains open.

The electronic timing system must support both a combined A+B station
setup and independent single-board timing, as specified below.

After a valid start, further START input events must not affect that
attempt. A physical STOP button supports stopping timing for the last
team member. Automatic identification or counting of team members
is not part of these requirements.

The firmware must timestamp events independently of browser execution.
Outdoor timing must use synchronized event timestamps, not radio arrival times.
The cable design is intended to use a shared timing clock and a protected
signal interface; its circuit and delay handling remain to be established.

## Application measurement modes — agreed requirements

The application must provide three selectable measurement modes:

1. Manual: preserve judge timing, manual time entry, the existing
   configurable judge count, and official-time calculation.
2. Combined automatic A+B: station A records START from an optical gate
   or physical button; station B records STOP from an optical gate
   or physical button. Both stations measure one participant's attempt.
3. Independent automatic stations: each board measures a complete
   attempt using its own optical gate or physical button for START
   and a separate physical button for STOP. A and B connect directly
   to the same PC through separate USB connections and support two
   participants being timed concurrently and independently.

The application configures the operating mode and selected START/STOP
sources. In independent mode, each station must have its own participant,
attempt ID, state, and result. Starting, stopping, or cancelling one
station's attempt must not affect the other station's attempt.

Each independent station calculates elapsed time using its own local
clock. LoRa and GNSS synchronization are not required for this mode.
Combined wireless timing retains the requirement for synchronized
event timestamps rather than radio arrival times.

Electronic measurements must remain separate from judge measurements.
Switching modes within an open competition must preserve saved results
and must not require restarting the application.

Recommended switching rule: complete or explicitly cancel active
attempts before changing the operating mode.

An acknowledgement timeout alone must not discard measured timestamps
or results. Preserve them for retransmission and recovery. If the operator
explicitly cancels an active attempt, a replacement attempt may use
another mode. Do not automatically transfer partial measurements
between modes.

Manual and combined automatic button timing are implemented as described in
the latest verification section below. Independent two-participant automatic
timing remains a requirement for future implementation.

## v11 integration review — 2026-10-23

Static code inspection confirmed existing manual timing, cancellation,
result storage, JSON backup, exports, and LIVE timing presentation.
Electronic communication and automatic measurement are not implemented.

The recommended extension adds an explicit measurement mode and attempt
lifecycle, binds each active measurement to its participant, and rejects
late or duplicate device messages. Results, backups, exports, and LIVE
views must distinguish automatic measurements from judge measurements.
Existing records should remain readable as manual measurements.

This review did not include browser execution or new hardware tests.

## Firmware USB test — verified 2026-10-23

The owner successfully built and uploaded TEST 0.1 using VS Code and
PlatformIO, then demonstrated repeated `HELTEC IS RUNNING` messages
from each board in the serial monitor at 115200 baud.

The first board was tested on COM3 and the second on COM5.
Windows port assignments may change when reconnecting boards.

Configuration: `esp32-s3-devkitc-1`, `espressif32`, Arduino framework,
with `ARDUINO_USB_CDC_ON_BOOT=1` and `ARDUINO_USB_MODE=1`.

The test does not initialize the display or control an LED.
A blank display after uploading this test is expected.
LoRa, GNSS, timing accuracy, sensors, and cable operation remain untested.

Close any running serial monitor before uploading.
When multiple ports are available, explicitly select the intended port
for both upload and monitoring.

## Firmware USB timing prototype — verified 2026-10-28

The owner uploaded the timing prototype to both Heltec boards and provided
serial responses confirming these tests on each board:

- Prepare, start, stop, and read the completed attempt time.
- Reject a repeated start without restarting the measurement.
- Reject a stop with a different attempt ID.
- Reject preparation of another attempt while timing is running.
- Cancel an attempt, clear its time, and reject a subsequent stop.

Commands are case-sensitive, sent at 115200 baud, and terminated by LF:

- `STATUS`
- `ARM <id>`
- `TEST_START <id>`
- `TEST_STOP <id>`
- `CANCEL <id>`

Responses begin with `V1 <boot-id>`. The boot ID is generated at startup
and is not a permanent board identifier. Attempt IDs contain 1–40 ASCII
letters, digits, hyphens, or underscores. Use a new ID for each new attempt.

Elapsed times are reported in microseconds using the board's local timer.
During a running attempt, STATUS does not report live elapsed time.
The firmware no longer prints periodic startup messages; send STATUS
to check communication. The display and LED are not controlled.

These tests verify command handling on individual boards. They do not
demonstrate timing accuracy, synchronization between boards, LoRa, GNSS,
physical buttons, optical sensors, cable operation, or browser integration.
No restart or disconnection recovery tests were performed.

## Open hardware work

- Verify remaining hardware details and peripheral pin assignments.
- Extend the tested USB timing prototype with physical timing inputs.
- Begin with test buttons before integrating optical sensors.
- Define GNSS synchronization, LoRa messaging, and loss-of-signal behavior.
- Design and validate the cable interface.
- Select affordable retroreflective sensors and matching reflectors.
- Design input protection, power, connectors, and mounting.
- Extend and validate the prototype USB protocol and implement application integration.
- Validate timing accuracy, reliability, and recovery from failures.

A target accuracy of 0.01 seconds has not been demonstrated.
Displaying milliseconds does not establish measurement accuracy.
Sensor specifications, wiring, and historical purchase prices require
fresh verification before implementation or further purchases.
Enclosure selection was explicitly deferred until the first prototype works.

## Verification status

This review examined the text of both PDFs and selected parts of the HTML.
The HTML identifies itself as v11 and contains the judge-count and time-rule
settings, v11 storage keys, backup code, and bracket code.

Historical application tests have not been independently reproduced here.
The initial documentation review included no browser or hardware tests.
The later firmware USB tests are recorded above.
No standalone automated test suite is present in the project files reviewed.

Before competition use, verify registration, timing and calculations,
calling order, brackets, LIVE windows, JSON saving, and restoration on
the actual competition PC.

## Documentation conventions

Use this README for project purpose, operation, requirements, and current status.
Use AGENTS.md for agent instructions, durable technical notes, and handover.
Keep documentation and code in English; communicate with the owner in Slovak.
Obtain approval before each individual file change.

## LoRa test — owner confirmation recorded 2026-10-31

- The owner confirmed successful A-to-B test packet delivery and
  B-to-A acknowledgements at approximately 80 metres, with station B
  inside a neighbour's house.
- Station B's display showed the received test packet count.
- This confirmation supersedes earlier statements that standalone
  LoRa communication and the receiver display remain unverified.
- Timing integration, the intended 200–300 metre range, and
  measurement accuracy remain unverified.

## Button verification and GNSS diagnostics — 2026-10-31

The owner confirmed repeated external-button presses on both stations.
Holding a button produced no additional events; another event required
release and a new press. Buttons connect GPIO6 to GND using INPUT_PULLUP.
These tests verify button detection, not timing accuracy.

Both stations registered pulses on GPIO36. This does not yet establish
GNSS lock, UTC-to-PPS association, or synchronization between stations.

The LoRa test firmware now includes receive-only GNSS diagnostics at
115200 baud on GPIO33. STATUS reports checksum-verified RMC message
counts, raw UTC/date/status fields, message age, and diagnostic errors.
SYNC remains UNVERIFIED. This is not combined A+B timing.

Next verification: obtain fresh RMC messages on both boards outdoors,
then establish and verify the association between UTC and PPS.
Avoid SEND during GNSS diagnostics because radio acknowledgement
waiting can delay UART processing.

## Project hold and outdoor GNSS results — 2026-10-31

Work is on hold at the owner's request until a new Heltec board is
available. Continue with combined A=START, B=STOP timing before
implementing the three application measurement modes.

Completed verification:
- USB timing commands previously passed on both boards.
- LoRa delivery, acknowledgements, and the B display passed at
  approximately 80 metres, with B inside a neighbouring house.
- External buttons passed repeated-press and held-button tests on A and B.
- The latest diagnostic firmware built and uploaded successfully to both
  boards. It supports STATUS and a 10-second GNSS_SCAN of GGA/GSA/GSV.

Outdoor GNSS comparison:
- B obtained valid RMC time/date, increasing PPS counts, and a 3D fix.
  GGA reported 19 satellites used initially and 30 in a later test.
- A received checksum-valid messages but reported no satellites,
  no fix, empty UTC/date, RMC status V, and a PPS count remaining at 2.
- A remained affected outside the breadboard and after repositioning
  under open sky. The cause is unresolved; hardware failure is not proven.

Combined timing, UTC-to-PPS association, timing accuracy, cable operation,
optical gates, and HTML electronic-timing integration remain unverified
or unimplemented. Indoor cable operation without GNSS remains required.

Resume by identifying the new board, verifying its USB and outdoor GNSS
operation, then validating UTC-to-PPS association on both timing stations.
The support email draft is intentionally not stored in the repository.

## GNSS antenna clarification and retest — 2026-10-31

The owner identified the cause of A's earlier reception problem:
removing the display for soldering also removed the GNSS antenna
housed in the display's plastic enclosure. The earlier results do
not establish a board fault.

Subsequent owner-provided outdoor STATUS outputs showed valid RMC
time/date (status A) on both boards, with no checksum errors or
oversized lines. A recorded 24 PPS pulses over 24 seconds of GNSS
time; B recorded 20 over 20 seconds.

This supersedes the unresolved-cause assessment above. A replacement
board is no longer a prerequisite for further GNSS investigation.
Project work remains paused until the owner requests continuation.
UTC-to-PPS association, inter-board synchronization, and measurement
accuracy remain unverified; SYNC=UNVERIFIED remains intentional.

## Combined GNSS timing implementation and verification — 2026-10-31

The owner resumed development and authorized firmware, application, documentation,
commit and push work. This section supersedes earlier statements that combined
timing and HTML integration are unimplemented or waiting for a replacement board.

### Current completion status: hardware connection required

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

- Both latest environments build successfully. Earlier builds were uploaded;
  the final upload is pending reconnection, as described above.
- The latest intermediate GPIO6 common-input test passed: **24 impulses**, maximum
  absolute A/B difference **6 microseconds** (0.006 ms), against
  a 1000-microsecond acceptance threshold. See
  [shared-input.json](firmware/test-results/shared-input.json) for individual samples,
  board MAC identifiers and exact ELF firmware hashes.
- Four complete electrical-input/LoRa/USB/application calculations passed, including
  repeated-START rejection and identical record retrieval after reopening finish USB.
  See [end-to-end.json](firmware/test-results/end-to-end.json).
- Three radio prepare/GET/cancel/re-prepare cycles passed without a fixed 30-second
  delay. The new archived-ARM replay and absent-attempt cancellation assertions still
  require the final hardware run.
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
