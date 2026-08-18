import { appendFileSync } from "node:fs";
import { importJWK, compactVerify, type JWK } from "jose";
import { verifySshSignature } from "@thwip/sshsig";
import { verifyProof, type GithubFacts } from "@thwip/verifier";
import {
  b64stdDecode,
  extractCarrier,
  parseStatement,
  utf8Decode,
  type VerificationBundleV1,
} from "@thwip/protocol";
import servicePublicJwk from "../service-public.jwk.json" with { type: "json" };
import { parseBundleResolutionBody } from "./bundle-resolution.js";
import { ActionClient } from "./control-plane.js";
import { readActionContext, readActionInputs, type PullRequestContext } from "./context.js";
import { verifyAndAuthorize } from "./orchestration.js";

interface CommitData {
  sha: string;
  tree: { sha: string };
  parents: Array<{ sha: string }>;
  message: string;
}

function summary(line: string): void {
  const f = process.env["GITHUB_STEP_SUMMARY"];
  if (f) appendFileSync(f, line + "\n");
  console.log(line);
}

function proofHints(commitMessage: string): { signerGithubUserId?: string; keyFingerprint?: string } {
  const carrier = extractCarrier(commitMessage);
  if (!carrier.ok) return {};
  const keyFingerprint = carrier.envelope.signatures[0]?.keyid;
  let signerGithubUserId: string | undefined;
  try {
    const statement = JSON.parse(new TextDecoder().decode(b64stdDecode(carrier.envelope.payload))) as {
      predicate?: { signer?: { githubUserId?: string } };
    };
    const claimed = statement.predicate?.signer?.githubUserId;
    if (typeof claimed === "string" && /^[0-9]+$/.test(claimed)) signerGithubUserId = claimed;
  } catch {
    /* malformed proofs fail later, with a reason code */
  }
  return {
    ...(signerGithubUserId !== undefined ? { signerGithubUserId } : {}),
    ...(keyFingerprint !== undefined ? { keyFingerprint } : {}),
  };
}

async function fetchBundle(
  client: ActionClient,
  repositoryId: string,
  headSha: string,
  hints: { signerGithubUserId?: string; keyFingerprint?: string },
): Promise<
  | { kind: "active"; bundle: VerificationBundleV1 }
  | {
      kind: "bootstrap_pending";
      code: "POLICY_AWAITING_FIRST_MERGE";
      repository: string;
      repositoryId: string;
      projectId: string;
      defaultBranch: string;
    }
> {
  const response = await client.controlPlane<unknown>("/v1/verification-bundles:resolve", {
    repositoryId,
    headSha,
    ...hints,
  });
  if (response.status !== 200) {
    throw new Error(`BUNDLE_UNAVAILABLE: ${response.status} ${response.text}`);
  }
  const resolution = parseBundleResolutionBody(response.body);
  if (resolution.kind === "bootstrap_pending") return resolution;
  const key = await importJWK(servicePublicJwk as JWK, "ES256");
  const { payload, protectedHeader } = await compactVerify(resolution.bundle, key);
  if (protectedHeader.typ !== "thwip-bundle+jws") throw new Error("BUNDLE_SIGNATURE_INVALID: bad typ");
  return {
    kind: "active",
    bundle: JSON.parse(new TextDecoder().decode(payload)) as VerificationBundleV1,
  };
}

async function mergeBase(client: ActionClient, repoFullName: string, base: string, head: string): Promise<string> {
  const cmp = await client.github<{ merge_base_commit: { sha: string } }>(
    `/repos/${repoFullName}/compare/${encodeURIComponent(base)}...${head}`,
  );
  return cmp.merge_base_commit.sha;
}

