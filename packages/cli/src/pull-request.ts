/**
 * Which pull request, if any, `gh pr view` is talking about.
 *
 * `gh pr view` with no argument answers for the current branch, and it answers
 * with the most recent pull request for that branch whatever state it is in. A
 * branch name that gets reused therefore reads back as a merged pull request
 * from days ago.
 *
 * That is not a corner case here. Agents ship from a branch, the queue merges
 * and deletes it, and the next run recreates the same name. Ship read the
 * merged number, decided a pull request already existed, skipped opening one,
 * and joined the queue against a number that named somebody else's merged work.
 * It printed QUEUE_REQUESTED while nothing was queued and nothing was open.
 *
 * So the state is read, not assumed, and only OPEN counts.
 */
export interface OpenPullRequest {
  readonly number: number;
  readonly isDraft: boolean;
}

/** The exact gh command needed before ship's requested PR mode is true. */
export function pullRequestCommand(current: OpenPullRequest | null, draft: boolean): readonly string[] | null {
  if (current === null) return ["pr", "create", "--fill", ...(draft ? ["--draft"] : [])];
  if (draft && !current.isDraft) return ["pr", "ready", String(current.number), "--undo"];
  return null;
}

function openPullRequestView(ghOutput: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(ghOutput);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const view = parsed as Record<string, unknown>;
  // An answer with no state is an answer this cannot check, and an unchecked
  // answer is what caused the bug. Missing is refused rather than allowed.
  if (view["state"] !== "OPEN") return null;

  return view;
}

/** The open pull request and whether GitHub still considers it a draft. */
export function openPullRequest(ghOutput: string): OpenPullRequest | null {
  const view = openPullRequestView(ghOutput);
  if (view === null || typeof view["isDraft"] !== "boolean") return null;

  const number = view["number"];
  return typeof number === "number" && Number.isSafeInteger(number) && number > 0
    ? { number, isDraft: view["isDraft"] }
    : null;
}
