"""Exercise real GPIO capture, LoRa delivery, USB recovery and application math.

The two stations remain connected by GPIO6/GND. B generates the first edge
while only A is armed. A generates the second edge after B is armed; A has
already captured START and ignores repeat START edges. No competition is edited.
"""

import argparse
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
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--usb-station", choices=("A", "B"), default="B",
                        help="Station relaying the other station's LoRa data to USB")
    parser.add_argument("--port-a", default="COM3")
    parser.add_argument("--port-b", default="COM5")
    parser.add_argument("--output", type=Path, help="Report path; A-USB uses a separate report by default")
    args = parser.parse_args()
    usb_station = args.usb_station
    ports = {"A": args.port_a, "B": args.port_b}
    connections = {station: open_port(port) for station, port in ports.items()}
    buffers = {"A": "", "B": ""}
    transcript = []
    results = []
    current_id = None

    def send(station, command):
        connections[station].write((command + "\n").encode("ascii"))
        connections[station].flush()
        transcript.append({"port": station, "command": command})

    def send_operation(station, operation):
        prefix = "AUTO_" if station == usb_station else "REMOTE_"
        send(usb_station, prefix + operation + " " + current_id)

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
                    # Read official data only from the selected USB coordinator; the remote event must traverse LoRa.
                    if port != usb_station or message.get("id") != current_id:
                        continue
                    if message.get("type") == "error":
                        if expected_type == "armed" and message.get("reason") == "RADIO_CREDIT_PENDING":
                            time.sleep(0.1)
                            send_operation(message["station"], "ARM")
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
            send_operation("A", "ARM")
            ready_a = collect(5, "A", "armed")
            send("B", "TEST_PULSE")
            start = collect(5, "A", "event")
            if not start.get("valid"):
                raise RuntimeError("Invalid START clock")
            collect(0.15)
            send_operation("B", "ARM")
            ready_b = collect(2, "B", "armed")
            collect(pause)
            send("A", "TEST_PULSE")
            stop = collect(3, "B", "event")
            if not stop.get("valid"):
                raise RuntimeError("Invalid STOP clock")
            send_operation("A", "GET")
            duplicate_start = collect(3, "A", "event")
            if duplicate_start["utcUs"] != start["utcUs"]:
                raise RuntimeError("Repeat START changed the retained timestamp")
            # Reopen the selected coordinator USB connection without resetting either board.
            connections[usb_station].close()
            time.sleep(0.15)
            connections[usb_station] = open_port(ports[usb_station])
            buffers[usb_station] = ""
            send_operation("B", "GET")
            recovered_stop = collect(3, "B", "event")
            send_operation("A", "GET")
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
            send_operation("B", "COMPLETE")
            collect(2, "B", "complete")
            send_operation("A", "COMPLETE")
            collect(3, "A", "complete")
            send_operation("B", "ARCHIVE")
            send_operation("A", "ARCHIVE")
            collect(0.25)
            current_id = None
        output = args.output or Path("test-results/end-to-end" + ("-a-usb" if usb_station == "A" else "") + ".json")
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps({"createdAt": datetime.now(timezone.utc).isoformat(),
            "passed": True, "usbStation": usb_station, "cycles": results, "transcript": transcript}, indent=2) + "\n", encoding="utf-8")
        print("Real GPIO -> LoRa -> USB -> application calculation and USB recovery passed.", flush=True)
    finally:
        if current_id is not None:
            try:
                send_operation("B", "CANCEL")
                send_operation("A", "CANCEL")
                collect(0.4)
            except Exception:
                pass
        for connection in connections.values():
            connection.close()


if __name__ == "__main__":
    main()
