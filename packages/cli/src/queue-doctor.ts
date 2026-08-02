import { EXIT, nextActionFor, type ExitCode } from "./queue-exit.js";

/**
 * `thwip queue doctor`, as three reads rather than one.
 *
 * It used to send the developer's session to `/admin/queue/doctor`, an endpoint
 * only an operator token opens. So the command failed for everybody except the
 * people who would never need to run it, which makes it not a diagnostic.
 *
 * Two of the three things doctor reports are readable by any member of the
 * repository: whether thwip is installed here at all, and what the queue is
 * doing on this branch. The third, what the GitHub App is granted and what the
 * branch ruleset requires, comes from GitHub under the installation and is
 * genuinely admin material. So the command reads the first two through member
 * routes, asks for the third, and when that is refused it says which part it
 * could not see and reports the rest. `--strict` is for the setup script that
 * wants a partial answer to fail.
 */

export type DoctorSection = "repository" | "queue" | "app";

export interface DoctorProbe {
  readonly section: DoctorSection;
  readonly method: "GET";
  /** `{repositoryId}` is substituted once the first probe has answered. */
  readonly path: string;
  readonly requiresAdmin: boolean;
}

export function doctorProbes(input: { repo: string; ref: string; events: number }): DoctorProbe[] {
  return [
    {
      section: "repository",
      method: "GET",
      path: `/v1/resolve-repo?name=${encodeURIComponent(input.repo)}`,
      requiresAdmin: false,
    },
    {
      section: "queue",
      method: "GET",
      path: `/v1/queue/{repositoryId}/explain?ref=${encodeURIComponent(input.ref)}&events=${input.events}`,
      requiresAdmin: false,
    },
    { section: "app", method: "GET", path: "/v1/queue/{repositoryId}/doctor", requiresAdmin: true },
  ];
}

export interface DoctorObservation {
  readonly section: DoctorSection;
  /** 0 when the request never completed. */
  readonly status: number;
  readonly body: Record<string, unknown> | null;
}

export interface DoctorReport {
  readonly lines: readonly string[];
  readonly exitCode: ExitCode;
  /** Sections this caller was not allowed to read, named so nobody assumes. */
  readonly unread: readonly DoctorSection[];
}

/** Worst first, so the code a reader gets is the worst thing doctor found. */
const SEVERITY: ExitCode[] = [
  EXIT.authRequired,
  EXIT.setupInvalid,
  EXIT.permission,
  EXIT.unavailable,
  EXIT.ok,
];

