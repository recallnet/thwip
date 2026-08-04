import type { D1Like } from "./projection.js";
import { setupPullRequestFiles, type SetupFile } from "./bootstrap-workflows.js";
import {
  bootstrapCheckRuns,
  BOOTSTRAP_STEPS,
  checkRulesetForBackend,
  diffRuleset,
  GITHUB_ACTIONS_INTEGRATION_ID,
  managedOwnershipRuleset,
  mayActivate,
  nativeMergeQueueRuleset,
  nextBootstrapStep,
  policyRuleset,
  POLICY_RULESET_NAME,
  proofIntegrationFor,
  type ProofCheckMode,
  type Backend,
  type BootstrapProgress,
  type BootstrapStep,
  type MergeMethod,
  type Ruleset,
} from "./rulesets.js";
import { PROOF_CHECK, TURN_CHECK } from "./turn-check.js";
import { mergeWriterOf, type MergeWriter } from "./merge-write.js";

/**
 * Enrolling a repository, through the product.
 *
 * `BOOTSTRAP_STEPS` and `mayActivate` were written, tested, and never called.
 * Bringing `recallnet/thwip-test` into the queue therefore took a `queue_projects`
 * row typed into D1, workflows copied in by hand, and a branch ruleset created
 * with `gh api` because no product path existed. Everything here exists so the
 * next repository takes a request. New enrolments use the App as their merge
 * writer, so setup does not ask an adopter to mint a branch-write token.
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

/** Longer than the longest turn plus verifier and reconciliation allowance. */
const NATIVE_CHECK_RESPONSE_TIMEOUT_MINUTES = 60;

export interface QueueProject {
  readonly id: string;
  readonly organizationId: string;
  readonly repositoryId: string;
  readonly baseRef: string;
  readonly backend: Backend;
  readonly mergeMethod: MergeMethod;
  readonly mergeWriter: MergeWriter;
  readonly enabled: boolean;
  readonly activationState: string;
  readonly progress: BootstrapProgress;
}

export interface SetupPullRequestState {
  readonly number: number;
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
  }): Promise<SetupPullRequestState>;
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
  /** GitHub Actions, which sources the proof check. Defaulted. */
  readonly actionsIntegrationId?: number;
  readonly endpoint: string;
  readonly actionRef: string;
  readonly review: {
    readonly requiredApprovingReviewCount: number;
    readonly requireCodeOwnerReview: boolean;
  };
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

/**
 * `pullRequestNumber` is carried rather than left in `detail` because a caller
 * needs to link to the pull request a person has to merge. The dashboard read it
 * back out of the prose with a regular expression, which breaks silently the day
 * the sentence is reworded.
 */
export type StepOutcome =
  | {
      readonly kind: "advanced";
      readonly step: BootstrapStep;
      readonly detail: string;
      readonly pullRequestNumber?: number;
    }
  | {
      readonly kind: "waiting";
      readonly step: BootstrapStep;
      readonly detail: string;
      readonly pullRequestNumber?: number;
      readonly manualRulesets?: readonly ManualRulesetChange[];
      readonly confirmationRequired?: "ruleset-bypass-actors";
    }
  | { readonly kind: "refused"; readonly step: BootstrapStep; readonly detail: string }
  | { readonly kind: "complete" };

/* ---------------------------------------------------------------- */
/* The row                                                          */
/* ---------------------------------------------------------------- */

interface ProjectRow {
  id: string;
  organization_id: string;
  github_repository_id: string;
  base_ref: string;
  backend: string;
  merge_method: string;
  merge_writer: string | null;
  enabled: number;
  activation_state: string;
  bootstrap_progress_json: string;
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
    backend: row.backend === "native" ? "native" : "managed",
    mergeMethod: row.merge_method === "merge" ? "merge" : "squash",
    mergeWriter: mergeWriterOf(row.merge_writer),
    enabled: row.enabled === 1,
    activationState: row.activation_state,
    progress,
  };
}

export async function readQueueProject(
  db: D1Like,
  repositoryId: string,
  baseRef: string,
): Promise<QueueProject | null> {
  const row = await db
    .prepare(
      `SELECT id, organization_id, github_repository_id, base_ref, backend, merge_method, merge_writer,
              enabled, activation_state, bootstrap_progress_json
         FROM queue_projects
        WHERE github_repository_id = ? AND base_ref = ?`,
    )
    .bind(repositoryId, baseRef)
    .first<ProjectRow>();
  return row === null ? null : toProject(row);
}

