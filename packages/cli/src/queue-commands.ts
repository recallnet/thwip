import { EXIT, type ExitCode } from "./queue-exit.js";

/**
 * Argument parsing and request planning for `thwip queue …` (plan.md §30.4).
 *
 * Parsing is separated from execution because this is where the damaging mistakes
 * live. A destructive command that ran with a missing argument silently defaulted,
 * or an administrative command that accepted a blank reason, would do real harm to
 * a real repository — so every such rule is a pure function with a test.
 *
 * Three rules run through all of it. A mutation that changes someone else's work
 * requires a reason. A destructive operation requires an explicit confirmation
 * that names its target, so it cannot be produced by shell history. And an unknown
 * flag is an error rather than being ignored, because a silently dropped flag is
 * how a command does something other than what was asked.
 */

export interface RequestPlan {
  readonly method: "GET" | "POST" | "DELETE";
  readonly path: string;
  readonly body?: Record<string, unknown>;
  /** Present for anything that changes state, so a retry is safe. */
  readonly idempotencyKey?: string;
  /** True when the command needs repository-admin standing. */
  readonly requiresAdmin: boolean;
}

export type ParseResult =
  | { readonly ok: true; readonly plan: RequestPlan }
  | { readonly ok: false; readonly exitCode: ExitCode; readonly message: string };

function usage(message: string): ParseResult {
  return { ok: false, exitCode: EXIT.usage, message };
}

interface Flags {
  readonly values: Map<string, string>;
  readonly bare: readonly string[];
}

/** Parses `--key value` and `--flag`. An unknown key is caught by the caller. */
function parseFlags(argv: readonly string[]): Flags {
  const values = new Map<string, string>();
  const bare: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (!token.startsWith("--")) {
      bare.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      values.set(key, "");
      continue;
    }
    values.set(key, next);
    i += 1;
  }
  return { values, bare };
}

function rejectUnknown(flags: Flags, allowed: readonly string[]): ParseResult | null {
  if (flags.bare.length > 0) return usage(`unexpected argument ${flags.bare[0]}`);
  for (const key of flags.values.keys()) {
    if (!allowed.includes(key)) return usage(`unknown flag --${key}`);
  }
  return null;
}

function requireRepo(flags: Flags): string | ParseResult {
  const repo = flags.values.get("repo") ?? "";
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return usage("--repo owner/name is required");
  return repo;
}

function requireRef(flags: Flags): string {
  const branch = flags.values.get("branch");
  return branch === undefined || branch === "" ? "refs/heads/main" : `refs/heads/${branch}`;
}

function requirePr(flags: Flags): number | ParseResult {
  const raw = flags.values.get("pr") ?? "";
  if (!/^[0-9]{1,9}$/.test(raw) || Number(raw) === 0) return usage("--pr <number> is required");
  return Number(raw);
}

/**
 * A reason is required for anything that affects work someone else is waiting on,
 * and it has to say something: a blank or one-word reason in an audit trail is
 * worse than none, because it looks like a justification.
 */
function requireReason(flags: Flags): string | ParseResult {
  const reason = (flags.values.get("reason") ?? "").trim();
  if (reason.length === 0) return usage("--reason <text> is required");
  if (reason.length < 8) return usage("--reason must explain why, not just name a word");
  if (new TextEncoder().encode(reason).length > 512) return usage("--reason exceeds 512 bytes");
  return reason;
}

function isPlan(value: string | number | ParseResult): value is ParseResult {
  return typeof value === "object";
}

/** Stable idempotency key: the same command twice is one effect. */
function key(parts: readonly (string | number)[]): string {
  return parts.join(":");
}