function worst(codes: readonly ExitCode[]): ExitCode {
  return SEVERITY.find((code) => codes.includes(code)) ?? EXIT.ok;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function describeRepository(o: DoctorObservation, repo: string): { lines: string[]; exitCode: ExitCode } {
  if (o.status === 0) {
    return { lines: [`Could not reach the control plane to look up ${repo}.`], exitCode: EXIT.unavailable };
  }
  if (o.status === 401) return { lines: ["You are not signed in. Run thwip login."], exitCode: EXIT.authRequired };
  if (o.status === 404) {
    return {
      lines: [`thwip is not installed on ${repo}. Ask an admin to install the Thwip App on it.`],
      exitCode: EXIT.setupInvalid,
    };
  }
  if (o.status >= 400) {
    return { lines: [`The control plane refused to look up ${repo} (${o.status}).`], exitCode: EXIT.unavailable };
  }
  const id = record(o.body)["repositoryId"];
  return { lines: [`thwip is installed on ${repo} (repository ${String(id ?? "unknown")}).`], exitCode: EXIT.ok };
}

function describeQueue(
  o: DoctorObservation,
  ref: string,
): { lines: string[]; exitCode: ExitCode; unread: boolean } {
  if (o.status === 0) {
    return { lines: [`Could not reach the control plane to read the queue for ${ref}.`], exitCode: EXIT.unavailable, unread: true };
  }
  if (o.status === 401 || o.status === 403) {
    return { lines: [`Reading the queue for ${ref} was refused, so nothing below is from it.`], exitCode: EXIT.ok, unread: true };
  }
  if (o.status === 404) {
    return { lines: [`No queue is configured for ${ref}.`], exitCode: EXIT.setupInvalid, unread: false };
  }
  if (o.status >= 400) {
    return { lines: [`The control plane refused to read the queue for ${ref} (${o.status}).`], exitCode: EXIT.unavailable, unread: true };
  }

  const body = record(o.body);
  const snapshot = record(body["snapshot"]);
  const all = Array.isArray(snapshot["entries"]) ? (snapshot["entries"] as Record<string, unknown>[]) : [];
  // The document keeps merged and cancelled entries, and counting them read as
  // twenty-two pull requests waiting on a queue that had one live entry.
  const entries = all.filter((e) => e["state"] !== "Merged" && e["state"] !== "Cancelled");
  const why = Array.isArray(body["why"]) ? (body["why"] as Record<string, unknown>[]) : [];
  const lines: string[] = [];

  if (snapshot["paused"] === true) {
    const reason = snapshot["pauseReason"];
    lines.push(
      typeof reason === "string" && reason.length > 0
        ? `The queue for ${ref} is paused: ${reason}.`
        : `The queue for ${ref} is paused.`,
    );
  } else {
    const holding = snapshot["activeAttemptId"];
    lines.push(
      `The queue for ${ref} is running, with ${entries.length} waiting and ` +
        (typeof holding === "string" ? "one holding the lane." : "nothing holding the lane."),
    );
  }

  for (const entry of entries) {
    const number = entry["pullRequestNumber"];
    const state = String(entry["state"] ?? "unknown");
    const blocked = why.find((w) => w["pullRequestNumber"] === number)?.["blockedBy"];
    const said = typeof blocked === "string" && blocked.length > 0 ? explain(blocked) : "nothing is holding it.";
    lines.push(`  #${String(number)} ${state}: ${said}`);
  }

  return { lines, exitCode: EXIT.ok, unread: false };
}

/**
 * A blocking reason as the rest of thwip says it. The route answers with a
 * reason code where it has one and a phrase where it does not, and quoting a
 * bare code at a developer is the thing the shared table exists to stop.
 */
function explain(blockedBy: string): string {
  return /^[A-Z][A-Z_]+$/.test(blockedBy) ? nextActionFor(blockedBy) : `${blockedBy}.`;
}

function describeApp(o: DoctorObservation): { lines: string[]; exitCode: ExitCode; unread: boolean } {
  if (o.status === 0) {
    return { lines: ["Could not reach the control plane to read App permissions."], exitCode: EXIT.unavailable, unread: true };
  }
  if (o.status === 401 || o.status === 403) {
    return {
      lines: [
        "App permissions and branch rulesets need repository admin, so this run did not read them.",
        "Ask an admin to run thwip queue doctor if the queue looks configured and still will not merge.",
      ],
      exitCode: EXIT.ok,
      unread: true,
    };
  }
  if (o.status >= 400) {
    return { lines: [`The control plane refused to read App permissions (${o.status}).`], exitCode: EXIT.unavailable, unread: true };
  }

  const body = record(o.body);
  const missing = Object.keys(record(body["missingPermissions"]));
  const rulesets = Array.isArray(body["rulesets"]) ? body["rulesets"].length : 0;
  const lines: string[] = [];
  if (missing.length === 0) {
    lines.push("The Thwip App holds every permission the queue needs.");
  } else {
    lines.push(`The Thwip App is missing ${missing.join(", ")}. An admin needs to reinstall it with those granted.`);
  }
  if (body["canPublishMergeCheck"] === false) {
    lines.push("Without the checks permission it cannot publish the check the branch requires, so nothing will ever merge.");
  }
  lines.push(rulesets === 1 ? "1 ruleset applies to this repository." : `${rulesets} rulesets apply to this repository.`);
  return { lines, exitCode: missing.length === 0 ? EXIT.ok : EXIT.setupInvalid, unread: false };
}

export function reportDoctor(
  observations: readonly DoctorObservation[],
  options: { repo: string; ref: string; strict: boolean },
): DoctorReport {
  const lines: string[] = [];
  const codes: ExitCode[] = [];
  const unread: DoctorSection[] = [];

  const seen = (section: DoctorSection) => observations.find((o) => o.section === section);

  const repository = seen("repository");
  if (repository !== undefined) {
    const part = describeRepository(repository, options.repo);
    lines.push(...part.lines);
    codes.push(part.exitCode);
  }

  const queue = seen("queue");
  if (queue !== undefined) {
    const part = describeQueue(queue, options.ref);
    lines.push(...part.lines);
    codes.push(part.exitCode);
    if (part.unread) unread.push("queue");
  }

  const app = seen("app");
  if (app !== undefined) {
    const part = describeApp(app);
    lines.push(...part.lines);
    codes.push(part.exitCode);
    if (part.unread) unread.push("app");
  }

  // A partial answer is the point of the command, so it exits 0 by default. A
  // caller that needs the whole picture asks for --strict and gets told which
  // part is missing.
  if (options.strict && unread.length > 0) codes.push(EXIT.permission);

  return { lines, exitCode: worst(codes), unread };
}
