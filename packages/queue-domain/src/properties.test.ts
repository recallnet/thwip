import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { applyEvent, emptyState, QueueRuleViolation, type BranchQueueState } from "./reducer.js";
import { applyEvents } from "./test/apply-events.js";
import { checkInvariants } from "./invariants.js";
import { selectNext, type EligibleEntry } from "./scheduler.js";
import type { QueueEvent } from "./events.js";

/**
 * These are the statements the product is
 * selling — fairness, one lane, a place in line that survives failure — so they
 * are checked against generated histories rather than hand-picked ones.
 */

const principals = ["alice", "bob", "carol", "dave"];

/**
 * A simulated queue: entries arrive, turns are offered by the real scheduler,
 * and each turn ends in a merge, a failure, or an unclaimed expiry.
 */
type Step =
  | { readonly kind: "request"; readonly principal: string }
  | { readonly kind: "offer" }
  | { readonly kind: "merge" }
  | { readonly kind: "fail" }
  | { readonly kind: "expire" }
  | { readonly kind: "duplicate" }
  /** Deliberately contend for an occupied lane; the queue must refuse. */
  | { readonly kind: "jumpLane" };

const stepArb: fc.Arbitrary<Step> = fc.oneof(
  { arbitrary: fc.record({ kind: fc.constant("request" as const), principal: fc.constantFrom(...principals) }), weight: 4 },
  { arbitrary: fc.constant({ kind: "offer" as const }), weight: 4 },
  { arbitrary: fc.constant({ kind: "merge" as const }), weight: 3 },
  { arbitrary: fc.constant({ kind: "fail" as const }), weight: 2 },
  { arbitrary: fc.constant({ kind: "expire" as const }), weight: 2 },
  { arbitrary: fc.constant({ kind: "duplicate" as const }), weight: 2 },
  { arbitrary: fc.constant({ kind: "jumpLane" as const }), weight: 3 },
);

interface Run {
  state: BranchQueueState;
  readonly log: QueueEvent[];
  /** Principal served on each offer, in order. */
  readonly served: string[];
  seq: number;
  ids: number;
  transitions: number;
  lastDigest: string | null;
}

function eligible(state: BranchQueueState): EligibleEntry[] {
  return [...state.entries.values()]
    .filter((e) => e.state === "Ready" && e.schedulerEligible)
    .map((e) => ({
      entryId: e.entryId,
      sponsorPrincipalId: e.sponsorPrincipalId,
      sponsorGithubUserId: BigInt(e.sponsorGithubUserId),
      fairnessOrdinal: e.fairnessOrdinal,
      pullRequestNumber: e.pullRequestNumber,
      cooldownUntil: e.cooldownUntil,
    }));
}

function at(seq: number): string {
  return new Date(Date.UTC(2026, 6, 29, 12, 0, 0) + seq * 1000).toISOString();
}

function push(run: Run, body: Omit<QueueEvent, "sequence" | "idempotencyKey" | "at">): void {
  run.seq += 1;
  const event = { sequence: run.seq, idempotencyKey: `k${run.seq}`, at: at(run.seq), ...body } as QueueEvent;
  run.log.push(event);
  run.state = applyEvent(run.state, event);
}

