import React, { useCallback, useEffect, useState } from "react";

/**
 * The queue surfaces (plan.md §28.2, §28.3).
 *
 * Two rules from the specification shape this view and are worth stating because
 * they are easy to break by accident.
 *
 * Order is projected, never promised. Readiness changes after every GitHub event,
 * so a number presented as a fixed position would be a lie the user notices the
 * moment it moves. It is labelled as projected and explained.
 *
 * Every blocked entry shows the action that clears it, not just its reason code.
 * A queue that says `CODEOWNER_REVIEW_REQUIRED` and stops has told a developer
 * nothing they can use.
 */

export interface QueueEntryView {
  readonly entryId: string;
  readonly pullRequestNumber: number;
  readonly sponsorPrincipalId: string;
  readonly state: string;
  readonly primaryReason: string | null;
  readonly schedulerEligible: boolean;
  readonly fairnessOrdinal: string;
  readonly cooldownUntil: string | null;
  readonly lastAttemptId: string | null;
}

/** One recorded move of the protected branch. */
export interface QueueTransitionView {
  readonly transitionSequence: number;
  readonly kind: string;
  readonly digest: string;
  readonly priorDigest: string | null;
  readonly baseSha: string;
  readonly attemptId: string | null;
  readonly witnessPrincipalIds: readonly string[];
  readonly recordedAt: string | null;
}

export interface QueueSnapshot {
  readonly generation: number;
  readonly attemptRevision: number;
  readonly paused: boolean;
  readonly pauseReason: string | null;
  readonly rebaselineRequired: boolean;
  readonly baseSha: string | null;
  readonly activeAttemptId: string | null;
  readonly chainHead: { readonly sequence: number; readonly digest: string } | null;
  readonly transitions?: readonly QueueTransitionView[];
  readonly entries: readonly QueueEntryView[];
}

/**
 * What a transition means, in the words a reader needs.
 *
 * The queue's own vocabulary leaked into the dashboard: a merge history read
 * "Transition 13 · sha256:003fbf43ede765da… · base 003fbf43ede7", which says
 * nothing about which pull request landed or when.
 */
const TRANSITION_KIND: Record<string, string> = {
  verified: "Merged by the queue",
  override: "Merged with an override",
  external: "Moved outside the queue",
  genesis: "Queue opened here",
};

function whenText(iso: string | null): string {
  if (iso === null) return "time not recorded";
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "time not recorded";
  const minutes = Math.floor((Date.now() - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(at).toLocaleDateString();
}

/**
 * The same guidance the check publishes, so a developer reading the dashboard and
 * a developer reading a red check are told the same thing.
 */
const NEXT_ACTION: Record<string, string> = {
  REVIEW_REQUIRED: "Ask for a review. The queue holds this place while it waits.",
  CODEOWNER_REVIEW_REQUIRED: "A code owner for the changed files still needs to approve.",
  APPROVAL_AFTER_PUSH_REQUIRED: "Pushed after the last approval, so it needs approving again.",
  CONVERSATION_UNRESOLVED: "Resolve the open review conversations.",
  REQUIRED_CHECK_PENDING: "A required check is still running.",
  REQUIRED_CHECK_FAILED: "A required check failed. Fix and push; the place is kept.",
  VERIFICATION_REJECTED: "The verifier refused the candidate. thwip verify explains why; the place is kept.",
  MERGE_CONFLICT: "Rebase or merge the base branch to clear the conflict.",
  LOCAL_RECEIPT_MISSING: "Run thwip run on this commit and push.",
  LOCAL_RECEIPT_REJECTED: "The proof was not accepted. thwip verify explains why.",
  AGENT_OFFLINE: "No machine is connected to run the integration.",
  NO_COMPATIBLE_RUNNER: "No connected machine can run this project's pipeline.",
  PR_DRAFT: "Mark the pull request ready for review.",
  PR_CLOSED: "The pull request is closed.",
  OWNER_UNAUTHORIZED: "The owner no longer has the required repository permission.",
  SPONSOR_REQUIRED: "A bot pull request needs a human sponsor.",
  COOLDOWN_ACTIVE: "A turn was offered and not claimed; short cooldown before the next.",
  NEEDS_REPAIR: "Integration failed. Push a fix; the place in line is kept.",
  POLICY_CHANGED: "The policy changed; the queue will re-evaluate against the new one.",
  RULESET_DRIFT: "The repository ruleset no longer matches what the queue expects.",
  APP_PERMISSION_DRIFT: "The Thwip App is missing a permission it needs.",
  PROJECT_DISABLED: "This project is not enabled for the queue.",
  QUEUE_PAUSED: "The queue is paused.",
  BASE_NOT_MANAGED: "This pull request targets a branch the queue does not manage.",
};

function nextAction(reason: string | null): string | null {
  if (reason === null) return null;
  return NEXT_ACTION[reason] ?? reason;
}

const IN_FLIGHT = ["Offered", "Active", "ReconnectGrace", "Verifying", "MergeGuard", "Merging", "Reconciling"];

function stateTone(entry: QueueEntryView): string {
  if (entry.state === "Merged") return "ok";
  if (IN_FLIGHT.includes(entry.state)) return "";
  if (entry.state === "Cancelled") return "bad";
  return entry.primaryReason === null ? "" : "bad";
}

async function api<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: "include" });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? String(res.status));
  }
  return (await res.json()) as T;
}

