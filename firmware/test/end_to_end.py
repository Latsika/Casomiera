"""Exercise real GPIO capture, LoRa delivery, USB recovery and application math.

The two stations remain connected by GPIO6/GND. B generates the first edge
while only A is armed. A generates the second edge after B is armed; A has
already captured START and ignores repeat START edges. No competition is edited.
"""

import json
import subprocess
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

import serial


def open_port(port):
    connection = serial.Serial(port=None, baudrate=115200, timeout=0, write_timeout=2)
    connection.dtr = False
    connection.rts = False
    connection.port = port
    connection.open()
    return connection


def main():
    connections = {"A": open_port("COM3"), "B": open_port("COM5")}
    buffers = {"A": "", "B": ""}
    transcript = []
    results = []
    current_id = None

    def send(station, command):
        connections[station].write((command + "\n").encode("ascii"))
        connections[station].flush()
        transcript.append({"port": station, "command": command})

    def collect(duration, expected_station=None, expected_type=None):
        deadline = time.monotonic() + duration
        while time.monotonic() < deadline:
            for port, connection in connections.items():
                buffers[port] += connection.read(connection.in_waiting).decode("ascii", errors="replace")
                while "\n" in buffers[port]:
                    line, buffers[port] = buffers[port].split("\n", 1)
                    transcript.append({"port": port, "response": line.strip()})
                    if not line.startswith("AUTO "):
                        continue
                    message = json.loads(line[5:])
                    # The official A event must actually have traversed LoRa to B.
                    if port != "B" or message.get("id") != current_id:
                        continue
                    if message.get("type") == "error":
                        if expected_type == "armed" and message.get("reason") == "RADIO_CREDIT_PENDING":
                            time.sleep(0.1)
                            send("B", ("REMOTE_ARM " if message["station"] == "A" else "AUTO_ARM ") + current_id)
                            continue
                        raise RuntimeError(message)
                    if message.get("station") == expected_station and message.get("type") == expected_type:
                        return message
            time.sleep(0.002)
        if expected_station:
            raise RuntimeError(f"Missing {expected_station} {expected_type}")
        return None

    try:
        for connection in connections.values():
            connection.reset_input_buffer()
        for index, pause in enumerate((0.25, 0.8, 1.4, 2.1)):
            current_id = "bench_" + uuid.uuid4().hex[:24]
            send("B", "REMOTE_ARM " + current_id)
            ready_a = collect(5, "A", "armed")
            send("B", "TEST_PULSE")
            start = collect(5, "A", "event")
            if not start.get("valid"):
                raise RuntimeError("Invalid START clock")
            collect(0.15)
            send("B", "AUTO_ARM " + current_id)
            ready_b = collect(2, "B", "armed")
            collect(pause)
            send("A", "TEST_PULSE")
            stop = collect(3, "B", "event")
            if not stop.get("valid"):
                raise RuntimeError("Invalid STOP clock")
            send("B", "REMOTE_GET " + current_id)
            duplicate_start = collect(3, "A", "event")
            if duplicate_start["utcUs"] != start["utcUs"]:
                raise RuntimeError("Repeat START changed the retained timestamp")
            # Reopen the finish USB connection without resetting either board.
            connections["B"].close()
            time.sleep(0.15)
            connections["B"] = open_port("COM5")
            buffers["B"] = ""
            send("B", "AUTO_GET " + current_id)
            recovered_stop = collect(3, "B", "event")
            send("B", "REMOTE_GET " + current_id)
            recovered_start = collect(3, "A", "event")
            if recovered_stop != stop or recovered_start != start:
                raise RuntimeError("Recovered records differ from the original measurements")
            model_input = {"id": current_id, "messages": [ready_a, start, ready_b, stop, recovered_stop, recovered_start],
                           "start": start, "stop": stop}
            checked = subprocess.run(["node", "test/consume_measurement.cjs"],
                input=json.dumps(model_input), text=True, capture_output=True, check=True)
            computed = json.loads(checked.stdout)
            if not 100000 <= int(computed["elapsedUs"]) <= 10000000:
                raise RuntimeError("Unexpected physical test duration")
            results.append({**model_input, "computed": computed})
            print(f"Hardware/LoRa/USB/app cycle {index + 1}: {computed['elapsedUs']} us; recovery identical", flush=True)
            send("B", "AUTO_COMPLETE " + current_id)
            collect(2, "B", "complete")
            send("B", "REMOTE_COMPLETE " + current_id)
            collect(3, "A", "complete")
            send("B", "AUTO_ARCHIVE " + current_id)
            send("B", "REMOTE_ARCHIVE " + current_id)
            collect(0.25)
            current_id = None
        output = Path("test-results/end-to-end.json")
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps({"createdAt": datetime.now(timezone.utc).isoformat(),
            "passed": True, "cycles": results, "transcript": transcript}, indent=2) + "\n", encoding="utf-8")
        print("Real GPIO -> LoRa -> USB -> application calculation and USB recovery passed.", flush=True)
    finally:
        if current_id is not None:
            try:
                send("B", "AUTO_CANCEL " + current_id)
                send("B", "REMOTE_CANCEL " + current_id)
                collect(0.4)
            except Exception:
                pass
        for connection in connections.values():
            connection.close()


if __name__ == "__main__":
    main()
