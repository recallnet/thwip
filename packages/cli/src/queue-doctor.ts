import { EXIT, exitCodeFor, type ExitCode, type ReasonCode } from "./queue-exit.js";

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
      path: `/v1/queue/{repositoryId}/readiness?ref=${encodeURIComponent(input.ref)}`,
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
  EXIT.sourceChanged,
  EXIT.invariant,
  EXIT.unavailable,
  EXIT.ok,
];

function worst(codes: readonly ExitCode[]): ExitCode {
  return SEVERITY.find((code) => codes.includes(code)) ?? EXIT.ok;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
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
  if (typeof id !== "string") {
    return {
      lines: [`The control plane returned no repository id for ${repo}.`],
      status: "unread",
      reasonCode: "INVARIANT_FAILURE",
    };
  }
  const projectId = record(o.body)["projectId"];
  return {
    lines: [`thwip is installed on ${repo} (repository ${id}).`],
    status: "pass",
    reasonCode: "PASS",
    facts: { repository: repo, repositoryId: id, projectId: typeof projectId === "string" ? projectId : null },
  };
}

function describeQueue(
  o: DoctorObservation,
  ref: string,
  expected: { repositoryId: string; projectId: string },
): Part {
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
  const projectId = body["projectId"];
  const repositoryId = body["repositoryId"];
  const baseRef = body["baseRef"];
  const projectEnabled = body["projectEnabled"];
  const activePolicyDigest = body["activePolicyDigest"];
  const queueConfigured = body["queueConfigured"];
  const queueEnabled = body["queueEnabled"];
  const activationState = body["activationState"];
  const setupComplete = body["setupComplete"];
  if (
    typeof projectId !== "string" ||
    typeof repositoryId !== "string" ||
    typeof baseRef !== "string" ||
    typeof projectEnabled !== "boolean" ||
    !(activePolicyDigest === null || typeof activePolicyDigest === "string") ||
    typeof queueConfigured !== "boolean" ||
    typeof queueEnabled !== "boolean" ||
    !(activationState === null || typeof activationState === "string") ||
    typeof setupComplete !== "boolean"
  ) {
    return {
      lines: [`The control plane returned incomplete queue readiness for ${ref}.`],
      status: "unread",
      reasonCode: "INVARIANT_FAILURE",
    };
  }
  const facts = {
    ref: baseRef,
    projectId,
    repositoryId,
    projectEnabled,
    activePolicyDigest,
    queueConfigured,
    queueEnabled,
    activationState,
    setupComplete,
  };
  if (repositoryId !== expected.repositoryId || projectId !== expected.projectId || baseRef !== ref) {
    return {
      lines: [`The control plane returned queue readiness for a different project incarnation or branch than ${ref}.`],
      status: "unread",
      reasonCode: "INVARIANT_FAILURE",
      facts,
    };
  }
  if (!projectEnabled) {
    return {
      lines: [`The current project for ${ref} is disabled.`],
      status: "fail",
      reasonCode: "PROJECT_DISABLED",
      facts,
    };
  }
  if (activePolicyDigest === null) {
    return {
      lines: [`The current project for ${ref} has no active policy.`],
      status: "fail",
      reasonCode: "POLICY_CHANGED",
      facts,
    };
  }
  if (!queueConfigured || !queueEnabled || activationState !== "enforced" || !setupComplete) {
    return {
      lines: [
        !queueConfigured
          ? `No queue is configured for ${ref}.`
          : `The queue for ${ref} is not ready (enabled: ${queueEnabled}, state: ${activationState ?? "none"}, setup complete: ${setupComplete}).`,
      ],
      status: "fail",
      reasonCode: "QUEUE_NOT_CONFIGURED",
      facts,
    };
  }
  return {
    lines: [`The queue for ${ref} is enabled, fully set up, and enforced.`],
    status: "pass",
    reasonCode: "PASS",
    facts,
  };
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
  if (o.status === 404) {
    return {
      lines: ["The Thwip App installation is missing from this repository."],
      status: "fail",
      reasonCode: "APP_UNINSTALLED",
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
  const missingBody = body["missingPermissions"];
  const healthBody = body["rulesetHealth"];
  const workflowBody = body["workflowHealth"];
  if (
    missingBody === null ||
    typeof missingBody !== "object" ||
    Array.isArray(missingBody) ||
    typeof body["canPublishMergeCheck"] !== "boolean" ||
    typeof body["receivesEveryHandledEvent"] !== "boolean" ||
    healthBody === null ||
    typeof healthBody !== "object" ||
    Array.isArray(healthBody) ||
    typeof (healthBody as Record<string, unknown>)["healthy"] !== "boolean" ||
    !stringArray((healthBody as Record<string, unknown>)["expectedNames"]) ||
    !stringArray((healthBody as Record<string, unknown>)["missing"]) ||
    !stringArray((healthBody as Record<string, unknown>)["duplicate"]) ||
    !stringArray((healthBody as Record<string, unknown>)["drifted"]) ||
    typeof (healthBody as Record<string, unknown>)["bypassActorsKnown"] !== "boolean" ||
    workflowBody === null ||
    typeof workflowBody !== "object" ||
    Array.isArray(workflowBody) ||
    typeof (workflowBody as Record<string, unknown>)["healthy"] !== "boolean" ||
    !stringArray((workflowBody as Record<string, unknown>)["expectedPaths"]) ||
    !stringArray((workflowBody as Record<string, unknown>)["missing"]) ||
    !stringArray((workflowBody as Record<string, unknown>)["drifted"]) ||
    typeof (workflowBody as Record<string, unknown>)["actionRef"] !== "string" ||
    typeof (workflowBody as Record<string, unknown>)["actionAccessible"] !== "boolean"
  ) {
    return {
      lines: ["The control plane returned incomplete App or ruleset diagnostics."],
      status: "unread",
      reasonCode: "INVARIANT_FAILURE",
    };
  }
  const missing = Object.keys(record(body["missingPermissions"]));
  const rulesetHealth = record(healthBody);
  const workflowHealth = record(workflowBody);
  const expectedNames = Array.isArray(rulesetHealth["expectedNames"])
    ? (rulesetHealth["expectedNames"] as unknown[]).filter((name): name is string => typeof name === "string")
    : [];
  const missingRulesets = Array.isArray(rulesetHealth["missing"])
    ? (rulesetHealth["missing"] as unknown[]).filter((name): name is string => typeof name === "string")
    : [];
  const duplicateRulesets = Array.isArray(rulesetHealth["duplicate"])
    ? (rulesetHealth["duplicate"] as unknown[]).filter((name): name is string => typeof name === "string")
    : [];
  const driftedRulesets = Array.isArray(rulesetHealth["drifted"])
    ? (rulesetHealth["drifted"] as unknown[]).filter((name): name is string => typeof name === "string")
    : [];
  const expectedWorkflows = Array.isArray(workflowHealth["expectedPaths"])
    ? (workflowHealth["expectedPaths"] as unknown[]).filter((path): path is string => typeof path === "string")
    : [];
  const missingWorkflows = Array.isArray(workflowHealth["missing"])
    ? (workflowHealth["missing"] as unknown[]).filter((path): path is string => typeof path === "string")
    : [];
  const driftedWorkflows = Array.isArray(workflowHealth["drifted"])
    ? (workflowHealth["drifted"] as unknown[]).filter((path): path is string => typeof path === "string")
    : [];
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
  if (body["receivesEveryHandledEvent"] === false) {
    lines.push("The App is not subscribed to every GitHub event its handlers require.");
  }
  if (rulesetHealth["healthy"] === true) {
    lines.push(`GitHub is actively enforcing the exact ${expectedNames.join(" and ")} rulesets.`);
  } else {
    const findings = [
      ...missingRulesets.map((name) => `missing ${name}`),
      ...duplicateRulesets.map((name) => `duplicate ${name}`),
      ...driftedRulesets.map((name) => `drifted ${name}`),
    ];
    lines.push(`The managed branch rulesets are not exact: ${findings.join(", ") || "unknown drift"}.`);
  }
  if (rulesetHealth["bypassActorsKnown"] === false) {
    lines.push("GitHub hid bypass actors from the App, so doctor cannot confirm the managed rulesets are exact.");
  }
  if (workflowHealth["healthy"] === true) {
    lines.push("The default branch has the exact managed workflows and can read the pinned verifier action.");
  } else {
    const findings = [
      ...missingWorkflows.map((path) => `missing ${path}`),
      ...driftedWorkflows.map((path) => `drifted ${path}`),
      ...(workflowHealth["actionAccessible"] === false ? ["pinned verifier action is inaccessible"] : []),
    ];
    lines.push(`The managed workflows are not ready: ${findings.join(", ") || "unknown drift"}.`);
  }
  const appBad =
    missing.length > 0 ||
    body["canPublishMergeCheck"] === false ||
    body["receivesEveryHandledEvent"] === false;
  const rulesetBad =
    missingRulesets.length > 0 || duplicateRulesets.length > 0 || driftedRulesets.length > 0;
  const bypassActorsUnread = !rulesetBad && rulesetHealth["bypassActorsKnown"] === false;
  const workflowBad = workflowHealth["healthy"] !== true;
  const bad = appBad || rulesetBad || workflowBad;
  return {
    lines,
    status: bad ? "fail" : bypassActorsUnread ? "unread" : "pass",
    reasonCode: appBad
      ? "APP_PERMISSION_DRIFT"
      : rulesetBad
        ? "RULESET_DRIFT"
        : workflowBad
          ? "NO_PINNED_VERIFIER"
          : bypassActorsUnread
            ? "OWNER_UNAUTHORIZED"
            : "PASS",
    facts: {
      missingPermissions: missing,
      canPublishMergeCheck: body["canPublishMergeCheck"] === true,
      receivesEveryHandledEvent: body["receivesEveryHandledEvent"] === true,
      rulesetHealth: {
        healthy: rulesetHealth["healthy"] === true,
        expectedNames,
        missing: missingRulesets,
        duplicate: duplicateRulesets,
        drifted: driftedRulesets,
        bypassActorsKnown: rulesetHealth["bypassActorsKnown"] === true,
      },
      workflowHealth: {
        healthy: workflowHealth["healthy"] === true,
        expectedPaths: expectedWorkflows,
        missing: missingWorkflows,
        drifted: driftedWorkflows,
        actionRef: typeof workflowHealth["actionRef"] === "string" ? workflowHealth["actionRef"] : null,
        actionAccessible: workflowHealth["actionAccessible"] === true,
      },
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
  const repositoryPart = describeRepository(
    repository ?? { section: "repository", status: 0, body: null },
    options.repo,
  );
  add("repository", repositoryPart);
  const resolvedRepositoryId = repository?.body?.["repositoryId"];
  const resolvedProjectId = repository?.body?.["projectId"];
  const exactProject =
    typeof resolvedRepositoryId === "string" && typeof resolvedProjectId === "string"
      ? { repositoryId: resolvedRepositoryId, projectId: resolvedProjectId }
      : null;

  const queue = seen("queue");
  if (queue !== undefined && exactProject !== null) add("queue", describeQueue(queue, options.ref, exactProject));
  else if (queue !== undefined && repositoryPart.status === "pass") {
    add("queue", {
      lines: ["The repository lookup returned no exact project incarnation for the readiness check."],
      status: "unread",
      reasonCode: "INVARIANT_FAILURE",
    });
  }
  else if (repositoryPart.status === "pass") {
    add("queue", {
      lines: [`Could not reach the control plane to read the queue for ${options.ref}.`],
      status: "unread",
      reasonCode: "SERVICE_UNAVAILABLE",
    });
  }

  const app = seen("app");
  if (app !== undefined) add("app", describeApp(app));
  else if (repositoryPart.status === "pass") add("app", describeApp({ section: "app", status: 0, body: null }));

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
