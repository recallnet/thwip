import { SignJWT, importPKCS8 } from "jose";
import type { Env } from "./env.js";
import { GithubApiError, GithubRateLimitError } from "./github-error.js";
import type { D1Like } from "./queue/projection.js";
import {
  drainRepositoryAuthorityLeases,
  fenceDeselectedProjects,
  reconcileInstalledProjects,
  releaseInstallationProjects,
  type InstalledProjectRepository,
  type RepositoryAuthorityLease,
} from "./project-lifecycle.js";

const API = "https://api.github.com";
// One installation sync must fit below both Cloudflare's 10,000-subrequest
// invocation ceiling and GitHub's ordinary 5,000-request installation-token
// hourly floor. The explicit repository cap below makes a complete two-pass
// authority read fit this conservative budget or fail before live state moves.
// A continuation deliberately uses only a small part of either provider's
// per-invocation allowance. Cloudflare D1 permits 1,000 queries on a paid
// Worker invocation and GitHub installations ordinarily start with 5,000 REST
// requests per hour. Every page is stored with one set-based JSON statement,
// so this bound leaves room for D1 lifecycle, queue and finalization work.
const MAX_SYNC_GITHUB_REQUESTS = 80;
const MAX_SUPPORTED_INSTALLATION_REPOSITORIES = 500;

class GithubRequestBudget {
  private used = 0;
  constructor(private readonly limit = MAX_SYNC_GITHUB_REQUESTS) {}
  get remaining(): number { return this.limit - this.used; }
  spend(path: string): void {
    this.used += 1;
    if (this.used > this.limit) {
      throw new Error(
        `GitHub installation snapshot exceeded the supported ${this.limit}-request limit at ${path}; no authoritative projection was applied`,
      );
    }
  }
}

async function appJwt(env: Env): Promise<string> {
  const key = await importPKCS8(env.GITHUB_APP_PRIVATE_KEY, "RS256");
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256" })
    .setIssuedAt(now - 60)
    .setExpirationTime(now + 9 * 60)
    .setIssuer(env.GITHUB_APP_ID)
    .sign(key);
}

async function gh<T>(token: string, path: string, init?: RequestInit, budget?: GithubRequestBudget): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    budget?.spend(path);
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "user-agent": "thwip-control-plane",
        ...(init?.headers ?? {}),
      },
    });
    if (res.ok) return res.json() as Promise<T>;
    const retryAfter = res.headers.get("retry-after");
    const explicitRetrySeconds = retryAfter === null ? null : Number(retryAfter);
    const rateLimitReset = res.headers.get("x-ratelimit-reset");
    const primaryRetrySeconds =
      res.headers.get("x-ratelimit-remaining") === "0" && rateLimitReset !== null
        ? Math.max(1, Number(rateLimitReset) - Math.floor(Date.now() / 1_000) + 1)
        : null;
    const retrySeconds =
      explicitRetrySeconds !== null && Number.isFinite(explicitRetrySeconds)
        ? explicitRetrySeconds
        : primaryRetrySeconds !== null && Number.isFinite(primaryRetrySeconds)
          ? primaryRetrySeconds
          : null;
    if (
      attempt < 2 &&
      (res.status === 429 || res.status === 403) &&
      retrySeconds !== null &&
      Number.isFinite(retrySeconds) &&
      retrySeconds >= 0 &&
      retrySeconds <= 30
    ) {
      await new Promise((resolve) => setTimeout(resolve, retrySeconds * 1_000));
      continue;
    }
    const body = await res.text();
    if ((res.status === 429 || res.status === 403) && retrySeconds !== null && retrySeconds >= 0) {
      throw new GithubRateLimitError(path, res.status, body, Math.max(1, Math.min(3_600, retrySeconds)));
    }
    throw new GithubApiError(path, res.status, body);
  }
}

interface ProjectProjectionRepository {
  readonly id: number | string;
  readonly full_name: string;
  readonly default_branch: string;
}

const MAX_PAGED_GITHUB_PAGES = 90;

async function ghPaged<T extends { readonly id: number | string }>(
  token: string,
  path: string,
  afterPage?: () => Promise<void>,
  budget?: GithubRequestBudget,
): Promise<T[]> {
  const out: T[] = [];
  const seen = new Set<string>();
  for (let page = 1; page <= MAX_PAGED_GITHUB_PAGES; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const batch = await gh<T[]>(token, `${path}${sep}per_page=100&page=${page}`, undefined, budget);
    const before = seen.size;
    for (const item of batch) {
      const id = String(item.id);
      if (id.length === 0) throw new Error(`GitHub returned an item without an identity while listing ${path}`);
      if (!seen.has(id)) {
        seen.add(id);
        out.push(item);
      }
    }
    await afterPage?.();
    if (batch.length < 100) break;
    if (seen.size === before) throw new Error(`GitHub made no progress while listing ${path}`);
    if (page === MAX_PAGED_GITHUB_PAGES) {
      throw new Error(`GitHub listing ${path} exceeded the safe ${MAX_PAGED_GITHUB_PAGES}-page bound`);
    }
  }
  return out;
}

function stableIdentities<T extends { readonly id: number | string }>(
  items: readonly T[],
  identity: (item: T) => string = (item) => String(item.id),
): string {
  return items.map(identity).sort().join("\n");
}

async function completePagedList<T extends { readonly id: number | string }>(
  token: string,
  path: string,
  afterPage?: () => Promise<void>,
  budget?: GithubRequestBudget,
  identity?: (item: T) => string,
): Promise<T[]> {
  const first = await ghPaged<T>(token, path, afterPage, budget);
  const second = await ghPaged<T>(token, path, afterPage, budget);
  if (stableIdentities(first, identity) !== stableIdentities(second, identity)) {
    throw new Error(`GitHub changed identities while listing ${path}`);
  }
  return second;
}

/**
 * GitHub owns the binding between a public key and an identity. This reads a
 * user's registered *signing* keys; the fingerprint of each is what a proof
 * names, so no separate thwip key directory exists.
 */
export async function githubSigningKeys(
  token: string | undefined,
  login: string,
): Promise<Array<{ githubKeyId: number; title: string; publicKey: string }>> {
  const res = await fetch(`${API}/users/${encodeURIComponent(login)}/ssh_signing_keys?per_page=100`, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "thwip-control-plane",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!res.ok) throw new Error(`signing keys for ${login} -> ${res.status}`);
  const keys = (await res.json()) as Array<{ id: number; key: string; title: string }>;
  return keys.map((k) => ({ githubKeyId: k.id, title: k.title, publicKey: k.key.trim() }));
}

