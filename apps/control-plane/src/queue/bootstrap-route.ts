import { installationToken, listInstallations } from "../github-app.js";
import { githubStatusOf } from "../github-error.js";
import {
  bootstrapGitHub,
  bootstrapStatus,
  handleBootstrapRequest,
  readQueueProject,
  type BootstrapGitHub,
  type BootstrapResponse,
} from "./bootstrap.js";
import {
  QUEUE_ACTION_REF,
  SETUP_BRANCH,
  SETUP_PULL_REQUEST_TITLE,
  setupPullRequestBody,
  verifierUpgradePullRequestBody,
} from "./bootstrap-workflows.js";
import { githubHttp } from "./github-port.js";
import type { D1Like } from "./projection.js";
import { isOrgAdmin } from "./repository-access.js";
import type { Env } from "../env.js";
import {
  acquireProjectWriteLease,
  repositoryAllowsExternalWrite,
  type ProjectWriteLease,
} from "../project-lifecycle.js";

/**
 * The HTTP shape of enrolment.
 *
 * This module joins the validated request to the GitHub setup sequence. Keeping
 * that path explicit prevents setup from depending on manual database,
 * workflow, or ruleset changes.
 *
 * The authorization and the port both live here rather than in `index.ts`
 * because they are what a test needs to hold: a fake `BootstrapGitHub` in place
 * of a customer repository, and a viewer the test decides the role of.
 */

/** What the caller may choose. The base ref comes from the repository. */
export interface BootstrapRouteBody {
  readonly includeRepositoryConfig?: boolean;
  readonly chainPublic?: boolean;
  readonly confirmQueueEnforcement?: boolean;
  readonly confirmRulesetBypassActors?: boolean;
}

/** Only the fields the route reads, so a test does not build a whole Worker env. */
export type BootstrapRouteEnv = Pick<
  Env,
  "DB" | "PUBLIC_ORIGIN" | "GITHUB_APP_ID" | "GITHUB_APP_PRIVATE_KEY"
>;

/** The viewer as far as setup cares: which selected organization gave them this role. */
export interface BootstrapViewer {
  readonly organizationId: string | null;
  readonly githubOrgRole: string | null;
}

interface RepositoryRow {
  id: string;
  github_name: string;
  default_branch: string | null;
  installation_id: string | null;
}

const VERIFIER_UPGRADE_BRANCH = "thwip/upgrade-verifier-v3";
const VERIFIER_UPGRADE_PULL_REQUEST_TITLE = "Upgrade Thwip verifier trust protocol";

/** The repository a request names, or nothing to act on. */
async function repositoryFor(
  env: BootstrapRouteEnv,
  repositoryId: string,
  organizationId: string,
): Promise<{ projectId: string; repositoryId: string; owner: string; repo: string; baseRef: string; installationId: string } | null> {
  const row = await env.DB.prepare(
    `SELECT p.id, p.github_name, p.default_branch, o.installation_id
       FROM projects p
       JOIN organizations o ON o.id = p.organization_id
      WHERE p.github_repository_id = ? AND p.organization_id = ?
        AND NOT EXISTS (SELECT 1 FROM project_release_requests r WHERE r.github_repository_id = p.github_repository_id)
        AND NOT EXISTS (
          SELECT 1 FROM project_release_jobs r
           WHERE r.organization_id = p.organization_id
             AND r.github_repository_id = p.github_repository_id
        )`,
  )
    .bind(repositoryId, organizationId)
    .first<RepositoryRow>();
  if (row === null) return null;
  // No installation means no token, so nothing can be written to the repository
  // even though the projection remembers it.
  if (row.installation_id === null) return null;
  const [owner, repo] = row.github_name.split("/");
  if (owner === undefined || repo === undefined) return null;
  return {
    projectId: row.id,
    repositoryId,
    owner,
    repo,
    baseRef: `refs/heads/${row.default_branch ?? "main"}`,
    installationId: row.installation_id,
  };
}

