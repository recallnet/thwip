import {
  b64stdDecode,
  extractCarrier,
  parseStatement,
  utf8Decode,
  type ProofVerificationAuditV1,
  type VerificationBundleV1,
} from "@thwip/protocol";
import { verifyProof, type GithubFacts, type VerifyResult } from "@thwip/verifier";
import { installationToken } from "./github-app.js";
import { signPayload } from "./service-signing.js";
import { verifySshSigEd25519 } from "./sshsig-verify.js";
import {
  resolveVerificationBundle,
  VerificationBundleError,
  type VerificationBundleInput,
  type VerificationBundleResolution,
} from "./verification-bundle.js";
import type { Env } from "./env.js";

const API = "https://api.github.com";
export const APP_PROOF_CHECK = "thwip";
export const APP_PROOF_OBSERVE_CHECK = "thwip / proof (observe)";
const EXTERNAL_ID_PREFIX = "proof-verification:";

export interface AppProofRequest {
  event: "pull_request" | "merge_group";
  repositoryId: string;
  repository: string;
  ownerId: string;
  installationId: string;
  subjectSha: string;
  baseRef: string;
  pullRequestNumber?: number;
  prAuthorGithubUserId?: string;
  mergeGroupBaseSha?: string;
}

export type AppProofTask =
  | { kind: "verify"; request: AppProofRequest }
  | { kind: "rerequest"; verificationId: string };

interface PullRequestPayload {
  number?: number;
  user?: { id?: number };
  head?: { sha?: string };
  base?: { ref?: string };
}

interface ProofWebhookPayload {
  action?: string;
  installation?: { id?: number };
  repository?: { id?: number; full_name?: string; owner?: { id?: number } };
  pull_request?: PullRequestPayload;
  merge_group?: { head_sha?: string; base_sha?: string; base_ref?: string };
  check_run?: { name?: string; external_id?: string };
  check_suite?: {
    head_sha?: string;
    pull_requests?: Array<{
      number?: number;
      head?: { sha?: string };
      base?: { ref?: string; repo?: { id?: number } };
    }>;
  };
}

const PULL_REQUEST_ACTIONS = new Set(["opened", "reopened", "synchronize", "ready_for_review", "edited"]);

function decimal(value: unknown): string | null {
  const stringValue = typeof value === "number" ? String(value) : value;
  return typeof stringValue === "string" && /^[0-9]+$/.test(stringValue) ? stringValue : null;
}

function gitOid(value: unknown): string | null {
  return typeof value === "string" && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(value) ? value : null;
}

function repositoryFacts(payload: ProofWebhookPayload) {
  const repositoryId = decimal(payload.repository?.id);
  const ownerId = decimal(payload.repository?.owner?.id);
  const installationId = decimal(payload.installation?.id);
  const repository = payload.repository?.full_name;
  if (
    repositoryId === null ||
    ownerId === null ||
    installationId === null ||
    typeof repository !== "string" ||
    !/^[\w.-]+\/[\w.-]+$/.test(repository)
  ) {
    return null;
  }
  return { repositoryId, ownerId, installationId, repository };
}

