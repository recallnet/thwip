import type { D1Like } from "./projection.js";
import { setupPullRequestFiles, verifierWorkflowFile, type SetupFile } from "./bootstrap-workflows.js";
import {
  bootstrapCheckRuns,
  BOOTSTRAP_STEPS,
  bypassActorsMatch,
  bypassActorsVisible,
  checkAppRuleset,
  diffRuleset,
  GITHUB_ACTIONS_INTEGRATION_ID,
  appOwnershipRuleset,
  mayActivate,
  nextBootstrapStep,
  policyRuleset,
  POLICY_RULESET_NAME,
  proofContextFor,
  proofIntegrationFor,
  rulesetConfigurationMatches,
  type ProofCheckMode,
  type BootstrapProgress,
  type BootstrapStep,
  type Ruleset,
} from "./rulesets.js";
import { PROOF_CHECK, TURN_CHECK, WORKFLOW_CHECK } from "./turn-check.js";
import { databaseSchemaCapabilities } from "../schema-state.js";

/**
 * Enrolling a repository, through the product.
 *
 * The product must own the complete setup sequence rather than rely on manual
 * database rows, copied workflows, or command-line ruleset writes. New
 * enrolments use the App as their merge writer, so setup does not ask an adopter
 * to mint a branch-write token.
 *
 * The order is the order in `rulesets.ts`, which is not arbitrary: GitHub will
 * not source-pin a context that does not already exist as a requirement, and it
 * will not offer an App as a source unless the App has recently published a
 * check with that name. Doing the tempting thing instead, creating one active
 * pinned ruleset, fails, and it fails after leaving a branch requiring a check
 * nothing will post. So setup first asks an administrator for a disabled,
 * unpinned policy, publishes the check against it, asks for the pin while the
 * policy still cannot block, reads it back, and only then offers activation.
 *
 * Nothing here writes a ruleset or decides on its own to activate. Every step
 * that could leave a branch unmergeable stops for a repository administrator,
 * and a refusal stops the run where it is with the policy still disabled.
 */

export interface QueueProject {
  readonly id: string;
  readonly organizationId: string;
  readonly repositoryId: string;
  readonly baseRef: string;
  readonly enabled: boolean;
  readonly activationState: string;
  readonly chainPublic: boolean;
  readonly progress: BootstrapProgress;
  readonly projectId: string;
  readonly verifierWorkflowVersion: 1 | 2;
  readonly verifierProtocol: 1 | 2 | 3;
}

export interface SetupPullRequestState {
  readonly number: number;
  readonly state: "open" | "closed";
  readonly merged: boolean;
  readonly headSha: string;
}

export interface StoredRuleset {
  readonly id: number;
  readonly ruleset: Ruleset;
}

/**
 * The repository side of enrolment.
 *
 * Narrow on purpose. Every call it makes is one a person had to make by hand,
 * and a port this shape is what lets the sequence be tested without a
 * repository to ruin.
 */
export interface BootstrapGitHub {
  /** The tip of the base branch, which the bootstrap check is published on. */
  baseSha(): Promise<string>;
  setupPullRequest(): Promise<SetupPullRequestState | null>;
  openSetupPullRequest(input: {
    files: readonly SetupFile[];
    baseSha: string;
    /** Only replace the reserved branch when it still has this closed pull request's head. */
    replaceHeadSha?: string;
  }): Promise<SetupPullRequestState>;
  verifierUpgradePullRequest(): Promise<SetupPullRequestState | null>;
  openVerifierUpgradePullRequest(input: {
    files: readonly SetupFile[];
    baseSha: string;
    /** Only replace the reserved branch when it still has this closed pull request's head. */
    replaceHeadSha?: string;
  }): Promise<SetupPullRequestState>;
  /** Exact default-branch verifier after a person merges the upgrade. */
  verifierWorkflowAtBase?(): Promise<{ commitSha: string; blobSha: string; content: string }>;
  /** GitHub's observed permissions for this exact App installation. */
  installationPermissions?(): Promise<Readonly<Record<string, string>> | null>;
  rulesetNamed(name: string): Promise<StoredRuleset | null>;
  /** Answers the Integration GitHub attributed the check to, not the one we hoped for. */
  publishBootstrapCheck(run: {
    name: string;
    head_sha: string;
    status: string;
    conclusion: string;
    external_id: string;
    output: { title: string; summary: string };
  }): Promise<{ appId: number }>;
}

export interface BootstrapDeps {
  readonly db: D1Like;
  readonly github: BootstrapGitHub;
  /** The Thwip App's Integration id, which sources the turn check. */
  readonly integrationId: number;
  /** GitHub Actions, which sources the workflow proof gate. Defaulted. */
  readonly actionsIntegrationId?: number;
  readonly endpoint: string;
  readonly actionRef: string;
  /** Include a repository override only when the administrator explicitly chose it. */
  readonly includeRepositoryConfig?: boolean;
  /** Begin the observe-to-enforced handoff after a real pull request was checked. */
  readonly confirmQueueEnforcement?: boolean;
  /**
   * GitHub hides ruleset bypass actors from an App that cannot edit rulesets.
   * A repository administrator must therefore confirm that the generated
   * bypass configuration is what they applied before setup may activate.
   */
  readonly confirmRulesetBypassActors?: boolean;
}

export type ManualRulesetChange =
  | { readonly operation: "create"; readonly ruleset: Ruleset }
  | { readonly operation: "update"; readonly rulesetId: number; readonly ruleset: Ruleset };

export interface ExpectedBypassActors {
  readonly ruleset: string;
  readonly bypassActors: Ruleset["bypass_actors"];
}

/**
 * `pullRequestNumber` is carried rather than left in `detail` because a caller
 * needs to link to the pull request a person has to merge. The dashboard read it
 * back out of the prose with a regular expression, which breaks silently the day
 * the sentence is reworded.
 */
export type BootstrapActivityStep = BootstrapStep | "merge-verifier-v3-pr";

export type StepOutcome =
  | {
      readonly kind: "advanced";
      readonly step: BootstrapActivityStep;
      readonly detail: string;
      readonly pullRequestNumber?: number;
    }
  | {
      readonly kind: "waiting";
      readonly step: BootstrapActivityStep;
      readonly detail: string;
      readonly pullRequestNumber?: number;
      readonly manualRulesets?: readonly ManualRulesetChange[];
      readonly confirmationRequired?: "queue-enforcement" | "ruleset-bypass-actors";
      readonly expectedBypassActors?: readonly ExpectedBypassActors[];
    }
  | { readonly kind: "refused"; readonly step: BootstrapActivityStep; readonly detail: string }
  | { readonly kind: "complete" };

