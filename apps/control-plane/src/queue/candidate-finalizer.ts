import type { D1Like } from "./projection.js";
import type { CandidateSuite, CandidateVerdict } from "./store.js";
import {
  claimPendingCandidateReports,
  finalizeCandidateVerdictV3,
  finishPendingCandidateReport,
  retryPendingCandidateReport,
  type PendingCandidateFinalization,
} from "./candidate-store.js";
import { candidateResultBytes, candidateResultDigest } from "./candidate-verdict.js";
import { readActivePolicy } from "../active-policy.js";
import { acquireProjectWriteLease, repositoryAllowsExternalWrite } from "../project-lifecycle.js";
import { installationToken } from "../github-app.js";
import { QUEUE_ACTION_REF, verifierWorkflowFile } from "./bootstrap-workflows.js";
import { VERIFIER_WORKFLOW_PATH } from "./bootstrap.js";
import { storeEvidence } from "./merge-lane.js";
import type { QueueRouteEnv } from "./routes.js";
import { databaseSchemaCapabilities } from "../schema-state.js";

const REPORT_JOB_NAME = "register trusted candidate report";
const PREPARE_JOB_NAME = "prepare trusted suite matrix";
const VERIFY_PREFIX = "verify candidate / ";
const PENDING_TTL_MS = 60 * 60_000;
const RETRY_MS = 60_000;
const CLAIM_MS = 4 * 60_000;

export interface GithubWorkflowJob {
  readonly id: number;
  readonly run_id: number;
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly head_sha: string;
  readonly started_at: string | null;
  readonly completed_at: string | null;
}

export interface GithubRun {
  readonly id: number;
  readonly run_attempt: number;
  readonly event: string;
  readonly path: string;
  readonly head_sha: string;
  readonly status: string;
  readonly conclusion: string | null;
}

export type DerivedGithubVerdict =
  | { readonly kind: "waiting"; readonly detail: string }
  | { readonly kind: "terminal"; readonly detail: string }
  | { readonly kind: "complete"; readonly suites: readonly CandidateSuite[]; readonly accepted: boolean };

/**
 * Pure GitHub-owned result derivation. No workflow artifact, output, log,
 * workspace file, environment value or candidate request body enters here.
 */
export function deriveGithubCandidateVerdict(
  pending: PendingCandidateFinalization,
  run: GithubRun,
  jobs: readonly GithubWorkflowJob[],
): DerivedGithubVerdict {
  if (
    String(run.id) !== pending.runId ||
    run.run_attempt !== pending.runAttempt ||
    run.event !== "repository_dispatch" ||
    run.path !== VERIFIER_WORKFLOW_PATH ||
    run.head_sha !== pending.workflowCommitSha
  ) {
    return { kind: "terminal", detail: "workflow run identity does not match the dispatch" };
  }
  if (run.status !== "completed") return { kind: "waiting", detail: "workflow run is not complete" };

  const ids = jobs.map((job) => String(job.id));
  if (new Set(ids).size !== ids.length) {
    return { kind: "terminal", detail: "GitHub returned duplicate workflow jobs" };
  }
  const expectedVerifyNames = new Set(pending.requiredSuites.map((suite) => VERIFY_PREFIX + suite));
  const allowed = new Set([PREPARE_JOB_NAME, REPORT_JOB_NAME, ...expectedVerifyNames]);
  if (jobs.some((job) => String(job.run_id) !== pending.runId || job.head_sha !== pending.workflowCommitSha)) {
    return { kind: "terminal", detail: "a workflow job belongs to another run or commit" };
  }
  if (jobs.some((job) => !allowed.has(job.name))) {
    return { kind: "terminal", detail: "the run contains an unexpected workflow job" };
  }

  const report = jobs.filter((job) => job.name === REPORT_JOB_NAME);
  if (report.length !== 1 || String(report[0]?.id) !== pending.checkRunId) {
    return { kind: "terminal", detail: "the signed report job is missing or ambiguous" };
  }
  if (report[0]?.status !== "completed") return { kind: "waiting", detail: "report job is not complete" };
  if (report[0]?.conclusion !== "success") {
    return { kind: "terminal", detail: "report job did not complete successfully" };
  }
  const prepare = jobs.filter((job) => job.name === PREPARE_JOB_NAME);
  if (prepare.length !== 1) return { kind: "terminal", detail: "prepare job is missing or ambiguous" };
  if (prepare[0]?.status !== "completed") return { kind: "waiting", detail: "prepare job is not complete" };
  if (prepare[0]?.conclusion !== "success") return { kind: "terminal", detail: "prepare job failed" };

  const suites: CandidateSuite[] = [];
  for (const suite of pending.requiredSuites) {
    const matches = jobs.filter((job) => job.name === VERIFY_PREFIX + suite);
    if (matches.length !== 1) return { kind: "terminal", detail: `suite job ${suite} is missing or ambiguous` };
    const job = matches[0]!;
    if (job.status !== "completed") return { kind: "waiting", detail: `suite job ${suite} is not complete` };
    const started = Date.parse(job.started_at ?? "");
    const completed = Date.parse(job.completed_at ?? "");
    if (!Number.isFinite(started) || !Number.isFinite(completed) || completed < started) {
      return { kind: "terminal", detail: `suite job ${suite} has invalid GitHub timestamps` };
    }
    suites.push({
      name: suite,
      outcome: job.conclusion === "success" ? "passed" : "failed",
      durationMs: Math.min(completed - started, 86_400_000),
    });
  }
  return { kind: "complete", suites, accepted: suites.every((suite) => suite.outcome === "passed") };
}