/** How the route reaches a repository. Replaced in tests, never in production. */
export type BootstrapPort = (
  env: BootstrapRouteEnv,
  repo: { projectId: string; repositoryId: string; owner: string; repo: string; baseRef: string; installationId: string },
  setup?: { readonly includeRepositoryConfig?: boolean },
  beforeWrite?: () => Promise<void>,
) => Promise<BootstrapGitHub>;

const githubPort: BootstrapPort = async (env, repo, setup = {}, beforeWrite) => {
  // `installationToken` asks for the whole binding and reads two fields of it,
  // both of which are here.
  const token = await installationToken(env as Env, repo.installationId, undefined, repo.repositoryId);
  const github = bootstrapGitHub(
    githubHttp(token),
    { owner: repo.owner, repo: repo.repo, baseRef: repo.baseRef },
    {
      branch: SETUP_BRANCH,
      title: SETUP_PULL_REQUEST_TITLE,
      body: setupPullRequestBody({
        endpoint: env.PUBLIC_ORIGIN,
        actionRef: QUEUE_ACTION_REF,
        ...(setup.includeRepositoryConfig === true ? { includeRepositoryConfig: true } : {}),
      }),
      verifierUpgrade: {
        branch: VERIFIER_UPGRADE_BRANCH,
        title: VERIFIER_UPGRADE_PULL_REQUEST_TITLE,
        body: verifierUpgradePullRequestBody({
          endpoint: env.PUBLIC_ORIGIN,
          actionRef: QUEUE_ACTION_REF,
        }),
      },
    },
    beforeWrite,
  );
  return {
    ...github,
    async installationPermissions() {
      const installations = await listInstallations(env as Env).catch(() => null);
      if (installations === null) return null;
      return installations.find((installation) => String(installation.id) === repo.installationId)?.permissions ?? null;
    },
  };
};

const UNAUTHORIZED: BootstrapResponse = { status: 401, body: { error: "unauthorized" } };
const FORBIDDEN: BootstrapResponse = { status: 403, body: { error: "repository admin required" } };
const UNKNOWN: BootstrapResponse = { status: 404, body: { error: "unknown repository" } };

class ProjectReleaseDuringSetup extends Error {}

function lifecycleBoundGitHub(
  db: D1Like,
  repositoryId: string,
  lease: ProjectWriteLease,
  github: BootstrapGitHub,
): BootstrapGitHub {
  const beforeWrite = async () => {
    await lease.renew();
    if (!(await repositoryAllowsExternalWrite(db, repositoryId, lease.projectId))) {
      throw new ProjectReleaseDuringSetup("repository access was removed during setup");
    }
  };
  return {
    baseSha: () => github.baseSha(),
    setupPullRequest: () => github.setupPullRequest(),
    verifierUpgradePullRequest: () => github.verifierUpgradePullRequest(),
    ...(github.verifierWorkflowAtBase === undefined
      ? {}
      : { verifierWorkflowAtBase: () => github.verifierWorkflowAtBase!() }),
    ...(github.installationPermissions === undefined
      ? {}
      : { installationPermissions: () => github.installationPermissions!() }),
    rulesetNamed: (name) => github.rulesetNamed(name),
    async openSetupPullRequest(input) {
      await beforeWrite();
      return github.openSetupPullRequest(input);
    },
    async openVerifierUpgradePullRequest(input) {
      await beforeWrite();
      return github.openVerifierUpgradePullRequest(input);
    },
    async publishBootstrapCheck(run) {
      await beforeWrite();
      return github.publishBootstrapCheck(run);
    },
  };
}

