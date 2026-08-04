import { EXIT, exitCodeFor, nextActionFor, type ExitCode, type ReasonCode } from "./queue-exit.js";

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
 * genuinely admin material.
 *
 * Every section lands in one of three states. It passed, it failed, or nobody
 * read it. The third used to score as the first: a 403 on the App section
 * exited zero, so the command whose job is to say whether this project is set
 * up correctly answered "fine" about a thing it had not looked at. Unread now
 * carries its own exit code, and `--allow-unread` is the one way to spend it.
 *
 * The opt-out covers standing and nothing else. A member who is not a
 * repository admin cannot read App permissions, and that is a fact about them
 * rather than about the project, so they may say so and still exit zero. A
 * control plane that never answered, or a session that is not signed in, is not
 * forgiven by the flag: exiting zero there would be the same lie one step
 * along.
 */

export type DoctorSection = "repository" | "queue" | "app";

/**
 * Read and good, read and bad, or not read. Folding the third into the first is
 * the defect this type exists to make unwritable.
 */
export type CheckStatus = "pass" | "fail" | "unread";

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

export interface DoctorSectionResult {
  readonly section: DoctorSection;
  readonly status: CheckStatus;
  readonly lines: readonly string[];
  /**
   * The shared code for this section, so the sentence a person reads and the
   * code a program branches on come from the same table.
   */
  readonly reasonCode: ReasonCode;
  /** What this section alone would exit with, from the code above. */
  readonly exitCode: ExitCode;
  /** Non-secret values this section actually read. Nothing is defaulted in. */
  readonly facts: Record<string, unknown>;
}