async function requireBootstrapPrerequisites(
  client: ActionClient,
  fullName: string,
  ownerId: string,
  repositoryId: string,
  commit: CommitData,
): Promise<void> {
  const carrier = extractCarrier(commit.message);
  if (!carrier.ok) {
    throw new Error(`BOOTSTRAP_PREREQUISITE_FAILED: ${commit.sha} has no parseable proof (${carrier.error.code})`);
  }
  let parsed: ReturnType<typeof parseStatement>;
  try {
    parsed = parseStatement(JSON.parse(utf8Decode(b64stdDecode(carrier.envelope.payload))));
  } catch {
    throw new Error(`BOOTSTRAP_PREREQUISITE_FAILED: ${commit.sha} has a malformed proof payload`);
  }
  if (!parsed.ok) {
    throw new Error(`BOOTSTRAP_PREREQUISITE_FAILED: ${commit.sha} proof payload ${parsed.detail}`);
  }
  const predicate = parsed.value.predicate;
  const objectFormat = commit.sha.length === 64 ? "sha256" : "sha1";
  if (
    predicate.repository.ownerId !== ownerId ||
    predicate.repository.repositoryId !== repositoryId ||
    predicate.git.treeOid !== commit.tree.sha ||
    predicate.git.parentOids.length !== commit.parents.length ||
    predicate.git.parentOids.some((parent, index) => parent !== commit.parents[index]?.sha) ||
    parsed.value.subject[0]?.digest[objectFormat] !== commit.tree.sha
  ) {
    throw new Error(`BOOTSTRAP_PREREQUISITE_FAILED: ${commit.sha} proof is not bound to this repository tree`);
  }
  try {
    await client.github<unknown>(`/repos/${fullName}/contents/thwip.yaml?ref=${encodeURIComponent(commit.sha)}`);
  } catch {
    throw new Error(`BOOTSTRAP_PREREQUISITE_FAILED: ${commit.sha} has no committed thwip.yaml`);
  }
}

async function verifyPullRequest(context: PullRequestContext, client: ActionClient): Promise<number> {
  const commit = await client.github<CommitData>(`/repos/${context.repository}/git/commits/${context.headSha}`);
  const resolution = await fetchBundle(client, context.repositoryId, context.headSha, proofHints(commit.message));
  if (resolution.kind === "bootstrap_pending") {
    await requireBootstrapPrerequisites(
      client,
      context.repository,
      context.repositoryOwnerId,
      context.repositoryId,
      commit,
    );
    summary("## 🟡 `BOOTSTRAP_PENDING` — waiting for the first canonical policy");
    summary("");
    summary(
      `${resolution.repository} is enabled, but has no active policy yet. This successful bootstrap result lets the onboarding change merge while the first canonical policy is derived.`,
    );
    summary("");
    summary(
      `A candidate \`thwip.yaml\` and structured proof bound to the exact repository tree are present on the head. This result does **not** approve that candidate policy or verify its signature. After merge, thwip derives and activates the exact policy from \`${resolution.defaultBranch}\`; later changes are verified under the policy that was already active.`,
    );
    await recordObservation(client, context.repositoryId, resolution.projectId, commit.sha, "BOOTSTRAP_PENDING", context.runId);
    return 0;
  }
  const bundle = resolution.bundle;

  const baseSha = await mergeBase(client, context.repository, context.baseRefName, context.headSha);
  const facts: GithubFacts = {
    ownerId: context.repositoryOwnerId,
    repositoryId: context.repositoryId,
    headSha: commit.sha,
    treeOid: commit.tree.sha,
    parentOids: commit.parents.map((p) => p.sha),
    baseRef: `refs/heads/${context.baseRefName}`,
    baseSha,
    objectFormat: commit.sha.length === 64 ? "sha256" : "sha1",
    prAuthorGithubUserId: context.authorGithubUserId,
  };
  const result = await verifyProof(
    { commitMessage: commit.message, facts, bundle, now: new Date().toISOString() },
    {
      verifySshSignature,
      // Remote suites are proven by GitHub's own checks on this commit.
      remoteCheckConclusions: async (headSha) => {
        const runs = await client.github<{ check_runs: Array<{ name: string; conclusion: string | null }> }>(
          `/repos/${context.repository}/commits/${headSha}/check-runs?per_page=100`,
        );
        const map = new Map<string, string>();
        for (const r of runs.check_runs) map.set(r.name, r.conclusion ?? "pending");
        return map;
      },
    },
  );
  renderRichSummary(result, commit, facts);

  if (result.code === "VERIFICATION_PENDING") {
    console.log(
      `[thwip] ${commit.sha.slice(0, 12)}: waiting for evidence. ${result.detail ?? ""} ` +
        `Nothing failed. Re-run this job once the checks it names have finished.`,
    );
  }

  if (result.code === "PASS" && result.statement) {
    await publishSuiteChecks(client, context.repository, commit.sha, result.statement).catch(() => {
      /* display only; never affects the conclusion */
    });
  }

  if (result.code !== "VERIFICATION_PENDING") {
    await recordObservation(client, context.repositoryId, bundle.projectId, commit.sha, result.code, context.runId);
  }
  return result.code === "PASS" ? 0 : 1;
}

