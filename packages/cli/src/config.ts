import { parse as parseYaml } from "yaml";
import { canonicalDigest, type PolicyBundleV1, type Sha256 } from "@thwip/protocol";
import type { PipelineDefinition } from "./pipeline.js";
import { git, showFileAtHead } from "./git.js";

/**
 * thwip.yaml holds only what thwip is authoritative for: the security
 * profile, which suites are required, and policy knobs. Repository identity
 * comes from the git remote; suite commands come from the repository's own
 * pipeline definition (package.json scripts today, a Dagger module when the
 * pipeline runner is dagger).
 *
 * version: 3
 * profile: fast | fresh | audited | remote
 * required: [lint, typecheck, test]
 * suites:            # optional override for repos without package.json
 *   lint: pnpm lint
 * policy:
 *   minimum_permission: write
 *   allow_author_as_signer: true
 *   allowed_key_algorithms: [ssh-ed25519]
 *   proof_max_age_seconds: 86400
 */
export interface ThwipYaml {
  version: number;
  profile: "fast" | "fresh" | "audited" | "remote";
  required: string[];
  suites?: Record<string, string>;
  policy?: {
    minimum_permission?: "triage" | "write" | "maintain" | "admin";
    allow_author_as_signer?: boolean;
    allowed_key_algorithms?: string[];
    proof_max_age_seconds?: number;
  };
}

export interface ProjectConfig {
  policy: PolicyBundleV1;
  policyDigest: Sha256;
  pipeline: PipelineDefinition;
  pipelineDigest: Sha256;
}

const SUITE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function parseThwipYaml(text: string): ThwipYaml {
  const y = parseYaml(text) as ThwipYaml;
  if (typeof y !== "object" || y === null) throw new Error("thwip.yaml is not a mapping");
  if (!Number.isInteger(y.version) || y.version < 1) throw new Error("thwip.yaml: version must be a positive integer");
  if (!["fast", "fresh", "audited", "remote"].includes(y.profile)) {
    throw new Error("thwip.yaml: profile must be fast | fresh | audited | remote");
  }
  if (!Array.isArray(y.required) || y.required.length === 0) {
    throw new Error("thwip.yaml: 'required' must list at least one suite id");
  }
  for (const id of y.required) {
    if (typeof id !== "string" || !SUITE_ID.test(id)) throw new Error(`thwip.yaml: invalid suite id '${id}'`);
  }
  if (y.suites) {
    for (const [id, cmd] of Object.entries(y.suites)) {
      if (!SUITE_ID.test(id)) throw new Error(`thwip.yaml: invalid suite id '${id}'`);
      if (typeof cmd !== "string" || cmd.length === 0) {
        throw new Error(`thwip.yaml: suite '${id}' must map to a shell command`);
      }
    }
  }
  return y;
}

/**
 * Resolve suite id -> command. Explicit `suites:` wins; otherwise the suite
 * id names a package.json script and runs through the repository's package
 * manager (detected from the committed lockfile).
 */
async function suiteCommand(cwd: string, y: ThwipYaml, id: string): Promise<string> {
  if (y.suites?.[id]) return y.suites[id];
  const runner = await (async () => {
    const tracked = await git(["ls-files", "pnpm-lock.yaml", "yarn.lock", "package-lock.json"], cwd);
    if (tracked.includes("pnpm-lock.yaml")) return "pnpm run";
    if (tracked.includes("yarn.lock")) return "yarn run";
    return "npm run";
  })();
  return `${runner} ${id}`;
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
  const suites: Array<{ id: string; command: string[] }> = [];
  for (const id of y.required) {
    suites.push({ id, command: ["sh", "-c", await suiteCommand(cwd, y, id)] });
  }
  const pipeline: PipelineDefinition = { schemaVersion: "1", runner: "command", suites };
  const pipelineDigest = await canonicalDigest(pipeline);
  const policy: PolicyBundleV1 = {
    schemaVersion: "1",
    projectId: `gh:${ids.repositoryId}`,
    repositoryId: ids.repositoryId,
    ownerId: ids.ownerId,
    version: y.version,
    securityProfile: y.profile,
    minimumPermission: y.policy?.minimum_permission ?? "write",
    allowAuthorAsSigner: y.policy?.allow_author_as_signer ?? true,
    evaluationMode: "head-tree",
    allowedKeyAlgorithms: y.policy?.allowed_key_algorithms ?? ["ssh-ed25519"],
    requireGithubKeyPresence: false,
    lease: { required: y.profile !== "fast", maxAgeSeconds: 1800 },
    pipeline: { digest: pipelineDigest, runner: "command", requiredSuites: y.required },
    proofMaxAgeSeconds: y.policy?.proof_max_age_seconds ?? 86400,
    audit: { basisPoints: 0, mandatoryPaths: [] },
  };
  const policyDigest = await canonicalDigest(policy);
  return { policy, policyDigest, pipeline, pipelineDigest };
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