export async function installationToken(
  env: Env,
  installationId: string,
  budget?: GithubRequestBudget,
  repositoryId?: string,
): Promise<string> {
  const jwt = await appJwt(env);
  const numericRepositoryId = repositoryId === undefined ? undefined : Number(repositoryId);
  if (numericRepositoryId !== undefined && !Number.isSafeInteger(numericRepositoryId)) {
    throw new Error(`GitHub repository id ${repositoryId} cannot be scoped safely`);
  }
  const res = await gh<{ token: string }>(jwt, `/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    ...(numericRepositoryId === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ repository_ids: [numericRepositoryId] }),
        }),
  }, budget);
  return res.token;
}

export async function listInstallations(env: Env): Promise<
  Array<{
    id: number;
    account: { id: number; login: string; type: string };
    repository_selection: string;
    permissions?: Record<string, string>;
    /**
     * What this installation actually delivers. Absent on older responses, and
     * a caller must not read that absence as "subscribed to nothing".
     */
    events?: string[];
  }>
> {
  const jwt = await appJwt(env);
  return listInstallationsWithToken(jwt);
}

export async function listInstallationsWithToken(token: string): ReturnType<typeof listInstallations> {
  return completePagedList(token, `/app/installations`, undefined, undefined, (installation) =>
    JSON.stringify({
      id: installation.id,
      account: installation.account,
      repositorySelection: installation.repository_selection,
      permissions: installation.permissions ?? {},
      events: [...(installation.events ?? [])].sort(),
    }));
}

function syncLeaseKey(installationId: string): string {
  return `github-installation-${installationId}`;
}

export class GithubInstallationSyncBusyError extends Error {
  constructor(readonly installationId: string) {
    super(`GitHub installation ${installationId} is already syncing`);
  }
}

async function acquireSyncLease(env: Env, installationId: string, owner: string): Promise<void> {
  const now = new Date();
  const expires = new Date(now.getTime() + 30 * 60_000).toISOString();
  const result = await env.DB.prepare(
    `INSERT INTO installation_sync_leases (installation_id, owner_token, expires_at)
     VALUES (?, ?, ?)
     ON CONFLICT(installation_id) DO UPDATE SET owner_token = excluded.owner_token, expires_at = excluded.expires_at
       WHERE installation_sync_leases.expires_at <= ?`,
  )
    .bind(syncLeaseKey(installationId), owner, expires, now.toISOString())
    .run();
  if ((result.meta.changes ?? 0) === 0) throw new GithubInstallationSyncBusyError(installationId);
}

async function renewSyncLease(env: Env, installationId: string, owner: string): Promise<void> {
  const expires = new Date(Date.now() + 30 * 60_000).toISOString();
  const result = await env.DB.prepare(
    "UPDATE installation_sync_leases SET expires_at = ? WHERE installation_id = ? AND owner_token = ?",
  )
    .bind(expires, syncLeaseKey(installationId), owner)
    .run();
  if ((result.meta.changes ?? 0) === 0) throw new Error("GitHub installation sync ownership was lost");
}

async function releaseSyncLease(env: Env, installationId: string, owner: string): Promise<void> {
  await env.DB.prepare("DELETE FROM installation_sync_leases WHERE installation_id = ? AND owner_token = ?")
    .bind(syncLeaseKey(installationId), owner)
    .run();
}

async function suspendInstallation(env: Env, installationId: string): Promise<void> {
  await env.DB.prepare("UPDATE organizations SET status = 'suspended' WHERE installation_id = ?")
    .bind(installationId)
    .run();
}

/**
 * Treat only GitHub's authoritative installation lookup returning 404 as an
 * uninstall. A delayed repository or membership webhook can arrive after the
 * deleted webhook was lost; retrying that message can never make the missing
 * installation return. Other 404s and every transient/permission failure stay
 * errors because they do not prove that the installation is gone.
 */
export async function syncOrDeleteInstallation(
  env: Env,
  installationId: string,
  dependencies: {
    sync?: (installationId: string) => Promise<SyncInstallationResult>;
    remove?: (installationId: string) => Promise<void>;
  } = {},
): Promise<SyncInstallationResult | "deleted"> {
  try {
    return await (dependencies.sync ?? ((id) => syncInstallation(env, id)))(installationId);
  } catch (error) {
    if (
      !(error instanceof GithubApiError) ||
      error.status !== 404 ||
      error.path !== `/app/installations/${installationId}`
    ) {
      throw error;
    }
    await (dependencies.remove ?? ((id) => deleteInstallation(env, id)))(installationId);
    return "deleted";
  }
}

/** Remove only the installation that GitHub named; a delayed old uninstall is harmless after reinstall. */
export async function deleteInstallation(
  env: Env,
  installationId: string,
  dependencies: { readonly afterOrganizationRead?: () => Promise<void> } = {},
): Promise<void> {
  const owner = crypto.randomUUID();
  await acquireSyncLease(env, installationId, owner);
  try {
    const organization = await env.DB.prepare(
      "SELECT id FROM organizations WHERE installation_id = ?",
    )
      .bind(installationId)
      .first<{ id: string }>();
    await dependencies.afterOrganizationRead?.();
    if (organization !== null) {
      await releaseInstallationProjects(env, organization.id, {}, installationId);
    }
    // The exact installation is authoritatively gone. A same-organization
    // reinstall may already have replaced organizations.installation_id, so
    // cleanup cannot depend on that mutable pointer. Remove only the old
    // installation's authority and snapshots; the guarded organization update
    // leaves a current reinstall untouched.
    await env.DB.batch([
      env.DB.prepare(
        "DELETE FROM github_repository_authority WHERE installation_id = ?",
      ).bind(installationId),
      env.DB.prepare(
        `UPDATE organizations
            SET installation_id = NULL, repository_selection = NULL, status = 'disconnected'
          WHERE installation_id = ?`,
      ).bind(installationId),
      env.DB.prepare("DELETE FROM github_sync_snapshots WHERE installation_id = ?")
        .bind(installationId),
    ]);
  } finally {
    await releaseSyncLease(env, installationId, owner);
  }
  // Successful uninstall removed its projects, authority, and staged snapshot.
  // Once the finishing schema is installed, discard the now-expired
  // repository authority identities as well. The bounded drainer repeats all
  // ownership predicates, so unrelated or newly active repositories survive.
  await drainRepositoryAuthorityLeases(env.DB as unknown as D1Like);
}

export interface InstallationReconcileEnqueueDependencies {
  list(): Promise<Array<{ id: number | string }>>;
  enqueueBatch(messages: readonly QueueConsumerInstallationReconcileMessage[]): Promise<void>;
}

interface QueueConsumerInstallationReconcileMessage {
  readonly event: "policy_reconcile";
  readonly installationId: string;
  readonly syncInstallation: true;
  readonly policyPush: null;
  readonly appProofTask: null;
  readonly reconcileProofRepositoryId: null;
  readonly reconcileProofProjectId: null;
  readonly postSyncPolicyReconcile?: boolean;
  readonly postSyncProofReconcile?: boolean;
}

function compareDecimalInstallationIds(left: string, right: string): number {
  if (!/^\d+$/.test(left) || !/^\d+$/.test(right)) {
    throw new Error("GitHub installation ids must be decimal integers");
  }
  const normalizedLeft = left.replace(/^0+(?=\d)/, "");
  const normalizedRight = right.replace(/^0+(?=\d)/, "");
  return normalizedLeft.length - normalizedRight.length || normalizedLeft.localeCompare(normalizedRight);
}

/**
 * Fan the daily authority sweep into one queue delivery per installation.
 * The queue consumer batch size is one, so every installation receives its
 * own Worker/GitHub budget. Locally known ids are included so a missed
 * uninstall webhook converges through the authoritative installation 404.
 */
export async function enqueueAppInstallationReconciliation(
  env: Env,
  dependencies?: InstallationReconcileEnqueueDependencies,
): Promise<string[]> {
  const local = await env.DB.prepare("SELECT installation_id FROM organizations WHERE installation_id IS NOT NULL")
    .bind()
    .all<{ installation_id: string }>();
  const current = await (dependencies?.list ?? (() => listInstallations(env)))();
  const ids = [...new Set([
    ...current.map((installation) => String(installation.id)),
    ...local.results.map((row) => row.installation_id),
  ])].sort(compareDecimalInstallationIds);
  const enqueueBatch = dependencies?.enqueueBatch ?? (async (messages) => {
    await env.SYNC_QUEUE.sendBatch(messages.map((body) => ({ body })));
  });
  for (let start = 0; start < ids.length; start += 100) {
    await enqueueBatch(ids.slice(start, start + 100).map((installationId) => ({
      event: "policy_reconcile" as const,
      installationId,
      syncInstallation: true as const,
      policyPush: null,
      appProofTask: null,
      reconcileProofRepositoryId: null,
      reconcileProofProjectId: null,
    })));
  }
  return ids;
}

export interface DueReimportEnqueueDependencies {
  readonly now?: () => Date;
  readonly enqueueBatch?: (messages: readonly QueueConsumerInstallationReconcileMessage[]) => Promise<void>;
}

/**
 * Recover a clean import whose delayed queue delivery was lost.
 *
 * The five-minute scheduler calls this before quarantine collection. Only the
 * installation GitHub currently projects as selected is enqueued. The
 * authoritative sync still re-reads GitHub before it imports anything.
 */
export async function enqueueDueProjectReimportReconciliation(
  env: Env,
  dependencies: DueReimportEnqueueDependencies = {},
): Promise<string[]> {
  const now = dependencies.now?.() ?? new Date();
  const rows = await env.DB.prepare(
    `SELECT DISTINCT authority.installation_id AS installationId
       FROM project_reimport_quarantines quarantine
       JOIN github_repository_authority authority
         ON authority.github_repository_id = quarantine.github_repository_id
        AND authority.selected = 1
       JOIN organizations organization
         ON organization.id = authority.organization_id
        AND organization.installation_id = authority.installation_id
      WHERE quarantine.reimport_not_before <= ?
        AND NOT EXISTS (
          SELECT 1 FROM projects project
           WHERE project.github_repository_id = quarantine.github_repository_id
        )`,
  ).bind(now.toISOString()).all<{ installationId: string }>();
  const installationIds = rows.results.map((row) => row.installationId).sort(compareDecimalInstallationIds);
  const enqueueBatch = dependencies.enqueueBatch ?? (async (messages) => {
    await env.SYNC_QUEUE.sendBatch(messages.map((body) => ({ body })));
  });
  for (let start = 0; start < installationIds.length; start += 100) {
    await enqueueBatch(installationIds.slice(start, start + 100).map((installationId) => ({
      event: "policy_reconcile" as const,
      installationId,
      syncInstallation: true as const,
      policyPush: null,
      appProofTask: null,
      reconcileProofRepositoryId: null,
      reconcileProofProjectId: null,
    })));
  }
  return installationIds;
}

async function deleteSnapshot(env: Env, snapshotId: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM github_sync_repositories WHERE snapshot_id = ?").bind(snapshotId),
    env.DB.prepare("DELETE FROM github_sync_people WHERE snapshot_id = ?").bind(snapshotId),
    env.DB.prepare("DELETE FROM github_sync_teams WHERE snapshot_id = ?").bind(snapshotId),
    env.DB.prepare("DELETE FROM github_sync_team_members WHERE snapshot_id = ?").bind(snapshotId),
    env.DB.prepare("DELETE FROM github_sync_team_repos WHERE snapshot_id = ?").bind(snapshotId),
    env.DB.prepare("DELETE FROM github_sync_grants WHERE snapshot_id = ?").bind(snapshotId),
    env.DB.prepare("DELETE FROM github_sync_snapshots WHERE id = ?").bind(snapshotId),
  ]);
}

/**
 * Remove crash-orphaned authority generations without waiting for that
 * installation or tenant to sync again. A live generation is protected by the
 * exact installation lease owner that created it.
 */
export async function drainGithubSyncSnapshots(env: Env, limit = 10): Promise<number> {
  const bounded = Math.max(1, Math.min(100, Math.trunc(limit)));
  const rows = await env.DB.prepare(
    `SELECT snapshot.id
       FROM github_sync_snapshots snapshot
      WHERE NOT EXISTS (
        SELECT 1 FROM installation_sync_leases lease
         WHERE lease.installation_id = 'github-installation-' || snapshot.installation_id
           AND lease.owner_token = snapshot.owner_token
           AND lease.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')
      )
        AND (
          snapshot.continuation_pending = 0
          OR snapshot.continuation_not_before IS NULL
          OR snapshot.continuation_not_before <= strftime('%Y-%m-%dT%H:%M:%fZ','now','-24 hours')
        )
      ORDER BY snapshot.created_at, snapshot.id
      LIMIT ?`,
  ).bind(bounded).all<{ id: string }>();
  for (const row of rows.results) await deleteSnapshot(env, row.id);
  return rows.results.length;
}

interface InstallationAuthority {
  readonly account: { readonly id: number; readonly login: string; readonly type: string };
  readonly repository_selection: string;
  readonly suspended_at?: string | null;
}

async function installationAuthority(
  token: string,
  installationId: string,
  budget: GithubRequestBudget,
): Promise<InstallationAuthority> {
  return gh<InstallationAuthority>(token, `/app/installations/${installationId}`, undefined, budget);
}

function sameInstallationAuthority(left: InstallationAuthority, right: InstallationAuthority): boolean {
  return left.account.id === right.account.id &&
    left.account.login === right.account.login &&
    left.account.type === right.account.type &&
    left.repository_selection === right.repository_selection &&
    (left.suspended_at ?? null) === (right.suspended_at ?? null);
}

async function requireCurrentInstallationAuthority(
  env: Env,
  installationId: string,
  original: InstallationAuthority,
  budget: GithubRequestBudget,
): Promise<InstallationAuthority> {
  // App JWTs last only nine minutes. Never reuse the start-of-sync token at a
  // late authority boundary.
  const current = await installationAuthority(await appJwt(env), installationId, budget);
  if (sameInstallationAuthority(original, current)) return current;
  if (current.suspended_at != null) await suspendInstallation(env, installationId);
  throw new Error(`GitHub changed installation ${installationId} while its authority was being read`);
}

/**
 * Full idempotent projection sync for one installation: organization, member
 * roles, teams, team members/repos, installed repositories, and effective
 * collaborator permissions. Webhooks are hints; this is the authority.
 */
export interface SyncInstallationDependencies {
  /** Test-only pause after the exact publication lease has been renewed. */
  readonly beforePublicationBatch?: () => Promise<void>;
  /** Test-only pause after repository pass three, before global epochs are taken. */
  readonly afterRepositoryPassThree?: () => Promise<void>;
  /** A continuation is one new queue invocation with fresh provider budgets. */
  readonly enqueueContinuation?: (
    installationId: string,
    schedule?: { readonly delaySeconds: number; readonly notBefore: string },
    postSyncWork?: InstallationPostSyncWork,
  ) => Promise<void>;
  /** Deterministic quarantine and continuation clock for lifecycle tests. */
  readonly now?: () => Date;
  /** Work that must run only after this authority snapshot is fully current. */
  readonly postSyncWork?: InstallationPostSyncWork;
}

export interface InstallationPostSyncWork {
  readonly reconcilePolicies: boolean;
  readonly reconcileProofChecks: boolean;
}

export interface SyncInstallationResult extends Record<string, number> {
  readonly members: number;
  readonly teams: number;
  readonly repos: number;
  readonly grants: number;
  readonly continued: 0 | 1;
}

interface DurableGithubSnapshot {
  readonly id: string;
  readonly organizationId: string;
  readonly installationId: string;
  readonly ownerToken: string;
  readonly phase: string;
  readonly authorityPass: number;
  readonly cursorParent: string | null;
  readonly cursorPage: number;
  readonly installationAuthority: string;
  readonly repositoryCount: number | null;
  readonly continuationPending: number;
  readonly continuationNotBefore: string | null;
  readonly postSyncPolicyReconcile: number;
  readonly postSyncProofReconcile: number;
}

const AUTHORITY_PHASES = ["owners", "members", "outside", "teams", "team_members", "team_repos", "collaborators"] as const;
type AuthorityPhase = (typeof AUTHORITY_PHASES)[number];

function phaseFor(kind: "repositories" | AuthorityPhase, pass: number): string {
  return `${kind}:${pass}`;
}

function parsePhase(value: string): { kind: "repositories" | AuthorityPhase | "finalize"; pass: number } {
  if (value === "finalize") return { kind: "finalize", pass: 3 };
  const [kind, rawPass] = value.split(":");
  const pass = Number(rawPass);
  if ((kind === "repositories" || AUTHORITY_PHASES.includes(kind as AuthorityPhase)) && [1, 2, 3].includes(pass)) {
    return { kind: kind as "repositories" | AuthorityPhase, pass };
  }
  throw new Error(`unknown GitHub snapshot phase ${value}`);
}

function nextAuthorityPhase(kind: AuthorityPhase, pass: number): string {
  const index = AUTHORITY_PHASES.indexOf(kind);
  if (index < AUTHORITY_PHASES.length - 1) return phaseFor(AUTHORITY_PHASES[index + 1]!, pass);
  return pass === 1 ? phaseFor("owners", 2) : pass === 2 ? phaseFor("repositories", 3) : "finalize";
}

async function loadSnapshot(env: Env, installationId: string): Promise<DurableGithubSnapshot | null> {
  return env.DB.prepare(
    `SELECT id, organization_id AS organizationId, installation_id AS installationId,
            owner_token AS ownerToken, phase, authority_pass AS authorityPass,
            cursor_parent AS cursorParent, cursor_page AS cursorPage,
            installation_authority AS installationAuthority,
            repository_count AS repositoryCount,
            continuation_pending AS continuationPending,
            continuation_not_before AS continuationNotBefore,
            post_sync_policy_reconcile AS postSyncPolicyReconcile,
            post_sync_proof_reconcile AS postSyncProofReconcile
       FROM github_sync_snapshots WHERE installation_id = ? ORDER BY created_at DESC LIMIT 1`,
  ).bind(installationId).first<DurableGithubSnapshot>();
}

async function updateSnapshotCursor(
  env: Env,
  snapshotId: string,
  owner: string,
  values: { phase?: string; pass?: number; parent?: string | null; page?: number; repositoryCount?: number },
): Promise<void> {
  const result = await env.DB.prepare(
    `UPDATE github_sync_snapshots
        SET phase = COALESCE(?, phase), authority_pass = COALESCE(?, authority_pass),
            cursor_parent = ?, cursor_page = COALESCE(?, cursor_page),
            repository_count = COALESCE(?, repository_count),
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ? AND owner_token = ?
        AND EXISTS (
          SELECT 1 FROM installation_sync_leases lease
           WHERE lease.installation_id = 'github-installation-' || github_sync_snapshots.installation_id
             AND lease.owner_token = ?
             AND lease.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')
        )`,
  ).bind(
    values.phase ?? null,
    values.pass ?? null,
    values.parent ?? null,
    values.page ?? null,
    values.repositoryCount ?? null,
    snapshotId,
    owner,
    owner,
  ).run();
  if ((result.meta.changes ?? 0) !== 1) throw new Error("GitHub snapshot ownership was lost");
}

async function createOrResumeSnapshot(
  env: Env,
  installationId: string,
  owner: string,
  authority: InstallationAuthority,
  requestedPostSyncWork: InstallationPostSyncWork = {
    reconcilePolicies: false,
    reconcileProofChecks: false,
  },
): Promise<DurableGithubSnapshot> {
  const current = await loadSnapshot(env, installationId);
  const encoded = JSON.stringify(authority);
  const postSyncPolicyReconcile =
    requestedPostSyncWork.reconcilePolicies || current?.postSyncPolicyReconcile === 1 ? 1 : 0;
  const postSyncProofReconcile =
    requestedPostSyncWork.reconcileProofChecks || current?.postSyncProofReconcile === 1 ? 1 : 0;
  if (current !== null && current.installationAuthority !== encoded) {
    // Reset one durable generation in place. Deleting and recreating it would
    // leave a crash window where the post-sync purpose existed only in memory.
    await env.DB.batch([
      env.DB.prepare("DELETE FROM github_sync_repositories WHERE snapshot_id = ?").bind(current.id),
      env.DB.prepare("DELETE FROM github_sync_people WHERE snapshot_id = ?").bind(current.id),
      env.DB.prepare("DELETE FROM github_sync_teams WHERE snapshot_id = ?").bind(current.id),
      env.DB.prepare("DELETE FROM github_sync_team_members WHERE snapshot_id = ?").bind(current.id),
      env.DB.prepare("DELETE FROM github_sync_team_repos WHERE snapshot_id = ?").bind(current.id),
      env.DB.prepare("DELETE FROM github_sync_grants WHERE snapshot_id = ?").bind(current.id),
      env.DB.prepare(
        `UPDATE github_sync_snapshots
            SET owner_token = ?, phase = 'repositories:1', authority_pass = 1,
                cursor_kind = 'repositories', cursor_parent = NULL, cursor_page = 1,
                installation_authority = ?, repository_count = NULL,
                publication_ready = 0, continuation_pending = 0,
                continuation_not_before = NULL,
                post_sync_policy_reconcile = ?, post_sync_proof_reconcile = ?,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id = ? AND installation_id = ?`,
      ).bind(
        owner,
        encoded,
        postSyncPolicyReconcile,
        postSyncProofReconcile,
        current.id,
        installationId,
      ),
      env.DB.prepare(
        `UPDATE organizations
            SET github_login = ?, repository_selection = ?
          WHERE id = ? AND installation_id = ?`,
      ).bind(authority.account.login, authority.repository_selection, current.organizationId, installationId),
    ]);
    return {
      ...current,
      ownerToken: owner,
      phase: "repositories:1",
      authorityPass: 1,
      cursorParent: null,
      cursorPage: 1,
      installationAuthority: encoded,
      repositoryCount: null,
      continuationPending: 0,
      continuationNotBefore: null,
      postSyncPolicyReconcile,
      postSyncProofReconcile,
    };
  }
  const resumable = current !== null && current.installationAuthority === encoded ? current : null;
  if (resumable !== null) {
    await env.DB.prepare(
      `UPDATE github_sync_snapshots
          SET owner_token = ?, continuation_pending = 0, continuation_not_before = NULL,
              post_sync_policy_reconcile = max(post_sync_policy_reconcile, ?),
              post_sync_proof_reconcile = max(post_sync_proof_reconcile, ?),
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?`,
    ).bind(owner, postSyncPolicyReconcile, postSyncProofReconcile, resumable.id).run();
    return {
      ...resumable,
      ownerToken: owner,
      continuationPending: 0,
      continuationNotBefore: null,
      postSyncPolicyReconcile,
      postSyncProofReconcile,
    };
  }
  const orgGithubId = String(authority.account.id);
  const fallbackOrgId = `org_gh_${orgGithubId}`;
  const existing = await env.DB.prepare("SELECT id FROM organizations WHERE github_org_id = ?")
    .bind(orgGithubId).first<{ id: string }>();
  const organizationId = existing?.id ?? fallbackOrgId;
  await env.DB.prepare(
    `INSERT INTO organizations (id, github_org_id, github_login, installation_id, repository_selection, status)
     VALUES (?, ?, ?, ?, ?, 'syncing')
     ON CONFLICT(github_org_id) DO UPDATE SET
       github_login = excluded.github_login,
       installation_id = excluded.installation_id,
       repository_selection = excluded.repository_selection`,
  ).bind(fallbackOrgId, orgGithubId, authority.account.login, installationId, authority.repository_selection).run();
  const id = `ghsync_${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT INTO github_sync_snapshots
       (id, organization_id, installation_id, owner_token, phase, authority_pass,
        cursor_kind, cursor_page, installation_authority,
        post_sync_policy_reconcile, post_sync_proof_reconcile)
     VALUES (?, ?, ?, ?, 'repositories:1', 1, 'repositories', 1, ?, ?, ?)`,
  ).bind(
    id,
    organizationId,
    installationId,
    owner,
    encoded,
    postSyncPolicyReconcile,
    postSyncProofReconcile,
  ).run();
  return {
    id,
    organizationId,
    installationId,
    ownerToken: owner,
    phase: "repositories:1",
    authorityPass: 1,
    cursorParent: null,
    cursorPage: 1,
    installationAuthority: encoded,
    repositoryCount: null,
    continuationPending: 0,
    continuationNotBefore: null,
    postSyncPolicyReconcile,
    postSyncProofReconcile,
  };
}

async function stageJsonRows(env: Env, sql: string, json: unknown): Promise<number> {
  const result = await env.DB.prepare(sql).bind(JSON.stringify(json)).run();
  return result.meta.changes ?? 0;
}

async function repositoryPassMatches(env: Env, snapshotId: string, left: number, right: number): Promise<boolean> {
  const mismatch = await env.DB.prepare(
    `SELECT 1 AS mismatch FROM (
       SELECT github_repository_id, github_name, default_branch
         FROM github_sync_repositories WHERE snapshot_id = ? AND authority_pass = ?
       EXCEPT
       SELECT github_repository_id, github_name, default_branch
         FROM github_sync_repositories WHERE snapshot_id = ? AND authority_pass = ?
       UNION ALL
       SELECT github_repository_id, github_name, default_branch
         FROM github_sync_repositories WHERE snapshot_id = ? AND authority_pass = ?
       EXCEPT
       SELECT github_repository_id, github_name, default_branch
         FROM github_sync_repositories WHERE snapshot_id = ? AND authority_pass = ?
     ) LIMIT 1`,
  ).bind(snapshotId, left, snapshotId, right, snapshotId, right, snapshotId, left).first<{ mismatch: number }>();
  return mismatch === null;
}

async function authorityPassMatches(env: Env, snapshotId: string, left = 1, right = 2): Promise<boolean> {
  for (const [table, columns] of [
    ["github_sync_people", "github_user_id, github_login, github_org_role, COALESCE(avatar_url,'')"],
    ["github_sync_teams", "team_id, slug, name"],
    ["github_sync_team_members", "team_id, github_user_id"],
    ["github_sync_team_repos", "team_id, github_repository_id, permission"],
    ["github_sync_grants", "github_repository_id, github_user_id, github_login, permission"],
  ] as const) {
    const row = await env.DB.prepare(
      `SELECT 1 AS mismatch FROM (
         SELECT ${columns} FROM ${table} WHERE snapshot_id = ? AND authority_pass = ${left}
         EXCEPT SELECT ${columns} FROM ${table} WHERE snapshot_id = ? AND authority_pass = ${right}
         UNION ALL
         SELECT ${columns} FROM ${table} WHERE snapshot_id = ? AND authority_pass = ${right}
         EXCEPT SELECT ${columns} FROM ${table} WHERE snapshot_id = ? AND authority_pass = ${left}
       ) LIMIT 1`,
    ).bind(snapshotId, snapshotId, snapshotId, snapshotId).first<{ mismatch: number }>();
    if (row !== null) return false;
  }
  return true;
}

async function nextSnapshotParent(
  env: Env,
  snapshotId: string,
  pass: number,
  table: "github_sync_repositories" | "github_sync_teams",
  idColumn: "github_repository_id" | "team_id",
  nameColumn: "github_name" | "slug",
  after: string | null,
): Promise<{ id: string; name: string } | null> {
  return env.DB.prepare(
    `SELECT ${idColumn} AS id, ${nameColumn} AS name FROM ${table}
      WHERE snapshot_id = ? AND authority_pass = ?
        AND (? IS NULL OR length(${idColumn}) > length(?) OR
             (length(${idColumn}) = length(?) AND ${idColumn} > ?))
      ORDER BY length(${idColumn}), ${idColumn} LIMIT 1`,
  ).bind(snapshotId, pass, after, after, after, after).first<{ id: string; name: string }>();
}

async function enqueueSyncContinuation(
  env: Env,
  installationId: string,
  snapshotId: string,
  owner: string,
  dependency?: SyncInstallationDependencies["enqueueContinuation"],
  delaySeconds = 0,
  exactNotBefore?: string,
): Promise<void> {
  const notBefore = exactNotBefore ?? new Date(Date.now() + Math.max(0, delaySeconds) * 1_000).toISOString();
  const marked = await env.DB.prepare(
    `UPDATE github_sync_snapshots
        SET continuation_pending = 1, continuation_not_before = ?,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ? AND installation_id = ? AND owner_token = ?`,
  ).bind(notBefore, snapshotId, installationId, owner).run();
  if ((marked.meta.changes ?? 0) !== 1) throw new Error("GitHub snapshot continuation ownership was lost");
  const purpose = await env.DB.prepare(
    `SELECT post_sync_policy_reconcile AS reconcilePolicies,
            post_sync_proof_reconcile AS reconcileProofChecks
       FROM github_sync_snapshots
      WHERE id = ? AND installation_id = ? AND owner_token = ?`,
  ).bind(snapshotId, installationId, owner).first<{
    reconcilePolicies: number;
    reconcileProofChecks: number;
  }>();
  if (purpose === null) throw new Error("GitHub snapshot continuation purpose was lost");
  const postSyncWork: InstallationPostSyncWork = {
    reconcilePolicies: purpose.reconcilePolicies === 1,
    reconcileProofChecks: purpose.reconcileProofChecks === 1,
  };
  if (dependency !== undefined) {
    return dependency(installationId, { delaySeconds, notBefore }, postSyncWork);
  }
  await env.SYNC_QUEUE.send({
    event: "installation_sync_continue",
    installationId,
    syncInstallation: true,
    policyPush: null,
    appProofTask: null,
    reconcileProofRepositoryId: null,
    reconcileProofProjectId: null,
    postSyncPolicyReconcile: postSyncWork.reconcilePolicies,
    postSyncProofReconcile: postSyncWork.reconcileProofChecks,
  }, delaySeconds > 0 ? { delaySeconds } : undefined);
}

function syncCounts(continued: 0 | 1, repos = 0): SyncInstallationResult {
  return { members: 0, teams: 0, repos, grants: 0, continued };
}

async function readCurrentInstallationRepositories(
  token: string,
  budget: GithubRequestBudget,
): Promise<ProjectProjectionRepository[]> {
  const repositories: ProjectProjectionRepository[] = [];
  const seen = new Set<string>();
  let expectedCount: number | null = null;
  for (let page = 1; page <= 6; page += 1) {
    const response = await gh<{ total_count: number; repositories: ProjectProjectionRepository[] }>(
      token,
      `/installation/repositories?per_page=100&page=${page}`,
      undefined,
      budget,
    );
    if (!Number.isSafeInteger(response.total_count) || response.total_count < 0) {
      throw new Error("GitHub returned an invalid installation repository count");
    }
    if (expectedCount !== null && expectedCount !== response.total_count) {
      throw new Error("GitHub changed the repository count during its final authority check");
    }
    expectedCount = response.total_count;
    for (const repository of response.repositories) {
      const id = String(repository.id);
      if (seen.has(id)) throw new Error("GitHub repeated a repository during its final authority check");
      seen.add(id);
      repositories.push(repository);
    }
    if (repositories.length === expectedCount) break;
    if (response.repositories.length !== 100 || repositories.length > expectedCount) {
      throw new Error("GitHub returned an incomplete final installation repository list");
    }
  }
  if (repositories.length !== expectedCount) {
    throw new Error("GitHub final installation repository list exceeded the supported page bound");
  }
  return repositories;
}

function stableRepositories(repositories: readonly ProjectProjectionRepository[]): string {
  return repositories
    .map((repository) => `${repository.id}\0${repository.full_name}\0${repository.default_branch}`)
    .sort()
    .join("\n");
}

async function relevantPublicationRepositoryIds(
  env: Env,
  snapshot: DurableGithubSnapshot,
): Promise<string[]> {
  const rows = await env.DB.prepare(
    `SELECT github_repository_id FROM github_sync_repositories
      WHERE snapshot_id = ? AND authority_pass = 3
     UNION
     SELECT github_repository_id FROM projects WHERE organization_id = ?
     UNION
     SELECT github_repository_id FROM github_repository_authority
      WHERE organization_id = ? OR installation_id = ?`,
  ).bind(snapshot.id, snapshot.organizationId, snapshot.organizationId, snapshot.installationId)
    .all<{ github_repository_id: string }>();
  return rows.results.map((row) => row.github_repository_id).sort(compareDecimalInstallationIds);
}

async function acquirePublicationLeases(
  env: Env,
  snapshot: DurableGithubSnapshot,
  owner: string,
): Promise<Map<string, RepositoryAuthorityLease> | null> {
  const leases = new Map<string, RepositoryAuthorityLease>();
  const repositoryIds = await relevantPublicationRepositoryIds(env, snapshot);
  if (repositoryIds.length === 0) return leases;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 30 * 60_000).toISOString();
  await env.DB.prepare(
    `INSERT INTO github_repository_reconcile_leases
       (github_repository_id, installation_id, owner_token, epoch, expires_at)
     SELECT CAST(json_extract(value,'$') AS TEXT), ?, ?, 1, ? FROM json_each(?) WHERE 1
     ON CONFLICT(github_repository_id) DO UPDATE SET
       installation_id = excluded.installation_id,
       owner_token = excluded.owner_token,
       epoch = github_repository_reconcile_leases.epoch + 1,
       expires_at = excluded.expires_at
     WHERE github_repository_reconcile_leases.expires_at <= ?`,
  ).bind(snapshot.installationId, owner, expiresAt, JSON.stringify(repositoryIds), now.toISOString()).run();
  const rows = await env.DB.prepare(
    `SELECT github_repository_id AS repositoryId, epoch
       FROM github_repository_reconcile_leases
      WHERE installation_id = ? AND owner_token = ?
        AND github_repository_id IN (SELECT CAST(value AS TEXT) FROM json_each(?))`,
  ).bind(snapshot.installationId, owner, JSON.stringify(repositoryIds))
    .all<{ repositoryId: string; epoch: number }>();
  if (rows.results.length !== repositoryIds.length) {
    await env.DB.prepare(
      `UPDATE github_repository_reconcile_leases
          SET expires_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE installation_id = ? AND owner_token = ?`,
    ).bind(snapshot.installationId, owner).run();
    return null;
  }
  for (const row of rows.results) {
    const assert = async (): Promise<void> => {
      const result = await env.DB.prepare(
        `UPDATE github_repository_reconcile_leases SET expires_at = ?
          WHERE github_repository_id = ? AND installation_id = ?
            AND owner_token = ? AND epoch = ?
            AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
      ).bind(
        new Date(Date.now() + 30 * 60_000).toISOString(),
        row.repositoryId,
        snapshot.installationId,
        owner,
        row.epoch,
      ).run();
      if ((result.meta.changes ?? 0) !== 1) throw new Error(`repository ${row.repositoryId} authority epoch was lost`);
    };
    leases.set(row.repositoryId, {
      repositoryId: row.repositoryId,
      installationId: snapshot.installationId,
      owner,
      epoch: row.epoch,
      assert,
      release: async () => {},
    });
  }
  return leases;
}