async function digestText(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${[...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function githubJson<T>(token: string, url: string): Promise<T | null> {
  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "user-agent": "thwip-control-plane",
    },
  }).catch(() => null);
  if (response === null || !response.ok) return null;
  return (await response.json().catch(() => null)) as T | null;
}

export type GithubCandidateState =
  | { readonly kind: "waiting"; readonly detail: string }
  | { readonly kind: "terminal"; readonly detail: string }
  | { readonly kind: "ready"; readonly run: GithubRun; readonly jobs: readonly GithubWorkflowJob[] };

async function githubState(
  env: QueueRouteEnv,
  pending: PendingCandidateFinalization,
): Promise<GithubCandidateState> {
  const project = await env.DB.prepare(
    `SELECT p.github_name, o.installation_id
       FROM projects p JOIN organizations o ON o.id = p.organization_id
      WHERE p.id = ? AND p.github_repository_id = ? AND o.status = 'active'`,
  )
    .bind(pending.projectId, pending.repositoryId)
    .first<{ github_name: string; installation_id: string | null }>();
  if (project === null || project.installation_id === null) {
    return { kind: "terminal", detail: "the project has no active GitHub installation" };
  }
  const token = await installationToken(env as never, project.installation_id, undefined, pending.repositoryId).catch(
    () => null,
  );
  if (token === null) return { kind: "waiting", detail: "GitHub installation token is temporarily unavailable" };
  const api = `https://api.github.com/repos/${project.github_name}`;

  const file = await githubJson<{ sha: string; content: string; encoding: string }>(
    token,
    `${api}/contents/${VERIFIER_WORKFLOW_PATH}?ref=${pending.workflowCommitSha}`,
  );
  if (file === null) return { kind: "waiting", detail: "the immutable verifier workflow is temporarily unreadable" };
  if (file.encoding !== "base64" || file.sha !== pending.workflowBlobSha) {
    return { kind: "terminal", detail: "the immutable verifier workflow blob does not match the dispatch" };
  }
  const content = atob(file.content.replaceAll("\n", ""));
  const expected = verifierWorkflowFile({ endpoint: env.PUBLIC_ORIGIN, actionRef: QUEUE_ACTION_REF }).content;
  if (content !== expected || (await digestText(content)) !== pending.workflowContentDigest) {
    return { kind: "terminal", detail: "the immutable verifier workflow content does not match the reviewed v3 template" };
  }

  const run = await githubJson<GithubRun>(
    token,
    `${api}/actions/runs/${pending.runId}/attempts/${pending.runAttempt}`,
  );
  if (run === null) return { kind: "waiting", detail: "the exact GitHub run attempt is not visible yet" };
  const jobs: GithubWorkflowJob[] = [];
  let total: number | null = null;
  for (let page = 1; page <= 10; page += 1) {
    const response = await githubJson<{ total_count: number; jobs: GithubWorkflowJob[] }>(
      token,
      `${api}/actions/runs/${pending.runId}/attempts/${pending.runAttempt}/jobs?per_page=100&page=${page}`,
    );
    if (response === null || !Array.isArray(response.jobs)) {
      return { kind: "waiting", detail: "the exact GitHub job page is not visible yet" };
    }
    if (total === null) total = response.total_count;
    if (response.total_count !== total) return { kind: "waiting", detail: "GitHub job pagination changed during the read" };
    jobs.push(...response.jobs);
    if (response.jobs.length < 100) break;
    if (page === 10) return { kind: "terminal", detail: "the workflow run has too many jobs to verify safely" };
  }
  if (jobs.length !== total) return { kind: "waiting", detail: "GitHub returned an incomplete job list" };
  return { kind: "ready", run, jobs };
}

export interface FinalizeCandidateReportsDeps {
  activeAttempt(repositoryId: string, baseRef: string): Promise<string | null>;
  publish(
    pending: PendingCandidateFinalization,
    verdict: { accepted: boolean; suites: readonly CandidateSuite[] },
  ): Promise<void>;
  drive(repositoryId: string, baseRef: string): Promise<void>;
  /** Test seam for GitHub-owned state. Production always uses the App read. */
  githubState?(pending: PendingCandidateFinalization): Promise<GithubCandidateState>;
}