/** Normalize only the webhook actions that can require a fresh exact-subject check. */
export function appProofTaskFromWebhook(event: string, payload: ProofWebhookPayload): AppProofTask | null {
  if (event === "check_run" && payload.action === "rerequested") {
    if (![APP_PROOF_CHECK, APP_PROOF_OBSERVE_CHECK].includes(payload.check_run?.name ?? "")) return null;
    const externalId = payload.check_run?.external_id ?? "";
    if (!externalId.startsWith(EXTERNAL_ID_PREFIX)) return null;
    const verificationId = externalId.slice(EXTERNAL_ID_PREFIX.length);
    return /^[a-zA-Z0-9_-]{8,128}$/.test(verificationId) ? { kind: "rerequest", verificationId } : null;
  }

  const repository = repositoryFacts(payload);
  if (repository === null) return null;
  if (event === "check_suite" && payload.action === "rerequested") {
    const subjectSha = gitOid(payload.check_suite?.head_sha);
    const pull = payload.check_suite?.pull_requests?.find(
      (candidate) =>
        decimal(candidate.base?.repo?.id) === repository.repositoryId &&
        candidate.head?.sha === subjectSha,
    );
    const pullRequestNumber = pull?.number;
    const base = pull?.base?.ref;
    if (
      subjectSha === null ||
      !Number.isInteger(pullRequestNumber) ||
      (pullRequestNumber ?? 0) < 1 ||
      typeof base !== "string" ||
      base.length === 0
    ) {
      return null;
    }
    return {
      kind: "verify",
      request: {
        event: "pull_request",
        ...repository,
        subjectSha,
        baseRef: `refs/heads/${base}`,
        pullRequestNumber: pullRequestNumber!,
      },
    };
  }
  if (event === "pull_request" && PULL_REQUEST_ACTIONS.has(payload.action ?? "")) {
    const pullRequestNumber = payload.pull_request?.number;
    const subjectSha = gitOid(payload.pull_request?.head?.sha);
    const base = payload.pull_request?.base?.ref;
    const author = decimal(payload.pull_request?.user?.id);
    if (
      !Number.isInteger(pullRequestNumber) ||
      (pullRequestNumber ?? 0) < 1 ||
      subjectSha === null ||
      typeof base !== "string" ||
      base.length === 0
    ) {
      return null;
    }
    return {
      kind: "verify",
      request: {
        event: "pull_request",
        ...repository,
        subjectSha,
        baseRef: `refs/heads/${base}`,
        pullRequestNumber: pullRequestNumber!,
        ...(author !== null ? { prAuthorGithubUserId: author } : {}),
      },
    };
  }
  if (event === "merge_group" && payload.action === "checks_requested") {
    const subjectSha = gitOid(payload.merge_group?.head_sha);
    const baseSha = gitOid(payload.merge_group?.base_sha);
    const baseRef = payload.merge_group?.base_ref;
    if (subjectSha === null || baseSha === null || typeof baseRef !== "string" || !baseRef.startsWith("refs/heads/")) {
      return null;
    }
    return {
      kind: "verify",
      request: {
        event: "merge_group",
        ...repository,
        subjectSha,
        baseRef,
        mergeGroupBaseSha: baseSha,
      },
    };
  }
  return null;
}

interface GitCommit {
  sha: string;
  treeOid: string;
  parentOids: string[];
  message: string;
}

export interface AppProofTarget extends GitCommit {
  baseSha: string;
  prAuthorGithubUserId?: string;
}

export interface AppProofTargetResult {
  headSha: string;
  treeOid: string;
  outcome: string;
  detail?: string;
  signerKeyId?: string;
}

export interface AppProofEvaluation {
  outcome: string;
  detail?: string;
  policyDigest: ProofVerificationAuditV1["policyDigest"];
  policyVersion: ProofVerificationAuditV1["policyVersion"];
  configSource: ProofVerificationAuditV1["configSource"];
  targets: AppProofTargetResult[];
}

export interface AppProofEvaluationDependencies {
  loadTargets(request: AppProofRequest): Promise<AppProofTarget[]>;
  resolveBundle(input: VerificationBundleInput): Promise<VerificationBundleResolution>;
  remoteCheckConclusions(headSha: string): Promise<Map<string, string>>;
  verifySshSignature(args: {
    publicKey: string;
    namespace: string;
    message: Uint8Array;
    signatureBase64: string;
  }): Promise<boolean>;
  now(): string;
}

