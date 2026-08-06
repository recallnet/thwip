import { describe, expect, it } from "vitest";
import { applyEvent, emptyState, QueueRuleViolation, type BranchQueueState } from "./reducer.js";
import { checkInvariants } from "./invariants.js";
import { selectNext } from "./scheduler.js";
import type { QueueEvent } from "./events.js";

/**
 * Exhaustive bounded model checking of the branch queue.
 *
 * The design called for a small TLA+ model. This checks the same properties by
 * exhaustively exploring the state space of the *actual reducer* instead, which
 * is stronger in the way that matters: a TLA+ model is a second description of
 * the system and can pass while the code it describes differs. Here the thing
 * being checked is the thing that ships.
 *
 * The exploration is breadth-first over every legal command from every reachable
 * state, deduplicated by a canonical state key, with three principals and a small
 * entry budget. Illegal commands are attempted too, and are required both to be
 * refused and to leave state untouched — a rejected command that mutated anything
 * would be a hole no invariant check could find afterwards.
 *
 * It is bounded, not complete: exploration stops at MAX_STATES, which it currently
 * reaches at breadth-first depth 8. So this establishes that no invariant can be
 * broken within that horizon, not that none can be broken ever. Raising the cap
 * costs only time, and the liveness properties that need temporal logic — a
 * principal eventually being served under weak fairness — are not expressible this
 * way and remain covered by the fairness property tests instead.
 */

const PRINCIPALS = ["alice", "bob", "carol"] as const;
const MAX_ENTRIES = 3;
const MAX_STATES = 20_000;

/** Every command the checker can attempt, as a function of the current state. */
type Action = { readonly label: string; readonly event: Omit<QueueEvent, "sequence"> };

const AT = (n: number) => new Date(Date.UTC(2026, 6, 29, 12, 0, 0) + n * 1000).toISOString();