function failureDetail(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

/** Turn GitHub's setup refusal into an instruction instead of a bare 500. */
function githubSetupFailure(error: unknown): BootstrapResponse | null {
  if (githubStatusOf(error) !== null) {
    return {
      status: 502,
      body: {
        error: "GitHub refused repository setup",
        code: "GITHUB_SETUP_FAILED",
        detail: failureDetail(error),
      },
    };
  }
  return null;
}

/**
 * Run setup for one repository.
 *
 * The same role the doctor route asks for. This opens the setup pull request,
 * publishes bootstrap checks, and returns ruleset payloads for that repository
 * administrator to apply; the App only reads rulesets back. Everything it does
 * is idempotent, so a caller who retries a 202 gets the same answer rather than
 * a second pull request.
 */
export async function bootstrapRouteResponse(
  env: BootstrapRouteEnv,
  viewer: BootstrapViewer | null,
  repositoryId: string,
  body: BootstrapRouteBody,
  port: BootstrapPort = githubPort,
): Promise<BootstrapResponse> {
  if (viewer === null) return UNAUTHORIZED;
  if (!isOrgAdmin(viewer.githubOrgRole)) return FORBIDDEN;
  if (!/^[0-9]{1,32}$/.test(repositoryId)) {
    return { status: 400, body: { error: "invalid repository id" } };
  }
  if (viewer.organizationId === null) return UNKNOWN;
  const repo = await repositoryFor(env, repositoryId, viewer.organizationId);
  if (repo === null) return UNKNOWN;
  const lease = await acquireProjectWriteLease(
    env.DB as unknown as D1Like,
    repositoryId,
    repo.projectId,
  );
  if (lease === null) {
    return { status: 409, body: { error: "repository access is being removed" } };
  }

  try {
    const beforeWrite = async () => {
      await lease.renew();
      if (!(await repositoryAllowsExternalWrite(env.DB as unknown as D1Like, repositoryId, lease.projectId))) {
        throw new ProjectReleaseDuringSetup("repository access was removed during setup");
      }
    };
    const github = lifecycleBoundGitHub(
      env.DB as unknown as D1Like,
      repositoryId,
      lease,
      await port(env, repo, {
        ...(body.includeRepositoryConfig === true ? { includeRepositoryConfig: true } : {}),
      }, beforeWrite),
    );
    return await handleBootstrapRequest({
      db: env.DB as unknown as D1Like,
      github,
      integrationId: Number(env.GITHUB_APP_ID),
      endpoint: env.PUBLIC_ORIGIN,
      actionRef: QUEUE_ACTION_REF,
      repositoryId,
      baseRef: repo.baseRef,
      expectedProjectId: repo.projectId,
      expectedOrganizationId: viewer.organizationId,
      ...(typeof body.chainPublic === "boolean" ? { chainPublic: body.chainPublic } : {}),
      ...(body.includeRepositoryConfig === true ? { includeRepositoryConfig: true } : {}),
      ...(body.confirmQueueEnforcement === true ? { confirmQueueEnforcement: true } : {}),
      ...(body.confirmRulesetBypassActors === true ? { confirmRulesetBypassActors: true } : {}),
    });
  } catch (error) {
    if (error instanceof ProjectReleaseDuringSetup) {
      return { status: 409, body: { error: error.message } };
    }
    const failure = githubSetupFailure(error);
    if (failure !== null) return failure;
    throw error;
  } finally {
    await lease.release();
  }
}

/**
 * Where setup got to, without doing any of it again.
 *
 * A run that stopped on the setup pull request answers 202 and nothing more
 * happens until a person merges it. Polling this asks GitHub for nothing and
 * opens nothing, so a dashboard can watch for the merge without re-POSTing.
 */
export async function bootstrapStatusResponse(
  env: BootstrapRouteEnv,
  viewer: BootstrapViewer | null,
  repositoryId: string,
): Promise<BootstrapResponse> {
  if (viewer === null) return UNAUTHORIZED;
  if (!isOrgAdmin(viewer.githubOrgRole)) return FORBIDDEN;
  if (!/^[0-9]{1,32}$/.test(repositoryId)) {
    return { status: 400, body: { error: "invalid repository id" } };
  }

  if (viewer.organizationId === null) return UNKNOWN;
  const repo = await repositoryFor(env, repositoryId, viewer.organizationId);
  if (repo === null) return UNKNOWN;

  const project = await readQueueProject(env.DB as unknown as D1Like, repositoryId, repo.baseRef, {
    projectId: repo.projectId,
    organizationId: viewer.organizationId,
  });
  if (project === null) return { status: 404, body: { error: "the repository is not enrolled" } };
  return { status: 200, body: bootstrapStatus(project) };
}