/* ---------------------------------------------------------------- */
/* The row                                                          */
/* ---------------------------------------------------------------- */

interface ProjectRow {
  id: string;
  organization_id: string;
  github_repository_id: string;
  base_ref: string;
  enabled: number;
  activation_state: string;
  chain_public: number;
  bootstrap_progress_json: string;
  project_id: string;
  verifier_workflow_version: number;
  verifier_protocol: number;
}

function toProject(row: ProjectRow): QueueProject {
  let progress: BootstrapProgress = {};
  try {
    const parsed: unknown = JSON.parse(row.bootstrap_progress_json);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      progress = parsed as BootstrapProgress;
    }
  } catch {
    // A row whose progress cannot be read is a row that has made no progress.
    // Treating it as complete would activate a policy on unproven configuration.
    progress = {};
  }
  return {
    id: row.id,
    organizationId: row.organization_id,
    repositoryId: row.github_repository_id,
    baseRef: row.base_ref,
    enabled: row.enabled === 1,
    activationState: row.activation_state,
    chainPublic: row.chain_public === 1,
    progress,
    projectId: row.project_id,
    verifierWorkflowVersion: row.verifier_workflow_version === 2 ? 2 : 1,
    verifierProtocol: row.verifier_protocol === 3 ? 3 : row.verifier_protocol === 1 ? 1 : 2,
  };
}

export interface BootstrapProjectBinding {
  readonly projectId: string;
  readonly organizationId: string;
}

export async function readQueueProject(
  db: D1Like,
  repositoryId: string,
  baseRef: string,
  expected?: BootstrapProjectBinding,
): Promise<QueueProject | null> {
  const v3Ready = (await databaseSchemaCapabilities(db)).verifierProtocolV3;
  const row = await db
    .prepare(
      `SELECT id, organization_id, github_repository_id, base_ref,
              enabled, activation_state, chain_public, bootstrap_progress_json, project_id,
              verifier_workflow_version,
              ${v3Ready ? "verifier_protocol" : "CASE verifier_workflow_version WHEN 1 THEN 1 ELSE 2 END"} AS verifier_protocol
         FROM queue_projects
        WHERE github_repository_id = ? AND base_ref = ?
          AND project_id IS NOT NULL
          AND (? IS NULL OR project_id = ?)
          AND (? IS NULL OR organization_id = ?)`,
    )
    .bind(
      repositoryId,
      baseRef,
      expected?.projectId ?? null,
      expected?.projectId ?? null,
      expected?.organizationId ?? null,
      expected?.organizationId ?? null,
    )
    .first<ProjectRow>();
  return row === null ? null : toProject(row);
}

export interface EnrollmentRequest {
  readonly repositoryId: string;
  readonly baseRef: string;
  readonly expectedProjectId: string;
  readonly expectedOrganizationId: string;
  /** Public chains need no session to read. Private is the safe default. */
  readonly chainPublic?: boolean;
}

export type Enrollment =
  | { readonly ok: true; readonly project: QueueProject }
  | { readonly ok: false; readonly reason: string };

/** The file the control plane dispatches `thwip-queue-verify` to. */
export const VERIFIER_WORKFLOW_PATH = ".github/workflows/thwip-queue-verify.yml";

/**
 * Who may say "the integrated candidate passed".
 *
 * Any workflow in a repository can obtain an OIDC token for that repository, so
 * the queue pins the workflow's path and refuses anything else. Nothing wrote
 * this record: `queue_projects.verifier_json` has existed since migration 0005
 * and enrolment never filled it in, so `remote` and `audited` refused every
 * merge with NO_PINNED_VERIFIER and `candidate-result` answered 409 to the
 * verdict that would have cleared it. This repository's own row was typed into
 * D1 by hand, which is why the gap survived.
 *
 * The revision is deliberately not pinned. A run triggered by
 * repository_dispatch executes the default branch's current head, so an exact
 * revision would need re-pinning after every merge and a stale pin refuses
 * every verdict. The path on the default branch is what carries the weight, and
 * only a merge can change it.
 */
function pinnedVerifierFor(input: {
  repositoryId: string;
  ownerId: string;
  repository: string;
  baseRef: string;
}): Record<string, unknown> {
  const ref = `${input.repository}/${VERIFIER_WORKFLOW_PATH}@${input.baseRef}`;
  return {
    repositoryId: input.repositoryId,
    repositoryOwnerId: input.ownerId,
    workflowRef: ref,
    workflowSha: null,
    reusableWorkflowRef: ref,
    reusableWorkflowSha: null,
    expectedEventName: "repository_dispatch",
    defaultBranchRef: input.baseRef,
  };
}

/**
 * Create the queue project.
 *
 * The organization comes from `projects`, which installation sync writes, rather
 * than from the caller: a caller who could name the organization could enrol a
 * repository into someone else's. No `projects` row means the App is not
 * installed, and there is nothing to enrol.
 */
