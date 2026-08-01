import { appendFileSync, readFileSync } from "node:fs";
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
import { collectMergeGroupTargets, type MergeGroupTarget } from "./merge-group-targets.js";

interface CommitData {
  sha: string;
  tree: { sha: string };
  parents: Array<{ sha: string }>;
  message: string;
}

const API = process.env["GITHUB_API_URL"] ?? "https://api.github.com";
const TOKEN = process.env["GITHUB_TOKEN"] ?? "";
const ENDPOINT = process.env["THWIP_ENDPOINT"] ?? "https://thwip.recall.net";

function summary(line: string): void {
  const f = process.env["GITHUB_STEP_SUMMARY"];
  if (f) appendFileSync(f, line + "\n");
  console.log(line);
}

async function gh<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    headers: {
      authorization: `Bearer ${TOKEN}`,
      accept: "application/vnd.github+json",
      "user-agent": "thwip-action",
    },
  });
  if (!res.ok) throw new Error(`GitHub API ${path} -> ${res.status}`);
  return res.json() as Promise<T>;
}

async function getOidcToken(audience: string): Promise<string> {
  const url = process.env["ACTIONS_ID_TOKEN_REQUEST_URL"];
  const reqToken = process.env["ACTIONS_ID_TOKEN_REQUEST_TOKEN"];
  if (!url || !reqToken) throw new Error("OIDC not available; set permissions id-token: write");
  const res = await fetch(`${url}&audience=${encodeURIComponent(audience)}`, {
    headers: { authorization: `Bearer ${reqToken}`, accept: "application/json" },
  });
  if (!res.ok) throw new Error(`OIDC token request failed: ${res.status}`);
  const body = (await res.json()) as { value: string };
  return body.value;
}

/**
 * Read the signer selectors out of the trailer without trusting them. They
 * only decide which facts the control plane returns; the verifier re-checks
 * every one of them against the signed payload afterwards.
 */
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

/**
 * Selector hints come from the unverified proof; they only choose which facts
 * to fetch. Everything is re-checked against the signed payload afterwards.
 */
async function fetchBundle(
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
      defaultBranch: string;
    }
> {
  const oidc = await getOidcToken(`${ENDPOINT}/api/github-actions`);
  const res = await fetch(`${ENDPOINT}/v1/verification-bundles:resolve`, {
    method: "POST",
    headers: { authorization: `Bearer ${oidc}`, "content-type": "application/json" },
    body: JSON.stringify({ repositoryId, headSha, ...hints }),
  });
  if (!res.ok) throw new Error(`BUNDLE_UNAVAILABLE: ${res.status} ${await res.text()}`);
  const resolution = parseBundleResolutionBody(await res.json());
  if (resolution.kind === "bootstrap_pending") return resolution;
  const key = await importJWK(servicePublicJwk as JWK, "ES256");
  const { payload, protectedHeader } = await compactVerify(resolution.bundle, key);
  if (protectedHeader.typ !== "thwip-bundle+jws") throw new Error("BUNDLE_SIGNATURE_INVALID: bad typ");
  return {
    kind: "active",
    bundle: JSON.parse(new TextDecoder().decode(payload)) as VerificationBundleV1,
  };
}

async function mergeBase(repoFullName: string, base: string, head: string): Promise<string> {
  const cmp = await gh<{ merge_base_commit: { sha: string } }>(
    `/repos/${repoFullName}/compare/${encodeURIComponent(base)}...${head}`,
  );
  return cmp.merge_base_commit.sha;
}

type Target = MergeGroupTarget;

async function requireBootstrapPrerequisites(
  fullName: string,
  ownerId: string,
  repositoryId: string,
  targets: Target[],
  firstCommit: CommitData,
): Promise<void> {
  for (const target of targets) {
    const commit =
      target.prHeadSha === firstCommit.sha
        ? firstCommit
        : await gh<CommitData>(`/repos/${fullName}/git/commits/${target.prHeadSha}`);
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
      await gh<unknown>(`/repos/${fullName}/contents/thwip.yaml?ref=${encodeURIComponent(commit.sha)}`);
    } catch {
      throw new Error(`BOOTSTRAP_PREREQUISITE_FAILED: ${commit.sha} has no committed thwip.yaml`);
    }
  }
}

