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

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} is not a mapping`);
  }
  return value as Record<string, unknown>;
}

function validatedThwipYaml(value: unknown): ThwipYaml {
  const y = record(value, "thwip.yaml") as unknown as ThwipYaml;
  if (typeof y !== "object" || y === null) throw new Error("thwip.yaml is not a mapping");
  if (!Number.isInteger(y.version) || y.version < 1) {
    throw new Error("thwip.yaml: version must be a positive integer");
  }
  if (!["fast", "fresh", "audited", "remote"].includes(y.profile)) {
    throw new Error("thwip.yaml: profile must be fast | fresh | audited | remote");
  }
  // Fresh and Audited are defined as issuing an assignment and requiring an
  // integration receipt signed where the suites ran. Nothing issues one and
  // nothing signs one, so selecting either used to deliver what Remote delivers
  // under a name that claims more than happened. Refuse, and say what to pick.
  if (y.profile === "fresh" || y.profile === "audited") {
    throw new Error(
      `thwip.yaml: profile ${y.profile} requires an integration receipt signed where the suites ran, ` +
        "and nothing issues one yet. Use remote to run the required suites in GitHub Actions against the " +
        "merge candidate, or fast to reuse the proof already on the head.",
    );
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
  if (y.policy !== undefined) {
    const policy = record(y.policy, "thwip.yaml: 'policy'");
    const minimumPermission = policy["minimum_permission"];
    if (
      minimumPermission !== undefined &&
      !["triage", "write", "maintain", "admin"].includes(String(minimumPermission))
    ) {
      throw new Error("thwip.yaml: policy.minimum_permission must be triage | write | maintain | admin");
    }
    const allowAuthor = policy["allow_author_as_signer"];
    if (allowAuthor !== undefined && typeof allowAuthor !== "boolean") {
      throw new Error("thwip.yaml: policy.allow_author_as_signer must be boolean");
    }
    const algorithms = policy["allowed_key_algorithms"];
    if (
      algorithms !== undefined &&
      (!Array.isArray(algorithms) ||
        algorithms.length === 0 ||
        algorithms.some((algorithm) => typeof algorithm !== "string" || algorithm.length === 0))
    ) {
      throw new Error("thwip.yaml: policy.allowed_key_algorithms must be a non-empty list of strings");
    }
    const maxAge = policy["proof_max_age_seconds"];
    if (maxAge !== undefined && (!Number.isInteger(maxAge) || (maxAge as number) <= 0)) {
      throw new Error("thwip.yaml: policy.proof_max_age_seconds must be a positive integer");
    }
  }
  return y;
}

export function parseThwipYaml(text: string): ThwipYaml {
  return validatedThwipYaml(parseYaml(text));
}

function optionalSection(
  defaults: unknown,
  overrideDocument: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  if (!(key in overrideDocument)) {
    return defaults === undefined ? undefined : record(defaults, `global defaults: '${key}'`);
  }
  const override = overrideDocument[key];
  if (override === null) return undefined;
  return {
    ...(defaults === undefined ? {} : record(defaults, `global defaults: '${key}'`)),
    ...record(override, `thwip.yaml: '${key}'`),
  };
}

/**
 * Resolve remotely managed organization defaults with an optional repository
 * override. Arrays replace arrays; mapping sections merge by field; an
 * explicit null clears an optional mapping. The fully resolved document is
 * validated by the same parser as a repository-owned configuration.
 */
export function resolveThwipYaml(
  globalDefaults: ThwipYaml | null,
  repositoryYamlText: string | null,
): { config: ThwipYaml; source: "global" | "repository-override" } {
  if (repositoryYamlText === null) {
    if (globalDefaults === null) throw new Error("no thwip.yaml or organization defaults are configured");
    return { config: validatedThwipYaml(globalDefaults), source: "global" };
  }

  const override = record(parseYaml(repositoryYamlText), "thwip.yaml");
  const defaults = globalDefaults === null ? {} : (globalDefaults as unknown as Record<string, unknown>);
  const merged: Record<string, unknown> = { ...defaults, ...override };
  for (const key of ["pipeline", "suites", "policy"] as const) {
    const section = optionalSection(defaults[key], override, key);
    if (section === undefined) delete merged[key];
    else merged[key] = section;
  }
  return {
    config: validatedThwipYaml(merged),
    source: "repository-override",
  };
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
  // Audited is "fresh local receipt plus a full Dagger rerun in GitHub Actions
  // before merge" (plan.md §19.3). Full, not sampled: every required suite has
  // to be proven a second time by GitHub's own checks, on top of the signer's
  // account of running it locally. Suites a project already names remote stay
  // remote, so choosing Audited never subtracts a requirement.
  const remoteSuites =
    y.profile === "audited"
      ? [...y.required, ...(y.remote ?? [])]
      : (y.remote ?? []);
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
      ...(remoteSuites.length > 0 ? { remoteSuites } : {}),
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

export async function deriveEffectiveProjectConfig(
  globalDefaults: ThwipYaml | null,
  repositoryYamlText: string | null,
  ids: { ownerId: string; repositoryId: string },
  snapshot: RepositorySnapshot,
): Promise<ProjectConfig & { configSource: "global" | "repository-override" }> {
  const resolved = resolveThwipYaml(globalDefaults, repositoryYamlText);
  return {
    ...(await deriveProjectConfig(resolved.config, ids, snapshot)),
    configSource: resolved.source,
  };
}