export async function enrollQueueProject(db: D1Like, request: EnrollmentRequest): Promise<Enrollment> {
  const v3Ready = (await databaseSchemaCapabilities(db)).verifierProtocolV3;
  const installed = await db
    .prepare(
      `SELECT p.id AS projectId, p.organization_id AS organizationId, p.github_name AS repository, o.github_org_id AS ownerId
         FROM projects p JOIN organizations o ON o.id = p.organization_id
        WHERE p.github_repository_id = ? AND p.id = ? AND p.organization_id = ?
          AND NOT EXISTS (SELECT 1 FROM project_release_requests r WHERE r.github_repository_id = p.github_repository_id)
          AND NOT EXISTS (
            SELECT 1 FROM project_release_jobs r
             WHERE r.organization_id = p.organization_id
               AND r.github_repository_id = p.github_repository_id
          )`,
    )
    .bind(request.repositoryId, request.expectedProjectId, request.expectedOrganizationId)
    .first<{ projectId: string; organizationId: string; repository: string; ownerId: string }>();
  if (installed === null) {
    return { ok: false, reason: "the Thwip App is not installed on this repository" };
  }

  await db
    .prepare(
      v3Ready ? `INSERT INTO queue_projects
       (id, organization_id, github_repository_id, base_ref,
          enabled, activation_state, chain_public, bootstrap_progress_json, verifier_json, project_id,
          verifier_workflow_version, verifier_protocol)
       SELECT ?, ?, ?, ?, 0, 'configured', ?, '{}', ?, ?, 2, 2
        WHERE EXISTS (
          SELECT 1 FROM projects p
           WHERE p.id = ? AND p.organization_id = ? AND p.github_repository_id = ?
             AND NOT EXISTS (
               SELECT 1 FROM project_release_requests r
                WHERE r.github_repository_id = p.github_repository_id
             )
             AND NOT EXISTS (
               SELECT 1 FROM project_release_jobs r
                WHERE r.organization_id = p.organization_id
                  AND r.github_repository_id = p.github_repository_id
             )
        )
       ON CONFLICT (github_repository_id, base_ref) DO NOTHING`
      : `INSERT INTO queue_projects
       (id, organization_id, github_repository_id, base_ref,
          enabled, activation_state, chain_public, bootstrap_progress_json, verifier_json, project_id,
          verifier_workflow_version)
       SELECT ?, ?, ?, ?, 0, 'configured', ?, '{}', ?, ?, 2
        WHERE EXISTS (
          SELECT 1 FROM projects p
           WHERE p.id = ? AND p.organization_id = ? AND p.github_repository_id = ?
             AND NOT EXISTS (
               SELECT 1 FROM project_release_requests r
                WHERE r.github_repository_id = p.github_repository_id
             )
             AND NOT EXISTS (
               SELECT 1 FROM project_release_jobs r
                WHERE r.organization_id = p.organization_id
                  AND r.github_repository_id = p.github_repository_id
             )
        )
       ON CONFLICT (github_repository_id, base_ref) DO NOTHING`,
    )
    .bind(
      `qp_${crypto.randomUUID()}`,
      installed.organizationId,
      request.repositoryId,
      request.baseRef,
      request.chainPublic === true ? 1 : 0,
      JSON.stringify(
        pinnedVerifierFor({
          repositoryId: request.repositoryId,
          ownerId: installed.ownerId,
          repository: installed.repository,
          baseRef: request.baseRef,
        }),
      ),
      installed.projectId,
      request.expectedProjectId,
      request.expectedOrganizationId,
      request.repositoryId,
    )
    .run();

  // Omitting the choice on a later setup request leaves the stored privacy
  // decision alone. Supplying either boolean is an explicit administrator
  // change, including for a repository whose bootstrap already completed.
  if (request.chainPublic !== undefined) {
    await db
      .prepare(
        `UPDATE queue_projects SET chain_public = ?
          WHERE github_repository_id = ? AND base_ref = ?
            AND project_id = ? AND organization_id = ?
            AND EXISTS (
              SELECT 1 FROM projects p
               WHERE p.id = queue_projects.project_id
                 AND p.organization_id = queue_projects.organization_id
                 AND p.github_repository_id = queue_projects.github_repository_id
            )
            AND NOT EXISTS (
              SELECT 1 FROM project_release_requests r
               WHERE r.github_repository_id = queue_projects.github_repository_id
            )
            AND NOT EXISTS (
              SELECT 1 FROM project_release_jobs r
               WHERE r.organization_id = queue_projects.organization_id
                 AND r.github_repository_id = queue_projects.github_repository_id
            )`,
      )
      .bind(
        request.chainPublic ? 1 : 0,
        request.repositoryId,
        request.baseRef,
        request.expectedProjectId,
        request.expectedOrganizationId,
      )
      .run();
  }

  const project = await readQueueProject(db, request.repositoryId, request.baseRef, {
    projectId: request.expectedProjectId,
    organizationId: request.expectedOrganizationId,
  });
  if (project === null) return { ok: false, reason: "the queue project could not be read back" };
  return { ok: true, project };
}

/**
 * Record a completed step.
 *
 * Read-modify-write on one row for one repository, which is the same shape the
 * hand enrolment used and is safe because nothing else writes this column.
 */
async function recordBootstrapStep(
  db: D1Like,
  project: QueueProject,
  step: BootstrapStep,
): Promise<BootstrapProgress | null> {
  const progress: BootstrapProgress = { ...project.progress, [step]: true };
  return (await guardedProjectUpdate(db, project, "bootstrap_progress_json = ?", [JSON.stringify(progress)]))
    ? progress
    : null;
}

async function guardedProjectUpdate(
  db: D1Like,
  project: QueueProject,
  set: string,
  bindings: readonly unknown[] = [],
  requireDefaultBranch = false,
): Promise<boolean> {
  const defaultBranchGuard = requireDefaultBranch
    ? "AND queue_projects.base_ref = 'refs/heads/' || p.default_branch"
    : "";
  const written = await db
    .prepare(
      `UPDATE queue_projects SET ${set}
        WHERE id = ? AND project_id = ? AND organization_id = ?
          AND github_repository_id = ? AND base_ref = ?
          AND EXISTS (
            SELECT 1 FROM projects p
             WHERE p.id = queue_projects.project_id
               AND p.organization_id = queue_projects.organization_id
               AND p.github_repository_id = queue_projects.github_repository_id
               ${defaultBranchGuard}
          )
          AND NOT EXISTS (
            SELECT 1 FROM project_release_requests r
             WHERE r.github_repository_id = queue_projects.github_repository_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM project_release_jobs r
             WHERE r.organization_id = queue_projects.organization_id
               AND r.github_repository_id = queue_projects.github_repository_id
          )`,
    )
    .bind(
      ...bindings,
      project.id,
      project.projectId,
      project.organizationId,
      project.repositoryId,
      project.baseRef,
    )
    .run();
  return ((written as { meta?: { changes?: number } }).meta?.changes ?? 0) === 1;
}

/** The queue starts observing under the repository's existing controls. */
async function observeQueueProject(db: D1Like, project: QueueProject): Promise<boolean> {
  return guardedProjectUpdate(db, project, "enabled = 1, activation_state = 'observe'");
}

/**
 * Persist the explicit enforcement decision before a human applies ownership.
 * `canary` is already an enforcing writer state, so the App remains able to
 * advance the branch during the manual ruleset handoff instead of being locked
 * out between the ownership write and the next setup request.
 */
async function beginQueueEnforcement(db: D1Like, project: QueueProject): Promise<boolean> {
  await guardedProjectUpdate(
    db,
    project,
    "activation_state = CASE WHEN activation_state = 'observe' THEN 'canary' ELSE activation_state END",
  );
  const stored = await db
    .prepare("SELECT activation_state FROM queue_projects WHERE id = ? AND project_id = ? AND organization_id = ?")
    .bind(project.id, project.projectId, project.organizationId)
    .first<{ activation_state: string }>();
  return stored?.activation_state === "canary";
}