export function proofHints(commitMessage: string): {
  signerGithubUserId?: string;
  keyFingerprint?: string;
} {
  const carrier = extractCarrier(commitMessage);
  if (!carrier.ok) return {};
  const keyFingerprint = carrier.envelope.signatures[0]?.keyid;
  let signerGithubUserId: string | undefined;
  try {
    const statement = parseStatement(JSON.parse(utf8Decode(b64stdDecode(carrier.envelope.payload))));
    const claimed = statement.ok ? statement.value.predicate.signer.githubUserId : undefined;
    if (typeof claimed === "string" && /^[0-9]+$/.test(claimed)) signerGithubUserId = claimed;
  } catch {
    // Malformed proof content is classified by the shared verifier.
  }
  return {
    ...(signerGithubUserId !== undefined ? { signerGithubUserId } : {}),
    ...(keyFingerprint !== undefined ? { keyFingerprint } : {}),
  };
}

function targetResult(target: AppProofTarget, result: VerifyResult): AppProofTargetResult {
  return {
    headSha: target.sha,
    treeOid: target.treeOid,
    outcome: result.code,
    ...(result.detail !== undefined ? { detail: result.detail.slice(0, 500) } : {}),
    ...(result.signerKey !== undefined ? { signerKeyId: result.signerKey.keyId } : {}),
  };
}

/** Evaluate all exact PR heads represented by a PR or merge-group subject. */
export async function evaluateAppProof(
  request: AppProofRequest,
  dependencies: AppProofEvaluationDependencies,
): Promise<AppProofEvaluation> {
  const targets = await dependencies.loadTargets(request);
  if (targets.length === 0) {
    return {
      outcome: "MERGE_GROUP_EMPTY",
      detail: "merge group contains no pull-request heads",
      policyDigest: null,
      policyVersion: null,
      configSource: "unavailable",
      targets: [],
    };
  }

  let policyDigest: ProofVerificationAuditV1["policyDigest"] = null;
  let policyVersion: ProofVerificationAuditV1["policyVersion"] = null;
  let configSource: ProofVerificationAuditV1["configSource"] = "unavailable";
  let resolutionIdentity: string | null = null;
  const results: AppProofTargetResult[] = [];
  for (const target of targets) {
    const resolution = await dependencies.resolveBundle({
      repositoryId: request.repositoryId,
      ...proofHints(target.message),
    });
    if (resolution.kind === "bootstrap_pending") {
      if (resolutionIdentity !== null && resolutionIdentity !== "bootstrap_pending") {
        throw new Error("active policy changed during verification");
      }
      resolutionIdentity = "bootstrap_pending";
      results.push({
        headSha: target.sha,
        treeOid: target.treeOid,
        outcome: resolution.code,
        detail: "no active policy is available",
      });
      continue;
    }
    const nextConfigSource =
      resolution.configSource === "global" || resolution.configSource === "repository-override"
        ? resolution.configSource
        : "unavailable";
    const nextIdentity = [
      "active",
      resolution.bundle.activePolicyDigest,
      resolution.bundle.policy.version,
      nextConfigSource,
    ].join(":");
    if (resolutionIdentity !== null && resolutionIdentity !== nextIdentity) {
      throw new Error("active policy changed during verification");
    }
    resolutionIdentity = nextIdentity;
    policyDigest = resolution.bundle.activePolicyDigest;
    policyVersion = resolution.bundle.policy.version;
    configSource = nextConfigSource;
    const facts: GithubFacts = {
      ownerId: request.ownerId,
      repositoryId: request.repositoryId,
      headSha: target.sha,
      treeOid: target.treeOid,
      parentOids: target.parentOids,
      baseRef: request.baseRef,
      baseSha: target.baseSha,
      objectFormat: target.sha.length === 64 ? "sha256" : "sha1",
      ...(target.prAuthorGithubUserId !== undefined
        ? { prAuthorGithubUserId: target.prAuthorGithubUserId }
        : {}),
    };
    const result = await verifyProof(
      {
        commitMessage: target.message,
        facts,
        bundle: resolution.bundle,
        now: dependencies.now(),
      },
      {
        verifySshSignature: dependencies.verifySshSignature,
        remoteCheckConclusions: dependencies.remoteCheckConclusions,
      },
    );
    results.push(targetResult(target, result));
  }

  const failed = results.find((result) => result.outcome !== "PASS");
  return {
    outcome: failed?.outcome ?? "PASS",
    ...(failed?.detail !== undefined ? { detail: failed.detail } : {}),
    policyDigest,
    policyVersion,
    configSource,
    targets: results,
  };
}

