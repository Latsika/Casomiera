"""Exercise preparation, recovery and immediate cancellation over real LoRa."""

import json
import time
import uuid
from pathlib import Path
from datetime import datetime, timezone

import serial


def main():
    connection = serial.Serial(port=None, baudrate=115200, timeout=0.1, write_timeout=2)
    connection.dtr = False
    connection.rts = False
    connection.port = "COM5"
    transcript = []
    reports = []

    def send(command):
        transcript.append({"command": command})
        connection.write((command + "\n").encode("ascii"))
        connection.flush()

    def wait_for(attempt_id, expected, timeout=5):
        stations = set()
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            line = connection.readline().decode("ascii", errors="replace").strip()
            if not line:
                continue
            transcript.append({"response": line})
            print(line, flush=True)
            if not line.startswith("AUTO "):
                continue
            message = json.loads(line[5:])
            if message.get("id") != attempt_id:
                continue
            if message.get("type") == "error":
                if expected == "armed" and message.get("reason") == "RADIO_CREDIT_PENDING":
                    time.sleep(0.1)
                    send(("REMOTE_ARM " if message["station"] == "A" else "AUTO_ARM ") + attempt_id)
                    continue
                raise RuntimeError(message)
            if message.get("type") == expected:
                stations.add(message["station"])
            if stations == {"A", "B"}:
                return
        raise RuntimeError(f"Missing {expected} response from both stations; got {stations}")

    with connection:
        connection.reset_input_buffer()
        try:
            send("AUTO_STATUS")
            send("REMOTE_STATUS")
            identities = {}
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline and len(identities) < 2:
                line = connection.readline().decode("ascii", errors="replace").strip()
                if line.startswith("AUTO "):
                    message = json.loads(line[5:])
                    if message.get("type") == "status":
                        identities[message["station"]] = message
            tested = json.loads(Path("test-results/shared-input.json").read_text(encoding="utf-8"))["stations"]
            for station in ("A", "B"):
                if identities.get(station, {}).get("boardId") != tested[station]["boardId"] or identities[station].get("firmwareHash") != tested[station]["firmwareHash"]:
                    raise RuntimeError("LoRa/USB firmware identities do not match the physical verification report.")
            for index in range(3):
                attempt_id = "rf_" + uuid.uuid4().hex[:24]
                began = time.monotonic()
                send("AUTO_ARM " + attempt_id)
                send("REMOTE_ARM " + attempt_id)
                wait_for(attempt_id, "armed")
                send("AUTO_GET " + attempt_id)
                send("REMOTE_GET " + attempt_id)
                wait_for(attempt_id, "armed")
                send("AUTO_CANCEL " + attempt_id)
                send("REMOTE_CANCEL " + attempt_id)
                wait_for(attempt_id, "cancelled")
                send("AUTO_ARCHIVE " + attempt_id)
                send("REMOTE_ARCHIVE " + attempt_id)
                # Give the archive frame time to leave the FIFO before next ARM.
                time.sleep(0.25)
                # Replay the same old ARM token after archival: it must not rearm A.
                send("REMOTE_ARM " + attempt_id)
                send("REMOTE_GET " + attempt_id)
                deadline = time.monotonic() + 3
                rejected = False
                while time.monotonic() < deadline:
                    line = connection.readline().decode("ascii", errors="replace").strip()
                    if not line.startswith("AUTO "):
                        continue
                    message = json.loads(line[5:])
                    if message.get("station") != "A" or message.get("id") != attempt_id:
                        continue
                    if message.get("type") == "armed":
                        raise RuntimeError("An archived attempt was rearmed by a delayed ARM")
                    if message.get("reason") == "ATTEMPT_MISMATCH":
                        rejected = True
                        break
                if not rejected:
                    raise RuntimeError("Archived ARM rejection was not verified")
                reports.append({"id": attempt_id, "elapsedSeconds": time.monotonic() - began})
            # A failed or partial preparation must still be cancellable.
            missing_id = "rf_missing_" + uuid.uuid4().hex[:20]
            send("AUTO_CANCEL " + missing_id)
            send("REMOTE_CANCEL " + missing_id)
            wait_for(missing_id, "cancelled")
            output = Path("test-results/radio-workflow.json")
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(json.dumps({"createdAt": datetime.now(timezone.utc).isoformat(),
                "passed": True, "stations": identities, "cycles": reports, "transcript": transcript}, indent=2) + "\n", encoding="utf-8")
            print("Real-radio preparation, GET recovery and immediate re-preparation passed.", flush=True)
        except Exception:
            # Do not leave a diagnostic attempt armed after a failed test.
            if "attempt_id" in locals():
                send("AUTO_CANCEL " + attempt_id)
                send("REMOTE_CANCEL " + attempt_id)
                time.sleep(0.3)
            raise


if __name__ == "__main__":
    main()