export interface EnrollmentRequest {
  readonly repositoryId: string;
  readonly baseRef: string;
  readonly backend?: Backend;
  readonly mergeMethod?: MergeMethod;
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
export function pinnedVerifierFor(input: {
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
  const installed = await db
    .prepare(
      `SELECT p.organization_id AS organizationId, p.github_name AS repository, o.github_org_id AS ownerId
         FROM projects p JOIN organizations o ON o.id = p.organization_id
        WHERE p.github_repository_id = ?`,
    )
    .bind(request.repositoryId)
    .first<{ organizationId: string; repository: string; ownerId: string }>();
  if (installed === null) {
    return { ok: false, reason: "the Thwip App is not installed on this repository" };
  }

  await db
    .prepare(
      `INSERT INTO queue_projects
         (id, organization_id, github_repository_id, base_ref, backend, merge_method,
          merge_writer, enabled, activation_state, bootstrap_progress_json, verifier_json)
       VALUES (?, ?, ?, ?, ?, ?, 'app', 0, 'configured', '{}', ?)
       ON CONFLICT (github_repository_id, base_ref) DO NOTHING`,
    )
    .bind(
      `qp_${crypto.randomUUID()}`,
      installed.organizationId,
      request.repositoryId,
      request.baseRef,
      request.backend ?? "managed",
      request.mergeMethod ?? "merge",
      JSON.stringify(
        pinnedVerifierFor({
          repositoryId: request.repositoryId,
          ownerId: installed.ownerId,
          repository: installed.repository,
          baseRef: request.baseRef,
        }),
      ),
    )
    .run();

  const project = await readQueueProject(db, request.repositoryId, request.baseRef);
  if (project === null) return { ok: false, reason: "the queue project could not be read back" };
  return { ok: true, project };
}

/**
 * Record a completed step.
 *
 * Read-modify-write on one row for one repository, which is the same shape the
 * hand enrolment used and is safe because nothing else writes this column.
 */
export async function recordBootstrapStep(
  db: D1Like,
  project: QueueProject,
  step: BootstrapStep,
): Promise<BootstrapProgress> {
  const progress: BootstrapProgress = { ...project.progress, [step]: true };
  await db
    .prepare("UPDATE queue_projects SET bootstrap_progress_json = ? WHERE id = ?")
    .bind(JSON.stringify(progress), project.id)
    .run();
  return progress;
}

/** The queue starts observing. It cannot block anything until an operator says so. */
export async function observeQueueProject(db: D1Like, project: QueueProject): Promise<void> {
  await db
    .prepare("UPDATE queue_projects SET enabled = 1, activation_state = 'observe' WHERE id = ?")
    .bind(project.id)
    .run();
}

/* ---------------------------------------------------------------- */
/* The sequence                                                     */
/* ---------------------------------------------------------------- */

export interface BootstrapStatus {
  readonly repositoryId: string;
  readonly baseRef: string;
  readonly backend: Backend;
  readonly enabled: boolean;
  readonly activationState: string;
  readonly progress: BootstrapProgress;
  readonly nextStep: BootstrapStep | null;
  readonly complete: boolean;
  readonly mayActivate: ReturnType<typeof mayActivate>;
}

export function bootstrapStatus(project: QueueProject): BootstrapStatus {
  const next = nextBootstrapStep(project.progress);
  return {
    repositoryId: project.repositoryId,
    baseRef: project.baseRef,
    backend: project.backend,
    enabled: project.enabled,
    activationState: project.activationState,
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
    mergeMethod: project.mergeMethod,
    requiredApprovingReviewCount: deps.review.requiredApprovingReviewCount,
    requireCodeOwnerReview: deps.review.requireCodeOwnerReview,
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
    .prepare("SELECT proof_check_mode FROM projects WHERE github_repository_id = ?")
    .bind(project.repositoryId)
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
  const expected: Array<[string, number]> = [
    [
      PROOF_CHECK,
      proofIntegrationFor({
        mode: await proofCheckMode(deps, project),
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

function matchesExpected(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return false;
    const unmatched = [...actual];
    for (const value of expected) {
      const index = unmatched.findIndex((candidate) => matchesExpected(candidate, value));
      if (index === -1) return false;
      unmatched.splice(index, 1);
    }
    return true;
  }
  if (expected !== null && typeof expected === "object") {
    if (actual === null || typeof actual !== "object" || Array.isArray(actual)) return false;
    const record = actual as Record<string, unknown>;
    return Object.entries(expected).every(([key, value]) => matchesExpected(record[key], value));
  }
  return Object.is(actual, expected);
}

/**
 * Compare the configuration GitHub exposes to the payload setup generated.
 * Server-owned response fields are ignored, but every generated field other
 * than bypass actors must match. GitHub deliberately hides bypass actors from
 * callers without ruleset-write access, so those are handled separately by an
 * explicit administrator confirmation before activation.
 */
function rulesetConfigurationMatches(actual: Ruleset, expected: Ruleset): boolean {
  const { bypass_actors: _ignored, ...visibleExpected } = expected;
  return matchesExpected(actual, visibleExpected);
}

function bypassActorsVisible(ruleset: Ruleset): boolean {
  return Object.hasOwn(ruleset, "bypass_actors");
}

function bypassActorsMatch(actual: Ruleset, expected: Ruleset): boolean {
  return !bypassActorsVisible(actual) || matchesExpected(actual.bypass_actors, expected.bypass_actors);
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

  const backend = checkRulesetForBackend(next, project.backend);
  if (!backend.ok) return { kind: "refused", step, detail: backend.reason };

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
  if (outcome.kind === "advanced") await recordBootstrapStep(deps.db, project, step);
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
      if (open === null) {
        const baseSha = await deps.github.baseSha();
        const opened = await deps.github.openSetupPullRequest({
          files: setupPullRequestFiles({
            endpoint: deps.endpoint,
            actionRef: deps.actionRef,
            mergeWriter: project.mergeWriter,
          }),
          baseSha,
        });
        return {
          kind: "waiting",
          step,
          detail: `opened the setup pull request #${opened.number}; merge it to continue`,
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

      const existingPolicy = await deps.github.rulesetNamed(POLICY_RULESET_NAME);
      const policy = policyFor(deps, project, existingPolicy, {
        enforcement: "active",
        pinCheckSource: true,
        proofCheckMode: await proofCheckMode(deps, project),
      });
      const policyBackend = checkRulesetForBackend(policy, project.backend);
      if (!policyBackend.ok) return { kind: "refused", step, detail: policyBackend.reason };
      const policyDiff = diffRuleset(existingPolicy?.ruleset ?? null, policy);
      if (!policyDiff.safe) return { kind: "refused", step, detail: policyDiff.warnings.join("; ") };

      // Managed branches are written by the App, native ones by GitHub's queue.
      // Sending either backend's rule to the other hands the branch to the wrong
      // writer, which `checkRulesetForBackend` refuses.
      const second =
        project.backend === "managed"
          ? managedOwnershipRuleset({ baseRef: project.baseRef, integrationId: deps.integrationId })
          : nativeMergeQueueRuleset({
              baseRef: project.baseRef,
              integrationId: deps.integrationId,
              mergeMethod: project.mergeMethod,
              checkResponseTimeoutMinutes: NATIVE_CHECK_RESPONSE_TIMEOUT_MINUTES,
            });
      const backend = checkRulesetForBackend(second, project.backend);
      if (!backend.ok) return { kind: "refused", step, detail: backend.reason };

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
        return {
          kind: "waiting",
          step,
          detail:
            "GitHub hides bypass actors from a read-only App; confirm that the policy has no bypass and the ownership ruleset names only the generated writer",
          confirmationRequired: "ruleset-bypass-actors",
        };
      }

      return { kind: "advanced", step, detail: `activated the policy and ${second.name}` };
    }

    case "pin-proof-check-to-app": {
      // The last thing setup does, and the only one that happens after the
      // branch is already protected and merging.
      //
      // While `thwip` is sourced from GitHub Actions, any workflow in the
      // repository can publish a green check by that name and satisfy the
      // requirement. Sourcing it from the App narrows that to one publisher.
      //
      // It cannot happen earlier. The App publishes `thwip` only where
      // `proof_check_mode` is `enforced`; in `observe` it publishes
      // `thwip / proof (observe)` and never the enforced name. Moving the pin
      // first would leave the branch requiring a check with no publisher, and
      // every open pull request in the repository stuck behind it. So this
      // waits, the repository goes on merging on the workflow's check, and
      // enrolment is simply not finished until an administrator enforces.
      if ((await proofCheckMode(deps, project)) !== "enforced") {
        return {
          kind: "waiting",
          step,
          detail:
            `${PROOF_CHECK} is still sourced from GitHub Actions, which any workflow in this ` +
            "repository can satisfy. Enforce the App's proof check to move it to the App; the " +
            "branch keeps merging on the workflow's check until then.",
        };
      }

      const written = await verifyPolicy(deps, project, step, {
        enforcement: "active",
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
        };
      }
      return { kind: "advanced", step, detail: `${PROOF_CHECK} is sourced from the Thwip App` };
    }

    case "record-genesis":
      // The signed genesis transition is the queue's to write when it first
      // moves the branch. What enrolment owes it is a project that is on and
      // observing: observe reports what the queue would have done without being
      // able to block anything, which is what makes adoption reversible.
      await observeQueueProject(deps.db, project);
      return { kind: "advanced", step, detail: "the queue is enabled and observing" };
  }
}

export interface BootstrapRun {
  readonly outcomes: readonly StepOutcome[];
  readonly progress: BootstrapProgress;
  readonly enabled: boolean;
  readonly status: BootstrapStatus;
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
  for (let i = 0; i <= BOOTSTRAP_STEPS.length; i += 1) {
    const outcome = await advanceBootstrap(deps, current);
    outcomes.push(outcome);
    if (outcome.kind !== "advanced") break;
    const reloaded = await readQueueProject(deps.db, current.repositoryId, current.baseRef);
    if (reloaded === null) break;
    current = reloaded;
  }

  const finished = (await readQueueProject(deps.db, project.repositoryId, project.baseRef)) ?? current;
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
  readonly backend?: Backend;
  readonly mergeMethod?: MergeMethod;
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
 * 202 means the run stopped on something a person has to do; 409 means it
 * refused; 200 means the queue is on.
 */
export async function handleBootstrapRequest(request: BootstrapRequest): Promise<BootstrapResponse> {
  const enrolled = await enrollQueueProject(request.db, {
    repositoryId: request.repositoryId,
    baseRef: request.baseRef,
    ...(request.backend === undefined ? {} : { backend: request.backend }),
    ...(request.mergeMethod === undefined ? {} : { mergeMethod: request.mergeMethod }),
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
  setup: { branch: string; title: string; body: string },
): BootstrapGitHub {
  const base = `/repos/${repo.owner}/${repo.repo}`;
  const branch = repo.baseRef.replace(/^refs\/heads\//, "");

  return {
    async baseSha() {
      const ref = await http.json<{ object: { sha: string } }>(`${base}/git/ref/heads/${branch}`);
      return ref.object.sha;
    },

    async setupPullRequest() {
      const found = await http.json<
        Array<{ number: number; merged_at: string | null; head: { sha: string } }>
      >(`${base}/pulls?state=all&head=${repo.owner}:${setup.branch}&per_page=1`);
      const pull = found[0];
      if (pull === undefined) return null;
      return { number: pull.number, merged: pull.merged_at !== null, headSha: pull.head.sha };
    },

    async openSetupPullRequest(input) {
      // A tree built from blobs rather than the contents API, so every file
      // lands in one commit and a reviewer sees one diff.
      const blobs = await Promise.all(
        input.files.map(async (file) => {
          const blob = await http.json<{ sha: string }>(`${base}/git/blobs`, {
            method: "POST",
            body: JSON.stringify({ content: file.content, encoding: "utf-8" }),
            headers: { "content-type": "application/json" },
          });
          return { path: file.path, mode: "100644", type: "blob", sha: blob.sha };
        }),
      );
      const tree = await http.json<{ sha: string }>(`${base}/git/trees`, {
        method: "POST",
        body: JSON.stringify({ base_tree: input.baseSha, tree: blobs }),
        headers: { "content-type": "application/json" },
      });
      const commit = await http.json<{ sha: string }>(`${base}/git/commits`, {
        method: "POST",
        body: JSON.stringify({ message: setup.title, tree: tree.sha, parents: [input.baseSha] }),
        headers: { "content-type": "application/json" },
      });
      await http.json(`${base}/git/refs`, {
        method: "POST",
        body: JSON.stringify({ ref: `refs/heads/${setup.branch}`, sha: commit.sha }),
        headers: { "content-type": "application/json" },
      });
      const pull = await http.json<{ number: number; head: { sha: string } }>(`${base}/pulls`, {
        method: "POST",
        body: JSON.stringify({ title: setup.title, body: setup.body, head: setup.branch, base: branch }),
        headers: { "content-type": "application/json" },
      });
      return { number: pull.number, merged: false, headSha: pull.head.sha };
    },

    async rulesetNamed(name) {
      const all = await http.json<Array<{ id: number; name: string }>>(`${base}/rulesets`);
      const summary = all.find((r) => r.name === name);
      if (summary === undefined) return null;
      const full = await http.json<Ruleset>(`${base}/rulesets/${summary.id}`);
      return { id: summary.id, ruleset: full };
    },

    async publishBootstrapCheck(run) {
      const created = await http.json<{ app?: { id?: number } }>(`${base}/check-runs`, {
        method: "POST",
        body: JSON.stringify(run),
        headers: { "content-type": "application/json" },
      });
      return { appId: created.app?.id ?? 0 };
    },
  };
}