async function recordObservation(
  client: ActionClient,
  repositoryId: string,
  projectId: string,
  headSha: string,
  outcome: string,
  runId: string | null,
): Promise<void> {
  try {
    await client.controlPlane("/v1/verification-observations", {
      repositoryId,
      projectId,
      headSha,
      outcome,
      runId,
    });
  } catch {
    /* telemetry only */
  }
}

const CHECK_SEQUENCE: Array<[label: string, codes: string[]]> = [
  ["Proof present on the exact head commit", ["PROOF_MISSING", "PROOF_DUPLICATE", "PROOF_TOO_LARGE", "PROOF_MALFORMED", "PROOF_SCHEMA_UNSUPPORTED"]],
  ["Signature by an enrolled, unrevoked key", ["SIGNATURE_INVALID", "SIGNER_KEY_UNKNOWN", "SIGNER_KEY_REVOKED", "SIGNER_KEY_ALGORITHM_FORBIDDEN"]],
  ["Repository identity matches GitHub", ["SUBJECT_REPOSITORY_MISMATCH"]],
  ["Exact Git tree matches", ["SUBJECT_TREE_MISMATCH"]],
  ["Ancestry (parents) matches", ["SUBJECT_ANCESTRY_MISMATCH"]],
  ["Base context matches", ["SUBJECT_BASE_MISMATCH"]],
  ["Pipeline digest is policy-approved", ["PIPELINE_DIGEST_MISMATCH"]],
  ["Signer holds current repository permission", ["SIGNER_MISMATCH", "SIGNER_PERMISSION_INSUFFICIENT"]],
  ["Every required suite passed exactly once", ["SUITE_MISSING", "SUITE_DUPLICATE", "SUITE_NOT_PASSED"]],
  ["Proof age and lease within policy", ["PROOF_EXPIRED", "LEASE_REQUIRED", "LEASE_INVALID", "LEASE_EXPIRED", "LEASE_CONTEXT_MISMATCH"]],
];

