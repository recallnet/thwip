import { queueKey, TERMINAL_ENTRY_STATES } from "@thwip/queue-domain";
import type { Env } from "./env.js";
import { diagnose } from "./queue/queue-operations.js";
import { loadQueueState } from "./queue/queue-state.js";
import type { D1Like } from "./queue/projection.js";

interface ProjectRow {
  id: string;
  organizationId: string;
  repositoryId: string;
  name: string;
  defaultBranch: string;
  enabled: number;
  organizationLogin: string;
  installationId: string | null;
}

interface RemovedRow {
  repositoryId: string;
  organizationLogin: string;
  installationId: string | null;
  deletedAt: string;
}

export interface ProjectRemovalActor {
  readonly organizationId: string;
  readonly githubUserId: string;
  readonly githubOrgRole: string | null;
}

export interface ProjectRemovalInput {
  readonly projectId: string;
  /** Carries idempotency after the project row itself has gone. */
  readonly repositoryId: string | null;
  readonly confirmation: string;
  readonly actor: ProjectRemovalActor;
}

interface OwnerCheck {
  readonly organizationId: string;
  readonly organizationLogin: string;
  readonly installationId: string | null;
  readonly actorGithubUserId: string;
}

export interface ProjectRemovalDependencies {
  readonly now: () => string;
  readonly isCurrentOrganizationOwner: (input: OwnerCheck) => Promise<boolean>;
  readonly retireStatusComments: (
    repositoryId: string,
    baseRef: string,
    pullRequestNumbers: readonly number[],
  ) => Promise<void>;
  /** Failure injection after the exclusion marker is durable. */
  readonly afterMarker?: () => Promise<void>;
}

export type ProjectRemovalResult =
  | { readonly ok: true; readonly repositoryId: string; readonly alreadyRemoved: boolean }
  | { readonly ok: false; readonly status: 400 | 403 | 404 | 409 | 503; readonly code: string; readonly detail: string };

export interface ProjectAdditionDependencies {
  readonly isCurrentOrganizationOwner: ProjectRemovalDependencies["isCurrentOrganizationOwner"];
  readonly installedRepository: (
    installationId: string,
    fullName: string,
  ) => Promise<{ id: string; fullName: string; defaultBranch: string; ownerId: string }>;
}

export type ProjectAdditionResult =
  | { readonly ok: true; readonly projectId: string; readonly repositoryId: string; readonly name: string }
  | { readonly ok: false; readonly status: 400 | 403 | 404 | 409 | 503; readonly code: string; readonly detail: string };

type ProjectMutationStatus = 400 | 403 | 404 | 409 | 503;

function refusal(status: ProjectMutationStatus, code: string, detail: string) {
  return { ok: false as const, status, code, detail };
}

interface AdditionOrganization {
  id: string;
  githubOrgId: string;
  githubLogin: string;
  installationId: string | null;
}

