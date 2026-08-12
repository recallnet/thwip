import React, { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, useFetch } from "./api.js";
import { ConfirmAction, Panel } from "./ui.js";
import {
  blockedNextAction,
  blockerFreshness,
  entryStateText,
  entryStateTone,
  findingTitle,
  healActionLabel,
  healPanelFailure,
  ownerGithubUrl,
  ownerName,
  transitionKindText,
  whenText,
} from "./vocabulary.js";

/**
 * The queue surfaces.
 *
 * Two rules shape this view and are worth stating because they are easy to
 * break by accident.
 *
 * Order is projected, never promised. Readiness changes after every GitHub event,
 * so a number presented as a fixed position would be a lie the user notices the
 * moment it moves. It is labelled as projected and explained.
 *
 * Every blocked entry shows the action that clears it, not just its reason code.
 * A queue that says `CODEOWNER_REVIEW_REQUIRED` and stops has told a developer
 * nothing they can use. Every word this view puts on screen comes from
 * ./vocabulary.ts, which is the one place a code becomes a sentence.
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
  readonly pullRequestNumber?: number | null;
  readonly witnessPrincipalIds: readonly string[];
  readonly recordedAt: string | null;
}

export interface QueuePageInfo {
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly totalPages: number;
}

export interface QueueSnapshot {
  /**
   * Where this answer came from. `"projection"` is the default read: a row the
   * last command wrote, which keeps whatever it last held when that write
   * fails. `"queue"` is the authority, read with `?live=1`.
   */
  readonly source?: "projection" | "queue";
  /** When the projection was last written. Absent on a live read. */
  readonly projectedAt?: string | null;
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
  readonly pagination?: {
    readonly entries: QueuePageInfo;
    readonly transitions: QueuePageInfo;
  };
}

/** The state of an entry, said in words and toned by how worried to be. */
function EntryState({ entry }: { entry: QueueEntryView }) {
  const tone = entryStateTone(entry.state, entry.primaryReason !== null);
  return <span className={tone}>{entryStateText(entry.state)}</span>;
}

/**
 * What clears an entry, and how old that answer is.
 *
 * The reason comes from the projection, which is a row somebody wrote the last
 * time a command ran. Pull request 56 was ready for review on GitHub while this
 * column said "Mark the pull request ready for review", because the write that
 * would have cleared it never landed and the page stated the row in the present
 * tense. So the row is dated, and past the threshold `blockerFreshness` holds,
 * the instruction is withdrawn rather than repeated at somebody who has already
 * done it.
 */
function Blocker({
  reason,
  source,
  projectedAt,
}: {
  reason: string | null;
  source: QueueSnapshot["source"];
  projectedAt: QueueSnapshot["projectedAt"];
}) {
  const said = blockedNextAction(reason);
  if (said === null) return <span>Waiting for the scheduler.</span>;
  const freshness = blockerFreshness(source, projectedAt);
  if (freshness === null) return <span>{said}</span>;
  return (
    <>
      {freshness.confirmed && <span>{said} </span>}
      <span className="gp-panel__meta">{freshness.text}</span>
    </>
  );
}

/**
 * The person whose pull request this is.
 *
 * The column showed `prn_gh_370259`, which is the row id of a principal. The
 * organization projection already knows the login behind that id, so it is
 * asked, and the id is never what a reader gets.
 */
function Owner({ principalId, logins }: { principalId: string; logins: ReadonlyMap<string, string> }) {
  const name = ownerName(principalId, logins);
  const url = ownerGithubUrl(principalId, logins);
  if (url === null) return <span>{name}</span>;
  return (
    <a href={url} target="_blank" rel="noreferrer">
      {name}
    </a>
  );
}

/** One commit in a gap, and what the queue would record for it. */
interface HealStepView {
  readonly action: "record-merge" | "record-movement" | "ask-a-person";
  readonly commitSha: string;
  readonly sentence: string;
}

interface HealPlanView {
  readonly code: string;
  readonly digest: string;
  readonly detail: string;
  readonly summary: string;
  readonly steps: readonly HealStepView[];
  readonly healable: boolean;
}