export interface DoctorReport {
  readonly lines: readonly string[];
  readonly exitCode: ExitCode;
  readonly sections: readonly DoctorSectionResult[];
  /** Sections nobody read, named so nobody assumes. */
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

/**
 * One section's finding. The exit code is derived from `reasonCode` through the
 * table every other command uses, so a section cannot exit under one meaning
 * while saying another.
 */
type Part = {
  lines: string[];
  status: CheckStatus;
  reasonCode: ReasonCode;
  facts?: Record<string, unknown>;
};

function describeRepository(o: DoctorObservation, repo: string): Part {
  if (o.status === 0) {
    return {
      lines: [`Could not reach the control plane to look up ${repo}.`],
      status: "unread",
      reasonCode: "SERVICE_UNAVAILABLE",
    };
  }
  if (o.status === 401) {
    return { lines: ["You are not signed in. Run thwip login."], status: "unread", reasonCode: "LOGIN_REQUIRED" };
  }
  if (o.status === 404) {
    return {
      lines: [`thwip is not installed on ${repo}. Ask an admin to install the Thwip App on it.`],
      status: "fail",
      reasonCode: "APP_UNINSTALLED",
    };
  }
  if (o.status === 403) {
    return {
      lines: [`Looking up ${repo} was refused, so nothing below is about it.`],
      status: "unread",
      reasonCode: "OWNER_UNAUTHORIZED",
    };
  }
  if (o.status >= 400) {
    return {
      lines: [`The control plane refused to look up ${repo} (${o.status}).`],
      status: "unread",
      reasonCode: "SERVICE_UNAVAILABLE",
    };
  }
  const id = record(o.body)["repositoryId"];
  return {
    lines: [`thwip is installed on ${repo} (repository ${String(id ?? "unknown")}).`],
    status: "pass",
    reasonCode: "PASS",
    facts: { repository: repo, repositoryId: typeof id === "string" ? id : null },
  };
}

function describeQueue(o: DoctorObservation, ref: string): Part {
  if (o.status === 0) {
    return {
      lines: [`Could not reach the control plane to read the queue for ${ref}.`],
      status: "unread",
      reasonCode: "SERVICE_UNAVAILABLE",
    };
  }
  if (o.status === 401) {
    return {
      lines: [`Reading the queue for ${ref} needs a signed-in session. Run thwip login.`],
      status: "unread",
      reasonCode: "LOGIN_REQUIRED",
    };
  }
  if (o.status === 403) {
    return {
      lines: [`Reading the queue for ${ref} was refused, so nothing below is from it.`],
      status: "unread",
      reasonCode: "OWNER_UNAUTHORIZED",
    };
  }
  if (o.status === 404) {
    return { lines: [`No queue is configured for ${ref}.`], status: "fail", reasonCode: "QUEUE_NOT_CONFIGURED" };
  }
  if (o.status >= 400) {
    return {
      lines: [`The control plane refused to read the queue for ${ref} (${o.status}).`],
      status: "unread",
      reasonCode: "SERVICE_UNAVAILABLE",
    };
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

  return {
    lines,
    status: "pass",
    reasonCode: "PASS",
    facts: {
      ref,
      paused: snapshot["paused"] === true,
      waiting: entries.length,
      laneHeld: typeof snapshot["activeAttemptId"] === "string",
    },
  };
}

/**
 * A blocking reason as the rest of thwip says it. The route answers with a
 * reason code where it has one and a phrase where it does not, and quoting a
 * bare code at a developer is the thing the shared table exists to stop.
 */
function explain(blockedBy: string): string {
  return /^[A-Z][A-Z_]+$/.test(blockedBy) ? nextActionFor(blockedBy) : `${blockedBy}.`;
}

function describeApp(o: DoctorObservation): Part {
  if (o.status === 0) {
    return {
      lines: ["Could not reach the control plane to read App permissions."],
      status: "unread",
      reasonCode: "SERVICE_UNAVAILABLE",
    };
  }
  if (o.status === 401) {
    return {
      lines: ["Reading App permissions needs a signed-in session. Run thwip login."],
      status: "unread",
      reasonCode: "LOGIN_REQUIRED",
    };
  }
  if (o.status === 403) {
    return {
      lines: [
        "App permissions and branch rulesets need repository admin, so this run did not read them.",
        "Ask an admin to run thwip queue doctor, or pass --allow-unread to accept not knowing.",
      ],
      status: "unread",
      reasonCode: "OWNER_UNAUTHORIZED",
    };
  }
  if (o.status >= 400) {
    return {
      lines: [`The control plane refused to read App permissions (${o.status}).`],
      status: "unread",
      reasonCode: "SERVICE_UNAVAILABLE",
    };
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
  // Named for what it costs. An operator reading a scope name alone cannot tell
  // that the same permission carries the merge and the sentence on the page.
  if (body["canComment"] === false) {
    lines.push("It also cannot write the status comment on a queued pull request, so nothing on the page will say why.");
  }
  lines.push(rulesets === 1 ? "1 ruleset applies to this repository." : `${rulesets} rulesets apply to this repository.`);
  const bad = missing.length > 0 || body["canPublishMergeCheck"] === false;
  return {
    lines,
    status: bad ? "fail" : "pass",
    reasonCode: bad ? "APP_PERMISSION_DRIFT" : "PASS",
    facts: {
      missingPermissions: missing,
      canPublishMergeCheck: body["canPublishMergeCheck"] === true,
      rulesets,
    },
  };
}

export function reportDoctor(
  observations: readonly DoctorObservation[],
  options: { repo: string; ref: string; allowUnread: boolean },
): DoctorReport {
  const sections: DoctorSectionResult[] = [];

  const seen = (section: DoctorSection) => observations.find((o) => o.section === section);
  const add = (section: DoctorSection, part: Part) => {
    sections.push({
      section,
      status: part.status,
      lines: part.lines,
      reasonCode: part.reasonCode,
      exitCode: exitCodeFor(part.reasonCode),
      facts: part.facts ?? {},
    });
  };

  const repository = seen("repository");
  if (repository !== undefined) add("repository", describeRepository(repository, options.repo));

  const queue = seen("queue");
  if (queue !== undefined) add("queue", describeQueue(queue, options.ref));

  const app = seen("app");
  if (app !== undefined) add("app", describeApp(app));

  const codes = sections.map((section) => {
    // `--allow-unread` buys off a section this caller has no standing to read
    // and nothing else. An unreachable control plane and an unauthenticated
    // session stay what they are, because neither is about who is asking.
    const forgiven =
      options.allowUnread && section.status === "unread" && section.exitCode === EXIT.permission;
    return forgiven ? EXIT.ok : section.exitCode;
  });

  return {
    lines: sections.flatMap((section) => section.lines),
    exitCode: worst(codes),
    sections,
    unread: sections.filter((section) => section.status === "unread").map((section) => section.section),
  };
}
