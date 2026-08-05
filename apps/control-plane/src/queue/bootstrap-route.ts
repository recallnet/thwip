import { installationToken } from "../github-app.js";
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
} from "./bootstrap-workflows.js";
import { githubHttp } from "./github-port.js";
import type { D1Like } from "./projection.js";
import { isOrgAdmin } from "./repository-access.js";
import type { Env } from "../env.js";

/**
 * The HTTP shape of enrolment.
 *
 * `handleBootstrapRequest` and `bootstrapGitHub` were written, tested, and
 * imported by nothing, so bringing a repository into the queue still meant an
 * operator typing a `queue_projects` row into production D1, copying two
 * workflows in by hand, and building a branch ruleset with `gh api` in an order
 * GitHub will only accept one way round. This module is what a request has to
 * go through to reach them.
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

/** The viewer as far as setup cares: which role the selected organization gave them. */
export interface BootstrapViewer {
  readonly githubOrgRole: string | null;
}

interface RepositoryRow {
  github_name: string;
  default_branch: string | null;
  installation_id: string | null;
}

/** The repository a request names, or nothing to act on. */
async function repositoryFor(
  env: BootstrapRouteEnv,
  repositoryId: string,
): Promise<{ owner: string; repo: string; baseRef: string; installationId: string } | null> {
  const row = await env.DB.prepare(
    `SELECT p.github_name, p.default_branch, o.installation_id
       FROM projects p
       JOIN organizations o ON o.id = p.organization_id
      WHERE p.github_repository_id = ?`,
  )
    .bind(repositoryId)
    .first<RepositoryRow>();
  if (row === null) return null;
  // No installation means no token, so nothing can be written to the repository
  // even though the projection remembers it.
  if (row.installation_id === null) return null;
  const [owner, repo] = row.github_name.split("/");
  if (owner === undefined || repo === undefined) return null;
  return {
    owner,
    repo,
    baseRef: `refs/heads/${row.default_branch ?? "main"}`,
    installationId: row.installation_id,
  };
}

/** How the route reaches a repository. Replaced in tests, never in production. */
export type BootstrapPort = (
  env: BootstrapRouteEnv,
  repo: { owner: string; repo: string; baseRef: string; installationId: string },
  setup?: { readonly includeRepositoryConfig?: boolean },
) => Promise<BootstrapGitHub>;

const githubPort: BootstrapPort = async (env, repo, setup = {}) => {
  // `installationToken` asks for the whole binding and reads two fields of it,
  // both of which are here.
  const token = await installationToken(env as Env, repo.installationId);
  return bootstrapGitHub(
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
    },
  );
};

const UNAUTHORIZED: BootstrapResponse = { status: 401, body: { error: "unauthorized" } };
const FORBIDDEN: BootstrapResponse = { status: 403, body: { error: "repository admin required" } };
const UNKNOWN: BootstrapResponse = { status: 404, body: { error: "unknown repository" } };

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
  const repo = await repositoryFor(env, repositoryId);
  if (repo === null) return UNKNOWN;

  try {
    return await handleBootstrapRequest({
      db: env.DB as unknown as D1Like,
      github: await port(env, repo, {
        ...(body.includeRepositoryConfig === true ? { includeRepositoryConfig: true } : {}),
      }),
      integrationId: Number(env.GITHUB_APP_ID),
      endpoint: env.PUBLIC_ORIGIN,
      actionRef: QUEUE_ACTION_REF,
      repositoryId,
      baseRef: repo.baseRef,
      ...(typeof body.chainPublic === "boolean" ? { chainPublic: body.chainPublic } : {}),
      ...(body.includeRepositoryConfig === true ? { includeRepositoryConfig: true } : {}),
      ...(body.confirmQueueEnforcement === true ? { confirmQueueEnforcement: true } : {}),
      ...(body.confirmRulesetBypassActors === true ? { confirmRulesetBypassActors: true } : {}),
    });
  } catch (error) {
    const failure = githubSetupFailure(error);
    if (failure !== null) return failure;
    throw error;
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

  const repo = await repositoryFor(env, repositoryId);
  if (repo === null) return UNKNOWN;

  const project = await readQueueProject(env.DB as unknown as D1Like, repositoryId, repo.baseRef);
  if (project === null) return { status: 404, body: { error: "the repository is not enrolled" } };
  return { status: 200, body: bootstrapStatus(project) };
}
