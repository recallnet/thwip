import {
  deriveProjectConfig,
  parseThwipYaml,
  type ProjectConfig,
  type RepositorySnapshot,
  type ThwipYaml,
} from "@thwip/policy";
import { git, gitBytes, showFileAtHead } from "./git.js";

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
class GitHeadSnapshot implements RepositorySnapshot {
  constructor(private readonly cwd: string) {}

  async hasFile(path: string): Promise<boolean> {
    try {
      await git(["cat-file", "-e", `HEAD:${path}`], this.cwd);
      return true;
    } catch {
      return false;
    }
  }

  async listFiles(path: string): Promise<string[]> {
    const listed = await git(["ls-tree", "-r", "--name-only", "HEAD", "--", path], this.cwd);
    return listed.length === 0 ? [] : listed.split("\n");
  }

  readFile(path: string): Promise<Uint8Array> {
    return gitBytes(["show", `HEAD:${path}`], this.cwd);
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

export async function deriveConfig(
  y: ThwipYaml,
  cwd: string,
  ids: { ownerId: string; repositoryId: string },
): Promise<ProjectConfig> {
  return deriveProjectConfig(y, ids, new GitHeadSnapshot(cwd));
}

/** Load configuration from the committed tree (HEAD), never the worktree. */
export async function loadProjectConfigAtHead(
  cwd: string,
  endpoint: string,
  authHeader: string | null,
): Promise<ProjectConfig> {
  const text = await showFileAtHead(cwd, "thwip.yaml");
  const y = parseThwipYaml(text);
  const ids = await resolveRepositoryIds(cwd, endpoint, authHeader);
  return deriveConfig(y, cwd, ids);
}