/** The durable state follows only after ownership and policy were read back. */
async function enforceQueueProject(db: D1Like, project: QueueProject): Promise<boolean> {
  await guardedProjectUpdate(
    db,
    project,
    "activation_state = CASE WHEN activation_state IN ('canary', 'enforced') THEN 'enforced' ELSE activation_state END",
  );
  const stored = await db
    .prepare("SELECT activation_state FROM queue_projects WHERE id = ? AND project_id = ? AND organization_id = ?")
    .bind(project.id, project.projectId, project.organizationId)
    .first<{ activation_state: string }>();
  return stored?.activation_state === "enforced";
}

/* ---------------------------------------------------------------- */
/* The sequence                                                     */
/* ---------------------------------------------------------------- */

export interface BootstrapStatus {
  readonly repositoryId: string;
  readonly baseRef: string;
  readonly enabled: boolean;
  readonly activationState: string;
  readonly chainPublic: boolean;
  readonly progress: BootstrapProgress;
  readonly nextStep: BootstrapActivityStep | null;
  readonly complete: boolean;
  readonly mayActivate: ReturnType<typeof mayActivate>;
}

export function bootstrapStatus(project: QueueProject): BootstrapStatus {
  const ordinary = nextBootstrapStep(project.progress);
  const next = ordinary ?? (project.verifierProtocol === 3 ? null : "merge-verifier-v3-pr");
  return {
    repositoryId: project.repositoryId,
    baseRef: project.baseRef,
    enabled: project.enabled,
    activationState: project.activationState,
    chainPublic: project.chainPublic,
    progress: project.progress,
    nextStep: next,
    complete: next === null,
    mayActivate: mayActivate(project.progress),
  };
}

function policyFor(
  deps: BootstrapDeps,
  project: QueueProject,
  existing: StoredRuleset | null,
  options: { enforcement: "active" | "disabled"; pinCheckSource: boolean; proofCheckMode: ProofCheckMode },
): Ruleset {
  return policyRuleset({
    baseRef: project.baseRef,
    integrationId: deps.integrationId,
    actionsIntegrationId: deps.actionsIntegrationId ?? GITHUB_ACTIONS_INTEGRATION_ID,
    proofCheckMode: options.proofCheckMode,
    existingRequiredChecks: requiredChecksOf(existing?.ruleset ?? null),
    enforcement: options.enforcement,
    pinCheckSource: options.pinCheckSource,
  });
}

/**
 * Whether the App publishes `thwip` for this repository yet.
 *
 * Read from `projects.proof_check_mode` on every step rather than carried on the
 * queue project, because it is changed elsewhere — by an administrator on the
 * proof-mode route — and a copy would go stale between the change and the next
 * run of setup.
 */
async function proofCheckMode(deps: BootstrapDeps, project: QueueProject): Promise<ProofCheckMode> {
  const row = await deps.db
    .prepare(
      `SELECT p.proof_check_mode FROM projects p
        WHERE p.github_repository_id = ? AND p.id = ? AND p.organization_id = ?
        AND NOT EXISTS (SELECT 1 FROM project_release_requests r WHERE r.github_repository_id = p.github_repository_id)
        AND NOT EXISTS (
          SELECT 1 FROM project_release_jobs r
           WHERE r.organization_id = p.organization_id
             AND r.github_repository_id = p.github_repository_id
        )`,
    )
    .bind(project.repositoryId, project.projectId, project.organizationId)
    .first<{ proof_check_mode: string }>();
  return row?.proof_check_mode === "enforced" ? "enforced" : "observe";
}

/**
 * Read back what GitHub stored, and refuse anything that is not what it was
 * sent. Returns null when everything matched.
 *
 * GitHub does not always keep a source it accepted. A ruleset that took the
 * payload and dropped the pin leaves a context any workflow in the repository
 * can satisfy, and believing the payload we sent rather than the one GitHub kept
 * is how that goes unnoticed. Which Integration is expected for `thwip` follows
 * the publisher, so this reads it the same way the payload did.
 */
async function confirmSourcePins(
  deps: BootstrapDeps,
  project: QueueProject,
  ruleset: Ruleset,
  step: BootstrapStep,
): Promise<StepOutcome | null> {
  const stored = requiredChecksOf(ruleset);
  const proofMode = await proofCheckMode(deps, project);
  const expected: Array<[string, number]> = [
    [
      proofContextFor(proofMode),
      proofIntegrationFor({
        mode: proofMode,
        integrationId: deps.integrationId,
        ...(deps.actionsIntegrationId === undefined
          ? {}
          : { actionsIntegrationId: deps.actionsIntegrationId }),
      }),
    ],
    [TURN_CHECK, deps.integrationId],
  ];
  for (const [context, integrationId] of expected) {
    const found = stored.find((c) => c.context === context);
    if (found === undefined) {
      return { kind: "refused", step, detail: `GitHub is not requiring ${context}` };
    }
    if (found.integration_id !== integrationId) {
      return {
        kind: "refused",
        step,
        detail: `GitHub kept ${context} sourced from ${found.integration_id ?? "anything"}, not ${integrationId}`,
      };
    }
  }
  return null;
}

function requiredChecksOf(ruleset: Ruleset | null): Array<{ context: string; integration_id?: number }> {
  if (ruleset === null) return [];
  const rule = ruleset.rules.find((r) => r.type === "required_status_checks");
  return (rule?.parameters?.["required_status_checks"] ?? []) as Array<{
    context: string;
    integration_id?: number;
  }>;
}

function manualChange(existing: StoredRuleset | null, ruleset: Ruleset): ManualRulesetChange {
  return existing === null
    ? { operation: "create", ruleset }
    : { operation: "update", rulesetId: existing.id, ruleset };
}

/**
 * Verify a human-owned policy change, or return the exact payload still needed.
 *
 * A setup tool that silently dropped somebody's existing protection would be a
 * security regression delivered as a convenience, so the diff refuses unsafe
 * payloads before they are ever shown to an administrator.
 */
async function verifyPolicy(
  deps: BootstrapDeps,
  project: QueueProject,
  step: BootstrapStep,
  options: { enforcement: "active" | "disabled"; pinCheckSource: boolean; proofCheckMode?: ProofCheckMode },
): Promise<StepOutcome> {
  const existing = await deps.github.rulesetNamed(POLICY_RULESET_NAME);
  const next = policyFor(deps, project, existing, {
    ...options,
    proofCheckMode: options.proofCheckMode ?? (await proofCheckMode(deps, project)),
  });

  const compatible = checkAppRuleset(next);
  if (!compatible.ok) return { kind: "refused", step, detail: compatible.reason };

  const diff = diffRuleset(existing?.ruleset ?? null, next);
  if (!diff.safe) return { kind: "refused", step, detail: diff.warnings.join("; ") };

  if (
    existing !== null &&
    rulesetConfigurationMatches(existing.ruleset, next) &&
    bypassActorsMatch(existing.ruleset, next)
  ) {
    return { kind: "advanced", step, detail: `verified ruleset ${existing.id}` };
  }
  return {
    kind: "waiting",
    step,
    detail: `a repository administrator must ${existing === null ? "create" : "update"} ${next.name}`,
    manualRulesets: [manualChange(existing, next)],
  };
}