/** Explicitly add an installed repository as a fresh, disabled project. */
export async function addProject(
  env: Pick<Env, "DB">,
  input: { readonly fullName: string; readonly actor: ProjectRemovalActor },
  deps: ProjectAdditionDependencies,
): Promise<ProjectAdditionResult> {
  if (input.actor.githubOrgRole !== "owner") {
    return refusal(403, "ORGANIZATION_OWNER_REQUIRED", "a current GitHub organization owner must add a project");
  }
  if (!/^[^/\s]+\/[^/\s]+$/.test(input.fullName)) {
    return refusal(400, "REPOSITORY_NAME_INVALID", "name the repository as OWNER/REPOSITORY");
  }
  const org = await env.DB.prepare(
    `SELECT id, github_org_id AS githubOrgId, github_login AS githubLogin, installation_id AS installationId
       FROM organizations WHERE id = ?`,
  )
    .bind(input.actor.organizationId)
    .first<AdditionOrganization>();
  if (org === null || org.installationId === null) {
    return refusal(404, "ORGANIZATION_NOT_INSTALLED", "install the Thwip GitHub App for this organization first");
  }
  if (
    !(await deps.isCurrentOrganizationOwner({
      organizationId: org.id,
      organizationLogin: org.githubLogin,
      installationId: org.installationId,
      actorGithubUserId: input.actor.githubUserId,
    }))
  ) {
    return refusal(403, "ORGANIZATION_OWNER_REQUIRED", "GitHub no longer reports this account as an organization owner");
  }

  let repository: Awaited<ReturnType<ProjectAdditionDependencies["installedRepository"]>>;
  try {
    repository = await deps.installedRepository(org.installationId, input.fullName);
  } catch {
    return refusal(
      404,
      "REPOSITORY_NOT_INSTALLED",
      "the GitHub App cannot see that repository; add it to the App installation, then try again",
    );
  }
  if (repository.ownerId !== org.githubOrgId || repository.fullName.split("/")[0]?.toLowerCase() !== org.githubLogin.toLowerCase()) {
    return refusal(404, "REPOSITORY_NOT_IN_ORGANIZATION", "that repository does not belong to the selected organization");
  }

  const existing = await env.DB.prepare(
    "SELECT id FROM projects WHERE github_repository_id = ? OR lower(github_name) = lower(?) LIMIT 1",
  )
    .bind(repository.id, repository.fullName)
    .first<{ id: string }>();
  if (existing !== null) return refusal(409, "PROJECT_ALREADY_EXISTS", "that repository is already a Thwip project");

  const projectId = `prj_gh_${repository.id}`;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM removed_projects WHERE organization_id = ? AND github_repository_id = ?").bind(org.id, repository.id),
    env.DB
      .prepare(
        `INSERT INTO projects (id, organization_id, github_repository_id, github_name, default_branch, enabled)
         VALUES (?, ?, ?, ?, ?, 0)`,
      )
      .bind(projectId, org.id, repository.id, repository.fullName, repository.defaultBranch),
  ]);
  return { ok: true, projectId, repositoryId: repository.id, name: repository.fullName };
}

function isTerminal(state: string): boolean {
  return (TERMINAL_ENTRY_STATES as readonly string[]).includes(state);
}

const NON_MUTATING_OUTBOX_KINDS = new Set([
  "offer-created",
  "start-workflow",
  "dispatch-verifier",
  "reconcile-merge",
  "publish-transition",
]);

/**
 * Old outbox deliveries are diagnostic history after their attempt has ended.
 * They cannot move the branch because every later queue command refuses a
 * terminal or missing attempt. A merge write is different: it is safe only
 * when its durable operation has a confirmed outcome. Unknown work fails
 * closed so a new branch-mutating delivery cannot silently bypass removal.
 */
function pendingOutboxCanAct(
  store: Awaited<ReturnType<typeof loadQueueState>>["store"],
  report: ReturnType<typeof diagnose>,
): boolean {
  const attempts = new Map(report.attempts.map((attempt) => [attempt.attemptId, attempt]));
  const operations = new Map(report.mergeOperations.map((operation) => [operation.operationId, operation]));

  return store.pendingOutbox().some((item) => {
    if (item.kind === "notify-external-transition") return false;
    if (item.attemptId === undefined) return true;

    const attempt = attempts.get(item.attemptId);
    if (attempt !== undefined && attempt.outcome === null && attempt.phase !== "MERGED") return true;

    if (item.kind === "merge-write") {
      if (item.operationId === undefined) return true;
      return operations.get(item.operationId)?.outcome == null;
    }
    return !NON_MUTATING_OUTBOX_KINDS.has(item.kind);
  });
}

