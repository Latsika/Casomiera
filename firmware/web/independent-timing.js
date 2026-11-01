(function (root) {
  "use strict";
  const stations = ["A", "B"];
  const phases = ["preparing", "armed", "running", "finished", "recovery", "cancelled", "saved"];
  const clone = value => JSON.parse(JSON.stringify(value));
  const validId = value => /^[A-Za-z0-9_-]{1,40}$/.test(value || "");
  const validTime = value => /^\d{1,17}$/.test(String(value)) && BigInt(value) >= 0n;
  const isBusy = attempt => !!attempt && !["saved", "cancelled"].includes(attempt.phase);

  function validateAttempt(attempt, station) {
    if (attempt === null) return;
    if (!attempt || attempt.station !== station || !validId(attempt.id) ||
        !attempt.participant?.key || !attempt.competitionId ||
        !Number.isInteger(attempt.attemptNo) || attempt.attemptNo < 1 ||
        !phases.includes(attempt.phase) || !Array.isArray(attempt.errors) ||
        (attempt.startUs != null && !validTime(attempt.startUs)) ||
        (attempt.stopUs != null && !validTime(attempt.stopUs))) {
      throw new Error("Invalid retained independent attempt.");
    }
    if (attempt.startUs != null && BigInt(attempt.startUs) <= 0n) throw new Error("Invalid retained START.");
    if (attempt.stopUs != null) {
      if (!attempt.startUs || BigInt(attempt.stopUs) <= BigInt(attempt.startUs) ||
          BigInt(attempt.stopUs) - BigInt(attempt.startUs) > 86400000000n) throw new Error("Invalid retained STOP.");
      const elapsed = BigInt(attempt.stopUs) - BigInt(attempt.startUs);
      if (attempt.elapsedUs !== elapsed.toString() || attempt.elapsedMs !== Number((elapsed + 500n) / 1000n)) {
        throw new Error("Retained duration does not match captured timestamps.");
      }
    } else if (["finished", "saved"].includes(attempt.phase)) {
      throw new Error("Completed independent attempt has no STOP.");
    }
  }

  class IndependentRuns {
    constructor(snapshot = null) {
      this.current = { A: null, B: null };
      this.history = [];
      this.actions = [];
      if (!snapshot) return;
      if (!snapshot.current || !Array.isArray(snapshot.history) || !Array.isArray(snapshot.actions)) {
        throw new Error("Invalid independent timing backup.");
      }
      for (const station of stations) {
        validateAttempt(snapshot.current[station], station);
        this.current[station] = clone(snapshot.current[station]);
      }
      for (const attempt of snapshot.history) {
        validateAttempt(attempt, attempt?.station);
        if (!stations.includes(attempt.station)) throw new Error("Invalid history station.");
      }
      for (const action of snapshot.actions) {
        if (!stations.includes(action.station) || !validId(action.id) ||
            !["CANCEL", "COMPLETE"].includes(action.operation) || !["finish", "archive"].includes(action.stage)) {
          throw new Error("Invalid retained device operation.");
        }
      }
      this.history = clone(snapshot.history);
      this.actions = clone(snapshot.actions);
    }

    get busy() { return stations.some(station => isBusy(this.current[station])); }
    busyAt(station) { return isBusy(this.current[station]); }
    snapshot() { return clone({ current: this.current, history: this.history, actions: this.actions }); }

    retain(attempt) {
      const index = this.history.findIndex(item => item.station === attempt.station && item.id === attempt.id);
      if (index < 0) this.history.push(clone(attempt)); else this.history[index] = clone(attempt);
    }

    prepare(station, participant, attemptNo, competitionId, id, context = {}) {
      if (!stations.includes(station) || !participant?.key || !competitionId || !validId(id) ||
          !Number.isInteger(attemptNo) || attemptNo < 1 || this.busyAt(station)) throw new Error("Invalid or busy independent attempt.");
      if (this.history.some(item => item.id === id) || stations.some(key => this.current[key]?.id === id)) throw new Error("Attempt ID already used.");
      for (const other of stations) {
        const active = this.current[other];
        if (isBusy(active) && active.participant.key === participant.key &&
            active.participant.mode === participant.mode && active.participant.category === participant.category) {
          throw new Error("This participant already has an active attempt on the other station.");
        }
      }
      if (this.current[station]) this.retain(this.current[station]);
      const attempt = {
        station, id, participant: clone(participant), attemptNo, competitionId,
        phase: "preparing", startUs: null, stopUs: null, elapsedUs: null, elapsedMs: null,
        boot: context.boot || null, firmwareHash: context.firmwareHash || null,
        boardId: context.boardId || null, inputLowUs: context.inputLowUs,
        inputReleaseUs: context.inputReleaseUs, errors: [], createdAt: new Date().toISOString()
      };
      this.current[station] = attempt;
      return attempt;
    }

    action(attempt, operation) {
      if (!this.actions.some(item => item.station === attempt.station && item.id === attempt.id)) {
        this.actions.push({ station: attempt.station, id: attempt.id, operation, stage: "finish" });
      }
    }

    cancel(station) {
      const attempt = this.current[station];
      if (!isBusy(attempt)) return;
      attempt.phase = "cancelled";
      this.action(attempt, "CANCEL");
      this.retain(attempt);
    }

    markSaved(station, resultId) {
      const attempt = this.current[station];
      if (attempt?.phase !== "finished") throw new Error("No finished independent result.");
      attempt.phase = "saved";
      attempt.resultId = resultId;
      this.action(attempt, "COMPLETE");
      this.retain(attempt);
    }

    accept(message) {
      if (message?.kind !== "independent" || !stations.includes(message.station) || !validId(message.id)) return false;
      const station = message.station;
      const attempt = this.current[station]?.id === message.id ? this.current[station] :
        this.history.find(item => item.station === station && item.id === message.id);
      const action = this.actions.find(item => item.station === station && item.id === message.id);
      if (message.type === "independent_ack") {
        if (message.operation === "ARCHIVE" && action?.stage === "archive") {
          this.actions = this.actions.filter(item => item !== action);
          return true;
        }
        return false;
      }
      if (!attempt) return false;
      const closed = ["saved", "cancelled"].includes(attempt.phase);
      const fail = (reason, fatal = true) => {
        attempt.errors.push({ reason, at: new Date().toISOString() });
        attempt.errors = attempt.errors.slice(-32);
        if (!closed && fatal) attempt.phase = "recovery";
        else this.retain(attempt);
        return true;
      };
      if (message.type === "independent_error") {
        const reason = String(message.reason || "DEVICE_ERROR");
        return fail(reason, reason === "INPUT_OVERFLOW");
      }
      if (message.type !== "independent" || !/^[0-9a-f]{8}$/i.test(message.boot || "")) return false;
      if (!["armed", "running", "finished", "cancelled", "complete"].includes(message.phase)) return false;
      if (!validTime(message.startUs) || !validTime(message.stopUs)) return fail("INVALID_TIMESTAMPS");
      const start = BigInt(message.startUs), stop = BigInt(message.stopUs);
      if ((stop > 0n && (start <= 0n || stop <= start || stop - start > 86400000000n)) ||
          (["finished", "complete"].includes(message.phase) && stop <= 0n) ||
          (message.phase === "running" && start <= 0n)) return fail("INVALID_EVENT_ORDER");
      if (attempt.boot && attempt.boot !== message.boot && (start > 0n || !closed)) return fail("DEVICE_RESTARTED");
      if (!attempt.boot) attempt.boot = message.boot;
      if (start > 0n) {
        if (attempt.startUs && attempt.startUs !== start.toString()) return fail("CONFLICTING_START");
        attempt.startUs = start.toString();
      }
      if (stop > 0n) {
        if (attempt.stopUs && attempt.stopUs !== stop.toString()) return fail("CONFLICTING_STOP");
        if (!validTime(message.elapsedUs) || BigInt(message.elapsedUs) !== stop - start) return fail("INVALID_DURATION");
        attempt.stopUs = stop.toString();
        attempt.elapsedUs = (stop - start).toString();
        attempt.elapsedMs = Number((stop - start + 500n) / 1000n);
      }
      if (message.inputFault) return fail("INPUT_OVERFLOW");
      if (action && ((action.operation === "CANCEL" && message.phase === "cancelled") ||
          (action.operation === "COMPLETE" && message.phase === "complete"))) action.stage = "archive";
      if (!closed && attempt.phase !== "recovery") {
        attempt.phase = attempt.stopUs ? "finished" : attempt.startUs ? "running" : "armed";
        if (message.phase === "cancelled") attempt.phase = "cancelled";
      }
      if (closed || ["cancelled", "saved"].includes(attempt.phase)) this.retain(attempt);
      return true;
    }
  }

  const api = { IndependentRuns };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CasomieraIndependent = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