/** One step. Never more, so a refusal cannot be walked past. */
export async function advanceBootstrap(
  deps: BootstrapDeps,
  project: QueueProject,
): Promise<StepOutcome> {
  const step = nextBootstrapStep(project.progress);
  if (step === null) return { kind: "complete" };

  const outcome = await performStep(deps, project, step);
  if (outcome.kind === "advanced" && (await recordBootstrapStep(deps.db, project, step)) === null) {
    return { kind: "refused", step, detail: "the repository project changed while setup was running" };
  }
  return outcome;
}

async function performStep(
  deps: BootstrapDeps,
  project: QueueProject,
  step: BootstrapStep,
): Promise<StepOutcome> {
  switch (step) {
    case "merge-setup-pr": {
      // The repository's own reviewers approve the workflows under the controls
      // it already has. Nothing Thwip creates is active yet, so this cannot be
      // the queue asking the queue for permission.
      const open = await deps.github.setupPullRequest();
      if (open === null || (!open.merged && open.state === "closed")) {
        const baseSha = await deps.github.baseSha();
        const opened = await deps.github.openSetupPullRequest({
          files: setupPullRequestFiles({
            endpoint: deps.endpoint,
            actionRef: deps.actionRef,
            ...(deps.includeRepositoryConfig === true ? { includeRepositoryConfig: true } : {}),
          }),
          baseSha,
          ...(open === null ? {} : { replaceHeadSha: open.headSha }),
        });
        return {
          kind: "waiting",
          step,
          detail: open === null
            ? `opened the setup pull request #${opened.number}; merge it to continue`
            : `replaced closed setup pull request #${open.number} with #${opened.number}; merge it to continue`,
          pullRequestNumber: opened.number,
        };
      }
      if (!open.merged) {
        return {
          kind: "waiting",
          step,
          detail: `setup pull request #${open.number} is not merged`,
          pullRequestNumber: open.number,
        };
      }
      return {
        kind: "advanced",
        step,
        detail: `setup pull request #${open.number} merged`,
        pullRequestNumber: open.number,
      };
    }

    case "create-disabled-policy-without-source":
      // Disabled and unsourced, because GitHub will not accept a source for a
      // context that is not yet a requirement, and a disabled rule cannot block
      // the branch while the rest of the sequence runs.
      return verifyPolicy(deps, project, step, { enforcement: "disabled", pinCheckSource: false });

    case "publish-bootstrap-check": {
      const policy = await deps.github.rulesetNamed(POLICY_RULESET_NAME);
      if (policy === null) return { kind: "refused", step, detail: "the policy ruleset is missing" };
      if (policy.ruleset.enforcement === "evaluate") {
        return { kind: "refused", step, detail: "the policy ruleset is in evaluate mode" };
      }

      const baseSha = await deps.github.baseSha();
      const runs = bootstrapCheckRuns({ headSha: baseSha, policyEnforcement: policy.ruleset.enforcement });
      if (!runs.ok) return { kind: "refused", step, detail: runs.reason };

      for (const run of runs.checkRuns) {
        const published = await deps.github.publishBootstrapCheck(run);
        // The pin has to be the Integration GitHub says published the check.
        // Pinning the id we expected instead would require a source that does
        // not exist.
        if (published.appId !== deps.integrationId) {
          return {
            kind: "refused",
            step,
            detail: `GitHub attributed the ${run.name} check to integration ${published.appId}, not ${deps.integrationId}`,
          };
        }
      }
      return {
        kind: "advanced",
        step,
        detail: `published ${runs.checkRuns.map((r) => r.name).join(" and ")} on ${baseSha}`,
      };
    }

    case "attach-integration-id-while-disabled": {
      const policy = await deps.github.rulesetNamed(POLICY_RULESET_NAME);
      if (policy === null) return { kind: "refused", step, detail: "the policy ruleset is missing" };
      if (policy.ruleset.enforcement !== "disabled") {
        return { kind: "refused", step, detail: "the policy is already enforcing; the pin is not safe to change here" };
      }
      return verifyPolicy(deps, project, step, { enforcement: "disabled", pinCheckSource: true });
    }

    case "canary-negative-test": {
      // What §44.3 asks for is a temporary canary target proving a same-named
      // Actions check cannot satisfy an App-pinned rule. That creates and deletes
      // a ref, a pull request, and a rule on somebody's repository, so it is not
      // done without the owner asking for it separately.
      //
      // What is proved here is the half that can be proved without touching the
      // repository: that GitHub stored the sources it was sent. It does not
      // always. A ruleset that accepted the payload and dropped the pin leaves a
      // context any workflow can satisfy, and activating on the payload we sent
      // rather than the one GitHub kept is how that goes unnoticed.
      const policy = await deps.github.rulesetNamed(POLICY_RULESET_NAME);
      if (policy === null) return { kind: "refused", step, detail: "the policy ruleset is missing" };
      if (policy.ruleset.enforcement !== "disabled") {
        return { kind: "refused", step, detail: "the source pin must be proven while the policy is disabled" };
      }

      const kept = await confirmSourcePins(deps, project, policy.ruleset, step);
      if (kept !== null) return kept;
      return { kind: "advanced", step, detail: "GitHub kept both source pins" };
    }

    case "activate-policy-and-ownership": {
      const allowed = mayActivate(project.progress);
      if (!allowed.ok) return { kind: "refused", step, detail: allowed.reason };

      const shouldBeginEnforcement = project.activationState === "observe";
      if (shouldBeginEnforcement) {
        if (deps.confirmQueueEnforcement !== true) {
          return {
            kind: "waiting",
            step,
            detail:
              "the queue is observing under the repository's existing controls; validate its checks on a real pull request, then explicitly begin enforcement",
            confirmationRequired: "queue-enforcement",
          };
        }
      } else if (project.activationState !== "canary" && project.activationState !== "enforced") {
        return {
          kind: "refused",
          step,
          detail: `the queue must observe before enforcement (current state: ${project.activationState})`,
        };
      }

      const existingPolicy = await deps.github.rulesetNamed(POLICY_RULESET_NAME);
      const policy = policyFor(deps, project, existingPolicy, {
        enforcement: "active",
        pinCheckSource: true,
        proofCheckMode: await proofCheckMode(deps, project),
      });
      const policyCompatibility = checkAppRuleset(policy);
      if (!policyCompatibility.ok) return { kind: "refused", step, detail: policyCompatibility.reason };
      const policyDiff = diffRuleset(existingPolicy?.ruleset ?? null, policy);
      if (!policyDiff.safe) return { kind: "refused", step, detail: policyDiff.warnings.join("; ") };

      const second = appOwnershipRuleset({ baseRef: project.baseRef, integrationId: deps.integrationId });
      const compatibility = checkAppRuleset(second);
      if (!compatibility.ok) return { kind: "refused", step, detail: compatibility.reason };

      const existingSecond = await deps.github.rulesetNamed(second.name);
      const secondDiff = diffRuleset(existingSecond?.ruleset ?? null, second);
      if (!secondDiff.safe) return { kind: "refused", step, detail: secondDiff.warnings.join("; ") };

      // Ownership goes first. A manual setup may take minutes between writes;
      // making the App the only branch writer before activating the status-check
      // policy fails closed during that interval instead of leaving two writers.
      const changes: ManualRulesetChange[] = [];
      if (
        existingSecond === null ||
        !rulesetConfigurationMatches(existingSecond.ruleset, second) ||
        !bypassActorsMatch(existingSecond.ruleset, second)
      ) {
        changes.push(manualChange(existingSecond, second));
      }
      if (
        existingPolicy === null ||
        !rulesetConfigurationMatches(existingPolicy.ruleset, policy) ||
        !bypassActorsMatch(existingPolicy.ruleset, policy)
      ) {
        changes.push(manualChange(existingPolicy, policy));
      }
      if (changes.length > 0) {
        if (shouldBeginEnforcement && !(await beginQueueEnforcement(deps.db, project))) {
          return { kind: "refused", step, detail: "the queue activation state changed before enforcement began" };
        }
        return {
          kind: "waiting",
          step,
          detail:
            "a repository administrator must apply the generated ownership change first, then activate the policy",
          manualRulesets: changes,
        };
      }
      if (existingSecond === null || existingPolicy === null) {
        return { kind: "refused", step, detail: "ruleset verification lost its repository state" };
      }

      const bypassActorsAreHidden =
        !bypassActorsVisible(existingSecond.ruleset) || !bypassActorsVisible(existingPolicy.ruleset);
      if (bypassActorsAreHidden && deps.confirmRulesetBypassActors !== true) {
        if (shouldBeginEnforcement && !(await beginQueueEnforcement(deps.db, project))) {
          return { kind: "refused", step, detail: "the queue activation state changed before enforcement began" };
        }
        return {
          kind: "waiting",
          step,
          detail:
            "GitHub hides bypass actors from a read-only App; confirm that the policy has no bypass and the ownership ruleset names only the generated writer",
          confirmationRequired: "ruleset-bypass-actors",
          expectedBypassActors: [
            { ruleset: second.name, bypassActors: second.bypass_actors },
            { ruleset: policy.name, bypassActors: policy.bypass_actors },
          ],
        };
      }

      if (shouldBeginEnforcement && !(await beginQueueEnforcement(deps.db, project))) {
        return { kind: "refused", step, detail: "the queue activation state changed before enforcement began" };
      }
      if (!(await enforceQueueProject(deps.db, project))) {
        return { kind: "refused", step, detail: "the queue activation state changed before enforcement completed" };
      }
      return { kind: "advanced", step, detail: `activated the policy and ${second.name}` };
    }

    case "pin-proof-check-to-app": {
      // The last disabled-policy change, after a real pull request has proved
      // the observe path and before the App becomes the protected branch's only
      // writer.
      //
      // While setup observes, the policy names the Actions-owned
      // `thwip / workflow` context. Enforcement replaces that context with the
      // App-owned `thwip` context; the two publishers never share a name.
      //
      // It cannot happen earlier. The App publishes `thwip` only where
      // `proof_check_mode` is `enforced`; in `observe` it publishes
      // `thwip / proof (observe)` and never the enforced name. Moving the pin
      // first would prepare an unsatisfiable policy. Keeping that policy
      // disabled means the repository remains under its existing controls while
      // the publisher and pin change, and ownership is activated only after
      // both are verified.
      if ((await proofCheckMode(deps, project)) !== "enforced") {
        return {
          kind: "waiting",
          step,
          detail:
            `${WORKFLOW_CHECK} is still the Actions-owned proof gate. Enforce the App's ` +
            `${PROOF_CHECK} proof check to replace it; the policy remains disabled and ` +
            "the repository keeps its existing merge controls until then.",
        };
      }

      const written = await verifyPolicy(deps, project, step, {
        enforcement: "disabled",
        pinCheckSource: true,
        proofCheckMode: "enforced",
      });
      if (written.kind !== "advanced") return written;

      // Read back, because GitHub accepting a payload is not GitHub keeping it.
      const policy = await deps.github.rulesetNamed(POLICY_RULESET_NAME);
      if (policy === null) return { kind: "refused", step, detail: "the policy ruleset is missing" };
      const kept = await confirmSourcePins(deps, project, policy.ruleset, step);
      if (kept !== null) return kept;
      if (!bypassActorsVisible(policy.ruleset) && deps.confirmRulesetBypassActors !== true) {
        return {
          kind: "waiting",
          step,
          detail:
            "GitHub hides bypass actors from a read-only App; confirm that the updated policy still has no bypass actors",
          confirmationRequired: "ruleset-bypass-actors",
          expectedBypassActors: [{ ruleset: policy.ruleset.name, bypassActors: [] }],
        };
      }
      return {
        kind: "advanced",
        step,
        detail: `${WORKFLOW_CHECK} was replaced by ${PROOF_CHECK}, sourced from the Thwip App`,
      };
    }

    case "record-genesis":
      // The signed genesis transition is the queue's to write when it first
      // moves the branch. What enrolment owes it is a project that is on and
      // observing: observe reports what the queue would have done without being
      // able to block anything, which is what makes adoption reversible.
      if (!(await observeQueueProject(deps.db, project))) {
        return { kind: "refused", step, detail: "the repository project changed while setup was running" };
      }
      return { kind: "advanced", step, detail: "the queue is enabled and observing" };
  }
}