/** A queue may be erased only when nothing durable can still move its branch. */
export async function projectQueueRemovalBlocker(
  db: D1Like,
  repositoryId: string,
): Promise<{ baseRef: string; detail: string } | null> {
  const rows = await db
    .prepare("SELECT base_ref AS baseRef FROM queue_state WHERE github_repository_id = ? ORDER BY base_ref")
    .bind(repositoryId)
    .all<{ baseRef: string }>();
  for (const row of rows.results) {
    const { store } = await loadQueueState(db, repositoryId, row.baseRef);
    const report = diagnose(store);
    const unresolvedWrite = report.mergeOperations.find((operation) => operation.outcome === null);
    if (unresolvedWrite !== undefined) {
      return {
        baseRef: row.baseRef,
        detail:
          `merge operation ${unresolvedWrite.operationId} is unresolved on ${row.baseRef}; ` +
          "run thwip queue doctor --repo OWNER/REPOSITORY and follow its merge-recovery instruction, then retry removal",
      };
    }
    if (report.snapshot.activeAttemptId !== null) {
      return {
        baseRef: row.baseRef,
        detail:
          `attempt ${report.snapshot.activeAttemptId} still holds the lane on ${row.baseRef}; ` +
          "let it finish, or run thwip queue doctor --repo OWNER/REPOSITORY and follow its recovery instruction, then retry removal",
      };
    }
    const liveEntry = report.snapshot.entries.find((entry) => !isTerminal(entry.state));
    if (liveEntry !== undefined) {
      return {
        baseRef: row.baseRef,
        detail:
          `pull request #${liveEntry.pullRequestNumber} is still ${liveEntry.state} on ${row.baseRef}; ` +
          "drain or cancel it, then retry removal",
      };
    }
    if (
      pendingOutboxCanAct(store, report) ||
      report.deadlines.length > 0 ||
      report.attempts.some((attempt) => attempt.outcomeUnknown)
    ) {
      return {
        baseRef: row.baseRef,
        detail:
          `durable queue work is still pending on ${row.baseRef}; ` +
          "run thwip queue doctor --repo OWNER/REPOSITORY and clear every pending operation, then retry removal",
      };
    }
  }
  return null;
}

async function projectRow(db: D1Like, projectId: string, organizationId: string): Promise<ProjectRow | null> {
  return db
    .prepare(
      `SELECT p.id, p.organization_id AS organizationId, p.github_repository_id AS repositoryId,
              p.github_name AS name, p.default_branch AS defaultBranch, p.enabled,
              o.github_login AS organizationLogin, o.installation_id AS installationId
         FROM projects p JOIN organizations o ON o.id = p.organization_id
        WHERE p.id = ? AND p.organization_id = ?`,
    )
    .bind(projectId, organizationId)
    .first<ProjectRow>();
}

async function removedRow(db: D1Like, organizationId: string, repositoryId: string): Promise<RemovedRow | null> {
  return db
    .prepare(
      `SELECT r.github_repository_id AS repositoryId, r.deleted_at AS deletedAt,
              o.github_login AS organizationLogin, o.installation_id AS installationId
         FROM removed_projects r JOIN organizations o ON o.id = r.organization_id
        WHERE r.organization_id = ? AND r.github_repository_id = ?`,
    )
    .bind(organizationId, repositoryId)
    .first<RemovedRow>();
}

async function queueRefs(db: D1Like, repositoryId: string, defaultBranch: string): Promise<string[]> {
  const rows = await db
    .prepare(
      `SELECT base_ref AS baseRef FROM queue_state WHERE github_repository_id = ?
       UNION SELECT base_ref FROM queue_projects WHERE github_repository_id = ?
       UNION SELECT base_ref FROM queue_projection_marks WHERE github_repository_id = ?
       UNION SELECT base_ref FROM queue_status_comments WHERE github_repository_id = ?
       ORDER BY baseRef`,
    )
    .bind(repositoryId, repositoryId, repositoryId, repositoryId)
    .all<{ baseRef: string }>();
  const refs = new Set(rows.results.map((row) => row.baseRef));
  refs.add(`refs/heads/${defaultBranch}`);
  return [...refs].sort();
}