export function planQueueCommand(argv: readonly string[]): ParseResult {
  const [subcommand, ...rest] = argv;
  if (subcommand === undefined) return usage("thwip queue <status|explain|list|join|leave|pause|resume|reconcile|doctor|…>");
  const flags = parseFlags(rest);

  switch (subcommand) {
    case "status":
    case "list": {
      const unknown = rejectUnknown(flags, ["repo", "branch", "pr", "json", "watch"]);
      if (unknown !== null) return unknown;
      const repo = requireRepo(flags);
      if (isPlan(repo)) return repo;
      return {
        ok: true,
        plan: {
          method: "GET",
          path: `/v1/queue/{repositoryId}?ref=${encodeURIComponent(requireRef(flags))}`,
          requiresAdmin: false,
        },
      };
    }

    case "join": {
      const unknown = rejectUnknown(flags, ["repo", "branch", "pr", "sponsor", "wait"]);
      if (unknown !== null) return unknown;
      const repo = requireRepo(flags);
      if (isPlan(repo)) return repo;
      const pr = requirePr(flags);
      if (isPlan(pr)) return pr;
      const sponsor = flags.values.get("sponsor");
      return {
        ok: true,
        plan: {
          method: "POST",
          path: `/v1/queue/{repositoryId}/entries?ref=${encodeURIComponent(requireRef(flags))}`,
          body: {
            pullRequestNumber: pr,
            ...(sponsor === undefined || sponsor === "" ? {} : { sponsorLogin: sponsor }),
          },
          idempotencyKey: key(["join", repo, requireRef(flags), pr]),
          requiresAdmin: false,
        },
      };
    }

    case "leave": {
      const unknown = rejectUnknown(flags, ["repo", "branch", "pr"]);
      if (unknown !== null) return unknown;
      const repo = requireRepo(flags);
      if (isPlan(repo)) return repo;
      const pr = requirePr(flags);
      if (isPlan(pr)) return pr;
      const ref = requireRef(flags);
      return {
        ok: true,
        plan: {
          method: "DELETE",
          path: `/v1/queue/{repositoryId}/entries/entry_{repositoryId}_${pr}?ref=${encodeURIComponent(ref)}&reason=withdrawn`,
          idempotencyKey: key(["leave", repo, ref, pr]),
          requiresAdmin: false,
        },
      };
    }

    case "pause": {
      const unknown = rejectUnknown(flags, ["repo", "branch", "reason"]);
      if (unknown !== null) return unknown;
      const repo = requireRepo(flags);
      if (isPlan(repo)) return repo;
      const reason = requireReason(flags);
      if (isPlan(reason)) return reason;
      const ref = requireRef(flags);
      return {
        ok: true,
        plan: {
          method: "POST",
          path: `/v1/queue/{repositoryId}/pause?ref=${encodeURIComponent(ref)}`,
          body: { reason },
          idempotencyKey: key(["pause", repo, ref, reason]),
          requiresAdmin: true,
        },
      };
    }

    case "resume": {
      const unknown = rejectUnknown(flags, ["repo", "branch", "reason"]);
      if (unknown !== null) return unknown;
      const repo = requireRepo(flags);
      if (isPlan(repo)) return repo;
      const ref = requireRef(flags);
      return {
        ok: true,
        plan: {
          method: "POST",
          path: `/v1/queue/{repositoryId}/resume?ref=${encodeURIComponent(ref)}`,
          idempotencyKey: key(["resume", repo, ref]),
          requiresAdmin: true,
        },
      };
    }

    case "rebaseline": {
      const unknown = rejectUnknown(flags, ["repo", "branch", "reason", "base-sha"]);
      if (unknown !== null) return unknown;
      const repo = requireRepo(flags);
      if (isPlan(repo)) return repo;
      const reason = requireReason(flags);
      if (isPlan(reason)) return reason;
      const baseSha = flags.values.get("base-sha") ?? "";
      if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(baseSha)) {
        return usage("--base-sha <oid> is required, and must be the base the queue should adopt");
      }
      const ref = requireRef(flags);
      return {
        ok: true,
        plan: {
          method: "POST",
          path: `/v1/queue/{repositoryId}/rebaseline?ref=${encodeURIComponent(ref)}`,
          body: { baseSha, reason },
          idempotencyKey: key(["rebaseline", repo, ref, baseSha]),
          requiresAdmin: true,
        },
      };
    }

    case "eject": {
      const unknown = rejectUnknown(flags, ["repo", "branch", "pr", "reason"]);
      if (unknown !== null) return unknown;
      const repo = requireRepo(flags);
      if (isPlan(repo)) return repo;
      const pr = requirePr(flags);
      if (isPlan(pr)) return pr;
      // Ejecting removes work someone else is waiting on, so the reason is not
      // optional and it is recorded.
      const reason = requireReason(flags);
      if (isPlan(reason)) return reason;
      const ref = requireRef(flags);
      return {
        ok: true,
        plan: {
          method: "DELETE",
          path: `/v1/queue/{repositoryId}/entries/entry_{repositoryId}_${pr}?ref=${encodeURIComponent(ref)}&reason=${encodeURIComponent(reason)}`,
          idempotencyKey: key(["eject", repo, ref, pr, reason]),
          requiresAdmin: true,
        },
      };
    }

    case "bypass": {
      const unknown = rejectUnknown(flags, ["repo", "branch", "pr", "reason", "confirm"]);
      if (unknown !== null) return unknown;
      const repo = requireRepo(flags);
      if (isPlan(repo)) return repo;
      const pr = requirePr(flags);
      if (isPlan(pr)) return pr;
      const reason = requireReason(flags);
      if (isPlan(reason)) return reason;
      // Bypass merges without the evidence the queue exists to require, so it
      // needs a confirmation naming its exact target. A generic --force could be
      // recalled from shell history; `owner/name#42` cannot be typed by accident.
      const confirm = flags.values.get("confirm") ?? "";
      const expected = `${repo}#${pr}`;
      if (confirm !== expected) {
        return usage(`--confirm ${expected} is required to bypass the queue for this pull request`);
      }
      return {
        ok: true,
        plan: {
          method: "POST",
          path: `/v1/queue/{repositoryId}/bypass?ref=${encodeURIComponent(requireRef(flags))}`,
          body: { pullRequestNumber: pr, reason },
          idempotencyKey: key(["bypass", repo, pr, reason]),
          requiresAdmin: true,
        },
      };
    }

    case "explain": {
      // The command I wanted every time something sat in the queue and I could not
      // tell why. One call: lane holder, per-entry blocker, deadlines, recent events.
      const unknown = rejectUnknown(flags, ["repo", "branch", "events", "json"]);
      if (unknown !== null) return unknown;
      const repo = requireRepo(flags);
      if (isPlan(repo)) return repo;
      const events = flags.values.get("events") ?? "25";
      if (!/^[0-9]{1,3}$/.test(events)) return usage("--events must be a small number");
      return {
        ok: true,
        plan: {
          method: "GET",
          path: `/v1/queue/{repositoryId}/explain?ref=${encodeURIComponent(requireRef(flags))}&events=${events}`,
          requiresAdmin: false,
        },
      };
    }

    case "reconcile": {
      const unknown = rejectUnknown(flags, ["repo", "branch", "observed", "merge-sha", "reason"]);
      if (unknown !== null) return unknown;
      const repo = requireRepo(flags);
      if (isPlan(repo)) return repo;
      const reason = requireReason(flags);
      if (isPlan(reason)) return reason;
      const observed = flags.values.get("observed") ?? "";
      if (!["merged", "not-merged", "merged-outside-the-turn"].includes(observed)) {
        return usage("--observed must be merged | not-merged | merged-outside-the-turn");
      }
      const mergeSha = flags.values.get("merge-sha") ?? "";
      if (observed !== "not-merged" && !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(mergeSha)) {
        return usage("--merge-sha <oid> is required unless --observed not-merged");
      }
      return {
        ok: true,
        plan: {
          method: "POST",
          path: `/v1/queue/{repositoryId}/reconcile?ref=${encodeURIComponent(requireRef(flags))}`,
          body: { observed, reason, ...(mergeSha === "" ? {} : { mergeSha }) },
          idempotencyKey: key(["reconcile", repo, observed, mergeSha]),
          requiresAdmin: true,
        },
      };
    }

    case "work": {
      // The actual watch loop lives in queue-work.ts and is dispatched there
      // directly (it heartbeats on an interval rather than making one
      // request), so this only validates arguments. The plan below names the
      // endpoint the loop calls, for `queue --help` and for anything that
      // inspects a plan without executing it.
      const unknown = rejectUnknown(flags, ["repo", "branch", "watch"]);
      if (unknown !== null) return unknown;
      const repo = requireRepo(flags);
      if (isPlan(repo)) return repo;
      if (!flags.values.has("watch")) {
        return usage("thwip queue work --repo OWNER/NAME --watch [--branch BRANCH]");
      }
      return {
        ok: true,
        plan: {
          method: "POST",
          path: `/v1/queue/{repositoryId}/runners/heartbeat?ref=${encodeURIComponent(requireRef(flags))}`,
          requiresAdmin: false,
        },
      };
    }

    case "doctor": {
      const unknown = rejectUnknown(flags, ["repo", "explain", "strict", "json"]);
      if (unknown !== null) return unknown;
      const repo = requireRepo(flags);
      if (isPlan(repo)) return repo;
      return {
        ok: true,
        plan: { method: "GET", path: `/admin/queue/doctor?repo=${encodeURIComponent(repo)}`, requiresAdmin: true },
      };
    }

    default:
      return usage(`unknown subcommand \`queue ${subcommand}\``);
  }
}

/** Subcommands that change state, for the confirmation and audit surfaces. */
export const MUTATING_SUBCOMMANDS = [
  "reconcile",
  "join",
  "leave",
  "pause",
  "resume",
  "rebaseline",
  "eject",
  "bypass",
] as const;

export function isMutating(subcommand: string): boolean {
  return (MUTATING_SUBCOMMANDS as readonly string[]).includes(subcommand);
}