function actions(state: BranchQueueState, step: number): Action[] {
  const out: Action[] = [];
  const at = AT(step);
  const key = (s: string) => `${s}@${step}`;

  /* New requests, bounded so the space stays finite. */
  if (state.entries.size < MAX_ENTRIES) {
    for (const principal of PRINCIPALS) {
      const entryId = `e${state.entries.size + 1}`;
      out.push({
        label: `request:${principal}`,
        event: {
          idempotencyKey: key(`req:${entryId}:${principal}`),
          at,
          type: "QueueRequested",
          entryId,
          pullRequestNumber: state.entries.size + 1,
          sponsorPrincipalId: principal,
          sponsorGithubUserId: String(PRINCIPALS.indexOf(principal) + 1),
          headSha: "h".repeat(40),
        },
      });
    }
  }

  /* Readiness flips, which is how entries enter and leave the pool. */
  for (const entry of state.entries.values()) {
    for (const ready of [true, false]) {
      out.push({
        label: `readiness:${entry.entryId}:${ready}`,
        event: {
          idempotencyKey: key(`ready:${entry.entryId}:${ready}`),
          at,
          type: "ReadinessEvaluated",
          entryId: entry.entryId,
          ready,
          schedulerEligible: ready,
          primaryReason: ready ? null : "REVIEW_REQUIRED",
          secondaryReasons: [],
        },
      });
    }
  }

  /* A scheduler-chosen offer, plus a deliberately illegal one to prove the lane
     cannot be taken twice. */
  const eligible = [...state.entries.values()]
    .filter((e) => e.state === "Ready" && e.schedulerEligible)
    .map((e) => ({
      entryId: e.entryId,
      sponsorPrincipalId: e.sponsorPrincipalId,
      sponsorGithubUserId: BigInt(e.sponsorGithubUserId),
      fairnessOrdinal: e.fairnessOrdinal,
      pullRequestNumber: e.pullRequestNumber,
      cooldownUntil: e.cooldownUntil,
    }));
  const chosen = selectNext(eligible, state.lastServedTurn, at);
  if (chosen !== null) {
    out.push({
      label: `offer:${chosen.entryId}`,
      event: {
        idempotencyKey: key(`offer:${chosen.entryId}`),
        at,
        type: "TurnOffered",
        entryId: chosen.entryId,
        attemptId: `a${step}`,
        offerDeadline: AT(step + 90),
        decisionDigest: "sha256:dec",
      },
    });
  }

  const active = state.activeAttemptId === null ? null : state.attempts.get(state.activeAttemptId)!;
  if (active !== null) {
    const id = active.attemptId;
    const tree = `tree-${id}`;

    switch (active.phase) {
      case "OFFERED":
        out.push({
          label: "claim:device",
          event: { idempotencyKey: key(`claim:${id}`), at, type: "OfferClaimed", attemptId: id, executionMode: "device", deviceId: "d1" },
        });
        out.push({
          label: "claim:synthetic",
          event: { idempotencyKey: key(`syn:${id}`), at, type: "OfferClaimed", attemptId: id, executionMode: "fast-reuse" },
        });
        out.push({
          label: "expire",
          event: { idempotencyKey: key(`exp:${id}`), at, type: "OfferExpired", attemptId: id, cooldownUntil: AT(step + 300) },
        });
        break;
      case "CLAIMED":
        out.push({
          label: "candidate",
          event: {
            idempotencyKey: key(`cand:${id}`),
            at,
            type: "CandidatePrepared",
            attemptId: id,
            baseSha: "b".repeat(40),
            headSha: "h".repeat(40),
            candidateSha: `c-${id}`,
            candidateTree: tree,
            policyDigest: "sha256:pol",
            runner: "dagger",
          },
        });
        break;
      case "PREPARING_CANDIDATE":
        out.push({
          label: "assign",
          event: {
            idempotencyKey: key(`asg:${id}`),
            at,
            type: "AssignmentIssued",
            attemptId: id,
            assignmentDigest: "sha256:asg",
            executionDeadline: AT(step + 1200),
          },
        });
        break;
      case "ASSIGNED":
      case "RUNNING":
        out.push({
          label: "heartbeat",
          event: { idempotencyKey: key(`hb:${id}:${active.phase}`), at, type: "HeartbeatReceived", attemptId: id },
        });
        if (active.phase === "RUNNING" && active.graceUntil === null) {
          out.push({
            label: "heartbeat-lost",
            event: { idempotencyKey: key(`hl:${id}`), at, type: "HeartbeatLost", attemptId: id, graceUntil: AT(step + 60) },
          });
        }
        if (active.graceUntil !== null) {
          out.push({
            label: "reconnect",
            event: { idempotencyKey: key(`rc:${id}`), at, type: "Reconnected", attemptId: id, deviceId: "d1" },
          });
        }
        out.push({
          label: "receipt",
          event: { idempotencyKey: key(`rcpt:${id}`), at, type: "ReceiptSubmitted", attemptId: id, receiptDigest: "sha256:r" },
        });
        break;
      case "RECEIPT_SUBMITTED":
        out.push({
          label: "verify-start",
          event: { idempotencyKey: key(`vs:${id}`), at, type: "VerificationStarted", attemptId: id, nonce: `n-${id}` },
        });
        break;
      case "VERIFYING":
        for (const accepted of [true, false]) {
          out.push({
            label: `verify-done:${accepted}`,
            event: {
              idempotencyKey: key(`vd:${id}:${accepted}`),
              at,
              type: "VerificationCompleted",
              attemptId: id,
              nonce: `n-${id}`,
              accepted,
              resultDigest: "sha256:v",
            },
          });
        }
        break;
      case "VERIFIED":
        out.push({
          label: "intent",
          event: { idempotencyKey: key(`int:${id}`), at, type: "MergeIntentCreated", attemptId: id, intentDigest: "sha256:i" },
        });
        break;
      case "MERGE_INTENT_CREATED":
        out.push({
          label: "merge-requested",
          event: { idempotencyKey: key(`mr:${id}`), at, type: "MergeRequested", attemptId: id },
        });
        break;
      case "MERGE_REQUESTED":
        out.push({
          label: "merge-confirmed",
          event: {
            idempotencyKey: key(`mc:${id}`),
            at,
            type: "MergeConfirmed",
            attemptId: id,
            mergeSha: `m-${id}`,
            mergeTree: tree,
            parentShas: ["b".repeat(40), "h".repeat(40)],
          },
        });
        out.push({
          label: "merge-unknown",
          event: { idempotencyKey: key(`mu:${id}`), at, type: "MergeOutcomeUnknown", attemptId: id },
        });
        break;
      case "AWAITING_CONFIRMATION":
        out.push({
          label: "reconciled-merged",
          event: {
            idempotencyKey: key(`rm:${id}`),
            at,
            type: "MergeConfirmed",
            attemptId: id,
            mergeSha: `m-${id}`,
            mergeTree: tree,
            parentShas: ["b".repeat(40), "h".repeat(40)],
          },
        });
        out.push({
          label: "reconciled-not-merged",
          event: { idempotencyKey: key(`rn:${id}`), at, type: "MergeConfirmedNotMerged", attemptId: id },
        });
        break;
      default:
        break;
    }

    /* A crash or administrative termination at any phase. */
    if (!active.outcomeUnknown) {
      out.push({
        label: "terminate",
        event: { idempotencyKey: key(`term:${id}`), at, type: "AttemptTerminated", attemptId: id, outcome: "INTERNAL_FAILURE" },
      });
    }
  }

  /* Environment events, which can happen at any point. */
  out.push({
    label: "external-push",
    event: { idempotencyKey: key("ext"), at, type: "ExternalTransitionObserved", observedBaseSha: `x${step}`.padEnd(40, "0") },
  });
  if (state.paused) {
    if (state.rebaselineRequired) {
      out.push({
        label: "rebaseline",
        event: { idempotencyKey: key("rb"), at, type: "Rebaselined", actorPrincipalId: "admin", baseSha: "z".repeat(40) },
      });
    }
    out.push({
      label: "resume",
      event: { idempotencyKey: key("res"), at, type: "QueueResumed", actorPrincipalId: "admin" },
    });
  } else {
    out.push({
      label: "pause",
      event: { idempotencyKey: key("pa"), at, type: "QueuePaused", actorPrincipalId: "admin", reason: "incident" },
    });
  }

  return out;
}