export function QueuePanel({
  repositoryId,
  baseRef,
  repositoryName,
}: {
  repositoryId: string;
  baseRef: string;
  repositoryName: string;
}) {
  const [snapshot, setSnapshot] = useState<QueueSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api<QueueSnapshot>(`/v1/queue/${repositoryId}?ref=${encodeURIComponent(baseRef)}`)
      .then((s) => {
        setSnapshot(s);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, [repositoryId, baseRef]);

  useEffect(() => {
    load();
    // Readiness changes on GitHub events we do not see from here, so the view
    // refreshes rather than pretending its first read stays true.
    const timer = setInterval(load, 10_000);
    return () => clearInterval(timer);
  }, [load]);

  if (error !== null) {
    return (
      <div className="gp-panel">
        <div className="gp-panel__header">
          <h3 className="gp-panel__title">Queue</h3>
        </div>
        <div className="gp-panel__body">
          <p className="thwip-error">{error}</p>
          <p className="gp-panel__meta">
            A queue exists per repository and base branch. If this branch has never been configured, there is
            nothing to show yet.
          </p>
        </div>
      </div>
    );
  }

  if (snapshot === null) {
    return (
      <div className="gp-panel">
        <div className="gp-panel__body">
          <p className="gp-panel__meta">Loading queue…</p>
        </div>
      </div>
    );
  }

  const ready = snapshot.entries.filter((e) => e.state === "Ready" && e.schedulerEligible);
  const waiting = snapshot.entries.filter((e) => !ready.includes(e) && e.state !== "Merged" && e.state !== "Cancelled");
  const projected = new Map(ready.map((e, i) => [e.entryId, i + 1]));
  // Newest first: a reader wants the last thing that landed, not the first.
  const history = [...(snapshot.transitions ?? [])].sort(
    (a, b) => b.transitionSequence - a.transitionSequence,
  );
  const prForAttempt = new Map(
    snapshot.entries
      .filter((e) => e.lastAttemptId !== null)
      .map((e) => [e.lastAttemptId as string, e.pullRequestNumber]),
  );

  return (
    <div className="gp-panel">
      <div className="gp-panel__header">
        <h3 className="gp-panel__title">
          Queue · {repositoryName} · {baseRef.replace(/^refs\/heads\//, "")}
        </h3>
        <span className="gp-panel__meta">
          {snapshot.activeAttemptId === null ? "Nothing integrating" : "Integrating now"}
        </span>
      </div>
      <div className="gp-panel__body">
        {snapshot.paused && (
          <p className="thwip-error">
            Paused{snapshot.pauseReason === null ? "" : `: ${snapshot.pauseReason}`}.
            {snapshot.rebaselineRequired
              ? " The branch moved outside the queue, so an administrator has to rebaseline before merging resumes."
              : " An administrator can resume it."}
          </p>
        )}

        {snapshot.entries.length === 0 && (
          <p className="gp-panel__meta">
            Nothing is queued. Run <code>thwip ship --wait</code> on a branch to join.
          </p>
        )}

        {ready.length > 0 && (
          <>
            <p className="gp-panel__meta">
              Projected order, not a reservation: it changes after every review and check.
            </p>
            <table className="gp-data-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Pull request</th>
                  <th>Owner</th>
                  <th>State</th>
                </tr>
              </thead>
              <tbody>
                {ready.map((entry) => (
                  <tr key={entry.entryId}>
                    <td className="gp-mono">{projected.get(entry.entryId)}</td>
                    <td>
                      <a
                        href={`https://github.com/${repositoryName}/pull/${entry.pullRequestNumber}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        #{entry.pullRequestNumber}
                      </a>
                    </td>
                    <td className="gp-mono">{entry.sponsorPrincipalId}</td>
                    <td className={stateTone(entry)}>{entry.state}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}

        {waiting.length > 0 && (
          <>
            <p className="gp-panel__meta">
              Holding a place, not currently schedulable. Nothing here has lost its position.
            </p>
            <table className="gp-data-table">
              <thead>
                <tr>
                  <th>Pull request</th>
                  <th>Owner</th>
                  <th>State</th>
                  <th>What clears it</th>
                </tr>
              </thead>
              <tbody>
                {waiting.map((entry) => (
                  <tr key={entry.entryId}>
                    <td>
                      <a
                        href={`https://github.com/${repositoryName}/pull/${entry.pullRequestNumber}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        #{entry.pullRequestNumber}
                      </a>
                    </td>
                    <td className="gp-mono">{entry.sponsorPrincipalId}</td>
                    <td className={stateTone(entry)}>{entry.state}</td>
                    <td>{nextAction(entry.primaryReason) ?? "Waiting for the scheduler."}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}

        {history.length > 0 && (
          <>
            <p className="gp-panel__meta">
              How this branch has moved. Every row is a signed record; the queue merged the ones it verified.
            </p>
            <table className="gp-data-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Pull request</th>
                  <th>What happened</th>
                  <th>Commit</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {history.map((t) => {
                  const pr = t.attemptId === null ? undefined : prForAttempt.get(t.attemptId);
                  return (
                    <tr key={t.transitionSequence}>
                      <td className="gp-mono">{t.transitionSequence}</td>
                      <td>
                        {pr === undefined ? (
                          <span className="gp-panel__meta">—</span>
                        ) : (
                          <a
                            href={`https://github.com/${repositoryName}/pull/${pr}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            #{pr}
                          </a>
                        )}
                      </td>
                      <td className={t.kind === "verified" ? "gp-pass" : undefined}>
                        {TRANSITION_KIND[t.kind] ?? t.kind}
                      </td>
                      <td>
                        <a
                          className="gp-mono"
                          href={`https://github.com/${repositoryName}/commit/${t.baseSha}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {t.baseSha.slice(0, 8)}
                        </a>
                      </td>
                      <td className="gp-panel__meta">{whenText(t.recordedAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </>
        )}
      </div>
    </div>
  );
}

/** Exported for tests: the guidance table must cover what the queue can report. */
export const QUEUE_NEXT_ACTIONS = NEXT_ACTION;
export { nextAction as queueNextAction };