/** One bounded, idempotent finalizer pass. */
export async function finalizeCandidateReports(
  env: QueueRouteEnv,
  deps: FinalizeCandidateReportsDeps,
  now = new Date(),
): Promise<{ finalized: number; retried: number; terminal: number }> {
  const db = env.DB as unknown as D1Like;
  if (!(await databaseSchemaCapabilities(db)).verifierProtocolV3) {
    return { finalized: 0, retried: 0, terminal: 0 };
  }
  const claim = crypto.randomUUID();
  const rows = await claimPendingCandidateReports(
    db,
    claim,
    now.toISOString(),
    new Date(now.getTime() + CLAIM_MS).toISOString(),
    5,
  );
  let finalized = 0;
  let retried = 0;
  let terminal = 0;
  for (const pending of rows) {
    const fail = async (reason: string) => {
      if (await finishPendingCandidateReport(db, pending, claim, { terminalReason: reason.slice(0, 200) })) {
        terminal += 1;
        await deps.drive(pending.repositoryId, pending.baseRef);
      }
    };
    const lease = await acquireProjectWriteLease(db, pending.repositoryId, pending.projectId);
    if (lease === null) {
      await fail("project released or reselected");
      continue;
    }
    try {
      const age = now.getTime() - Date.parse(pending.pendingAt);
      if (!Number.isFinite(age) || age > PENDING_TTL_MS) {
        await fail("candidate report expired before GitHub completed");
        continue;
      }
      if ((await deps.activeAttempt(pending.repositoryId, pending.baseRef)) !== pending.attemptId) {
        await fail("queue attempt is no longer current");
        continue;
      }
      const policy = await readActivePolicy(db, pending.repositoryId, pending.baseRef);
      if (
        policy === null ||
        policy.projectId !== pending.projectId ||
        policy.policyDigest !== pending.policyDigest ||
        JSON.stringify(policy.requiredSuites) !== JSON.stringify(pending.requiredSuites)
      ) {
        await fail("active policy no longer matches the dispatch");
        continue;
      }
      const state = await (deps.githubState?.(pending) ?? githubState(env, pending));
      if (state.kind === "waiting") {
        await retryPendingCandidateReport(
          db,
          pending,
          claim,
          new Date(now.getTime() + RETRY_MS).toISOString(),
        );
        retried += 1;
        continue;
      }
      if (state.kind === "terminal") {
        await fail(state.detail);
        continue;
      }
      const derived = deriveGithubCandidateVerdict(pending, state.run, state.jobs);
      if (derived.kind === "waiting") {
        await retryPendingCandidateReport(
          db,
          pending,
          claim,
          new Date(now.getTime() + RETRY_MS).toISOString(),
        );
        retried += 1;
        continue;
      }
      if (derived.kind === "terminal") {
        await fail(derived.detail);
        continue;
      }
      // GitHub reads can take several requests. Fence the exact attempt again
      // after them, then enforce the same fact inside the D1 verdict write.
      if ((await deps.activeAttempt(pending.repositoryId, pending.baseRef)) !== pending.attemptId) {
        await fail("queue attempt changed while GitHub results were read");
        continue;
      }
      await lease.renew();
      if (!(await repositoryAllowsExternalWrite(db, pending.repositoryId, pending.projectId))) {
        await fail("project released before verdict materialization");
        continue;
      }
      const content = {
        candidateTreeOid: pending.candidateTreeOid,
        candidateSha: pending.candidateSha,
        baseSha: pending.baseSha,
        pullRequestNumber: pending.pullRequestNumber,
        accepted: derived.accepted,
        policyDigest: pending.policyDigest,
        suites: derived.suites,
        reasonCodes: derived.accepted ? [] : ["SUITE_NOT_PASSED"],
        workflowRef: policy.verifier?.workflowRef ?? "",
        workflowSha: pending.workflowCommitSha,
        runId: pending.runId,
      };
      const resultDigest = await candidateResultDigest(content);
      const verdict: CandidateVerdict = {
        ...content,
        resultDigest,
        observedAt: now.toISOString(),
      };
      await storeEvidence(env, {
        projectId: pending.projectId,
        organizationId: policy.organizationId,
        repositoryId: pending.repositoryId,
        kind: "verifier-result",
        digest: resultDigest as `sha256:${string}`,
        bytes: candidateResultBytes(content),
        writeLease: lease,
      });
      if (!(await finalizeCandidateVerdictV3(db, pending, claim, verdict, now.toISOString()))) {
        await fail("project released before verdict write");
        continue;
      }
      finalized += 1;
      // The verdict is durable authority. A best-effort check-run update must
      // not prevent the queue from consuming it, or one transient GitHub write
      // would strand a finalized row that later sweeps deliberately skip.
      await deps.publish(pending, { accepted: derived.accepted, suites: derived.suites }).catch(() => undefined);
      await deps.drive(pending.repositoryId, pending.baseRef);
    } finally {
      await lease.release();
    }
  }
  return { finalized, retried, terminal };
}