/**
 * What is wrong with this branch's record, and the one thing that fixes it.
 *
 * The queue has reported these findings on its heartbeat since the day the
 * first unrecorded merge was understood, and that is where it stopped. Turning
 * one into a whole chain meant reading `merge_operations` out of the database,
 * listing every signed merge intent, asking GitHub about each commit in the
 * gap, and matching trees and parents by hand. The queue holds both halves of
 * every one of those comparisons, so the server does the search and this shows
 * what it found.
 *
 * Nothing here sends a tree, a parent list or a commit sha. The administrator
 * names the finding and says why. An operator who could name a commit could
 * name the throwaway merge GitHub computes for an open pull request, which is
 * how record 54 reached the chain.
 *
 * Findings the queue cannot answer from evidence it holds get no button. A
 * control that produces a refusal teaches a reader to distrust the next thing
 * this page tells them.
 */
function ChainHealthPanel({ repositoryId, baseRef }: { repositoryId: string; baseRef: string }) {
  const [plans, setPlans] = useState<readonly HealPlanView[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  // A reader who is not an administrator gets 403 here, and that is not an
  // error to put on their screen: the panel simply is not theirs. A read that
  // fails any other way is thwip failing, and hiding that would show an
  // administrator the same page a whole chain shows.
  const [unreadable, setUnreadable] = useState<string | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});

  const path = `/v1/queue/${repositoryId}/heal?ref=${encodeURIComponent(baseRef)}`;
  const load = useCallback(() => {
    api<{ findings: readonly HealPlanView[] }>(path)
      .then((body) => {
        setPlans(body.findings);
        setUnreadable(null);
      })
      .catch((e: unknown) => {
        setPlans(null);
        setUnreadable(healPanelFailure(e instanceof ApiError ? e.status : undefined));
      });
  }, [path]);

  useEffect(load, [load]);

  if (unreadable !== null) {
    return (
      <Panel tone="finding" title="This branch's record" meta="unread">
        <p className="thwip-error">{unreadable}</p>
      </Panel>
    );
  }
  if (plans === null || plans.length === 0) return null;

  const resolve = (plan: HealPlanView) => {
    setBusy(plan.digest);
    setFailed(null);
    api(path, {
      method: "POST",
      body: JSON.stringify({
        finding: plan.digest,
        code: plan.code,
        reason: reasons[plan.digest] ?? plan.detail,
      }),
    })
      .then(() => load())
      .catch((e: Error) => setFailed(e.message))
      .finally(() => setBusy(null));
  };

  return (
    <Panel
      tone="finding"
      title="This branch's record"
      meta={plans.length === 1 ? "1 finding" : `${plans.length} findings`}
    >
      <>
        {failed !== null && <p className="thwip-error">{failed}</p>}
        {plans.map((plan) => {
          const label = healActionLabel(plan);
          return (
            <div key={plan.digest} className="thwip-finding">
              <p className="thwip-finding__title">{findingTitle(plan.code)}</p>
              <p className="gp-panel__meta">{plan.detail}</p>
              <p>{plan.summary}</p>
              {plan.steps.length > 0 && (
                <ul className="thwip-finding__steps">
                  {plan.steps.map((step) => (
                    <li key={step.commitSha}>
                      <code className="gp-mono">{step.commitSha.slice(0, 8)}</code> {step.sentence}
                    </li>
                  ))}
                </ul>
              )}
              {label === null ? null : (
                <>
                  <label className="thwip-finding__reason">
                    Why you are recording this
                    <input
                      type="text"
                      value={reasons[plan.digest] ?? plan.detail}
                      onChange={(e) => setReasons((r) => ({ ...r, [plan.digest]: e.target.value }))}
                    />
                  </label>
                  <ConfirmAction
                    label={label}
                    title={label}
                    consequence={<p>{plan.summary} The chain is append-only, so this cannot be undone.</p>}
                    confirmLabel={label}
                    busy={busy === plan.digest}
                    onConfirm={() => resolve(plan)}
                  />
                </>
              )}
            </div>
          );
        })}
      </>
    </Panel>
  );
}

