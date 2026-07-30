import { parse as parseYaml } from "yaml";
import { bytesDigest, canonicalDigest, type PolicyBundleV1, type Sha256 } from "@thwip/protocol";

/**
 * The repository-owned policy input. Execution details stay in a Dagger module
 * or in package scripts; this document only names what policy requires.
 */
export interface ThwipYaml {
  version: number;
  profile: "fast" | "fresh" | "audited" | "remote";
  required: string[];
  remote?: string[];
  pipeline?: { module: string; daggerVersion?: string };
  suites?: Record<string, string>;
  policy?: {
    minimum_permission?: "triage" | "write" | "maintain" | "admin";
    allow_author_as_signer?: boolean;
    allowed_key_algorithms?: string[];
    proof_max_age_seconds?: number;
  };
}

export interface PipelineDefinition {
  schemaVersion: "1";
  runner: "command" | "dagger";
  suites: Array<{ id: string; command: string[] }>;
  module?: string;
  daggerVersion?: string;
  moduleDigest?: string;
}

export interface ProjectConfig {
  policy: PolicyBundleV1;
  policyDigest: Sha256;
  pipeline: PipelineDefinition;
  pipelineDigest: Sha256;
}

/**
 * A frozen repository tree. Both the CLI's HEAD and GitHub's push commit
 * implement this interface, which keeps policy derivation byte-for-byte equal
 * on the developer machine and in the control plane.
 */
export interface RepositorySnapshot {
  hasFile(path: string): Promise<boolean>;
  listFiles(path: string): Promise<string[]>;
  readFile(path: string): Promise<Uint8Array>;
}

const SUITE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const te = new TextEncoder();

/** Pinned unless a project names its own. */
export const DEFAULT_DAGGER_VERSION = "0.21.8";

export function parseThwipYaml(text: string): ThwipYaml {
  const y = parseYaml(text) as ThwipYaml;
  if (typeof y !== "object" || y === null) throw new Error("thwip.yaml is not a mapping");
  if (!Number.isInteger(y.version) || y.version < 1) {
    throw new Error("thwip.yaml: version must be a positive integer");
  }
  if (!["fast", "fresh", "audited", "remote"].includes(y.profile)) {
    throw new Error("thwip.yaml: profile must be fast | fresh | audited | remote");
  }
  if (!Array.isArray(y.required) || y.required.length === 0) {
    throw new Error("thwip.yaml: 'required' must list at least one suite id");
  }
  for (const id of y.required) {
    if (typeof id !== "string" || !SUITE_ID.test(id)) {
      throw new Error(`thwip.yaml: invalid suite id '${id}'`);
    }
  }
  if (y.remote !== undefined) {
    if (!Array.isArray(y.remote)) throw new Error("thwip.yaml: 'remote' must be a list of suite ids");
    for (const id of y.remote) {
      if (typeof id !== "string" || !SUITE_ID.test(id)) {
        throw new Error(`thwip.yaml: invalid remote suite id '${id}'`);
      }
      if (y.required.includes(id)) {
        throw new Error(`thwip.yaml: '${id}' cannot be both required (local) and remote`);
      }
    }
  }
  if (y.pipeline !== undefined) {
    if (typeof y.pipeline.module !== "string" || y.pipeline.module.length === 0) {
      throw new Error("thwip.yaml: pipeline.module must be a path to a Dagger module");
    }
    normalizeRepositoryPath(y.pipeline.module);
    if (
      y.pipeline.daggerVersion !== undefined &&
      !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(y.pipeline.daggerVersion)
    ) {
      throw new Error("thwip.yaml: pipeline.daggerVersion must be an exact version");
    }
  }
  if (y.suites !== undefined) {
    if (typeof y.suites !== "object" || y.suites === null || Array.isArray(y.suites)) {
      throw new Error("thwip.yaml: 'suites' must be a mapping");
    }
    for (const [id, command] of Object.entries(y.suites)) {
      if (!SUITE_ID.test(id)) throw new Error(`thwip.yaml: invalid suite id '${id}'`);
      if (typeof command !== "string" || command.length === 0) {
        throw new Error(`thwip.yaml: suite '${id}' must map to a shell command`);
      }
    }
  }
  return y;
}

