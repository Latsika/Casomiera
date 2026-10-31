"""Compare the same GPIO6 edge on two owner-connected GNSS stations.

Required wiring: GND to GND and GPIO6 to GPIO6; both USB supplies connected.
TEST_PULSE uses open drain, and is allowed only when no attempt is active.
This establishes observed relative agreement, not absolute UTC traceability.
"""

import argparse
import json
from pathlib import Path
import re
import time
from datetime import datetime, timezone

import serial


def open_station(port):
    connection = serial.Serial(port=None, baudrate=115200, timeout=0, write_timeout=2)
    connection.dtr = False
    connection.rts = False
    connection.port = port
    connection.open()
    return connection


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--a", default="COM3")
    parser.add_argument("--b", default="COM5")
    parser.add_argument("--count", type=int, default=24)
    parser.add_argument("--output", default="test-results/shared-input.json")
    arguments = parser.parse_args()
    if not 1 <= arguments.count <= 32:
        raise SystemExit("Count must be between 1 and the 32 retained event slots.")
    connections = {}
    buffers = {"A": "", "B": ""}
    samples = []

    def read_lines(duration, predicate=None):
        collected = {"A": [], "B": []}
        deadline = time.monotonic() + duration
        while time.monotonic() < deadline:
            for station, connection in connections.items():
                buffers[station] += connection.read(connection.in_waiting).decode("ascii", errors="replace")
                while "\n" in buffers[station]:
                    line, buffers[station] = buffers[station].split("\n", 1)
                    collected[station].append(line.strip())
            if predicate and predicate(collected):
                break
            time.sleep(0.002)
        return collected

    def send(station, command):
        connections[station].write((command + "\n").encode("ascii"))
        connections[station].flush()

    try:
        connections["A"] = open_station(arguments.a)
        connections["B"] = open_station(arguments.b)
        time.sleep(0.5)
        for connection in connections.values():
            connection.reset_input_buffer()
        for station in connections:
            send(station, "CLOCK_TEST")
        tests = read_lines(2)
        for station in connections:
            if "CLOCK_TEST PASS" not in tests[station]:
                raise RuntimeError(f"{station} self-test did not pass: {tests[station]}")
        ready = False
        for attempt in range(90):
            for station in connections:
                send(station, "STATUS")
            statuses = read_lines(0.4)
            ready = all(any(line.startswith("CLOCK STATE=TRACKING ") for line in statuses[station])
                        for station in connections)
            if ready:
                break
            if attempt % 5 == 0:
                print("Waiting for both GNSS clocks to track...", flush=True)
            time.sleep(0.6)
        if not ready:
            raise RuntimeError(f"Both clocks must track before testing. Last status: {statuses}")
        for station in connections:
            send(station, "AUTO_STATUS")
        identities = read_lines(0.4)
        station_builds = {}
        for station in connections:
            status = next((json.loads(line[5:]) for line in identities[station]
                           if line.startswith("AUTO ")), None)
            if not status or status.get("station") != station or not status.get("boardId") or not status.get("firmwareHash"):
                raise RuntimeError("Board/build identity is required for the verification report.")
            station_builds[station] = {"boardId": status["boardId"], "firmwareHash": status["firmwareHash"]}
        for station in connections:
            send(station, "EVENT_CLEAR")
        read_lines(0.3)
        spacing = [0.23, 0.37, 0.59, 0.83, 1.07]
        for index in range(arguments.count):
            sent_at = time.monotonic()
            send("A", "TEST_PULSE")
            received = read_lines(1.5, lambda rows: all(any(line.startswith("EVENT STATION=")
                for line in rows[station]) for station in connections))
            events = {}
            for station in connections:
                lines = [line for line in received[station] if line.startswith("EVENT STATION=")]
                if len(lines) != 1:
                    raise RuntimeError(f"Expected one shared event on {station}: {received}")
                event = dict(re.findall(r"(\w+)=([^ ]+)", lines[0]))
                if event.get("VALID") != "1":
                    raise RuntimeError(f"Clock-invalid event: {event}")
                events[station] = event
            difference = int(events["A"]["UTC_US"]) - int(events["B"]["UTC_US"])
            samples.append({"number": index + 1, "a": events["A"], "b": events["B"],
                            "differenceUs": difference})
            print(f"Shared edge {index + 1}/{arguments.count}: A-B={difference} us", flush=True)
            remaining = spacing[index % len(spacing)] - (time.monotonic() - sent_at)
            if remaining > 0:
                time.sleep(remaining)
        differences = [sample["differenceUs"] for sample in samples]
        passed = all(abs(difference) <= 1000 for difference in differences)
        report = {
            "createdAt": datetime.now(timezone.utc).isoformat(),
            "test": "shared GPIO6 open-drain edge, GNSS preceding-PPS candidate association",
            "criterionUs": 1000, "passed": passed,
            "maximumAbsoluteDifferenceUs": max(abs(value) for value in differences),
            "minimumDifferenceUs": min(differences), "maximumDifferenceUs": max(differences),
            "stations": station_builds,
            "limitations": "Observed relative agreement only; not an absolute UTC or complete optical-gate accuracy certification.",
            "samples": samples,
        }
        output = Path(arguments.output)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        print(json.dumps({key: value for key, value in report.items() if key != "samples"}), flush=True)
        if not passed:
            raise RuntimeError("Observed agreement exceeded 1000 us; do not claim 1 ms accuracy.")
    finally:
        for connection in connections.values():
            connection.close()


if __name__ == "__main__":
    main()
