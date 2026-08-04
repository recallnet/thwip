import {
  deriveEffectiveProjectConfig,
  parseThwipYaml,
  type ProjectConfig,
  type RepositorySnapshot,
  type ThwipYaml,
} from "@thwip/policy";
import { git, gitBytes } from "./git.js";

export {
  DEFAULT_DAGGER_VERSION,
  parseThwipYaml,
  type ProjectConfig,
  type ThwipYaml,
} from "@thwip/policy";

/**
 * thwip.yaml names which checks are required and where each may run. It does
 * not describe how a check executes — matrices, services, platforms, and
 * caching live in the project's Dagger module, in a real language. thwip
 * deliberately owns no pipeline dialect.
 *
 * version: 5
 * profile: fast | fresh | audited | remote
 * pipeline:
 *   module: ./dagger        # Dagger module; its digest is part of the policy
 *   daggerVersion: 0.21.8   # pinned toolchain, provisioned by the CLI
 * required: [lint, test, build]           # module functions proven locally
 * remote:   [build-darwin, build-windows] # must run in GitHub and pass there
 *
 * Repositories that have not adopted Dagger may instead declare `suites:` as
 * a map of id to shell command. That fallback cannot produce an action graph,
 * so it is the weaker tier and is labelled as such.
 */
class GitRefSnapshot implements RepositorySnapshot {
  constructor(
    private readonly cwd: string,
    private readonly ref: string,
  ) {}

  async hasFile(path: string): Promise<boolean> {
    try {
      await git(["cat-file", "-e", `${this.ref}:${path}`], this.cwd);
      return true;
    } catch {
      return false;
    }
  }

  async listFiles(path: string): Promise<string[]> {
    const listed = await git(["ls-tree", "-r", "--name-only", this.ref, "--", path], this.cwd);
    return listed.length === 0 ? [] : listed.split("\n");
  }

  readFile(path: string): Promise<Uint8Array> {
    return gitBytes(["show", `${this.ref}:${path}`], this.cwd);
  }
}

/** Resolve the GitHub numeric ids for origin, caching in local git config. */
export async function resolveRepositoryIds(
  cwd: string,
  endpoint: string,
  authHeader: string | null,
): Promise<{ ownerId: string; repositoryId: string }> {
  try {
    const ownerId = await git(["config", "--get", "thwip.owner-id"], cwd);
    const repositoryId = await git(["config", "--get", "thwip.repository-id"], cwd);
    if (ownerId && repositoryId) return { ownerId, repositoryId };
  } catch {
    /* not cached yet */
  }
  const url = await git(["config", "--get", "remote.origin.url"], cwd);
  const m = /github\.com[:/]([^/]+\/[^/.]+)/.exec(url);
  if (!m) throw new Error("origin is not a GitHub remote");
  const name = m[1]!;
  // The control plane knows every installed repository's numeric ids.
  const res = await fetch(`${endpoint}/v1/resolve-repo?name=${encodeURIComponent(name)}`, {
    headers: authHeader ? { authorization: authHeader } : {},
  });
  if (!res.ok) {
    throw new Error(
      `cannot resolve numeric ids for ${name} (${res.status}); sign in with 'thwip login' and make sure the thwip GitHub App is installed on the repository`,
    );
  }
  const ids = (await res.json()) as { ownerId: string; repositoryId: string };
  await git(["config", "thwip.owner-id", ids.ownerId], cwd);
  await git(["config", "thwip.repository-id", ids.repositoryId], cwd);
  return ids;
}

interface ProjectConfigState {
  readonly defaults: ThwipYaml | null;
  /** Null means bootstrap; undefined means the server predates source reporting. */
  readonly activePolicySourceSha: string | null | undefined;
}

async function projectConfigState(
  endpoint: string,
  authHeader: string | null,
  repositoryId: string,
): Promise<ProjectConfigState> {
  if (authHeader === null) return { defaults: null, activePolicySourceSha: undefined };
  const response = await fetch(
    `${endpoint}/v1/project-config/defaults?repositoryId=${encodeURIComponent(repositoryId)}`,
    { headers: { authorization: authHeader } },
  );
  // A newly upgraded CLI can still run against a control plane that has not
  // deployed organization defaults yet. A complete thwip.yaml remains enough
  // to derive the same effective policy during that rolling upgrade.
  if (response.status === 404) return { defaults: null, activePolicySourceSha: undefined };
  if (!response.ok) {
    throw new Error(`cannot resolve organization defaults (${response.status}): ${await response.text()}`);
  }
  if (!(response.headers.get("content-type") ?? "").includes("application/json")) {
    return { defaults: null, activePolicySourceSha: undefined };
  }
  const body = (await response.json()) as { defaults?: unknown; activePolicySourceSha?: unknown };
  const defaults =
    body.defaults === null || body.defaults === undefined
      ? null
      : parseThwipYaml(JSON.stringify(body.defaults));
  const activePolicySourceSha =
    body.activePolicySourceSha === null || typeof body.activePolicySourceSha === "string"
      ? body.activePolicySourceSha
      : undefined;
  return { defaults, activePolicySourceSha };
}

async function loadProjectConfigAtRef(
  cwd: string,
  ref: string,
  ids: { ownerId: string; repositoryId: string },
  defaults: ThwipYaml | null,
): Promise<ProjectConfig & { configSource: "global" | "repository-override" }> {
  const snapshot = new GitRefSnapshot(cwd, ref);
  const repositoryYaml = (await snapshot.hasFile("thwip.yaml"))
    ? new TextDecoder().decode(await snapshot.readFile("thwip.yaml"))
    : null;
  return deriveEffectiveProjectConfig(defaults, repositoryYaml, ids, snapshot);
}

/**
 * Load effective configuration from the committed tree (HEAD), never the
 * worktree. Organization defaults supply YAML-free repositories; when
 * thwip.yaml exists its fields override those defaults.
 */
export async function loadProjectConfigAtHead(
  cwd: string,
  endpoint: string,
  authHeader: string | null,
): Promise<ProjectConfig & { configSource: "global" | "repository-override" }> {
  const ids = await resolveRepositoryIds(cwd, endpoint, authHeader);
  const state = await projectConfigState(endpoint, authHeader, ids.repositoryId);
  return loadProjectConfigAtRef(cwd, "HEAD", ids, state.defaults);
}

/**
 * Load the configuration a proof must satisfy.
 *
 * Once a project has an active policy, a pull request is judged by that policy,
 * not by an edited thwip.yaml in the candidate tree. The control plane names
 * the exact default-branch commit that produced the active policy. Before the
 * first policy exists, HEAD remains the bootstrap candidate; an older server
 * also keeps the prior HEAD behavior during a rolling deployment.
 */
export async function loadProjectConfigForRun(
  cwd: string,
  endpoint: string,
  authHeader: string | null,
): Promise<ProjectConfig & { configSource: "global" | "repository-override" }> {
  const ids = await resolveRepositoryIds(cwd, endpoint, authHeader);
  const state = await projectConfigState(endpoint, authHeader, ids.repositoryId);
  const ref = state.activePolicySourceSha ?? "HEAD";
  return loadProjectConfigAtRef(cwd, ref, ids, state.defaults);
}
