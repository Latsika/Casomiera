"""Record build/report provenance without treating intermediate tests as final."""

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

firmware = Path(__file__).resolve().parents[1]
reports = {}
for name in ("shared-input", "end-to-end", "radio-workflow"):
    path = firmware / "test-results" / (name + ".json")
    report = json.loads(path.read_text(encoding="utf-8"))
    reports[name] = {
        "createdAt": report.get("createdAt"),
        "passedForItsRecordedBuild": report.get("passed"),
        "fileSha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "stations": report.get("stations"),
    }
builds = {}
for environment in ("lora_A", "lora_B"):
    binary = firmware / ".pio" / "build" / environment / "firmware.bin"
    builds[environment] = {"built": binary.exists(), "binaryFileSha256": hashlib.sha256(binary.read_bytes()).hexdigest() if binary.exists() else None}
source_files = [firmware / "src/lora_test.cpp", firmware / "platformio.ini"] + sorted((firmware / "include").glob("*.h"))
status = {
    "createdAt": datetime.now(timezone.utc).isoformat(),
    "status": "awaiting_final_hardware_upload_and_validation",
    "latestUpload": "failed_both_USB_boards_absent_from_Windows",
    "applicationTests": "Node and isolated Chrome tests passed, including recorded hardware fixtures and offline cancellation",
    "latestBuilds": builds,
    "sourceSha256": {str(path.relative_to(firmware)): hashlib.sha256(path.read_bytes()).hexdigest() for path in source_files},
    "intermediateReports": reports,
    "limitations": [
        "Intermediate electrical agreement does not certify the final source build.",
        "The current shared-input and older complete/radio reports refer to different firmware hashes.",
        "Optical gates, long-term temperature accuracy and 200–300 metre range are not verified.",
    ],
    "nextSteps": ["Reconnect both USB boards", "Upload current lora_A/lora_B", "Run all three physical scripts", "Run tools/sync_automatic.py and application/browser tests", "Refresh documentation with matching reports"],
}
target = firmware / "test-results/verification-status.json"
target.write_text(json.dumps(status, indent=2) + "\n", encoding="utf-8")
print(target)