/** Drive one step; steps that do not apply are skipped rather than forced. */
function step(run: Run, s: Step): void {
  const active = run.state.activeAttemptId;
  const attempt = active === null ? null : run.state.attempts.get(active)!;

  switch (s.kind) {
    case "request": {
      run.ids += 1;
      const entryId = `e${run.ids}`;
      push(run, {
        type: "QueueRequested",
        entryId,
        pullRequestNumber: run.ids,
        sponsorPrincipalId: s.principal,
        sponsorGithubUserId: String(principals.indexOf(s.principal) + 1),
        headSha: "h".repeat(40),
      });
      push(run, {
        type: "ReadinessEvaluated",
        entryId,
        ready: true,
        schedulerEligible: true,
        primaryReason: null,
        secondaryReasons: [],
      });
      return;
    }

    case "offer": {
      if (active !== null || run.state.paused) return;
      const chosen = selectNext(eligible(run.state), run.state.lastServedTurn, at(run.seq + 1));
      if (chosen === null) return;
      run.ids += 1;
      run.served.push(chosen.sponsorPrincipalId);
      push(run, {
        type: "TurnOffered",
        entryId: chosen.entryId,
        attemptId: `t${run.ids}`,
        offerDeadline: at(run.seq + 90),
        decisionDigest: `sha256:d${run.ids}`,
      });
      return;
    }

    case "expire": {
      if (attempt === null || attempt.phase !== "OFFERED") return;
      push(run, {
        type: "OfferExpired",
        attemptId: attempt.attemptId,
        cooldownUntil: at(run.seq + 300),
      });
      return;
    }

    case "merge": {
      if (attempt === null || attempt.phase !== "OFFERED") return;
      const id = attempt.attemptId;
      const tree = `tree-${id}`;
      push(run, { type: "OfferClaimed", attemptId: id, executionMode: "device", deviceId: "d1" });
      push(run, {
        type: "CandidatePrepared",
        attemptId: id,
        baseSha: "b".repeat(40),
        headSha: "h".repeat(40),
        candidateSha: `c-${id}`,
        candidateTree: tree,
        policyDigest: "sha256:pol",
        runner: "dagger",
      });
      push(run, {
        type: "AssignmentIssued",
        attemptId: id,
        assignmentDigest: `sha256:a-${id}`,
        executionDeadline: at(run.seq + 1200),
      });
      push(run, { type: "HeartbeatReceived", attemptId: id });
      push(run, { type: "ReceiptSubmitted", attemptId: id, receiptDigest: `sha256:r-${id}` });
      push(run, { type: "VerificationStarted", attemptId: id, nonce: `n-${id}` });
      push(run, {
        type: "VerificationCompleted",
        attemptId: id,
        nonce: `n-${id}`,
        accepted: true,
        resultDigest: `sha256:v-${id}`,
      });
      push(run, { type: "MergeIntentCreated", attemptId: id, intentDigest: `sha256:i-${id}` });
      push(run, { type: "MergeRequested", attemptId: id });
      push(run, {
        type: "MergeConfirmed",
        attemptId: id,
        mergeSha: `m-${id}`,
        mergeTree: tree,
        parentShas: ["b".repeat(40), "h".repeat(40)],
      });
      run.transitions += 1;
      // Digest width, because the reducer refuses anything narrower: a chain
      // link names a record, and a value no record hashes to is not one.
      const digest = `sha256:${String(run.transitions).padStart(64, "f")}`;
      push(run, {
        type: "TransitionRecorded",
        kind: "verified",
        transitionSequence: run.transitions,
        priorDigest: run.lastDigest,
        digest,
        baseSha: `m-${id}`,
        attemptId: id,
        witnessPrincipalIds: [run.state.entries.get(attempt.entryId)!.sponsorPrincipalId],
      });
      run.lastDigest = digest;
      return;
    }

    case "fail": {
      if (attempt === null) return;
      push(run, { type: "AttemptTerminated", attemptId: attempt.attemptId, outcome: "CI_FAILED" });
      // A failed entry becomes Blocked; make it Ready again so the principal can
      // participate in a later round, as §8.3 describes.
      push(run, {
        type: "ReadinessEvaluated",
        entryId: attempt.entryId,
        ready: true,
        schedulerEligible: true,
        primaryReason: null,
        secondaryReasons: [],
      });
      return;
    }

    case "duplicate": {
      const last = run.log.at(-1);
      if (last === undefined) return;
      run.state = applyEvent(run.state, last);
      return;
    }

    case "jumpLane": {
      // A second device, a duplicated alarm, or a racing Worker tries to take
      // the lane while an attempt is live. The queue must reject it, and the
      // rejection must leave no trace in state.
      if (active === null) return;
      const other = [...run.state.entries.values()].find(
        (e) => e.currentAttemptId === null && e.state !== "Merged" && e.state !== "Cancelled",
      );
      if (other === undefined) return;
      const before = run.state;
      run.ids += 1;
      const intruder = {
        sequence: run.seq + 1,
        idempotencyKey: `jump${run.ids}`,
        at: at(run.seq + 1),
        type: "TurnOffered" as const,
        entryId: other.entryId,
        attemptId: `x${run.ids}`,
        offerDeadline: at(run.seq + 90),
        decisionDigest: `sha256:x${run.ids}`,
      };
      let rejected = false;
      try {
        applyEvent(run.state, intruder);
      } catch (error) {
        rejected = error instanceof QueueRuleViolation;
      }
      if (!rejected) throw new Error("the queue admitted a second attempt into an occupied lane");
      if (run.state !== before) throw new Error("a rejected command mutated state");
      return;
    }
  }
}