async function main(): Promise<void> {
  const eventName = process.env["GITHUB_EVENT_NAME"] ?? "";
  const event = JSON.parse(readFileSync(process.env["GITHUB_EVENT_PATH"]!, "utf8")) as Record<string, any>;
  const repo = event["repository"];
  const repositoryId = String(repo["id"]);
  const ownerId = String(repo["owner"]["id"]);
  const fullName = repo["full_name"] as string;

  const targets: Target[] = [];
  let baseRefName: string;

  if (eventName === "pull_request" || eventName === "pull_request_target") {
    const pr = event["pull_request"];
    baseRefName = pr["base"]["ref"];
    targets.push({ prHeadSha: pr["head"]["sha"], prAuthorId: String(pr["user"]["id"]) });
  } else if (eventName === "merge_group") {
    const mg = event["merge_group"];
    baseRefName = (mg["base_ref"] as string).replace(/^refs\/heads\//, "");
    targets.push(
      ...(await collectMergeGroupTargets(
        { headSha: mg["head_sha"] as string, baseSha: mg["base_sha"] as string },
        {
          commit: (sha) => gh<CommitData>(`/repos/${fullName}/git/commits/${sha}`),
          pullsForCommit: (sha) =>
            gh<Array<{ head: { sha: string }; user: { id: number } }>>(
              `/repos/${fullName}/commits/${sha}/pulls?per_page=100`,
            ),
        },
      )),
    );
    if (targets.length === 0) {
      summary("thwip: FAIL — merge group contains no mergeable PR entries");
      process.exit(1);
    }
  } else {
    summary(`thwip: FAIL — unsupported event ${eventName}`);
    process.exit(1);
  }

  // One bundle request per verification run.
  const firstCommit = await gh<CommitData>(`/repos/${fullName}/git/commits/${targets[0]!.prHeadSha}`);
  const resolution = await fetchBundle(repositoryId, targets[0]!.prHeadSha, proofHints(firstCommit.message));
  if (resolution.kind === "bootstrap_pending") {
    await requireBootstrapPrerequisites(fullName, ownerId, repositoryId, targets, firstCommit);
    summary("## 🟡 `BOOTSTRAP_PENDING` — waiting for the first canonical policy");
    summary("");
    summary(
      `${resolution.repository} is enabled, but has no active policy yet. This successful bootstrap result keeps onboarding eligible for the native merge queue.`,
    );
    summary("");
    summary(
      `A candidate \`thwip.yaml\` and structured proof bound to the exact repository tree are present on the head. This result does **not** approve that candidate policy or verify its signature. After merge, thwip derives and activates the exact policy from \`${resolution.defaultBranch}\`; later changes are verified under the policy that was already active.`,
    );
    await recordObservation(repositoryId, firstCommit.sha, "BOOTSTRAP_PENDING");
    process.exit(0);
  }
  const bundle = resolution.bundle;

  let allPass = true;
  for (const target of targets) {
    const commit =
      target.prHeadSha === firstCommit.sha
        ? firstCommit
        : await gh<CommitData>(`/repos/${fullName}/git/commits/${target.prHeadSha}`);
    const baseSha = await mergeBase(fullName, baseRefName, target.prHeadSha);
    const facts: GithubFacts = {
      ownerId,
      repositoryId,
      headSha: commit.sha,
      treeOid: commit.tree.sha,
      parentOids: commit.parents.map((p) => p.sha),
      baseRef: `refs/heads/${baseRefName}`,
      baseSha,
      objectFormat: commit.sha.length === 64 ? "sha256" : "sha1",
      ...(target.prAuthorId !== undefined ? { prAuthorGithubUserId: target.prAuthorId } : {}),
    };
    const result = await verifyProof(
      { commitMessage: commit.message, facts, bundle, now: new Date().toISOString() },
      {
        verifySshSignature,
        // Remote suites are proven by GitHub's own checks on this commit.
        remoteCheckConclusions: async (headSha) => {
          const runs = await gh<{ check_runs: Array<{ name: string; conclusion: string | null }> }>(
            `/repos/${fullName}/commits/${headSha}/check-runs?per_page=100`,
          );
          const map = new Map<string, string>();
          for (const r of runs.check_runs) map.set(r.name, r.conclusion ?? "pending");
          return map;
        },
      },
    );
    renderRichSummary(result, commit, facts);

    // This job publishes the `thwip` status check that the ruleset requires, so
    // anything but a pass has to keep the gate closed. That includes
    // VERIFICATION_PENDING: the evidence has not settled after the verifier's
    // own retries, and a green check here would let the merge through on
    // evidence nobody has read.
    //
    // The control plane publishes a separate in-progress check that explains
    // the wait. Say the same thing here, so the red is not read as "your tests
    // failed".
    if (result.code === "VERIFICATION_PENDING") {
      console.log(
        `[thwip] ${commit.sha.slice(0, 12)}: waiting for evidence. ${result.detail ?? ""} ` +
          `Nothing failed. Re-run this job once the checks it names have finished.`,
      );
    }
    if (result.code !== "PASS") allPass = false;

    // Per-suite check runs on the PR head, so the checks list reads like a
    // CI matrix: each proven suite appears with its measured local duration.
    if (result.code === "PASS" && result.statement) {
      await publishSuiteChecks(fullName, commit.sha, result.statement).catch(() => {
        /* display only; never affects the conclusion */
      });
    }

    // Best-effort observation; never affects the conclusion.
    //
    // Pending is not a verdict, so it is not recorded as one. The dashboard
    // reads the newest observation as the project's last verification, and
    // "we have not decided yet" is not something to show there.
    if (result.code !== "VERIFICATION_PENDING") {
      await recordObservation(repositoryId, commit.sha, result.code);
    }
  }

  process.exit(allPass ? 0 : 1);
}

async function recordObservation(repositoryId: string, headSha: string, outcome: string): Promise<void> {
  try {
    const oidc = await getOidcToken(`${ENDPOINT}/api/github-actions`);
    await fetch(`${ENDPOINT}/v1/verification-observations`, {
      method: "POST",
      headers: { authorization: `Bearer ${oidc}`, "content-type": "application/json" },
      body: JSON.stringify({
        repositoryId,
        headSha,
        outcome,
        runId: process.env["GITHUB_RUN_ID"] ?? null,
      }),
    });
  } catch {
    /* telemetry only */
  }
}

/**
 * The verifier runs its controls in a fixed order; the verdict code names the
 * first control that failed. This table maps each display row to the codes it
 * owns, so the summary can show what was established, what failed, and what
 * was never reached — in the same stable vocabulary as the product.
 */
const CHECK_SEQUENCE: Array<[label: string, codes: string[]]> = [
  ["Proof present on the exact head commit", ["PROOF_MISSING", "PROOF_DUPLICATE", "PROOF_TOO_LARGE", "PROOF_MALFORMED", "PROOF_SCHEMA_UNSUPPORTED"]],
  ["Signature by an enrolled, unrevoked key", ["SIGNATURE_INVALID", "SIGNER_KEY_UNKNOWN", "SIGNER_KEY_REVOKED", "SIGNER_KEY_ALGORITHM_FORBIDDEN"]],
  ["Repository identity matches GitHub", ["SUBJECT_REPOSITORY_MISMATCH"]],
  ["Exact Git tree matches", ["SUBJECT_TREE_MISMATCH"]],
  ["Ancestry (parents) matches", ["SUBJECT_ANCESTRY_MISMATCH"]],
  ["Base context matches", ["SUBJECT_BASE_MISMATCH"]],
  ["Policy digest is the active policy", ["POLICY_NOT_ACTIVE"]],
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

  // Verification sequence in the product's stable outcome vocabulary.
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

  // The CI sequence the proof covers, with the signer's measured durations.
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

/** One completed check run per proven suite, timed from the signer's run. */
async function publishSuiteChecks(fullName: string, headSha: string, statement: NonNullable<Awaited<ReturnType<typeof verifyProof>>["statement"]>): Promise<void> {
  const run = statement.predicate.run;
  let startMs = Date.parse(run.startedAt);
  for (const s of run.suites) {
    const started = new Date(startMs);
    const completed = new Date(startMs + s.durationMs);
    startMs += s.durationMs;
    await fetch(`${API}/repos/${fullName}/check-runs`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        accept: "application/vnd.github+json",
        "user-agent": "thwip-action",
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

main().catch((e: unknown) => {
  summary(`thwip: FAIL — ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