export interface BootstrapRun {
  readonly outcomes: readonly StepOutcome[];
  readonly progress: BootstrapProgress;
  readonly enabled: boolean;
  readonly status: BootstrapStatus;
}

async function upgradeVerifierWorkflow(deps: BootstrapDeps, project: QueueProject): Promise<StepOutcome> {
  const step = "merge-verifier-v3-pr" as const;
  if (!(await databaseSchemaCapabilities(deps.db)).verifierProtocolV3) {
    return {
      kind: "waiting",
      step,
      detail: "verifier protocol v3 is waiting for its guarded schema phase; protocol v2 remains active",
    };
  }
  if (deps.github.verifierWorkflowAtBase === undefined) {
    return { kind: "refused", step, detail: "the installed verifier cannot be read back" };
  }
  if (deps.github.installationPermissions === undefined) {
    return { kind: "refused", step, detail: "the GitHub App installation permissions cannot be read" };
  }
  const permissions = await deps.github.installationPermissions();
  if (permissions?.["actions"] !== "read") {
    return {
      kind: "waiting",
      step,
      detail:
        "approve the Thwip GitHub App's Actions: read permission, then return here; protocol v2 remains active until GitHub confirms it",
    };
  }

  const expected = verifierWorkflowFile({ endpoint: deps.endpoint, actionRef: deps.actionRef });
  const activateInstalledV3 = async (pullRequestNumber?: number): Promise<StepOutcome> => {
    const installed = await deps.github.verifierWorkflowAtBase!();
    if (installed.content !== expected.content) {
      return { kind: "refused", step, detail: "the installed verifier is not the exact reviewed protocol v3 workflow" };
    }
    if (!(await guardedProjectUpdate(
      deps.db,
      project,
      "verifier_workflow_version = 2, verifier_protocol = 3",
      [],
      true,
    ))) {
      return { kind: "refused", step, detail: "the repository project changed while setup was running" };
    }
    return {
      kind: "advanced",
      step,
      detail: pullRequestNumber === undefined
        ? "the exact protocol v3 verifier and Actions: read permission are active"
        : `verifier protocol upgrade pull request #${pullRequestNumber} merged`,
      ...(pullRequestNumber === undefined ? {} : { pullRequestNumber }),
    };
  };

  const installed = await deps.github.verifierWorkflowAtBase();
  if (installed.content === expected.content) return activateInstalledV3();

  const open = await deps.github.verifierUpgradePullRequest();
  if (open === null || (!open.merged && open.state === "closed")) {
    const baseSha = await deps.github.baseSha();
    const opened = await deps.github.openVerifierUpgradePullRequest({
      files: [verifierWorkflowFile({ endpoint: deps.endpoint, actionRef: deps.actionRef })],
      baseSha,
      ...(open === null ? {} : { replaceHeadSha: open.headSha }),
    });
    return {
      kind: "waiting",
      step,
      detail: open === null
        ? `opened verifier protocol upgrade pull request #${opened.number}; merge it to continue`
        : `replaced closed verifier protocol upgrade pull request #${open.number} with #${opened.number}; merge it to continue`,
      pullRequestNumber: opened.number,
    };
  }
  if (!open.merged) {
    return {
      kind: "waiting",
      step,
      detail: `verifier protocol upgrade pull request #${open.number} is not merged`,
      pullRequestNumber: open.number,
    };
  }
  return activateInstalledV3(open.number);
}

