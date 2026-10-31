# Casomiera — DHZ Ruskov

An offline competition management and timing application for DHZ Ruskov.
The project also includes a planned electronic timing extension.

Status reviewed: 2026-10-28.

## Project files

- `Casomiera_v11_OSTRA.html`: current production-designated application.
- `firmware/`: PlatformIO Arduino firmware; USB timing prototype tested on both boards.
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

Electronic timing is not implemented in the current v11 application.

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

These three modes are requirements for future implementation.
The current firmware and HTML application do not yet implement them.

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