function simulate(steps: readonly Step[]): Run {
  const run: Run = {
    state: emptyState("qk", "1315419165", "refs/heads/main"),
    log: [],
    served: [],
    seq: 0,
    ids: 0,
    transitions: 0,
    lastDigest: null,
  };
  for (const s of steps) step(run, s);
  return run;
}

const steps = fc.array(stepArb, { minLength: 1, maxLength: 60 });

describe("branch queue properties", () => {
  it("never violates an invariant, whatever the history", () => {
    fc.assert(
      fc.property(steps, (script) => {
        expect(checkInvariants(simulate(script).state)).toEqual([]);
      }),
      { numRuns: 300 },
    );
  });

  it("holds at most one nonterminal attempt at every point in the history", () => {
    fc.assert(
      fc.property(steps, (script) => {
        const run = simulate(script);
        let state = emptyState("qk", "1315419165", "refs/heads/main");
        for (const event of run.log) {
          state = applyEvent(state, event);
          const live = [...state.attempts.values()].filter(
            (a) => a.outcome === null && a.phase !== "MERGED",
          );
          expect(live.length).toBeLessThanOrEqual(1);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("is deterministic: the same log always yields the same state", () => {
    fc.assert(
      fc.property(steps, (script) => {
        const log = simulate(script).log;
        const a = applyEvents(emptyState("qk", "r", "refs/heads/main"), log);
        const b = applyEvents(emptyState("qk", "r", "refs/heads/main"), log);
        expect(dump(b)).toEqual(dump(a));
      }),
      { numRuns: 200 },
    );
  });

  it("is idempotent under duplication of every event", () => {
    fc.assert(
      fc.property(steps, (script) => {
        const log = simulate(script).log;
        const once = applyEvents(emptyState("qk", "r", "refs/heads/main"), log);
        const doubled = log.flatMap((e) => [e, e]);
        const twice = applyEvents(emptyState("qk", "r", "refs/heads/main"), doubled);
        expect(dump(twice)).toEqual(dump(once));
      }),
      { numRuns: 200 },
    );
  });

  it("ignores events replayed out of order", () => {
    fc.assert(
      fc.property(steps, (script) => {
        const log = simulate(script).log;
        if (log.length < 2) return;
        const state = applyEvents(emptyState("qk", "r", "refs/heads/main"), log);
        for (const event of log) {
          const stale = { ...event, idempotencyKey: `stale-${event.sequence}` };
          expect(dump(applyEvent(state, stale))).toEqual(dump(state));
        }
      }),
      { numRuns: 100 },
    );
  });

  it("never lets one principal be served twice while another waits (§8.3)", () => {
    fc.assert(
      fc.property(steps, (script) => {
        const run = simulate(script);
        let state = emptyState("qk", "1315419165", "refs/heads/main");

        /** Per offer: who was served, and who else was eligible at that moment. */
        const offers: Array<{ served: string; eligible: ReadonlySet<string> }> = [];

        for (const event of run.log) {
          if (event.type === "TurnOffered") {
            const entry = state.entries.get(event.entryId)!;
            offers.push({
              served: entry.sponsorPrincipalId,
              eligible: new Set(eligible(state).map((e) => e.sponsorPrincipalId)),
            });
          }
          state = applyEvent(state, event);
        }

        // The bound: between two turns for the same principal, every rival that
        // was eligible at both ends must have been offered a turn in between.
        // A rival who has never been served at all is the worst case, so it is
        // checked rather than skipped.
        for (let i = 0; i < offers.length; i += 1) {
          const here = offers[i]!;
          const previousIndex = offers.findLastIndex((o, j) => j < i && o.served === here.served);
          if (previousIndex === -1) continue;
          const servedBetween = new Set(offers.slice(previousIndex + 1, i).map((o) => o.served));
          for (const rival of here.eligible) {
            if (rival === here.served) continue;
            if (!offers[previousIndex]!.eligible.has(rival)) continue;
            if (servedBetween.has(rival)) continue;
            throw new Error(
              `${here.served} took turns ${previousIndex} and ${i} while ${rival} was eligible throughout and never served`,
            );
          }
        }
      }),
      { numRuns: 300 },
    );
  });

  it("gives a principal no extra share for extra pull requests", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 8 }), fc.integer({ min: 1, max: 8 }), (aliceCount, bobCount) => {
        const script: Step[] = [
          ...Array.from({ length: aliceCount }, () => ({ kind: "request" as const, principal: "alice" })),
          ...Array.from({ length: bobCount }, () => ({ kind: "request" as const, principal: "bob" })),
        ];
        const rounds = Math.min(aliceCount, bobCount) * 2;
        for (let i = 0; i < rounds; i += 1) script.push({ kind: "offer" }, { kind: "merge" });
        const served = simulate(script).served;
        const alice = served.filter((p) => p === "alice").length;
        const bob = served.filter((p) => p === "bob").length;
        expect(Math.abs(alice - bob)).toBeLessThanOrEqual(1);
      }),
      { numRuns: 100 },
    );
  });

  it("never changes a fairness ordinal on deferral or failure", () => {
    fc.assert(
      fc.property(steps, (script) => {
        let state = emptyState("qk", "1315419165", "refs/heads/main");
        const ordinals = new Map<string, bigint>();
        for (const event of simulate(script).log) {
          state = applyEvent(state, event);
          for (const entry of state.entries.values()) {
            const known = ordinals.get(entry.entryId);
            if (known === undefined) {
              ordinals.set(entry.entryId, entry.fairnessOrdinal);
              continue;
            }
            // Nothing in the generated script resets an ordinal, so any change
            // here would be the queue losing someone's place in line.
            expect(entry.fairnessOrdinal).toBe(known);
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  it("never mutates an attempt once it is terminal", () => {
    fc.assert(
      fc.property(steps, (script) => {
        let state = emptyState("qk", "1315419165", "refs/heads/main");
        const frozen = new Map<string, string>();
        for (const event of simulate(script).log) {
          state = applyEvent(state, event);
          for (const attempt of state.attempts.values()) {
            const terminal = attempt.outcome !== null || attempt.phase === "MERGED";
            if (!terminal) continue;
            const shot = JSON.stringify(attempt);
            const known = frozen.get(attempt.attemptId);
            if (known === undefined) frozen.set(attempt.attemptId, shot);
            else expect(shot).toEqual(known);
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  it("keeps the transition chain contiguous and linked", () => {
    fc.assert(
      fc.property(steps, (script) => {
        const { transitions } = simulate(script).state;
        transitions.forEach((transition, i) => {
          expect(transition.transitionSequence).toBe(i + 1);
          expect(transition.priorDigest).toBe(i === 0 ? null : transitions[i - 1]!.digest);
        });
      }),
      { numRuns: 200 },
    );
  });

  it("rejects rather than silently accepting an unknown event", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (type) => {
        fc.pre(!["QueueRequested", "QueuePaused", "QueueResumed"].includes(type));
        const event = { sequence: 1, idempotencyKey: "k", at: at(1), type } as unknown as QueueEvent;
        expect(() => applyEvent(emptyState("qk", "r", "refs/heads/main"), event)).toThrow(QueueRuleViolation);
      }),
      { numRuns: 100 },
    );
  });
});

function dump(state: BranchQueueState): string {
  return JSON.stringify(state, (_k, v) => {
    if (typeof v === "bigint") return `${v}n`;
    if (v instanceof Map) return [...v.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    if (v instanceof Set) return [...v].sort();
    return v;
  });
}