/**
 * Walk the sequence until it finishes or stops.
 *
 * `waiting` and `refused` both end the run. Waiting is a person's turn: the
 * setup pull request needs review. Refused is a repository that would be left
 * unmergeable, and the policy is still disabled when it happens.
 */
export async function runBootstrap(
  deps: BootstrapDeps,
  project: QueueProject,
): Promise<BootstrapRun> {
  const outcomes: StepOutcome[] = [];
  let current = project;

  // One pass per step, plus the pass that answers `complete`. Bound from the
  // list rather than a literal, so adding a step cannot silently stop the run
  // one short of the end.
  for (let i = 0; i <= BOOTSTRAP_STEPS.length + 1; i += 1) {
    const outcome = nextBootstrapStep(current.progress) === null && current.verifierProtocol !== 3
      ? await upgradeVerifierWorkflow(deps, current)
      : await advanceBootstrap(deps, current);
    outcomes.push(outcome);
    if (outcome.kind !== "advanced") break;
    const reloaded = await readQueueProject(deps.db, current.repositoryId, current.baseRef, {
      projectId: current.projectId,
      organizationId: current.organizationId,
    });
    if (reloaded === null) break;
    current = reloaded;
  }

  const finished = (await readQueueProject(deps.db, project.repositoryId, project.baseRef, {
    projectId: project.projectId,
    organizationId: project.organizationId,
  })) ?? current;
  return {
    outcomes,
    progress: finished.progress,
    enabled: finished.enabled,
    status: bootstrapStatus(finished),
  };
}

/* ---------------------------------------------------------------- */
/* The route                                                        */
/* ---------------------------------------------------------------- */

export interface BootstrapRequest extends BootstrapDeps {
  readonly repositoryId: string;
  readonly baseRef: string;
  readonly expectedProjectId: string;
  readonly expectedOrganizationId: string;
  readonly chainPublic?: boolean;
}

export interface BootstrapResponse {
  readonly status: number;
  readonly body: unknown;
}

/**
 * Enrol and bootstrap in one request, so the whole of setup is one call an
 * operator can make and repeat.
 *
 * Idempotent by construction: enrolment does nothing to an existing project, and
 * every step reads what the repository is before deciding what to do to it.
 * An open setup pull request is reused. A closed, unmerged one is replaced.
 * 202 means the run stopped on something a person has to do; 409 means it
 * refused; 200 means the queue is on.
 */
export async function handleBootstrapRequest(request: BootstrapRequest): Promise<BootstrapResponse> {
  const enrolled = await enrollQueueProject(request.db, {
    repositoryId: request.repositoryId,
    baseRef: request.baseRef,
    expectedProjectId: request.expectedProjectId,
    expectedOrganizationId: request.expectedOrganizationId,
    ...(request.chainPublic !== undefined ? { chainPublic: request.chainPublic } : {}),
  });
  if (!enrolled.ok) return { status: 404, body: { error: enrolled.reason } };

  const run = await runBootstrap(request, enrolled.project);
  const last = run.outcomes.at(-1);
  const body = { ...run.status, outcomes: run.outcomes };

  if (last?.kind === "refused") return { status: 409, body };
  if (last?.kind === "waiting") return { status: 202, body };
  return { status: 200, body };
}

/* ---------------------------------------------------------------- */
/* The real GitHub                                                  */
/* ---------------------------------------------------------------- */

interface HttpLike {
  json<T>(path: string, init?: RequestInit): Promise<T>;
}