function renderRichSummary(
  result: Awaited<ReturnType<typeof verifyProof>>,
  commit: CommitData,
  facts: GithubFacts,
): void {
  const pass = result.code === "PASS";
  const title = commit.message.split("\n")[0] ?? commit.sha;
  summary(`## ${pass ? "✅" : "❌"} \`${result.code}\` — ${title}`);
  summary("");
  summary(
    `commit \`${commit.sha.slice(0, 12)}\` · tree \`${facts.treeOid.slice(0, 12)}\` · base \`${facts.baseSha.slice(0, 12)}\`` +
      (result.signerKey ? ` · signer \`${result.signerKey.keyId}\` (${result.signerKey.algorithm})` : ""),
  );
  summary("");

  const failedIndex = pass ? -1 : CHECK_SEQUENCE.findIndex(([, codes]) => codes.includes(result.code));
  summary("| Verified | Outcome |");
  summary("| --- | --- |");
  CHECK_SEQUENCE.forEach(([label], i) => {
    if (pass || (failedIndex >= 0 && i < failedIndex)) summary(`| ${label} | ✅ |`);
    else if (i === failedIndex) summary(`| ${label} | ❌ \`${result.code}\`${result.detail ? ` (${result.detail})` : ""} |`);
    else if (failedIndex >= 0) summary(`| ${label} | ⏭ not reached |`);
    else summary(`| ${label} | ❌ \`${result.code}\` |`); // unmapped code: bundle/infrastructure failures
  });
  summary("");

  if (result.statement) {
    const run = result.statement.predicate.run;
    summary("### CI sequence proven");
    summary("");
    summary("| Suite | Result | Duration |");
    summary("| --- | --- | --- |");
    for (const s of run.suites) {
      const secs = (s.durationMs / 1000).toFixed(1);
      summary(`| \`${s.id}\` | ${s.status === "passed" ? "✅ passed" : `❌ ${s.status}`} | ${secs}s |`);
    }
    summary("");
    summary("```mermaid");
    summary("gantt");
    summary("  title local run · " + run.startedAt.slice(0, 19).replace("T", " ") + "Z");
    summary("  dateFormat  X");
    summary("  axisFormat  %Ss");
    summary("  section suites");
    let offset = 0;
    for (const s of run.suites) {
      const dur = Math.max(1, Math.round(s.durationMs / 1000));
      summary(`  ${s.id} (${(s.durationMs / 1000).toFixed(1)}s) :${s.status === "passed" ? "done" : "crit"}, ${offset}, ${offset + dur}`);
      offset += dur;
    }
    summary("```");
    summary("");
    summary(
      `_Suites ran on the signer's machine against the frozen tree; results are the signer's assertion, bound to this exact commit and the active policy, and verified here without rerunning them._`,
    );
  }
}

async function publishSuiteChecks(
  client: ActionClient,
  fullName: string,
  headSha: string,
  statement: NonNullable<Awaited<ReturnType<typeof verifyProof>>["statement"]>,
): Promise<void> {
  const run = statement.predicate.run;
  let startMs = Date.parse(run.startedAt);
  for (const s of run.suites) {
    const started = new Date(startMs);
    const completed = new Date(startMs + s.durationMs);
    startMs += s.durationMs;
    await client.github(`/repos/${fullName}/check-runs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: `thwip / ${s.id}`,
        head_sha: headSha,
        status: "completed",
        conclusion: s.status === "passed" ? "success" : "failure",
        started_at: started.toISOString(),
        completed_at: completed.toISOString(),
        output: {
          title: `${s.id}: ${s.status} in ${(s.durationMs / 1000).toFixed(1)}s on the signer's machine`,
          summary:
            `Proven by the thwip proof on \`${headSha.slice(0, 12)}\`: suite \`${s.id}\` ${s.status} in ` +
            `${(s.durationMs / 1000).toFixed(1)}s against the frozen tree. Verified cryptographically; not rerun here.`,
        },
      }),
    });
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runAction(): Promise<number> {
  const inputs = readActionInputs();
  const context = readActionContext();
  const client = new ActionClient({
    endpoint: inputs.endpoint,
    githubApiUrl: inputs.githubApiUrl,
    githubToken: inputs.githubToken,
  });
  if (context.kind === "candidate_report") {
    await client.reportCandidate(context);
    console.log("Thwip Queue accepted the candidate report");
    return 0;
  }
  return verifyAndAuthorize(
    () => verifyPullRequest(context, client),
    async () => {
      const reason = await client.authorize({
        repositoryId: context.repositoryId,
        pullRequestNumber: context.pullRequestNumber,
        headSha: context.headSha,
        baseRef: `refs/heads/${context.baseRefName}`,
        authorGithubUserId: context.authorGithubUserId,
        draft: context.draft,
      });
      console.log(`Thwip Queue says: ${reason}`);
    },
    (error) => summary(`thwip: FAIL — ${message(error)}`),
    (error) => console.warn(`thwip: queue enrolment could not complete — ${message(error)}`),
  );
}
