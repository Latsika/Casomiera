(function (root) {
  "use strict";

  function parseMessage(line) {
    if (!line.startsWith("AUTO ") || line.length > 1024) return null;
    try {
      const value = JSON.parse(line.slice(5));
      if (!value || !["A", "B"].includes(value.station) ||
          typeof value.type !== "string" || !/^[0-9a-f]{8}$/i.test(value.boot)) return null;
      return value;
    } catch { return null; }
  }

  function newAttemptId() {
    if (!root.crypto?.randomUUID) throw new Error("Secure attempt IDs are unavailable.");
    return root.crypto.randomUUID();
  }

  class AutomaticRun {
    constructor(snapshot = null) {
      if (snapshot && (!/^[A-Za-z0-9_-]{1,40}$/.test(snapshot.id || "") ||
          !snapshot.participant?.key || !snapshot.competitionId ||
          !["preparing", "armed", "running", "finished", "recovery", "cancelling", "cancelled", "saved"].includes(snapshot.phase) ||
          !snapshot.ready || !snapshot.events || !Array.isArray(snapshot.errors) || !snapshot.cancelled)) {
        throw new Error("Invalid retained automatic attempt; keep the original backup for recovery.");
      }
      this.current = snapshot ? JSON.parse(JSON.stringify(snapshot)) : null;
    }

    get busy() {
      return !!this.current && !["saved", "cancelled"].includes(this.current.phase);
    }

    prepare(participant, attemptNo, competitionId, id = newAttemptId()) {
      if (this.busy) throw new Error("An automatic attempt is already pending.");
      if (!participant?.key || !Number.isInteger(attemptNo) || attemptNo < 1 ||
          !competitionId || !/^[A-Za-z0-9_-]{1,40}$/.test(id)) {
        throw new Error("Invalid automatic attempt context.");
      }
      this.current = {
        id, competitionId, participant: JSON.parse(JSON.stringify(participant)), attemptNo,
        phase: "preparing", ready: {}, events: {}, errors: [], cancelled: {},
        createdAt: new Date().toISOString(), accuracy: "unverified"
      };
      return this.current;
    }

    accept(message) {
      const attempt = this.current;
      if (!attempt || !message || message.id !== attempt.id ||
          !["A", "B"].includes(message.station)) return false;
      if (["saved", "cancelled"].includes(attempt.phase)) return false;
      const station = message.station;
      attempt.errors = attempt.errors.slice(-15);
      if (message.type === "error") {
        attempt.errors.push({ station, reason: String(message.reason || "DEVICE_ERROR") });
        attempt.errors = attempt.errors.slice(-16);
        return true;  // A timeout or error must not discard a measured event.
      }
      if (message.type === "cancelled") {
        attempt.cancelled[station] = true;
        return true;
      }
      if (attempt.phase === "cancelling") return false;
      if (message.type === "armed") {
        const previous = attempt.ready[station];
        if (previous && previous.boot !== message.boot) {
          attempt.errors.push({ station, reason: "DEVICE_RESTARTED" });
          attempt.fatal = true;
          attempt.phase = "recovery";
          return true;
        }
        attempt.ready[station] = { boot: message.boot, generation: message.generation };
        if (attempt.ready.A && attempt.ready.B && attempt.phase === "preparing") {
          attempt.phase = "armed";
        }
        return true;
      }
      if (message.type !== "event" && message.type !== "complete") return false;
      if (message.valid !== true || !/^\d{1,17}$/.test(String(message.utcUs)) ||
          !Number.isSafeInteger(message.generation)) {
        attempt.errors.push({ station, reason: "INVALID_EVENT_CLOCK" });
        (attempt.rejectedEvents ||= {})[station] = JSON.parse(JSON.stringify(message));
        attempt.fatal = true;
        attempt.phase = "recovery";
        return true;
      }
      const ready = attempt.ready[station];
      if (ready && (ready.boot !== message.boot || ready.generation !== message.generation)) {
        attempt.errors.push({ station, reason: "CLOCK_OR_BOOT_CHANGED" });
        attempt.fatal = true;
        attempt.phase = "recovery";
        return true;
      }
      const existing = attempt.events[station];
      if (existing) {
        if (existing.utcUs !== String(message.utcUs) || existing.boot !== message.boot) {
          attempt.errors.push({ station, reason: "CONFLICTING_EVENT" });
          attempt.fatal = true;
          attempt.phase = "recovery";
        }
        return true;
      }
      attempt.events[station] = {
        boot: message.boot, utcUs: String(message.utcUs),
        localUs: String(message.localUs), generation: message.generation
      };
      if (attempt.events.A && attempt.events.B) {
        const elapsed = BigInt(attempt.events.B.utcUs) - BigInt(attempt.events.A.utcUs);
        // A bounded duration also rejects wrong-date and gross clock offsets.
        if (attempt.fatal || elapsed < 0n || elapsed > 86400000000n) {
          attempt.errors.push({ station, reason: "INVALID_EVENT_ORDER_OR_DURATION" });
          attempt.phase = "recovery";
        } else {
          attempt.elapsedUs = elapsed.toString();
          attempt.elapsedMs = Number((elapsed + 500n) / 1000n);
          attempt.phase = "finished";
        }
      } else if (attempt.events.A) {
        attempt.phase = "running";
      }
      return true;
    }

    cancel() {
      if (this.current && this.busy) this.current.phase = "cancelling";
    }

    confirmCancellation() {
      if (this.current?.phase === "cancelling") this.current.phase = "cancelled";
    }

    markSaved() {
      if (this.current?.phase !== "finished") throw new Error("No completed automatic result.");
      this.current.phase = "saved";
    }
  }

  const api = { AutomaticRun, parseMessage };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CasomieraAutomatic = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