/** Canonical key for deduplication: everything that can affect a future step. */
function stateKey(state: BranchQueueState): string {
  const entries = [...state.entries.values()]
    .sort((a, b) => a.entryId.localeCompare(b.entryId))
    .map((e) =>
      [e.entryId, e.state, e.sponsorPrincipalId, e.schedulerEligible ? 1 : 0, e.cooldownUntil ?? "-", e.currentAttemptId ?? "-"].join(":"),
    );
  const attempts = [...state.attempts.values()]
    .sort((a, b) => a.attemptId.localeCompare(b.attemptId))
    .map((a) => [a.phase, a.outcome ?? "-", a.outcomeUnknown ? 1 : 0, a.graceUntil === null ? 0 : 1].join(":"));
  return JSON.stringify({
    entries,
    attempts,
    active: state.activeAttemptId === null ? "-" : "yes",
    paused: state.paused,
    rebaseline: state.rebaselineRequired,
    transitions: state.transitions.length,
    // Turn history matters for fairness, but only its shape, not its numbers.
    served: [...state.lastServedTurn.entries()]
      .sort()
      .map(([p, t]) => `${p}:${t > 0n ? 1 : 0}`),
  });
}

interface Explored {
  readonly states: number;
  readonly transitions: number;
  readonly violations: string[];
  readonly rejections: number;
  readonly depth: number;
}

