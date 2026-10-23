# Casomiera — DHZ Ruskov

An offline competition management and timing application for DHZ Ruskov.
The project also includes a planned electronic timing extension.

Status reviewed: 2026-10-23.

## Project files

- `Casomiera_v11_OSTRA.html`: current production-designated application.
- `firmware/`: PlatformIO Arduino firmware; currently USB communication TEST 0.1.
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

The approved measurement modes are:

1. Gate A starts timing; gate B stops timing.
2. Gate A starts timing; a physical STOP button stops timing.

After a valid start, further interruptions of gate A must not affect that attempt.
The STOP-button mode supports a judge stopping timing for the last team member.
Automatic identification or counting of team members is not part of these modes.

The firmware must timestamp events independently of browser execution.
Outdoor timing must use synchronized event timestamps, not radio arrival times.
The cable design is intended to use a shared timing clock and a protected
signal interface; its circuit and delay handling remain to be established.

## Application measurement modes — agreed requirements

The application must support two independent measurement modes:

- Automatic: electronic timing using optical gates, with the previously
  approved physical STOP-button option retained.
- Manual: the existing configurable number of judges and time calculation.

Electronic measurements must remain separate from judge measurements.
The operator must be able to switch modes within an open competition
without losing saved results or restarting the application.

If electronics fail during an active measurement, the operator manually
cancels that measurement. A replacement run may then use either mode,
depending on hardware availability. There is no automatic fallback or
transfer of partial times between modes.

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

## Open hardware work

- Verify remaining hardware details and peripheral pin assignments.
- Extend the working PlatformIO Arduino USB test into timing firmware.
- Begin with test buttons before integrating optical sensors.
- Define GNSS synchronization, LoRa messaging, and loss-of-signal behavior.
- Design and validate the cable interface.
- Select affordable retroreflective sensors and matching reflectors.
- Design input protection, power, connectors, and mounting.
- Define the USB protocol and application integration.
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