interface ProofProject {
  id: string;
  repositoryId: string;
  repository: string;
  ownerId: string;
  installationId: string;
  enabled: boolean;
  mode: "observe" | "enforced";
}

export interface AppProofProcessDependencies {
  loadProject(env: Env, request: AppProofRequest): Promise<ProofProject | null>;
  insertStarted(
    env: Env,
    input: {
      id: string;
      project: ProofProject;
      request: AppProofRequest;
      verifierVersion: string;
      mode: ProofProject["mode"];
      checkName: string;
    },
  ): Promise<void>;
  markCheckStarted(env: Env, id: string, checkRunId: string): Promise<void>;
  markCompleted(
    env: Env,
    id: string,
    evaluation: AppProofEvaluation,
    auditJws: string,
    completedAt: string,
  ): Promise<void>;
  createCheck(project: ProofProject, request: AppProofRequest, id: string, checkName: string): Promise<string>;
  completeCheck(
    project: ProofProject,
    request: AppProofRequest,
    checkRunId: string,
    checkName: string,
    evaluation: AppProofEvaluation,
    conclusion: "success" | "failure" | "neutral",
    detailsUrl: string,
  ): Promise<void>;
  evaluationDependencies(project: ProofProject): AppProofEvaluationDependencies;
  signAudit(env: Env, audit: ProofVerificationAuditV1): Promise<string>;
  now(): string;
  verifierVersion(env: Env): string;
}

function verificationId(): string {
  return `proof_${crypto.randomUUID().replace(/-/g, "")}`;
}

function checkConclusion(_mode: ProofProject["mode"], outcome: string): "success" | "failure" | "neutral" {
  return outcome === "PASS" ? "success" : "failure";
}

export async function processAppProofVerification(
  env: Env,
  request: AppProofRequest,
  dependencies: AppProofProcessDependencies,
): Promise<{ verificationId: string; checkRunId: string; evaluation: AppProofEvaluation }> {
  const project = await dependencies.loadProject(env, request);
  if (project === null) throw new Error(`repository ${request.repositoryId} is not synchronized`);
  const id = verificationId();
  const verifierVersion = dependencies.verifierVersion(env);
  const checkName = project.mode === "observe" ? APP_PROOF_OBSERVE_CHECK : APP_PROOF_CHECK;
  await dependencies.insertStarted(env, {
    id,
    project,
    request,
    verifierVersion,
    mode: project.mode,
    checkName,
  });
  const checkRunId = await dependencies.createCheck(project, request, id, checkName);
  await dependencies.markCheckStarted(env, id, checkRunId);

  let evaluation: AppProofEvaluation;
  if (!project.enabled) {
    evaluation = {
      outcome: "PROJECT_DISABLED",
      detail: "the repository is installed but not enabled for thwip",
      policyDigest: null,
      policyVersion: null,
      configSource: "unavailable",
      targets: [],
    };
  } else {
    try {
      evaluation = await evaluateAppProof(request, dependencies.evaluationDependencies(project));
    } catch (error) {
      evaluation =
        error instanceof VerificationBundleError
          ? {
              outcome: error.code,
              detail: error.message.slice(0, 500),
              policyDigest: null,
              policyVersion: null,
              configSource: "unavailable",
              targets: [],
            }
          : {
              outcome: "VERIFICATION_INFRASTRUCTURE_ERROR",
              detail: (error instanceof Error ? error.message : String(error)).slice(0, 500),
              policyDigest: null,
              policyVersion: null,
              configSource: "unavailable",
              targets: [],
            };
    }
  }

  const evaluatedAt = dependencies.now();
  const audit: ProofVerificationAuditV1 = {
    schemaVersion: "1",
    verificationId: id,
    repositoryId: request.repositoryId,
    repository: request.repository,
    event: request.event,
    subjectSha: request.subjectSha,
    baseRef: request.baseRef,
    policyDigest: evaluation.policyDigest,
    policyVersion: evaluation.policyVersion,
    configSource: evaluation.configSource,
    verifierVersion,
    mode: project.mode,
    outcome: evaluation.outcome,
    ...(evaluation.detail !== undefined ? { detail: evaluation.detail } : {}),
    targets: evaluation.targets.map((target) => ({
      headSha: target.headSha,
      treeOid: target.treeOid,
      outcome: target.outcome,
      ...(target.signerKeyId !== undefined ? { signerKeyId: target.signerKeyId } : {}),
    })),
    checkRunId,
    evaluatedAt,
  };
  const auditJws = await dependencies.signAudit(env, audit);
  await dependencies.markCompleted(env, id, evaluation, auditJws, evaluatedAt);
  const detailsUrl = `${env.PUBLIC_ORIGIN}/v1/proof-verifications/${encodeURIComponent(id)}`;
  await dependencies.completeCheck(
    project,
    request,
    checkRunId,
    checkName,
    evaluation,
    checkConclusion(project.mode, evaluation.outcome),
    detailsUrl,
  );
  return { verificationId: id, checkRunId, evaluation };
}

