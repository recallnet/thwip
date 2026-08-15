import { doctorProbes } from "./queue-doctor.js";

export interface InitRepositoryContext {
  readonly root: string;
  readonly githubName: string;
  readonly defaultBranch: string;
  readonly baseRef: string;
}

export type InitLiveState =
  | { readonly kind: "signed-out"; readonly detail: string }
  | { readonly kind: "not-visible"; readonly detail: string }
  | { readonly kind: "selected"; readonly repositoryId: string; readonly projectId: string }
  | {
      readonly kind: "not-ready";
      readonly repositoryId: string;
      readonly projectId: string;
      readonly reasons: readonly string[];
    }
  | {
      readonly kind: "ready";
      readonly repositoryId: string;
      readonly projectId: string;
      readonly activationState: string | null;
    }
  | { readonly kind: "unreadable"; readonly detail: string };

export interface InitFetch {
  (input: string, init?: RequestInit): Promise<Response>;
}

type GitRead = (args: readonly string[], cwd: string) => Promise<string>;

/** Parse only an exact GitHub origin. Other hosts and ambiguous paths refuse. */
export function githubNameFromOrigin(remote: string): string | null {
  const trimmed = remote.trim();
  const matched = /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(
    trimmed,
  );
  return matched?.[1] ?? null;
}

/**
 * Resolve the real worktree root and the remote's current default branch.
 * `ls-remote --symref` is fresh and does not mistake the current PR target for
 * the repository default.
 */
export async function readInitRepositoryContext(cwd: string, runGit: GitRead): Promise<InitRepositoryContext> {
  const root = (await runGit(["rev-parse", "--show-toplevel"], cwd)).trim();
  if (root.length === 0) throw new Error("not inside a Git repository");
  const remote = await runGit(["config", "--get", "remote.origin.url"], root);
  const githubName = githubNameFromOrigin(remote);
  if (githubName === null) throw new Error("origin is not one exact GitHub owner/repository URL");
  const remoteHead = await runGit(["ls-remote", "--symref", "origin", "HEAD"], root);
  const defaultBranch = /^ref:\s+refs\/heads\/([^\s]+)\s+HEAD$/m.exec(remoteHead)?.[1] ?? null;
  if (defaultBranch === null || defaultBranch.length === 0) {
    throw new Error("could not read origin's current default branch");
  }
  return { root, githubName, defaultBranch, baseRef: `refs/heads/${defaultBranch}` };
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

async function json(response: Response): Promise<Record<string, unknown> | null> {
  return object(await response.json().catch(() => null));
}

function unreadable(detail: string): InitLiveState {
  return { kind: "unreadable", detail };
}

/**
 * Read user identity and member-visible project readiness. Every request is a
 * GET. Missing, malformed, mismatched, or unavailable state stays unreadable.
 */
export async function observeInitState(input: {
  readonly endpoint: string;
  readonly authHeader: string | null;
  readonly githubUserId: string;
  readonly context: InitRepositoryContext;
  readonly fetch: InitFetch;
  readonly timeoutMs?: number;
}): Promise<InitLiveState> {
  const { endpoint, authHeader, githubUserId, context, fetch } = input;
  const request = (url: string, init: RequestInit = {}) =>
    fetch(url, { ...init, signal: AbortSignal.timeout(input.timeoutMs ?? 15_000) });
  if (authHeader === null) return { kind: "signed-out", detail: "no user session" };
  const headers = { authorization: authHeader };

  let me: Response;
  try {
    me = await request(`${endpoint}/v1/session/identity`, { headers });
  } catch {
    return unreadable("the control plane could not verify the signed-in user");
  }
  if (me.status === 401) return { kind: "signed-out", detail: "the user session is no longer valid" };
  if (!me.ok) return unreadable(`the user identity read returned ${me.status}`);
  const meBody = await json(me);
  const serviceUserId = meBody?.["githubUserId"];
  if (String(serviceUserId ?? "") !== githubUserId) {
    return unreadable("the Thwip session and local GitHub identity name different users");
  }

  const probes = doctorProbes({ repo: context.githubName, ref: context.baseRef, events: 0 });
  const repositoryProbe = probes[0]!;
  let repository: Response;
  try {
    repository = await request(endpoint + repositoryProbe.path, { headers });
  } catch {
    return unreadable("the repository lookup did not complete");
  }
  if (repository.status === 401) return { kind: "signed-out", detail: "the user session is no longer valid" };
  if (repository.status === 404) {
    return {
      kind: "not-visible",
      detail: "the repository is not visible to this session; selection, access sync, or an administrator may be needed",
    };
  }
  if (!repository.ok) return unreadable(`the repository lookup returned ${repository.status}`);
  const resolved = await json(repository);
  const repositoryId = resolved?.["repositoryId"];
  const projectId = resolved?.["projectId"];
  if (typeof repositoryId !== "string" || !/^\d+$/.test(repositoryId) || typeof projectId !== "string" || projectId.length === 0) {
    return unreadable("the repository lookup returned malformed identity");
  }

  const readinessProbe = probes[1]!;
  const readinessPath = readinessProbe.path.replaceAll("{repositoryId}", repositoryId);
  let readiness: Response;
  try {
    readiness = await request(endpoint + readinessPath, { headers });
  } catch {
    return unreadable("the project readiness read did not complete");
  }
  if (readiness.status === 401) return { kind: "signed-out", detail: "the user session is no longer valid" };
  if (!readiness.ok) return unreadable(`the project readiness read returned ${readiness.status}`);
  const body = await json(readiness);
  if (
    body?.["repositoryId"] !== repositoryId ||
    body["projectId"] !== projectId ||
    body["baseRef"] !== context.baseRef ||
    typeof body["projectEnabled"] !== "boolean" ||
    !(body["activePolicyDigest"] === null ||
      (typeof body["activePolicyDigest"] === "string" && /^sha256:[0-9a-f]{64}$/.test(body["activePolicyDigest"]))) ||
    typeof body["queueConfigured"] !== "boolean" ||
    typeof body["queueEnabled"] !== "boolean" ||
    !(typeof body["activationState"] === "string" || body["activationState"] === null) ||
    typeof body["setupComplete"] !== "boolean"
  ) {
    return unreadable("the project readiness response did not match this origin and default branch");
  }
  const activationState = typeof body["activationState"] === "string" ? body["activationState"] : null;
  if (!body["queueConfigured"]) return { kind: "selected", repositoryId, projectId };
  const ready =
    body["projectEnabled"] === true &&
    typeof body["activePolicyDigest"] === "string" &&
    body["activePolicyDigest"].length > 0 &&
    body["queueEnabled"] === true &&
    activationState === "enforced" &&
    body["setupComplete"] === true;
  if (ready) return { kind: "ready", repositoryId, projectId, activationState };
  const reasons: string[] = [];
  if (body["projectEnabled"] !== true) reasons.push("the project is disabled");
  if (body["activePolicyDigest"] === null) reasons.push("no policy is active");
  if (body["queueEnabled"] !== true) reasons.push("the queue is disabled");
  if (activationState !== "enforced") reasons.push(`activation is ${activationState ?? "not set"}`);
  if (body["setupComplete"] !== true) reasons.push("queue setup is not complete");
  return { kind: "not-ready", repositoryId, projectId, reasons };
}

export function mayWriteGuidance(state: InitLiveState): state is Extract<
  InitLiveState,
  { kind: "selected" | "not-ready" | "ready" }
> {
  return (
    state.kind === "selected" ||
    state.kind === "not-ready" ||
    state.kind === "ready"
  );
}
