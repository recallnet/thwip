import { appendFileSync, readFileSync } from "node:fs";
import { importJWK, compactVerify, type JWK } from "jose";
import { verifySshSignature } from "@thwip/sshsig";
import { verifyProof, type GithubFacts } from "@thwip/verifier";
import type { VerificationBundleV1 } from "@thwip/protocol";
import servicePublicJwk from "../service-public.jwk.json" with { type: "json" };

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

async function fetchBundle(repositoryId: string, headSha: string, keyIds: string[]): Promise<VerificationBundleV1> {
  const oidc = await getOidcToken(`${ENDPOINT}/api/github-actions`);
  const res = await fetch(`${ENDPOINT}/v1/verification-bundles:resolve`, {
    method: "POST",
    headers: { authorization: `Bearer ${oidc}`, "content-type": "application/json" },
    body: JSON.stringify({ repositoryId, headSha, keyIds }),
  });
  if (!res.ok) throw new Error(`BUNDLE_UNAVAILABLE: ${res.status} ${await res.text()}`);
  const { bundle } = (await res.json()) as { bundle: string };
  const key = await importJWK(servicePublicJwk as JWK, "ES256");
  const { payload, protectedHeader } = await compactVerify(bundle, key);
  if (protectedHeader.typ !== "thwip-bundle+jws") throw new Error("BUNDLE_SIGNATURE_INVALID: bad typ");
  return JSON.parse(new TextDecoder().decode(payload)) as VerificationBundleV1;
}

async function mergeBase(repoFullName: string, base: string, head: string): Promise<string> {
  const cmp = await gh<{ merge_base_commit: { sha: string } }>(
    `/repos/${repoFullName}/compare/${encodeURIComponent(base)}...${head}`,
  );
  return cmp.merge_base_commit.sha;
}

interface Target {
  prHeadSha: string;
  prAuthorId?: string;
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
    // Walk the first-parent chain from the group head down to the group base;
    // each hop's second parent is one PR's head commit.
    let cursor = mg["head_sha"] as string;
    const baseSha = mg["base_sha"] as string;
    let hops = 0;
    while (cursor !== baseSha && hops < 50) {
      const c = await gh<CommitData>(`/repos/${fullName}/git/commits/${cursor}`);
      if (c.parents.length >= 2) targets.push({ prHeadSha: c.parents[1]!.sha });
      if (c.parents.length === 0) break;
      cursor = c.parents[0]!.sha;
      hops++;
    }
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
  const bundle = await fetchBundle(repositoryId, targets[0]!.prHeadSha, []);

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
      { verifySshSignature },
    );
    const icon = result.code === "PASS" ? "✅" : "❌";
    summary(
      `${icon} thwip \`${result.code}\`${result.detail ? ` (${result.detail})` : ""} — commit \`${commit.sha.slice(0, 12)}\` tree \`${commit.tree.sha.slice(0, 12)}\``,
    );
    if (result.code === "PASS" && result.statement) {
      const suites = result.statement.predicate.run.suites.map((s) => `${s.id}:${s.status}`).join(", ");
      summary(`&nbsp;&nbsp;signer key \`${result.signerKey?.keyId}\` (user ${result.signerKey?.githubUserId}); suites asserted by signer: ${suites}`);
    }
    if (result.code !== "PASS") allPass = false;

    // Best-effort observation; never affects the conclusion.
    try {
      const oidc = await getOidcToken(`${ENDPOINT}/api/github-actions`);
      await fetch(`${ENDPOINT}/v1/verification-observations`, {
        method: "POST",
        headers: { authorization: `Bearer ${oidc}`, "content-type": "application/json" },
        body: JSON.stringify({
          repositoryId,
          headSha: commit.sha,
          outcome: result.code,
          runId: process.env["GITHUB_RUN_ID"] ?? null,
        }),
      });
    } catch {
      /* telemetry only */
    }
  }

  process.exit(allPass ? 0 : 1);
}

main().catch((e: unknown) => {
  summary(`thwip: FAIL — ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