function repositoryPath(repository: string): string {
  return repository
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

async function github<T>(token: string, repository: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API}/repos/${repositoryPath(repository)}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "user-agent": "thwip-control-plane",
      ...(init?.headers ?? {}),
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub ${repository}${path} -> ${response.status}: ${(await response.text()).slice(0, 500)}`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function normalizeGitCommit(value: {
  sha?: string;
  message?: string;
  tree?: { sha?: string };
  parents?: Array<{ sha?: string }>;
  commit?: { message?: string; tree?: { sha?: string } };
}): GitCommit {
  const sha = gitOid(value.sha);
  const treeOid = gitOid(value.tree?.sha ?? value.commit?.tree?.sha);
  const message = value.message ?? value.commit?.message;
  const parentOids = (value.parents ?? []).map((parent) => gitOid(parent.sha)).filter((sha): sha is string => sha !== null);
  if (sha === null || treeOid === null || typeof message !== "string") {
    throw new Error("GitHub returned an incomplete commit");
  }
  return { sha, treeOid, parentOids, message };
}

async function mergeBase(token: string, request: AppProofRequest, headSha: string): Promise<string> {
  const base = request.baseRef.replace(/^refs\/heads\//, "");
  const comparison = await github<{ merge_base_commit?: { sha?: string } }>(
    token,
    request.repository,
    `/compare/${encodeURIComponent(base)}...${encodeURIComponent(headSha)}`,
  );
  const sha = gitOid(comparison.merge_base_commit?.sha);
  if (sha === null) throw new Error(`GitHub returned no merge base for ${headSha}`);
  return sha;
}

async function pullRequestHeadCommit(
  token: string,
  request: AppProofRequest & { pullRequestNumber: number },
): Promise<GitCommit & { prAuthorGithubUserId?: string }> {
  const pull = await github<{ commits?: number; user?: { id?: number } }>(
    token,
    request.repository,
    `/pulls/${request.pullRequestNumber}`,
  );
  const page = Math.max(1, Math.ceil((pull.commits ?? 1) / 100));
  const commits = await github<
    Array<{
      sha?: string;
      commit?: { message?: string; tree?: { sha?: string } };
      parents?: Array<{ sha?: string }>;
    }>
  >(token, request.repository, `/pulls/${request.pullRequestNumber}/commits?per_page=100&page=${page}`);
  const commit = commits.find((candidate) => candidate.sha === request.subjectSha);
  if (commit === undefined) throw new Error(`pull request head ${request.subjectSha} is not in its commit list`);
  const author = decimal(pull.user?.id);
  return {
    ...normalizeGitCommit(commit),
    ...(author !== null ? { prAuthorGithubUserId: author } : {}),
  };
}

async function commitAuthor(token: string, request: AppProofRequest, sha: string): Promise<string | undefined> {
  const pulls = await github<Array<{ user?: { id?: number }; base?: { repo?: { id?: number } } }>>(
    token,
    request.repository,
    `/commits/${encodeURIComponent(sha)}/pulls`,
  );
  const pull = pulls.find((candidate) => decimal(candidate.base?.repo?.id) === request.repositoryId) ?? pulls[0];
  return decimal(pull?.user?.id) ?? undefined;
}

export async function loadGithubProofTargets(token: string, request: AppProofRequest): Promise<AppProofTarget[]> {
  if (request.event === "pull_request") {
    if (request.pullRequestNumber === undefined) throw new Error("pull request number missing");
    const commit = await pullRequestHeadCommit(token, {
      ...request,
      pullRequestNumber: request.pullRequestNumber,
    });
    const prAuthorGithubUserId = request.prAuthorGithubUserId ?? commit.prAuthorGithubUserId;
    return [
      {
        ...commit,
        baseSha: await mergeBase(token, request, commit.sha),
        ...(prAuthorGithubUserId !== undefined ? { prAuthorGithubUserId } : {}),
      },
    ];
  }

  if (request.mergeGroupBaseSha === undefined) throw new Error("merge group base SHA missing");
  const targets: AppProofTarget[] = [];
  let cursor = request.subjectSha;
  for (let hops = 0; cursor !== request.mergeGroupBaseSha && hops < 100; hops++) {
    const groupCommit = normalizeGitCommit(
      await github(token, request.repository, `/git/commits/${encodeURIComponent(cursor)}`),
    );
    const targetSha = groupCommit.parentOids[1];
    if (targetSha !== undefined) {
      const target = normalizeGitCommit(
        await github(token, request.repository, `/git/commits/${encodeURIComponent(targetSha)}`),
      );
      const author = await commitAuthor(token, request, target.sha);
      targets.push({
        ...target,
        baseSha: await mergeBase(token, request, target.sha),
        ...(author !== undefined ? { prAuthorGithubUserId: author } : {}),
      });
    }
    const next = groupCommit.parentOids[0];
    if (next === undefined) break;
    cursor = next;
  }
  if (cursor !== request.mergeGroupBaseSha) {
    throw new Error("merge group first-parent history did not reach its declared base");
  }
  return targets;
}

function checkSummary(evaluation: AppProofEvaluation, detailsUrl: string): string {
  const targets =
    evaluation.targets.length === 0
      ? "No proof target could be evaluated."
      : evaluation.targets
          .map(
            (target) =>
              `- \`${target.headSha.slice(0, 12)}\` tree \`${target.treeOid.slice(0, 12)}\`: \`${target.outcome}\``,
          )
          .join("\n");
  return [
    `Exact-subject App verification concluded \`${evaluation.outcome}\`.`,
    evaluation.detail ?? "",
    targets,
    evaluation.policyDigest === null
      ? "No active policy digest was available."
      : `Policy: \`${evaluation.policyDigest}\` v${evaluation.policyVersion ?? "?"} (${evaluation.configSource}).`,
    `[Signed audit record](${detailsUrl})`,
  ]
    .filter((line) => line.length > 0)
    .join("\n\n")
    .slice(0, 60_000);
}