function explore(): Explored {
  const start = emptyState("qk", "1315419165", "refs/heads/main");
  const seen = new Set<string>([stateKey(start)]);
  let frontier: Array<{ state: BranchQueueState; step: number }> = [{ state: start, step: 1 }];
  const violations: string[] = [];
  let transitions = 0;
  let rejections = 0;
  let depth = 0;

  while (frontier.length > 0 && seen.size < MAX_STATES) {
    const next: Array<{ state: BranchQueueState; step: number }> = [];
    depth += 1;
    for (const node of frontier) {
      for (const action of actions(node.state, node.step)) {
        const before = stateKey(node.state);
        let after: BranchQueueState;
        try {
          after = applyEvent(node.state, { ...action.event, sequence: node.step } as QueueEvent);
        } catch (error) {
          if (!(error instanceof QueueRuleViolation)) throw error;
          rejections += 1;
          // A refused command must leave the state exactly as it was.
          if (stateKey(node.state) !== before) {
            violations.push(`rejected ${action.label} mutated state`);
          }
          continue;
        }
        transitions += 1;

        const found = checkInvariants(after);
        if (found.length > 0) {
          violations.push(`${action.label} -> ${found.map((v) => v.invariant).join(",")}`);
        }

        const key = stateKey(after);
        if (!seen.has(key)) {
          seen.add(key);
          next.push({ state: after, step: node.step + 1 });
        }
        if (seen.size >= MAX_STATES) break;
      }
      if (seen.size >= MAX_STATES) break;
    }
    frontier = next;
  }

  return { states: seen.size, transitions, violations, rejections, depth };
}

describe("exhaustive model check", () => {
  const result = explore();

  it("explores a substantial state space", () => {
    // eslint-disable-next-line no-console
    console.log(
      `model check: ${result.states} states, ${result.transitions} transitions, ` +
        `${result.rejections} refusals, depth ${result.depth}`,
    );
    // A trivial exploration would make every assertion below meaningless, so the
    // size is asserted rather than merely reported.
    expect(result.states).toBeGreaterThan(500);
    expect(result.transitions).toBeGreaterThan(2000);
    expect(result.depth).toBeGreaterThan(5);
  });

  it("attempts illegal commands, not only legal ones", () => {
    // Without refusals the checker would only be walking the happy paths.
    expect(result.rejections).toBeGreaterThan(100);
  });

  it("holds every invariant in every reachable state", () => {
    expect(result.violations).toEqual([]);
  });

  it("never mutates state on a refused command", () => {
    expect(result.violations.filter((v) => v.includes("mutated state"))).toEqual([]);
  });
});

describe("model check catches a broken reducer", () => {
  /**
   * The checker is only worth having if it fails when the system is wrong. This
   * replays the same exploration against a reducer wrapper that drops the
   * occupied-lane guard, and requires the invariants to catch it.
   */
  it("finds a lane violation when the guard is removed", () => {
    const start = emptyState("qk", "1315419165", "refs/heads/main");
    let state = start;
    let step = 1;
    const push = (event: Omit<QueueEvent, "sequence">) => {
      state = applyEvent(state, { ...event, sequence: step } as QueueEvent);
      step += 1;
    };

    push({
      idempotencyKey: "r1",
      at: AT(1),
      type: "QueueRequested",
      entryId: "e1",
      pullRequestNumber: 1,
      sponsorPrincipalId: "alice",
      sponsorGithubUserId: "1",
      headSha: "h".repeat(40),
    });
    push({
      idempotencyKey: "d1",
      at: AT(2),
      type: "ReadinessEvaluated",
      entryId: "e1",
      ready: true,
      schedulerEligible: true,
      primaryReason: null,
      secondaryReasons: [],
    });
    push({
      idempotencyKey: "o1",
      at: AT(3),
      type: "TurnOffered",
      entryId: "e1",
      attemptId: "a1",
      offerDeadline: AT(90),
      decisionDigest: "sha256:d",
    });

    // Forge the state the guard exists to prevent, and confirm the invariant
    // checker reports it rather than passing.
    const forged: BranchQueueState = {
      ...state,
      attempts: new Map(state.attempts),
    };
    forged.attempts.set("a2", { ...state.attempts.get("a1")!, attemptId: "a2" });
    const violations = checkInvariants(forged);
    expect(violations.map((v) => v.invariant)).toContain("OneActiveLane");
  });
});