async function statusComments(
  db: D1Like,
  repositoryId: string,
): Promise<Map<string, number[]>> {
  const rows = await db
    .prepare(
      `SELECT base_ref AS baseRef, pull_request_number AS pullRequestNumber
         FROM queue_status_comments WHERE github_repository_id = ?
        ORDER BY base_ref, pull_request_number`,
    )
    .bind(repositoryId)
    .all<{ baseRef: string; pullRequestNumber: number }>();
  const result = new Map<string, number[]>();
  for (const row of rows.results) {
    const numbers = result.get(row.baseRef) ?? [];
    numbers.push(row.pullRequestNumber);
    result.set(row.baseRef, numbers);
  }
  return result;
}

interface R2RemovalBucket {
  list(options: { prefix: string; cursor?: string }): Promise<{
    objects: Array<{ key: string }>;
    truncated: boolean;
    cursor?: string;
  }>;
  delete(keys: string | string[]): Promise<void>;
}

async function purgeEvidence(bucket: R2RemovalBucket | undefined, organizationId: string, repositoryId: string) {
  if (bucket === undefined) return;
  const prefix = `org/${organizationId}/repo/${repositoryId}/`;
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, ...(cursor === undefined ? {} : { cursor }) });
    if (page.objects.length > 0) await bucket.delete(page.objects.map((object) => object.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
}

async function purgeRetiredObjects(env: Pick<Env, "BRANCH_QUEUE">, repositoryId: string, refs: readonly string[]) {
  for (const baseRef of refs) {
    const name = await queueKey(repositoryId, baseRef);
    const stub = env.BRANCH_QUEUE.get(env.BRANCH_QUEUE.idFromName(name)) as unknown as { purge(): Promise<void> };
    await stub.purge();
  }
}

function deleteProjectStatements(
  db: D1Like,
  input: { projectId: string; organizationId: string; repositoryId: string; requestedAt: string; completedAt: string },
): unknown[] {
  const byProject = ["repository_grants", "proof_verifications", "verification_observations", "policy_bundles"];
  const byRepository = [
    "team_repos",
    "queue_status_comments",
    "queue_runners",
    "queue_assignments",
    "candidate_dispatches",
    "candidate_verdicts",
    "queue_attestations",
    "queue_transitions_index",
    "queue_entries_index",
    "queue_projection_marks",
    "queue_state",
    "queue_projects",
  ];
  return [
    ...byProject.map((table) => db.prepare(`DELETE FROM ${table} WHERE project_id = ?`).bind(input.projectId)),
    ...byRepository.map((table) =>
      db.prepare(`DELETE FROM ${table} WHERE github_repository_id = ?`).bind(input.repositoryId),
    ),
    db.prepare("DELETE FROM projects WHERE id = ? AND organization_id = ?").bind(input.projectId, input.organizationId),
    db
      .prepare(
        `UPDATE project_deletion_audits SET outcome = 'completed', completed_at = ?
          WHERE organization_id = ? AND github_repository_id = ? AND requested_at = ?`,
      )
      .bind(input.completedAt, input.organizationId, input.repositoryId, input.requestedAt),
  ];
}

/**
 * Permanently remove one project. The exclusion marker is written first, so a
 * failed R2 or Durable Object call is safe to retry and sync cannot recreate the
 * project while cleanup is incomplete.
 */
export async function removeProject(
  env: Pick<Env, "DB" | "BRANCH_QUEUE" | "EVIDENCE">,
  input: ProjectRemovalInput,
  deps: ProjectRemovalDependencies,
): Promise<ProjectRemovalResult> {
  const db = env.DB as unknown as D1Like;
  if (input.actor.githubOrgRole !== "owner") {
    return refusal(403, "ORGANIZATION_OWNER_REQUIRED", "a current GitHub organization owner must remove a project");
  }

  const project = await projectRow(db, input.projectId, input.actor.organizationId);
  if (project === null) {
    if (input.repositoryId === null) return refusal(404, "PROJECT_NOT_FOUND", "project not found");
    const removed = await removedRow(db, input.actor.organizationId, input.repositoryId);
    if (removed === null) return refusal(404, "PROJECT_NOT_FOUND", "project not found");
    const current = await deps.isCurrentOrganizationOwner({
      organizationId: input.actor.organizationId,
      organizationLogin: removed.organizationLogin,
      installationId: removed.installationId,
      actorGithubUserId: input.actor.githubUserId,
    });
    if (!current) {
      return refusal(403, "ORGANIZATION_OWNER_REQUIRED", "GitHub no longer reports this account as an organization owner");
    }
    return { ok: true, repositoryId: removed.repositoryId, alreadyRemoved: true };
  }

  if (input.repositoryId !== null && input.repositoryId !== project.repositoryId) {
    return refusal(400, "REPOSITORY_MISMATCH", "the repository id does not match this project");
  }
  if (input.confirmation !== project.name) {
    return refusal(400, "CONFIRMATION_MISMATCH", `type ${project.name} exactly to remove this project`);
  }
  const current = await deps.isCurrentOrganizationOwner({
    organizationId: project.organizationId,
    organizationLogin: project.organizationLogin,
    installationId: project.installationId,
    actorGithubUserId: input.actor.githubUserId,
  });
  if (!current) {
    return refusal(403, "ORGANIZATION_OWNER_REQUIRED", "GitHub no longer reports this account as an organization owner");
  }
  if (project.enabled !== 0) {
    return refusal(
      409,
      "DISABLE_PROJECT_FIRST",
      "disable this project first and wait for the project page to show Disabled, then retry removal",
    );
  }
  const initialBlocker = await projectQueueRemovalBlocker(db, project.repositoryId);
  if (initialBlocker !== null) return refusal(409, "QUEUE_NOT_DRAINED", initialBlocker.detail.replace("OWNER/REPOSITORY", project.name));

  const existingMarker = await removedRow(db, project.organizationId, project.repositoryId);
  const requestedAt = existingMarker?.deletedAt ?? deps.now();
  if (existingMarker === null) {
    await env.DB.batch([
      env.DB
        .prepare(
          `INSERT INTO removed_projects
             (organization_id, github_repository_id, deleted_at, deleted_by_github_user_id)
           VALUES (?, ?, ?, ?)`,
        )
        .bind(project.organizationId, project.repositoryId, requestedAt, input.actor.githubUserId),
      env.DB
        .prepare(
          `INSERT INTO project_deletion_audits
             (organization_id, github_repository_id, actor_github_user_id, requested_at, outcome)
           VALUES (?, ?, ?, ?, 'started')`,
        )
        .bind(project.organizationId, project.repositoryId, input.actor.githubUserId, requestedAt),
    ]);
  }
  await deps.afterMarker?.();

  // A writer that began before the marker may have committed before it learned
  // the project was removed. Re-read authority before deleting any evidence.
  const finalBlocker = await projectQueueRemovalBlocker(db, project.repositoryId);
  if (finalBlocker !== null) return refusal(409, "QUEUE_NOT_DRAINED", finalBlocker.detail.replace("OWNER/REPOSITORY", project.name));

  const refs = await queueRefs(db, project.repositoryId, project.defaultBranch);
  const comments = await statusComments(db, project.repositoryId);
  for (const [baseRef, pullRequestNumbers] of comments) {
    await deps.retireStatusComments(project.repositoryId, baseRef, pullRequestNumbers);
  }
  await purgeEvidence(env.EVIDENCE as unknown as R2RemovalBucket | undefined, project.organizationId, project.repositoryId);
  await purgeRetiredObjects(env, project.repositoryId, refs);

  const completedAt = deps.now();
  await (env.DB as unknown as D1Like).batch(
    deleteProjectStatements(db, {
      projectId: project.id,
      organizationId: project.organizationId,
      repositoryId: project.repositoryId,
      requestedAt,
      completedAt,
    }),
  );
  return { ok: true, repositoryId: project.repositoryId, alreadyRemoved: false };
}