async function loadProofProject(env: Env, repositoryId: string): Promise<ProofProject | null> {
  const row = await env.DB.prepare(
    `SELECT p.id, p.github_repository_id, p.github_name, p.enabled, p.proof_check_mode,
            o.github_org_id, o.installation_id
       FROM projects p JOIN organizations o ON o.id = p.organization_id
      WHERE p.github_repository_id = ?`,
  )
    .bind(repositoryId)
    .first<{
      id: string;
      github_repository_id: string;
      github_name: string;
      enabled: number;
      proof_check_mode: string;
      github_org_id: string;
      installation_id: string | null;
    }>();
  if (row === null || row.installation_id === null) return null;
  return {
    id: row.id,
    repositoryId: row.github_repository_id,
    repository: row.github_name,
    ownerId: row.github_org_id,
    installationId: row.installation_id,
    enabled: row.enabled === 1,
    mode: row.proof_check_mode === "enforced" ? "enforced" : "observe",
  };
}

const defaultStorageDependencies: Pick<
  AppProofProcessDependencies,
  "loadProject" | "insertStarted" | "markCheckStarted" | "markCompleted" | "signAudit" | "now" | "verifierVersion"
> = {
  loadProject: (env, request) => loadProofProject(env, request.repositoryId),
  async insertStarted(env, input) {
    await env.DB.prepare(
      `INSERT INTO proof_verifications
         (id, project_id, event, subject_sha, base_ref, verifier_version, mode, request_json, status, check_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
    )
      .bind(
        input.id,
        input.project.id,
        input.request.event,
        input.request.subjectSha,
        input.request.baseRef,
        input.verifierVersion,
        input.mode,
        JSON.stringify(input.request),
        input.checkName,
      )
      .run();
  },
  async markCheckStarted(env, id, checkRunId) {
    await env.DB.prepare(
      "UPDATE proof_verifications SET status = 'in_progress', check_run_id = ? WHERE id = ?",
    )
      .bind(checkRunId, id)
      .run();
  },
  async markCompleted(env, id, evaluation, auditJws, completedAt) {
    await env.DB.prepare(
      `UPDATE proof_verifications
          SET status = 'completed', outcome = ?, detail = ?, policy_digest = ?, audit_jws = ?, completed_at = ?
        WHERE id = ?`,
    )
      .bind(
        evaluation.outcome,
        evaluation.detail ?? null,
        evaluation.policyDigest,
        auditJws,
        completedAt,
        id,
      )
      .run();
  },
  signAudit(env, audit) {
    return signPayload(env, audit, "thwip-proof-verification+jws");
  },
  now: () => new Date().toISOString(),
  verifierVersion: (env) => env.BUILD_SHA || "development",
};

function defaultDependenciesForEnv(env: Env): AppProofProcessDependencies {
  const tokenByInstallation = new Map<string, Promise<string>>();
  const token = (project: ProofProject): Promise<string> => {
    let pending = tokenByInstallation.get(project.installationId);
    if (pending === undefined) {
      pending = installationToken(env, project.installationId);
      tokenByInstallation.set(project.installationId, pending);
    }
    return pending;
  };
  return {
    ...defaultStorageDependencies,
    async createCheck(project, request, id, checkName) {
      const body = await github<{ id?: number }>(await token(project), project.repository, "/check-runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: checkName,
          head_sha: request.subjectSha,
          status: "in_progress",
          external_id: `${EXTERNAL_ID_PREFIX}${id}`,
          details_url: `${env.PUBLIC_ORIGIN}/v1/proof-verifications/${encodeURIComponent(id)}`,
          output: {
            title: "Verifying signed proof",
            summary: `Thwip is verifying the exact ${request.event.replace("_", " ")} subject \`${request.subjectSha}\`.`,
          },
        }),
      });
      const idValue = decimal(body.id);
      if (idValue === null) throw new Error("GitHub created a check run without an id");
      return idValue;
    },
    async completeCheck(project, _request, checkRunId, _checkName, evaluation, conclusion, detailsUrl) {
      await github(await token(project), project.repository, `/check-runs/${encodeURIComponent(checkRunId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          status: "completed",
          conclusion,
          completed_at: new Date().toISOString(),
          details_url: detailsUrl,
          output: {
            title:
              evaluation.outcome === "PASS"
                ? "Signed proof accepted"
                : `Signed proof rejected: ${evaluation.outcome}`,
            summary: checkSummary(evaluation, detailsUrl),
          },
        }),
      });
    },
    evaluationDependencies(project) {
      return {
        loadTargets: async (request) => loadGithubProofTargets(await token(project), request),
        resolveBundle: (input) => resolveVerificationBundle(env, input),
        remoteCheckConclusions: async (headSha) => {
          const runs = await github<{ check_runs?: Array<{ name?: string; conclusion?: string | null }> }>(
            await token(project),
            project.repository,
            `/commits/${encodeURIComponent(headSha)}/check-runs?filter=latest&per_page=100`,
          );
          const conclusions = new Map<string, string>();
          for (const run of runs.check_runs ?? []) {
            if (typeof run.name === "string") conclusions.set(run.name, run.conclusion ?? "pending");
          }
          return conclusions;
        },
        verifySshSignature: verifySshSigEd25519,
        now: () => new Date().toISOString(),
      };
    },
  };
}

/** Production entrypoint; the explicit wrapper keeps the core easy to test. */
export function processAppProof(env: Env, request: AppProofRequest) {
  return processAppProofVerification(env, request, defaultDependenciesForEnv(env));
}

export async function requestForRerequest(env: Env, verificationId: string): Promise<AppProofRequest | null> {
  const row = await env.DB.prepare("SELECT request_json FROM proof_verifications WHERE id = ?")
    .bind(verificationId)
    .first<{ request_json: string }>();
  if (row === null) return null;
  try {
    return JSON.parse(row.request_json) as AppProofRequest;
  } catch {
    return null;
  }
}

interface OpenPullRequest {
  number?: number;
  user?: { id?: number };
  head?: { sha?: string };
  base?: { ref?: string };
}

function requestFromOpenPull(project: ProofProject, pull: OpenPullRequest): AppProofRequest | null {
  const number = pull.number;
  const subjectSha = gitOid(pull.head?.sha);
  const base = pull.base?.ref;
  if (!Number.isInteger(number) || (number ?? 0) < 1 || subjectSha === null || typeof base !== "string") return null;
  const author = decimal(pull.user?.id);
  return {
    event: "pull_request",
    repositoryId: project.repositoryId,
    repository: project.repository,
    ownerId: project.ownerId,
    installationId: project.installationId,
    subjectSha,
    baseRef: `refs/heads/${base}`,
    pullRequestNumber: number!,
    ...(author !== null ? { prAuthorGithubUserId: author } : {}),
  };
}

export async function reconcileProjectProofChecks(
  env: Env,
  repositoryId: string,
  dependencies: AppProofProcessDependencies = defaultDependenciesForEnv(env),
): Promise<number> {
  const project = await loadProofProject(env, repositoryId);
  if (project === null) return 0;
  const token = await installationToken(env, project.installationId);
  let processed = 0;
  for (let page = 1; page <= 10; page++) {
    const pulls = await github<OpenPullRequest[]>(
      token,
      project.repository,
      `/pulls?state=open&per_page=100&page=${page}`,
    );
    for (const pull of pulls) {
      const request = requestFromOpenPull(project, pull);
      if (request !== null) {
        await processAppProofVerification(env, request, dependencies);
        processed++;
      }
    }
    if (pulls.length < 100) break;
  }
  return processed;
}

export async function reconcileInstallationProofChecks(env: Env, installationId: string): Promise<number> {
  const projects = await env.DB.prepare(
    `SELECT p.github_repository_id
       FROM projects p JOIN organizations o ON o.id = p.organization_id
      WHERE o.installation_id = ? AND p.enabled = 1`,
  )
    .bind(installationId)
    .all<{ github_repository_id: string }>();
  const dependencies = defaultDependenciesForEnv(env);
  let processed = 0;
  for (const project of projects.results) {
    processed += await reconcileProjectProofChecks(env, project.github_repository_id, dependencies);
  }
  return processed;
}