function normalizeRepositoryPath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    normalized.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`thwip.yaml: pipeline.module must stay inside the repository ('${path}')`);
  }
  return normalized;
}

interface DirectoryNode {
  directories: Map<string, DirectoryNode>;
  files: Map<string, string>;
}

function directoryNode(): DirectoryNode {
  return { directories: new Map(), files: new Map() };
}

/**
 * Preserve the original CLI's Dagger module digest: depth-first directory
 * order, hashing each file's basename followed by its exact bytes.
 */
async function moduleDigest(snapshot: RepositorySnapshot, modulePath: string): Promise<Sha256> {
  const rootPath = normalizeRepositoryPath(modulePath);
  const paths = await snapshot.listFiles(rootPath);
  const root = directoryNode();
  for (const path of paths) {
    const normalized = path.replace(/\\/g, "/").replace(/^\.\/+/, "");
    const prefix = `${rootPath}/`;
    if (!normalized.startsWith(prefix)) continue;
    const parts = normalized.slice(prefix.length).split("/");
    if (parts.length === 0 || parts.some((part) => part === "node_modules" || part === ".git" || part === "sdk")) {
      continue;
    }
    const fileName = parts.pop()!;
    let node = root;
    for (const part of parts) {
      let child = node.directories.get(part);
      if (child === undefined) {
        child = directoryNode();
        node.directories.set(part, child);
      }
      node = child;
    }
    node.files.set(fileName, normalized);
  }
  if (root.directories.size === 0 && root.files.size === 0) {
    throw new Error(`thwip.yaml: pipeline module '${modulePath}' has no committed files`);
  }

  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  const append = (bytes: Uint8Array): void => {
    chunks.push(bytes);
    byteLength += bytes.byteLength;
  };
  const walk = async (node: DirectoryNode): Promise<void> => {
    const names = [...node.directories.keys(), ...node.files.keys()].sort();
    for (const name of names) {
      const child = node.directories.get(name);
      if (child !== undefined) {
        await walk(child);
        continue;
      }
      append(te.encode(name));
      append(await snapshot.readFile(node.files.get(name)!));
    }
  };
  await walk(root);
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytesDigest(bytes);
}

export async function deriveProjectConfig(
  y: ThwipYaml,
  ids: { ownerId: string; repositoryId: string },
  snapshot: RepositorySnapshot,
): Promise<ProjectConfig> {
  let pipeline: PipelineDefinition;
  if (y.pipeline !== undefined) {
    pipeline = {
      schemaVersion: "1",
      runner: "dagger",
      module: y.pipeline.module,
      daggerVersion: y.pipeline.daggerVersion ?? DEFAULT_DAGGER_VERSION,
      moduleDigest: await moduleDigest(snapshot, y.pipeline.module),
      suites: y.required.map((id) => ({ id, command: ["dagger", "call", id] })),
    };
  } else {
    const runner = (await snapshot.hasFile("pnpm-lock.yaml"))
      ? "pnpm run"
      : (await snapshot.hasFile("yarn.lock"))
        ? "yarn run"
        : "npm run";
    pipeline = {
      schemaVersion: "1",
      runner: "command",
      suites: y.required.map((id) => ({
        id,
        command: ["sh", "-c", y.suites?.[id] ?? `${runner} ${id}`],
      })),
    };
  }

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
    pipeline: {
      digest: pipelineDigest,
      runner: y.pipeline === undefined ? "command" : "dagger",
      requiredSuites: y.required,
      ...(y.remote !== undefined && y.remote.length > 0 ? { remoteSuites: y.remote } : {}),
    },
    proofMaxAgeSeconds: y.policy?.proof_max_age_seconds ?? 86400,
    audit: { basisPoints: 0, mandatoryPaths: [] },
  };
  const policyDigest = await canonicalDigest(policy);
  return { policy, policyDigest, pipeline, pipelineDigest };
}

export async function deriveProjectConfigFromText(
  yamlText: string,
  ids: { ownerId: string; repositoryId: string },
  snapshot: RepositorySnapshot,
): Promise<ProjectConfig> {
  return deriveProjectConfig(parseThwipYaml(yamlText), ids, snapshot);
}
