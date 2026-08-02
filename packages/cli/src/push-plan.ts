import { exitCodeFor, nextActionFor, type ExitCode } from "./queue-exit.js";

/**
 * What to do when `git push` refuses the commit ship just signed.
 *
 * Attaching a proof amends HEAD, which replaces the commit. On a branch that is
 * already on the remote — the ordinary state of anyone who opened the pull
 * request before running ship — the next push is rejected as non-fast-forward.
 * Ship caused that divergence, and until this existed the rejection escaped as
 * an unhandled node exception: git's output, a stack trace, and a dump of the
 * child-process object, on exit 1.
 *
 * Ship forces, and only in the one case it can prove it is undoing its own
 * work. `git commit --amend` keeps the parents and changes the commit, so a
 * remote tip with the same parents as local HEAD is this branch's own previous
 * tip and nothing else. Replacing it destroys nothing that was not already
 * replaced. A remote tip built on anything else means somebody pushed, and ship
 * stops with a reason code rather than overwrite work it never saw.
 *
 * The force carries a lease naming that exact commit, so a push that lands
 * between reading the tip and replacing it wins and ship loses. Asking the
 * developer to force by hand was the alternative, and it hands them a git error
 * for a divergence they did not create, one that ship can describe exactly.
 */

export interface PushAttempt {
  readonly ok: boolean;
  readonly stderr: string;
}

/** The two tips, read from git after a rejected push. */
export interface DivergedTips {
  readonly branch: string;
  readonly localSha: string;
  readonly localParents: readonly string[];
  /** Null when the remote tip could not be read at all. */
  readonly remoteSha: string | null;
  readonly remoteParents: readonly string[];
}

export type PushPlan =
  | { readonly kind: "done" }
  | {
      readonly kind: "force-with-lease";
      readonly branch: string;
      /** The commit the lease must still find on the remote. */
      readonly expect: string;
      readonly why: string;
    }
  | {
      readonly kind: "stop";
      readonly reasonCode: string;
      readonly exitCode: ExitCode;
      readonly why: string;
      readonly detail: string;
    };

/**
 * Whether git refused because the remote tip is not an ancestor of ours. Matched
 * on git's own words rather than the exit status, which is 1 for every refusal.
 */
export function isNonFastForward(stderr: string): boolean {
  return /non-fast-forward|fetch first|tip is behind/i.test(stderr);
}

/** The first line worth reading, so nothing prints git's whole hint block. */
function firstLine(text: string): string {
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith("hint:"));
  return (line ?? "git refused the push").slice(0, 400);
}

function sameCommit(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((sha, i) => sha === b[i]);
}

function stop(reasonCode: string, detail: string): PushPlan {
  return { kind: "stop", reasonCode, exitCode: exitCodeFor(reasonCode), why: nextActionFor(reasonCode), detail };
}

export function planPush(attempt: PushAttempt, tips: DivergedTips): PushPlan {
  if (attempt.ok) return { kind: "done" };
  if (!isNonFastForward(attempt.stderr)) return stop("LOCAL_FAILURE", firstLine(attempt.stderr));

  if (tips.remoteSha === null) return stop("PUSH_REJECTED", firstLine(attempt.stderr));
  // Two root commits both have no parents, so the parent test cannot tell an
  // amended first commit from an unrelated history pushed at the same branch.
  // The first is rare and the second is unrecoverable, so neither is forced.
  if (tips.localParents.length === 0) return stop("PUSH_REJECTED", firstLine(attempt.stderr));
  // Identical tips cannot be rejected for fast-forwarding, so something else is
  // true that this does not model. Forcing on a guess is how work disappears.
  if (tips.remoteSha === tips.localSha) return stop("PUSH_REJECTED", firstLine(attempt.stderr));
  if (!sameCommit(tips.localParents, tips.remoteParents)) {
    return stop("PUSH_REJECTED", firstLine(attempt.stderr));
  }

  return {
    kind: "force-with-lease",
    branch: tips.branch,
    expect: tips.remoteSha,
    why: `the proof rewrote ${tips.remoteSha.slice(0, 7)}, so ${tips.branch} is replaced rather than extended`,
  };
}

/** The push arguments for a plan, so nothing else assembles a force by hand. */
export function forceArgs(plan: Extract<PushPlan, { kind: "force-with-lease" }>): string[] {
  return [
    "push",
    "--force-with-lease=" + `refs/heads/${plan.branch}:${plan.expect}`,
    "--set-upstream",
    "origin",
    `HEAD:refs/heads/${plan.branch}`,
  ];
}
