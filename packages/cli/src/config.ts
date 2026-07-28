import { parse as parseYaml } from "yaml";
import { canonicalDigest, type PolicyBundleV1, type Sha256 } from "@thwip/protocol";
import type { PipelineDefinition } from "./pipeline.js";
import { showFileAtHead } from "./git.js";

/**
 * thwip.yaml is the committed source of project configuration. The CLI
 * derives the pipeline definition and the immutable policy bundle from it
 * deterministically, so the digest of a configuration is reproducible from
 * the file alone.
 *
 * version: 3
 * profile: fast | fresh | audited | remote
 * repository:
 *   owner_id: "162603603"
 *   repository_id: "1315419165"
 * suites:
 *   lint: pnpm lint
 *   typecheck: pnpm typecheck
 *   test: pnpm test
 * policy:
 *   minimum_permission: write
 *   allow_author_as_signer: true
 *   allowed_key_algorithms: [ssh-ed25519]
 *   proof_max_age_seconds: 86400
 */
export interface ThwipYaml {
  version: number;
  profile: "fast" | "fresh" | "audited" | "remote";
  repository: { owner_id: string; repository_id: string };
  suites: Record<string, string>;
  policy?: {
    minimum_permission?: "triage" | "write" | "maintain" | "admin";
    allow_author_as_signer?: boolean;
    allowed_key_algorithms?: string[];
    proof_max_age_seconds?: number;
    required?: string[];
  };
}

export interface ProjectConfig {
  policy: PolicyBundleV1;
  policyDigest: Sha256;
  pipeline: PipelineDefinition;
  pipelineDigest: Sha256;
}

export function parseThwipYaml(text: string): ThwipYaml {
  const y = parseYaml(text) as ThwipYaml;
  if (typeof y !== "object" || y === null) throw new Error("thwip.yaml is not a mapping");
  if (!Number.isInteger(y.version) || y.version < 1) throw new Error("thwip.yaml: version must be a positive integer");
  if (!["fast", "fresh", "audited", "remote"].includes(y.profile)) {
    throw new Error("thwip.yaml: profile must be fast | fresh | audited | remote");
  }
  if (!y.repository?.owner_id || !y.repository?.repository_id) {
    throw new Error("thwip.yaml: repository.owner_id and repository.repository_id are required");
  }
  if (!/^[0-9]+$/.test(y.repository.owner_id) || !/^[0-9]+$/.test(y.repository.repository_id)) {
    throw new Error("thwip.yaml: repository ids are GitHub's numeric ids, quoted as strings");
  }
  const suiteIds = Object.keys(y.suites ?? {});
  if (suiteIds.length === 0) throw new Error("thwip.yaml: declare at least one suite");
  for (const id of suiteIds) {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) throw new Error(`thwip.yaml: invalid suite id '${id}'`);
    if (typeof y.suites[id] !== "string" || y.suites[id]!.length === 0) {
      throw new Error(`thwip.yaml: suite '${id}' must map to a shell command`);
    }
  }
  return y;
}

export async function deriveConfig(y: ThwipYaml): Promise<ProjectConfig> {
  const suiteIds = Object.keys(y.suites);
  const pipeline: PipelineDefinition = {
    schemaVersion: "1",
    runner: "command",
    suites: suiteIds.map((id) => ({ id, command: ["sh", "-c", y.suites[id]!] })),
  };
  const pipelineDigest = await canonicalDigest(pipeline);
  const policy: PolicyBundleV1 = {
    schemaVersion: "1",
    projectId: `gh:${y.repository.repository_id}`,
    repositoryId: y.repository.repository_id,
    ownerId: y.repository.owner_id,
    version: y.version,
    securityProfile: y.profile,
    minimumPermission: y.policy?.minimum_permission ?? "write",
    allowAuthorAsSigner: y.policy?.allow_author_as_signer ?? true,
    evaluationMode: "head-tree",
    allowedKeyAlgorithms: y.policy?.allowed_key_algorithms ?? ["ssh-ed25519"],
    requireGithubKeyPresence: false,
    lease: { required: y.profile !== "fast", maxAgeSeconds: 1800 },
    pipeline: {
      digest: pipelineDigest,
      runner: "command",
      requiredSuites: y.policy?.required ?? suiteIds,
    },
    proofMaxAgeSeconds: y.policy?.proof_max_age_seconds ?? 86400,
    audit: { basisPoints: 0, mandatoryPaths: [] },
  };
  const policyDigest = await canonicalDigest(policy);
  return { policy, policyDigest, pipeline, pipelineDigest };
}

/** Load configuration from the committed tree (HEAD), never the worktree. */
export async function loadProjectConfigAtHead(cwd: string): Promise<ProjectConfig> {
  let text: string | null = null;
  try {
    text = await showFileAtHead(cwd, "thwip.yaml");
  } catch {
    text = null;
  }
  if (text !== null) return deriveConfig(parseThwipYaml(text));
  // Legacy pair of JSON files.
  const policyText = await showFileAtHead(cwd, "thwip.policy.json");
  const pipelineText = await showFileAtHead(cwd, "thwip.pipeline.json");
  const policy = JSON.parse(policyText) as PolicyBundleV1;
  const pipeline = JSON.parse(pipelineText) as PipelineDefinition;
  return {
    policy,
    policyDigest: await canonicalDigest(policy),
    pipeline,
    pipelineDigest: await canonicalDigest(pipeline),
  };
}
