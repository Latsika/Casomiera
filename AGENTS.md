# Project working agreement

## Communication and preparation
- Use English for communication, documentation, code, and comments.
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