/**
 * The port against a real repository.
 *
 * Repository writes here are limited to the reviewed setup pull request and
 * bootstrap checks. Rulesets are read only: an administrator applies the exact
 * payload returned by the setup route with their own authority.
 */
export function bootstrapGitHub(
  http: HttpLike,
  repo: { owner: string; repo: string; baseRef: string },
  setup: {
    branch: string;
    title: string;
    body: string;
    verifierUpgrade?: { branch: string; title: string; body: string };
  },
  beforeWrite: () => Promise<void> = async () => {},
): BootstrapGitHub {
  const base = `/repos/${repo.owner}/${repo.repo}`;
  const branch = repo.baseRef.replace(/^refs\/heads\//, "");

  const pullRequest = async (configuration: { branch: string }): Promise<SetupPullRequestState | null> => {
    type Pull = {
      number: number;
      state: string;
      merged_at: string | null;
      head: { sha: string };
    };
    const head = `${repo.owner}:${configuration.branch}`;
    const list = (state: "open" | "closed") => {
      const query = new URLSearchParams({ state, head, base: branch, per_page: "1" });
      return http.json<Pull[]>(`${base}/pulls?${query.toString()}`);
    };
    const open = await list("open");
    const expectedState = open[0] === undefined ? "closed" : "open";
    const found = open[0] ?? (await list("closed"))[0];
    if (found === undefined) return null;
    if (
      found.state !== expectedState ||
      !Number.isSafeInteger(found.number) ||
      found.number < 1 ||
      (found.merged_at !== null && typeof found.merged_at !== "string") ||
      typeof found.head?.sha !== "string" ||
      !/^[0-9a-f]{40,64}$/.test(found.head.sha) ||
      (found.state === "open" && found.merged_at !== null)
    ) {
      throw new Error("GitHub returned an invalid setup pull request state");
    }
    return {
      number: found.number,
      state: found.state,
      merged: found.merged_at !== null,
      headSha: found.head.sha,
    };
  };

  const openPullRequest = async (
    configuration: { branch: string; title: string; body: string },
    input: { files: readonly SetupFile[]; baseSha: string; replaceHeadSha?: string },
  ): Promise<SetupPullRequestState> => {
    // A tree built from blobs rather than the contents API, so every file
    // lands in one commit and a reviewer sees one diff.
    const blobs: Array<{ path: string; mode: string; type: string; sha: string }> = [];
    for (const file of input.files) {
      await beforeWrite();
      const blob = await http.json<{ sha: string }>(`${base}/git/blobs`, {
        method: "POST",
        body: JSON.stringify({ content: file.content, encoding: "utf-8" }),
        headers: { "content-type": "application/json" },
      });
      blobs.push({ path: file.path, mode: "100644", type: "blob", sha: blob.sha });
    }
    await beforeWrite();
    const tree = await http.json<{ sha: string }>(`${base}/git/trees`, {
      method: "POST",
      body: JSON.stringify({ base_tree: input.baseSha, tree: blobs }),
      headers: { "content-type": "application/json" },
    });
    await beforeWrite();
    const commit = await http.json<{ sha: string }>(`${base}/git/commits`, {
      method: "POST",
      body: JSON.stringify({
        message: configuration.title,
        tree: tree.sha,
        parents: input.replaceHeadSha === undefined
          ? [input.baseSha]
          : [input.baseSha, input.replaceHeadSha],
      }),
      headers: { "content-type": "application/json" },
    });
    const refName = `refs/heads/${configuration.branch}`;
    const matching = await http.json<Array<{ ref: string; object: { sha: string } }>>(
      `${base}/git/matching-refs/heads/${configuration.branch}`,
    );
    await beforeWrite();
    const existing = matching.find((candidate) => candidate.ref === refName);
    const replaceExisting = input.replaceHeadSha !== undefined && existing?.object.sha === input.replaceHeadSha;
    await http.json(replaceExisting ? `${base}/git/refs/heads/${configuration.branch}` : `${base}/git/refs`, {
      method: replaceExisting ? "PATCH" : "POST",
      body: JSON.stringify(replaceExisting ? { sha: commit.sha, force: false } : { ref: refName, sha: commit.sha }),
      headers: { "content-type": "application/json" },
    });
    await beforeWrite();
    const pull = await http.json<{ number: number; head: { sha: string } }>(`${base}/pulls`, {
      method: "POST",
      body: JSON.stringify({
        title: configuration.title,
        body: configuration.body,
        head: configuration.branch,
        base: branch,
      }),
      headers: { "content-type": "application/json" },
    });
    return { number: pull.number, state: "open", merged: false, headSha: pull.head.sha };
  };

  return {
    async baseSha() {
      const ref = await http.json<{ object: { sha: string } }>(`${base}/git/ref/heads/${branch}`);
      return ref.object.sha;
    },

    async setupPullRequest() {
      return pullRequest(setup);
    },

    async openSetupPullRequest(input) {
      return openPullRequest(setup, input);
    },

    async verifierUpgradePullRequest() {
      return setup.verifierUpgrade === undefined ? null : pullRequest(setup.verifierUpgrade);
    },

    async openVerifierUpgradePullRequest(input) {
      if (setup.verifierUpgrade === undefined) throw new Error("verifier upgrade pull request is not configured");
      return openPullRequest(setup.verifierUpgrade, input);
    },

    async verifierWorkflowAtBase() {
      const ref = await http.json<{ object: { sha: string } }>(`${base}/git/ref/heads/${branch}`);
      const commitSha = ref.object.sha;
      const file = await http.json<{ sha: string; content: string; encoding: string }>(
        `${base}/contents/.github/workflows/thwip-queue-verify.yml?ref=${encodeURIComponent(commitSha)}`,
      );
      if (file.encoding !== "base64") throw new Error("GitHub returned an unsupported verifier encoding");
      const bytes = Uint8Array.from(atob(file.content.replaceAll("\n", "")), (byte) => byte.charCodeAt(0));
      return {
        commitSha,
        blobSha: file.sha,
        content: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      };
    },

    async rulesetNamed(name) {
      const all = await http.json<Array<{ id: number; name: string }>>(`${base}/rulesets`);
      const summary = all.find((r) => r.name === name);
      if (summary === undefined) return null;
      const full = await http.json<Ruleset>(`${base}/rulesets/${summary.id}`);
      return { id: summary.id, ruleset: full };
    },

    async publishBootstrapCheck(run) {
      await beforeWrite();
      const created = await http.json<{ app?: { id?: number } }>(`${base}/check-runs`, {
        method: "POST",
        body: JSON.stringify(run),
        headers: { "content-type": "application/json" },
      });
      return { appId: created.app?.id ?? 0 };
    },
  };
}