/**
 * Accepting a base the queue did not sign for.
 *
 * The panel used to explain this condition and offer nothing to do about it, so
 * recovery was CLI-only at exactly the point where a person is meant to look
 * carefully. What makes it safe is not the confirmation dialog: it is that the
 * commit named here is the commit the queue observed, and the queue refuses the
 * submission if it has observed a newer one since. An administrator who reads
 * this, goes to look at the commit, and comes back to a branch that moved again
 * is told so rather than accepting something nobody read.
 */
function RebaselineRecovery({
  repositoryId,
  baseRef,
  repositoryName,
  observedBaseSha,
  chainHead,
  activeAttemptId,
  onChanged,
}: {
  repositoryId: string;
  baseRef: string;
  repositoryName: string;
  observedBaseSha: string | null;
  chainHead: { readonly sequence: number; readonly digest: string } | null;
  activeAttemptId: string | null;
  onChanged: () => void;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const branch = baseRef.replace(/^refs\/heads\//, "");

  if (observedBaseSha === null) {
    return <p className="thwip-error">The queue has not recorded which commit the branch moved to, so there is nothing to accept yet.</p>;
  }

  const accept = async () => {
    setBusy(true);
    setFailed(null);
    try {
      await api(`/v1/queue/${repositoryId}/rebaseline?ref=${encodeURIComponent(baseRef)}`, {
        method: "POST",
        body: JSON.stringify({ baseSha: observedBaseSha, reason: reason.trim() }),
      });
      setReason("");
      onChanged();
    } catch (cause) {
      setFailed((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="thwip-queue-controls">
      <dl className="thwip-pairs">
        <div>
          <dt>Branch</dt>
          <dd>
            {repositoryName} · {branch}
          </dd>
        </div>
        <div>
          <dt>Last signed base</dt>
          <dd>{chainHead === null ? "nothing signed yet" : `#${chainHead.sequence} · ${chainHead.digest.slice(0, 19)}`}</dd>
        </div>
        <div>
          <dt>Now on GitHub</dt>
          <dd>
            <a
              href={`https://github.com/${repositoryName}/commit/${observedBaseSha}`}
              target="_blank"
              rel="noreferrer"
            >
              <code>{observedBaseSha.slice(0, 12)}</code>
            </a>
          </dd>
        </div>
      </dl>
      {activeAttemptId !== null && (
        <p className="thwip-error">
          Something still holds the lane. Let it finish or end it before moving the base underneath it.
        </p>
      )}
      <div className="thwip-field">
        <label htmlFor={`rebaseline-reason-${repositoryId}`}>Reason</label>
        <input
          id={`rebaseline-reason-${repositoryId}`}
          value={reason}
          disabled={busy}
          placeholder="what you checked, and why this commit is acceptable"
          onChange={(event) => setReason(event.target.value)}
        />
      </div>
      <ConfirmAction
        label="Accept this base"
        title={`Accept ${observedBaseSha.slice(0, 12)} as the base of ${branch}?`}
        consequence={
          <>
            <p>
              The queue has no signed record of how {branch} reached this commit. Accepting it says you looked at it
              and vouch for it, and every merge the queue certifies afterwards is built on that.
            </p>
            <p>
              Merging stays paused. Resuming is a separate decision, so you can look at what is queued before anything
              moves.
            </p>
          </>
        }
        confirmLabel="Accept it"
        busy={busy || reason.trim() === "" || activeAttemptId !== null}
        onConfirm={() => void accept()}
      />
      {failed && <p className="thwip-error">{failed}</p>}
    </div>
  );
}

/**
 * Pause and resume, for somebody who can.
 *
 * The panel had said "an administrator can resume it" and offered nothing to do
 * it with, so the administrator reading that sentence went to the CLI. The
 * server is the authority on who may: `canAdminister` is the organization role,
 * which is a hint, and a reader who is an owner here but not an administrator of
 * this repository is refused by the route and told so.
 *
 * A pause needs a reason because the reason is what the next person to look at a
 * stopped queue reads.
 */
export function QueueControls({
  repositoryId,
  baseRef,
  paused,
  rebaselineRequired,
  onChanged,
}: {
  repositoryId: string;
  baseRef: string;
  paused: boolean;
  rebaselineRequired: boolean;
  onChanged: () => void;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const reasonField = useRef<HTMLTextAreaElement>(null);

  const send = async (action: "pause" | "resume", body: unknown) => {
    setBusy(true);
    setFailed(null);
    try {
      await api(`/v1/queue/${repositoryId}/${action}?ref=${encodeURIComponent(baseRef)}`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      setReason("");
      dialog.current?.close();
      onChanged();
    } catch (cause) {
      setFailed((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // A rebaseline comes first, and it is not this control. Offering resume here
  // would be offering a button whose only outcome is a refusal.
  if (paused && rebaselineRequired) return failed === null ? null : <p className="thwip-error">{failed}</p>;

  return (
    <div className="thwip-queue-controls">
      {paused ? (
        <button className="gp-btn gp-btn--sm" disabled={busy} onClick={() => void send("resume", {})}>
          Resume merging
        </button>
      ) : (
        <>
          <button
            className="gp-btn gp-btn--sm gp-btn--danger"
            disabled={busy}
            onClick={() => {
              setFailed(null);
              dialog.current?.showModal();
              requestAnimationFrame(() => reasonField.current?.focus());
            }}
          >
            Pause merging
          </button>
          <dialog
            ref={dialog}
            className="thwip-dialog"
            aria-labelledby={`pause-title-${repositoryId}`}
            onCancel={() => setFailed(null)}
          >
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (!busy && reason.trim() !== "") void send("pause", { reason: reason.trim() });
              }}
            >
              <h2 id={`pause-title-${repositoryId}`}>Pause merging on this branch?</h2>
              <p>
                Nothing merges until somebody resumes it. Pull requests keep their place in the queue.
              </p>
              <label htmlFor={`pause-reason-${repositoryId}`}>Reason</label>
              <textarea
                ref={reasonField}
                id={`pause-reason-${repositoryId}`}
                value={reason}
                disabled={busy}
                required
                rows={4}
                placeholder="Explain why merging should stop"
                onChange={(event) => setReason(event.target.value)}
              />
              {failed && <p className="thwip-error" role="alert">{failed}</p>}
              <div className="thwip-actions">
                <button className="gp-btn gp-btn--sm gp-btn--danger" type="submit" disabled={busy || reason.trim() === ""}>
                  Pause merging
                </button>
                <button
                  className="gp-btn gp-btn--sm gp-btn--quiet"
                  type="button"
                  disabled={busy}
                  onClick={() => dialog.current?.close()}
                >
                  Cancel
                </button>
              </div>
            </form>
          </dialog>
        </>
      )}
      {paused && failed && <p className="thwip-error" role="alert">{failed}</p>}
    </div>
  );
}

export function queueReadPath(repositoryId: string, baseRef: string, entriesPage: number, transitionsPage: number) {
  const query = new URLSearchParams({
    ref: baseRef,
    entriesPage: String(entriesPage),
    transitionsPage: String(transitionsPage),
  });
  return `/v1/queue/${repositoryId}?${query.toString()}`;
}

export function TablePagination({
  label,
  page,
  onPage,
}: {
  label: string;
  page: QueuePageInfo;
  onPage: (page: number) => void;
}) {
  if (page.totalPages <= 1) return null;
  return (
    <nav className="thwip-pagination" aria-label={`${label} pages`}>
      <button
        className="gp-btn gp-btn--sm gp-btn--quiet"
        disabled={page.page <= 1}
        onClick={() => onPage(page.page - 1)}
      >
        Previous
      </button>
      <span aria-live="polite">
        Page {page.page} of {page.totalPages} · {page.total} records
      </span>
      <button
        className="gp-btn gp-btn--sm gp-btn--quiet"
        disabled={page.page >= page.totalPages}
        onClick={() => onPage(page.page + 1)}
      >
        Next
      </button>
    </nav>
  );
}

export function QueueTableHeading({
  id,
  title,
  description,
}: {
  id: string;
  title: string;
  description: string;
}) {
  return (
    <>
      <h3 id={id}>{title}</h3>
      <p className="gp-panel__meta">{description}</p>
    </>
  );
}

export function QueuePanel({
  repositoryId,
  baseRef,
  repositoryName,
  canAdminister,
}: {
  repositoryId: string;
  baseRef: string;
  repositoryName: string;
  canAdminister: boolean;
}) {
  const [snapshot, setSnapshot] = useState<QueueSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [entriesPage, setEntriesPage] = useState(1);
  const [transitionsPage, setTransitionsPage] = useState(1);
  const requestVersion = useRef(0);
  // Who each principal id stands for. The queue snapshot carries ids; the
  // organization projection carries the names that go with them.
  const people = useFetch<{ members: Array<{ github_user_id: string; github_login: string }> }>(
    "/v1/dashboard/people",
  );
  const logins = new Map((people.data?.members ?? []).map((m) => [m.github_user_id, m.github_login]));

  const load = useCallback(() => {
    const version = ++requestVersion.current;
    api<QueueSnapshot>(queueReadPath(repositoryId, baseRef, entriesPage, transitionsPage))
      .then((s) => {
        if (version !== requestVersion.current) return;
        setSnapshot(s);
        setError(null);
        if (s.pagination !== undefined) {
          if (entriesPage > s.pagination.entries.totalPages) setEntriesPage(s.pagination.entries.totalPages);
          if (transitionsPage > s.pagination.transitions.totalPages) {
            setTransitionsPage(s.pagination.transitions.totalPages);
          }
        }
      })
      .catch((e: Error) => {
        if (version === requestVersion.current) setError(e.message);
      });
  }, [repositoryId, baseRef, entriesPage, transitionsPage]);

  useEffect(() => {
    load();
    // Readiness changes on GitHub events this page never sees, so it refreshes
    // rather than pretending its first read stays true. Thirty seconds, and only
    // while the tab is in front: at ten seconds a forgotten background tab was
    // enough to spend a month of Durable Object requests on nobody reading it.
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer === null && document.visibilityState === "visible") timer = setInterval(load, 30_000);
    };
    const stop = () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        load();
        start();
      } else {
        stop();
      }
    };
    start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      // A page change or navigation must not let an older response overwrite
      // the newer page after this effect has stopped owning the request.
      requestVersion.current += 1;
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [load]);

  if (error !== null) {
    return (
      <Panel title="Queue">
        <p className="thwip-error">{error}</p>
        <p className="gp-panel__meta">
          A queue exists per repository and base branch. If this branch has never been configured, there is
          nothing to show yet.
        </p>
      </Panel>
    );
  }

  if (snapshot === null) {
    return (
      <Panel title="Queue">
        <p className="gp-panel__meta">Loading queue…</p>
      </Panel>
    );
  }

  const entries = snapshot.entries.filter((e) => e.state !== "Merged" && e.state !== "Cancelled");
  const entryPage = snapshot.pagination?.entries.page ?? 1;
  const entryPageSize = snapshot.pagination?.entries.pageSize ?? entries.length;
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
    <>
      <ChainHealthPanel repositoryId={repositoryId} baseRef={baseRef} />
      <Panel
        title={`Queue · ${repositoryName} · ${baseRef.replace(/^refs\/heads\//, "")}`}
        meta={snapshot.activeAttemptId === null ? "Nothing integrating" : "Integrating now"}
        action={
          canAdminister ? (
            <QueueControls
              repositoryId={repositoryId}
              baseRef={baseRef}
              paused={snapshot.paused}
              rebaselineRequired={snapshot.rebaselineRequired}
              onChanged={load}
            />
          ) : undefined
        }
      >
      <>
        {snapshot.paused && (
          <p className="thwip-error">
            {snapshot.pauseReason === null
              ? "Merging is paused."
              : `Merging is paused: ${blockedNextAction(snapshot.pauseReason)}`}
            {snapshot.rebaselineRequired
              ? " The branch moved outside the queue, so an administrator has to rebaseline before merging resumes."
              : canAdminister
                ? ""
                : " An administrator can resume it."}
          </p>
        )}
        {canAdminister && snapshot.paused && snapshot.rebaselineRequired && (
          <RebaselineRecovery
            repositoryId={repositoryId}
            baseRef={baseRef}
            repositoryName={repositoryName}
            observedBaseSha={snapshot.baseSha}
            chainHead={snapshot.chainHead}
            activeAttemptId={snapshot.activeAttemptId}
            onChanged={load}
          />
        )}
        <section className="thwip-table-section" aria-labelledby="queue-entries-title">
          <QueueTableHeading
            id="queue-entries-title"
            title="Pull requests in this queue"
            description="Ordered by the queue. Ready pull requests can move when the lane is free; blocked ones keep their place."
          />
          {entries.length === 0 ? (
            <p>
              Nothing is queued. Run <code>thwip ship --wait</code> on a branch to join.
            </p>
          ) : (
            <div className="thwip-table-scroll">
              <table className="thwip-table thwip-table--queue">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Pull request</th>
                    <th>Owner</th>
                    <th>State</th>
                    <th>What clears it</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((entry, index) => {
                    const ready = entry.state === "Ready" && entry.schedulerEligible;
                    const holdsLane =
                      snapshot.activeAttemptId !== null && entry.lastAttemptId === snapshot.activeAttemptId;
                    return (
                      <tr key={entry.entryId}>
                        <td className="gp-mono">{(entryPage - 1) * entryPageSize + index + 1}</td>
                        <td>
                          <a
                            href={`https://github.com/${repositoryName}/pull/${entry.pullRequestNumber}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            #{entry.pullRequestNumber}
                          </a>
                        </td>
                        <td>
                          <Owner principalId={entry.sponsorPrincipalId} logins={logins} />
                        </td>
                        <td>
                          <EntryState entry={entry} />
                        </td>
                        <td>
                          {holdsLane ? (
                            <span>This pull request holds the lane.</span>
                          ) : ready ? (
                            <span>Ready for the scheduler.</span>
                          ) : (
                            <Blocker
                              reason={entry.primaryReason}
                              source={snapshot.source}
                              projectedAt={snapshot.projectedAt}
                            />
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {snapshot.pagination && (
            <TablePagination
              label="Queued pull requests"
              page={snapshot.pagination.entries}
              onPage={setEntriesPage}
            />
          )}
        </section>

        <section className="thwip-table-section" aria-labelledby="queue-history-title">
          <QueueTableHeading
            id="queue-history-title"
            title="Signed branch history"
            description="Each row is a signed record of a protected-branch move. Newest records appear first."
          />
          {history.length === 0 ? (
            <p>No branch moves have been recorded yet.</p>
          ) : (
            <div className="thwip-table-scroll">
              <table className="thwip-table thwip-table--queue">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Pull request</th>
                  <th>What happened</th>
                  <th>Commit</th>
                  <th>Record</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {history.map((t) => {
                  const pr = t.pullRequestNumber ?? (t.attemptId === null ? undefined : prForAttempt.get(t.attemptId));
                  return (
                    <tr key={t.transitionSequence}>
                      <td className="gp-mono">{t.transitionSequence}</td>
                      <td>
                        {pr === undefined ? (
                          <span className="gp-panel__meta">no pull request</span>
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
                      {/*
                        This column is prose, so a verified merge is coloured
                        and nothing else. Reaching for the `ok` utility here
                        also retyped the sentence as 11.5px mono, which made one
                        row of the column a different size from its neighbours.
                      */}
                      <td className={t.kind === "verified" ? "is-verified" : undefined}>
                        {transitionKindText(t.kind)}
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
                      <td>
                        {/*
                          The record behind the link. A link used to be the merge
                          commit dressed up as a digest, so there was nothing to
                          open; now it names signed bytes anyone can read.
                        */}
                        <a
                          className="gp-mono"
                          href={`/v1/queue/records/${t.digest}`}
                          target="_blank"
                          rel="noreferrer"
                          title="The signed record this link names"
                        >
                          {t.digest.replace(/^sha256:/, "").slice(0, 8)}
                        </a>
                      </td>
                      <td className="gp-panel__meta">{whenText(t.recordedAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
              </table>
            </div>
          )}
          {snapshot.pagination && (
            <TablePagination
              label="Signed branch history"
              page={snapshot.pagination.transitions}
              onPage={setTransitionsPage}
            />
          )}
        </section>
      </>
      </Panel>
    </>
  );
}