async function syncInstallationStep(
  env: Env,
  installationId: string,
  dependencies: SyncInstallationDependencies = {},
): Promise<SyncInstallationResult> {
  const leaseOwner = crypto.randomUUID();
  const budget = new GithubRequestBudget();
  let activeSnapshotId: string | null = null;
  let publicationLeases = new Map<string, RepositoryAuthorityLease>();
  await acquireSyncLease(env, installationId, leaseOwner);
  try {
    const current = await installationAuthority(await appJwt(env), installationId, budget);
    if (current.suspended_at != null) {
      await suspendInstallation(env, installationId);
      return syncCounts(0);
    }
    let snapshot = await createOrResumeSnapshot(
      env,
      installationId,
      leaseOwner,
      current,
      dependencies.postSyncWork,
    );
    activeSnapshotId = snapshot.id;
    const token = await installationToken(env, installationId, budget);

    while (budget.remaining > 4) {
      const parsed = parsePhase(snapshot.phase);
      if (parsed.kind === "finalize") break;

      if (parsed.kind === "repositories") {
        const response = await gh<{ total_count: number; repositories: ProjectProjectionRepository[] }>(
          token,
          `/installation/repositories?per_page=100&page=${snapshot.cursorPage}`,
          undefined,
          budget,
        );
        if (!Number.isSafeInteger(response.total_count) || response.total_count < 0) {
          throw new Error("GitHub returned an invalid installation repository count");
        }
        if (snapshot.repositoryCount !== null && snapshot.repositoryCount !== response.total_count) {
          throw new Error("GitHub changed the repository count while its snapshot was being read");
        }
        const changed = await stageJsonRows(env,
          `INSERT OR IGNORE INTO github_sync_repositories
             (snapshot_id, authority_pass, github_repository_id, github_name, default_branch)
           SELECT '${snapshot.id.replaceAll("'", "''")}', ${parsed.pass},
                  CAST(json_extract(value,'$.id') AS TEXT),
                  json_extract(value,'$.full_name'), json_extract(value,'$.default_branch')
             FROM json_each(?)`, response.repositories);
        const total = await env.DB.prepare(
          "SELECT count(*) AS count FROM github_sync_repositories WHERE snapshot_id = ? AND authority_pass = ?",
        ).bind(snapshot.id, parsed.pass).first<{ count: number }>();
        if (response.repositories.length === 100 && changed === 0) {
          throw new Error("GitHub made no progress while staging installation repositories");
        }
        if ((total?.count ?? 0) < response.total_count) {
          await updateSnapshotCursor(env, snapshot.id, leaseOwner, {
            page: snapshot.cursorPage + 1,
            repositoryCount: response.total_count,
          });
        } else {
          if ((total?.count ?? 0) !== response.total_count) throw new Error("GitHub repository snapshot was incomplete");
          if (parsed.pass === 2) {
            if (!(await repositoryPassMatches(env, snapshot.id, 1, 2))) {
              throw new Error("GitHub changed the installation repositories between authority passes");
            }
            const ids = await env.DB.prepare(
              "SELECT github_repository_id FROM github_sync_repositories WHERE snapshot_id = ? AND authority_pass = 2",
            ).bind(snapshot.id).all<{ github_repository_id: string }>();
            await fenceDeselectedProjects(
              env.DB as unknown as D1Like,
              snapshot.organizationId,
              ids.results.map((row) => row.github_repository_id),
            );
            if (response.total_count > MAX_SUPPORTED_INSTALLATION_REPOSITORIES) {
              throw new Error(
                `Thwip supports at most ${MAX_SUPPORTED_INSTALLATION_REPOSITORIES} repositories in one GitHub App installation; ` +
                `this installation selected ${response.total_count}. Select fewer repositories before syncing.`,
              );
            }
          }
          if (parsed.pass === 3 && !(await repositoryPassMatches(env, snapshot.id, 2, 3))) {
            throw new Error("GitHub changed the installation repositories before authority publication");
          }
          const next = parsed.pass === 1 ? phaseFor("repositories", 2) :
            parsed.pass === 2 ? phaseFor("owners", 1) : phaseFor("owners", 3);
          await updateSnapshotCursor(env, snapshot.id, leaseOwner, {
            phase: next, pass: parsed.pass === 1 ? 2 : parsed.pass === 2 ? 1 : 3,
            page: 1, parent: null, repositoryCount: response.total_count,
          });
          if (parsed.pass === 3) await dependencies.afterRepositoryPassThree?.();
        }
      } else {
        const org = current.account.login;
        let path: string;
        let parent: { id: string; name: string } | null = null;
        if (parsed.kind === "owners") path = `/orgs/${org}/members?role=admin`;
        else if (parsed.kind === "members") path = `/orgs/${org}/members?role=member`;
        else if (parsed.kind === "outside") path = `/orgs/${org}/outside_collaborators`;
        else if (parsed.kind === "teams") path = `/orgs/${org}/teams`;
        else if (parsed.kind === "collaborators") {
          parent = await nextSnapshotParent(env, snapshot.id, parsed.pass, "github_sync_repositories", "github_repository_id", "github_name", snapshot.cursorParent);
          if (parent === null) {
            const next = nextAuthorityPhase(parsed.kind, parsed.pass);
            if (next === phaseFor("repositories", 3)) await dependencies.beforePublicationBatch?.();
            await updateSnapshotCursor(env, snapshot.id, leaseOwner, { phase: next, page: 1, parent: null });
            snapshot = (await loadSnapshot(env, installationId))!;
            continue;
          }
          path = `/repos/${parent.name}/collaborators?affiliation=all`;
        } else {
          parent = await nextSnapshotParent(env, snapshot.id, parsed.pass, "github_sync_teams", "team_id", "slug", snapshot.cursorParent);
          if (parent === null) {
            await updateSnapshotCursor(env, snapshot.id, leaseOwner, { phase: nextAuthorityPhase(parsed.kind, parsed.pass), page: 1, parent: null });
            snapshot = (await loadSnapshot(env, installationId))!;
            continue;
          }
          path = parsed.kind === "team_members" ? `/orgs/${org}/teams/${parent.name}/members` : `/orgs/${org}/teams/${parent.name}/repos`;
        }
        const sep = path.includes("?") ? "&" : "?";
        const rows = await gh<Array<Record<string, unknown>>>(token, `${path}${sep}per_page=100&page=${snapshot.cursorPage}`, undefined, budget);
        let changed = 0;
        if (parsed.kind === "owners" || parsed.kind === "members" || parsed.kind === "outside") {
          const role = parsed.kind === "owners" ? "owner" : parsed.kind === "members" ? "member" : "outside";
          changed = await stageJsonRows(env,
            `INSERT OR IGNORE INTO github_sync_people
               (snapshot_id, authority_pass, github_user_id, github_login, github_org_role, avatar_url)
             SELECT '${snapshot.id.replaceAll("'", "''")}', ${parsed.pass}, CAST(json_extract(value,'$.id') AS TEXT),
                    json_extract(value,'$.login'), '${role}', json_extract(value,'$.avatar_url') FROM json_each(?)`, rows);
        } else if (parsed.kind === "teams") {
          changed = await stageJsonRows(env,
            `INSERT OR IGNORE INTO github_sync_teams (snapshot_id, authority_pass, team_id, slug, name)
             SELECT '${snapshot.id.replaceAll("'", "''")}', ${parsed.pass}, CAST(json_extract(value,'$.id') AS TEXT),
                    json_extract(value,'$.slug'), json_extract(value,'$.name') FROM json_each(?)`, rows);
        } else if (parsed.kind === "team_members") {
          changed = await stageJsonRows(env,
            `INSERT OR IGNORE INTO github_sync_team_members (snapshot_id, authority_pass, team_id, github_user_id)
             SELECT '${snapshot.id.replaceAll("'", "''")}', ${parsed.pass}, '${parent!.id.replaceAll("'", "''")}',
                    CAST(json_extract(value,'$.id') AS TEXT) FROM json_each(?)`, rows);
        } else if (parsed.kind === "team_repos") {
          changed = await stageJsonRows(env,
            `INSERT OR IGNORE INTO github_sync_team_repos
               (snapshot_id, authority_pass, team_id, github_repository_id, project_id, permission)
             SELECT '${snapshot.id.replaceAll("'", "''")}', ${parsed.pass}, '${parent!.id.replaceAll("'", "''")}',
                    CAST(json_extract(value,'$.id') AS TEXT), NULL,
                    COALESCE(json_extract(value,'$.role_name'), CASE
                      WHEN json_extract(value,'$.permissions.admin') THEN 'admin'
                      WHEN json_extract(value,'$.permissions.push') THEN 'write' ELSE 'read' END)
               FROM json_each(?)`, rows);
        } else {
          changed = await stageJsonRows(env,
            `INSERT OR IGNORE INTO github_sync_grants
               (snapshot_id, authority_pass, github_repository_id, project_id, github_user_id, github_login, permission)
             SELECT '${snapshot.id.replaceAll("'", "''")}', ${parsed.pass}, '${parent!.id.replaceAll("'", "''")}', NULL,
                    CAST(json_extract(value,'$.id') AS TEXT), json_extract(value,'$.login'),
                    COALESCE(json_extract(value,'$.role_name'), CASE
                      WHEN json_extract(value,'$.permissions.admin') THEN 'admin'
                      WHEN json_extract(value,'$.permissions.maintain') THEN 'maintain'
                      WHEN json_extract(value,'$.permissions.push') THEN 'write'
                      WHEN json_extract(value,'$.permissions.triage') THEN 'triage' ELSE 'read' END)
               FROM json_each(?)`, rows);
        }
        if (rows.length === 100 && changed === 0) throw new Error(`GitHub made no progress while staging ${parsed.kind}`);
        if (rows.length === 100) {
          await updateSnapshotCursor(env, snapshot.id, leaseOwner, { page: snapshot.cursorPage + 1, parent: snapshot.cursorParent });
        } else if (parent !== null) {
          await updateSnapshotCursor(env, snapshot.id, leaseOwner, { page: 1, parent: parent.id });
        } else {
          const next = nextAuthorityPhase(parsed.kind, parsed.pass);
          if (next === phaseFor("repositories", 3)) await dependencies.beforePublicationBatch?.();
          await updateSnapshotCursor(env, snapshot.id, leaseOwner, { phase: next, page: 1, parent: null });
        }
      }
      snapshot = (await loadSnapshot(env, installationId))!;
      if (budget.remaining <= 4) break;
    }

    if (snapshot.phase !== "finalize" || budget.remaining < 7) {
      await enqueueSyncContinuation(
        env,
        installationId,
        snapshot.id,
        leaseOwner,
        dependencies.enqueueContinuation,
      );
      const repos = snapshot.repositoryCount ?? 0;
      return syncCounts(1, repos);
    }

    if (!(await repositoryPassMatches(env, snapshot.id, 2, 3)) ||
        !(await authorityPassMatches(env, snapshot.id)) ||
        !(await authorityPassMatches(env, snapshot.id, 2, 3))) {
      throw new Error("GitHub changed installation authority before publication");
    }
    await requireCurrentInstallationAuthority(env, installationId, current, budget);
    await renewSyncLease(env, installationId, leaseOwner);
    const publicationOwner = crypto.randomUUID();
    const acquired = await acquirePublicationLeases(env, snapshot, publicationOwner);
    if (acquired === null) {
      await enqueueSyncContinuation(
        env,
        installationId,
        snapshot.id,
        leaseOwner,
        dependencies.enqueueContinuation,
        60,
      );
      return syncCounts(1, snapshot.repositoryCount ?? 0);
    }
    publicationLeases = acquired;
    const stagedRepositories = await env.DB.prepare(
      `SELECT github_repository_id AS id, github_name AS full_name,
              default_branch
         FROM github_sync_repositories
        WHERE snapshot_id = ? AND authority_pass = 3`,
    ).bind(snapshot.id).all<ProjectProjectionRepository>();
    // Make the remote membership read the last awaited authority operation.
    // The D1 snapshot is loaded first so there is no unrelated database pause
    // between GitHub's answer and the guarded publication batch below.
    const finalRepositories = await readCurrentInstallationRepositories(
      await installationToken(env, installationId, budget),
      budget,
    );
    if (stableRepositories(finalRepositories) !== stableRepositories(stagedRepositories.results)) {
      const postSyncWork = {
        reconcilePolicies: snapshot.postSyncPolicyReconcile === 1,
        reconcileProofChecks: snapshot.postSyncProofReconcile === 1,
      };
      await deleteSnapshot(env, snapshot.id);
      const restarted = await createOrResumeSnapshot(
        env,
        installationId,
        leaseOwner,
        current,
        postSyncWork,
      );
      activeSnapshotId = restarted.id;
      await enqueueSyncContinuation(
        env,
        installationId,
        restarted.id,
        leaseOwner,
        dependencies.enqueueContinuation,
      );
      return syncCounts(1, finalRepositories.length);
    }
    const orgId = snapshot.organizationId;
    const snapshotId = snapshot.id;
    const orgGithubId = String(current.account.id);
    const publicationGuard = `EXISTS (
      SELECT 1 FROM github_sync_snapshots publication
      JOIN organizations publication_org ON publication_org.id = publication.organization_id
       WHERE publication.id = ? AND publication.organization_id = ?
         AND publication.installation_id = ? AND publication.owner_token = ?
         AND publication.publication_ready = 1
         AND publication_org.installation_id = publication.installation_id
    )`;
    const publication = [snapshotId, orgId, installationId, leaseOwner] as const;
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE github_sync_snapshots SET publication_ready = 1
          WHERE id = ? AND organization_id = ? AND installation_id = ? AND owner_token = ?
            AND EXISTS (SELECT 1 FROM installation_sync_leases lease
              WHERE lease.installation_id = ? AND lease.owner_token = ?
                AND lease.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
      ).bind(snapshotId, orgId, installationId, leaseOwner, syncLeaseKey(installationId), leaseOwner),
      env.DB.prepare(
        `INSERT INTO github_repository_authority
           (github_repository_id, organization_id, installation_id, snapshot_id, lease_epoch, selected)
         SELECT p.github_repository_id, ?, ?, ?, repository_lease.epoch, 0
           FROM projects p
           JOIN github_repository_reconcile_leases repository_lease
             ON repository_lease.github_repository_id = p.github_repository_id
            AND repository_lease.installation_id = ?
            AND repository_lease.owner_token = ?
            AND repository_lease.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE p.organization_id = ?
         ON CONFLICT(github_repository_id, installation_id) DO UPDATE SET
           organization_id = excluded.organization_id, snapshot_id = excluded.snapshot_id,
           lease_epoch = excluded.lease_epoch, selected = 0,
           observed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
      ).bind(orgId, installationId, snapshotId, installationId, publicationOwner, orgId),
      env.DB.prepare(
        `INSERT INTO github_repository_authority
           (github_repository_id, organization_id, installation_id, snapshot_id, lease_epoch, selected)
         SELECT staged.github_repository_id, ?, ?, ?, repository_lease.epoch, 1
           FROM github_sync_repositories staged
           JOIN github_repository_reconcile_leases repository_lease
             ON repository_lease.github_repository_id = staged.github_repository_id
            AND repository_lease.installation_id = ?
            AND repository_lease.owner_token = ?
            AND repository_lease.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE staged.snapshot_id = ? AND staged.authority_pass = 3 AND ${publicationGuard}
         ON CONFLICT(github_repository_id, installation_id) DO UPDATE SET
           organization_id = excluded.organization_id, snapshot_id = excluded.snapshot_id,
           lease_epoch = excluded.lease_epoch, selected = 1,
           observed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
      ).bind(
        orgId,
        installationId,
        snapshotId,
        installationId,
        publicationOwner,
        snapshotId,
        ...publication,
      ),
      // A repository can be selected while its old App token quarantine is
      // active and then be deselected again before a fresh project exists.
      // Projects cannot drive that absence because this lifecycle deliberately
      // has no project row. Retire the same installation's prior selection
      // under the exact repository epoch held for this final GitHub snapshot.
      env.DB.prepare(
        `UPDATE github_repository_authority AS authority
            SET selected = 0, snapshot_id = ?,
                lease_epoch = (
                  SELECT repository_lease.epoch
                    FROM github_repository_reconcile_leases repository_lease
                   WHERE repository_lease.github_repository_id = authority.github_repository_id
                     AND repository_lease.installation_id = ?
                     AND repository_lease.owner_token = ?
                ),
                observed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE authority.organization_id = ? AND authority.installation_id = ?
            AND NOT EXISTS (
              SELECT 1 FROM github_sync_repositories staged
               WHERE staged.snapshot_id = ? AND staged.authority_pass = 3
                 AND staged.github_repository_id = authority.github_repository_id
            )
            AND EXISTS (
              SELECT 1 FROM github_repository_reconcile_leases repository_lease
               WHERE repository_lease.github_repository_id = authority.github_repository_id
                 AND repository_lease.installation_id = ?
                 AND repository_lease.owner_token = ?
                 AND repository_lease.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')
            )
            AND ${publicationGuard}`,
      ).bind(
        snapshotId,
        installationId,
        publicationOwner,
        orgId,
        installationId,
        snapshotId,
        installationId,
        publicationOwner,
        ...publication,
      ),
      env.DB.prepare(
        `DELETE FROM github_repository_authority
          WHERE installation_id != ?
            AND (
              (
                organization_id = ?
                AND github_repository_id IN (
                  SELECT repository_lease.github_repository_id
                    FROM github_repository_reconcile_leases repository_lease
                   WHERE repository_lease.installation_id = ?
                     AND repository_lease.owner_token = ?
                     AND repository_lease.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')
                )
              )
              OR github_repository_id IN (
                SELECT staged.github_repository_id FROM github_sync_repositories staged
                 JOIN github_repository_reconcile_leases repository_lease
                   ON repository_lease.github_repository_id = staged.github_repository_id
                  AND repository_lease.installation_id = ?
                  AND repository_lease.owner_token = ?
                 WHERE staged.snapshot_id = ? AND staged.authority_pass = 3
              )
            )
            AND ${publicationGuard}`,
      ).bind(
        installationId,
        orgId,
        installationId,
        publicationOwner,
        installationId,
        publicationOwner,
        snapshotId,
        ...publication,
      ),
    ]);
    const ready = await env.DB.prepare(
      "SELECT 1 AS ready FROM github_sync_snapshots WHERE id = ? AND owner_token = ? AND publication_ready = 1",
    ).bind(snapshotId, leaseOwner).first<{ ready: number }>();
    if (ready === null) throw new Error(`GitHub installation ${installationId} lost snapshot publication ownership`);

    const selected = await env.DB.prepare(
      `SELECT github_repository_id AS id, github_name AS fullName, default_branch AS defaultBranch
         FROM github_sync_repositories WHERE snapshot_id = ? AND authority_pass = 3
         ORDER BY length(github_repository_id), github_repository_id`,
    ).bind(snapshotId).all<InstalledProjectRepository>();
    await reconcileInstalledProjects(env, orgId, selected.results, {
      authorityInstallationId: installationId,
      authoritySnapshotId: snapshotId,
      authorityLeases: publicationLeases,
      authorityLeaseOwner: publicationOwner,
      ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
    });

    if (publicationLeases.size > 0) {
      const renewed = await env.DB.prepare(
        `UPDATE github_repository_reconcile_leases SET expires_at = ?
          WHERE installation_id = ? AND owner_token = ?
            AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
      ).bind(
        new Date(Date.now() + 30 * 60_000).toISOString(),
        installationId,
        publicationOwner,
      ).run();
      if ((renewed.meta.changes ?? 0) !== publicationLeases.size) {
        throw new Error("GitHub repository publication authority epochs were lost");
      }
    }

    await env.DB.batch([
    env.DB.prepare(
      `UPDATE github_sync_snapshots SET publication_ready = 1
        WHERE id = ? AND organization_id = ? AND installation_id = ? AND owner_token = ?
          AND EXISTS (
            SELECT 1 FROM installation_sync_leases lease
             WHERE lease.installation_id = ? AND lease.owner_token = ?
               AND lease.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')
          )`,
    ).bind(snapshotId, orgId, installationId, leaseOwner, syncLeaseKey(installationId), leaseOwner),
    env.DB.prepare(
      `UPDATE repository_grants SET active = 0, synced_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE project_id IN (SELECT id FROM projects WHERE organization_id = ?)
          AND ${publicationGuard}
          AND NOT EXISTS (
            SELECT 1 FROM github_sync_grants s JOIN projects staged_project
              ON staged_project.github_repository_id = s.github_repository_id
             AND staged_project.organization_id = ?
             WHERE s.snapshot_id = ? AND s.authority_pass = 3
               AND staged_project.id = repository_grants.project_id
               AND s.github_user_id = repository_grants.github_user_id
          )`,
    ).bind(orgId, ...publication, orgId, snapshotId),
    env.DB.prepare(
      `INSERT INTO repository_grants (project_id, github_user_id, github_login, permission, active, synced_at)
       SELECT p.id, s.github_user_id, s.github_login, s.permission, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now')
         FROM github_sync_grants s JOIN projects p
           ON p.github_repository_id = s.github_repository_id AND p.organization_id = ?
        WHERE s.snapshot_id = ? AND s.authority_pass = 3 AND ${publicationGuard}
       ON CONFLICT(project_id, github_user_id) DO UPDATE SET
         github_login = excluded.github_login, permission = excluded.permission,
         active = 1, synced_at = excluded.synced_at`,
    ).bind(orgId, snapshotId, ...publication),
    env.DB.prepare(
      `INSERT INTO principals (id, organization_id, github_user_id, github_login, github_org_role)
       SELECT 'prn_gh_' || s.github_user_id || '_org_' || ?, ?, s.github_user_id, MAX(s.github_login), 'outside'
         FROM github_sync_grants s WHERE s.snapshot_id = ? AND s.authority_pass = 3 AND ${publicationGuard} GROUP BY s.github_user_id
       ON CONFLICT(organization_id, github_user_id) DO UPDATE SET
         github_login = excluded.github_login,
         github_org_role = CASE
           WHEN principals.github_org_role IN ('owner', 'admin', 'member') OR principals.github_org_role IS NULL
             THEN principals.github_org_role ELSE 'outside' END`,
    ).bind(orgGithubId, orgId, snapshotId, ...publication),
    env.DB.prepare(
      `INSERT INTO principals (id, organization_id, github_user_id, github_login, github_org_role, avatar_url)
       SELECT 'prn_gh_' || github_user_id || '_org_' || ?, ?, github_user_id, github_login, github_org_role, avatar_url
         FROM github_sync_people WHERE snapshot_id = ? AND authority_pass = 3 AND ${publicationGuard}
       ON CONFLICT(organization_id, github_user_id) DO UPDATE SET
         github_login = excluded.github_login, github_org_role = excluded.github_org_role, avatar_url = excluded.avatar_url`,
    ).bind(orgGithubId, orgId, snapshotId, ...publication),
    env.DB.prepare(
      `UPDATE principals SET github_org_role = CASE
         WHEN EXISTS (
           SELECT 1 FROM repository_grants g JOIN projects p ON p.id = g.project_id
            WHERE p.organization_id = principals.organization_id
              AND g.github_user_id = principals.github_user_id AND g.active = 1
         ) THEN 'outside' ELSE 'removed' END
       WHERE organization_id = ?
         AND ${publicationGuard}
         AND NOT EXISTS (
           SELECT 1 FROM github_sync_people s
            WHERE s.snapshot_id = ? AND s.authority_pass = 3 AND s.github_user_id = principals.github_user_id
         )`,
    ).bind(orgId, ...publication, snapshotId),
    env.DB.prepare(`DELETE FROM team_members WHERE organization_id = ? AND ${publicationGuard}`)
      .bind(orgId, ...publication),
    env.DB.prepare(`DELETE FROM team_repos WHERE organization_id = ? AND ${publicationGuard}`)
      .bind(orgId, ...publication),
    env.DB.prepare(`DELETE FROM github_teams WHERE organization_id = ? AND ${publicationGuard}`)
      .bind(orgId, ...publication),
    env.DB.prepare(
      `INSERT INTO github_teams (organization_id, team_id, slug, name, synced_at)
       SELECT ?, team_id, slug, name, strftime('%Y-%m-%dT%H:%M:%fZ','now')
         FROM github_sync_teams WHERE snapshot_id = ? AND authority_pass = 3 AND ${publicationGuard}`,
    ).bind(orgId, snapshotId, ...publication),
    env.DB.prepare(
      `INSERT INTO team_members (organization_id, team_id, github_user_id)
       SELECT ?, team_id, github_user_id FROM github_sync_team_members
        WHERE snapshot_id = ? AND authority_pass = 3 AND ${publicationGuard}`,
    ).bind(orgId, snapshotId, ...publication),
    env.DB.prepare(
      `INSERT INTO team_repos (organization_id, team_id, github_repository_id, permission)
       SELECT ?, s.team_id, s.github_repository_id, s.permission
         FROM github_sync_team_repos s JOIN projects p
           ON p.github_repository_id = s.github_repository_id AND p.organization_id = ?
        WHERE s.snapshot_id = ? AND s.authority_pass = 3 AND ${publicationGuard}`,
    ).bind(orgId, orgId, snapshotId, ...publication),
    env.DB.prepare(`UPDATE organizations SET status = 'active' WHERE id = ? AND ${publicationGuard}`)
      .bind(orgId, ...publication),
  ]);
    const published = await env.DB.prepare(
    `SELECT 1 AS ready
       FROM github_sync_snapshots snapshot
       JOIN organizations organization ON organization.id = snapshot.organization_id
      WHERE snapshot.id = ? AND snapshot.owner_token = ? AND snapshot.publication_ready = 1
        AND organization.id = ? AND organization.status = 'active'`,
  ).bind(snapshotId, leaseOwner, orgId).first<{ ready: number }>();
    if (published === null) throw new Error(`GitHub installation ${installationId} lost snapshot publication ownership`);
    const counts = await env.DB.prepare(
      `SELECT
         (SELECT count(*) FROM github_sync_people WHERE snapshot_id = ? AND authority_pass = 3) AS members,
         (SELECT count(*) FROM github_sync_teams WHERE snapshot_id = ? AND authority_pass = 3) AS teams,
         (SELECT count(*) FROM github_sync_repositories WHERE snapshot_id = ? AND authority_pass = 3) AS repos,
         (SELECT count(*) FROM github_sync_grants WHERE snapshot_id = ? AND authority_pass = 3) AS grants`,
    ).bind(snapshotId, snapshotId, snapshotId, snapshotId).first<Omit<SyncInstallationResult, "continued">>();
    const finalizationNow = dependencies.now?.() ?? new Date();
    const pendingReimport = await env.DB.prepare(
      `SELECT min(quarantine.reimport_not_before) AS notBefore
         FROM project_reimport_quarantines quarantine
         JOIN github_repository_authority authority
           ON authority.github_repository_id = quarantine.github_repository_id
          AND authority.organization_id = ?
          AND authority.installation_id = ?
          AND authority.snapshot_id = ?
          AND authority.selected = 1
        WHERE NOT EXISTS (
          SELECT 1 FROM projects project
           WHERE project.github_repository_id = quarantine.github_repository_id
        )`,
    ).bind(orgId, installationId, snapshotId).first<{ notBefore: string | null }>();
    if (pendingReimport?.notBefore !== null && pendingReimport?.notBefore !== undefined) {
      const delaySeconds = Math.max(
        0,
        Math.ceil((Date.parse(pendingReimport.notBefore) - finalizationNow.getTime()) / 1_000),
      );
      await enqueueSyncContinuation(
        env,
        installationId,
        snapshotId,
        leaseOwner,
        dependencies.enqueueContinuation,
        delaySeconds,
        pendingReimport.notBefore,
      );
      return {
        members: counts?.members ?? 0,
        teams: counts?.teams ?? 0,
        repos: counts?.repos ?? 0,
        grants: counts?.grants ?? 0,
        continued: 1,
      };
    }
    await deleteSnapshot(env, snapshotId);
    return { members: counts?.members ?? 0, teams: counts?.teams ?? 0, repos: counts?.repos ?? 0, grants: counts?.grants ?? 0, continued: 0 };
  } catch (error) {
    if (error instanceof GithubRateLimitError && activeSnapshotId !== null) {
      await env.DB.prepare(
        `UPDATE github_sync_snapshots
            SET continuation_pending = 1, continuation_not_before = ?,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id = ? AND owner_token = ?`,
      ).bind(
        new Date(Date.now() + error.retryAfterSeconds * 1_000).toISOString(),
        activeSnapshotId,
        leaseOwner,
      ).run();
    } else if (activeSnapshotId !== null) {
      // A continuation is durable before Queue.send. If that send fails, keep
      // the exact snapshot and deadline so the retried delivery or the
      // five-minute due-reimport sweep can resume it. Other failed snapshots
      // have no authoritative continuation and are safe to discard.
      await env.DB.prepare(
        `DELETE FROM github_sync_snapshots
          WHERE id = ? AND owner_token = ? AND continuation_pending = 0`,
      ).bind(activeSnapshotId, leaseOwner).run();
    }
    throw error;
  } finally {
    if (publicationLeases.size > 0) {
      const owner = publicationLeases.values().next().value?.owner;
      if (owner !== undefined) {
        await env.DB.prepare(
          `UPDATE github_repository_reconcile_leases
              SET expires_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
            WHERE installation_id = ? AND owner_token = ?`,
        ).bind(installationId, owner).run();
      }
    }
    await releaseSyncLease(env, installationId, leaseOwner);
  }
}

/**
 * Production advances one bounded snapshot step per queue invocation. Unit
 * adapters without a Queue may drive every step inline; each step still
 * releases its installation lease and uses fresh provider budgets.
 */
export async function syncInstallation(
  env: Env,
  installationId: string,
  dependencies: SyncInstallationDependencies = {},
): Promise<SyncInstallationResult> {
  if (dependencies.enqueueContinuation !== undefined || env.SYNC_QUEUE !== undefined) {
    return syncInstallationStep(env, installationId, dependencies);
  }
  let result: SyncInstallationResult;
  do {
    result = await syncInstallationStep(env, installationId, {
      ...dependencies,
      enqueueContinuation: async () => {},
    });
  } while (result.continued === 1);
  return result;
}
