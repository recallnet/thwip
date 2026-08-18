import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { CompactSign, exportJWK, generateKeyPair, type JWK } from "jose";
import { signSsh } from "@thwip/sshsig";
import {
  DSSE_PAYLOAD_TYPE,
  PREDICATE_TYPE,
  STATEMENT_TYPE,
  b64stdEncode,
  dssePae,
  encodeCarrier,
  utf8Encode,
  type DsseEnvelope,
  type InTotoStatementV1,
  type VerificationBundleV1,
} from "@thwip/protocol";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { runAction } from "./main.js";

const originalEnv = { ...process.env };
const execFileP = promisify(execFile);
const HEAD = "d".repeat(40);
const TREE = "a".repeat(40);
const PARENT = "b".repeat(40);
const BASE = "c".repeat(40);
const POLICY_DIGEST = `sha256:${"1".repeat(64)}` as const;
const PIPELINE_DIGEST = `sha256:${"2".repeat(64)}` as const;

function eventFile(event: unknown): string {
  const path = join(mkdtempSync(join(tmpdir(), "thwip-action-smoke-")), "event.json");
  writeFileSync(path, JSON.stringify(event));
  return path;
}

function json(status: number, body: unknown): Response {
  return Response.json(body, { status });
}

let keyDirectory: string;
let privateKeyPath: string;
let publicKey: string;

beforeAll(async () => {
  keyDirectory = await mkdtemp(join(tmpdir(), "thwip-action-key-"));
  privateKeyPath = join(keyDirectory, "proof-key");
  await execFileP("ssh-keygen", ["-t", "ed25519", "-N", "", "-C", "action-test", "-f", privateKeyPath]);
  publicKey = (await readFile(`${privateKeyPath}.pub`, "utf8")).trim();
});

afterAll(async () => {
  await rm(keyDirectory, { recursive: true, force: true });
});

async function proof(now: Date): Promise<{ commitMessage: string; bundle: VerificationBundleV1 }> {
  const statement: InTotoStatementV1 = {
    _type: STATEMENT_TYPE,
    subject: [{ name: "git-tree", digest: { sha1: TREE } }],
    predicateType: PREDICATE_TYPE,
    predicate: {
      schemaVersion: "1",
      repository: { provider: "github", ownerId: "34", repositoryId: "12" },
      git: {
        objectFormat: "sha1",
        treeOid: TREE,
        parentOids: [PARENT],
        baseRef: "refs/heads/main",
        baseSha: BASE,
        evaluationMode: "head-tree",
      },
      policy: { digest: POLICY_DIGEST, version: 1 },
      pipeline: { digest: PIPELINE_DIGEST, runner: "command" },
      run: {
        startedAt: new Date(now.getTime() - 120_000).toISOString(),
        finishedAt: new Date(now.getTime() - 60_000).toISOString(),
        networkMode: "unrestricted",
        cacheMode: "read-write",
        suites: [{ id: "test", status: "passed", durationMs: 1_000 }],
      },
      signer: { keyId: "device-key", githubUserId: "78" },
    },
  };
  const payload = utf8Encode(JSON.stringify(statement));
  const envelope: DsseEnvelope = {
    payloadType: DSSE_PAYLOAD_TYPE,
    payload: b64stdEncode(payload),
    signatures: [
      {
        keyid: "device-key",
        sig: await signSsh({
          privateKeyPath,
          namespace: "thwip-ci-dsse-v1",
          message: dssePae(DSSE_PAYLOAD_TYPE, payload),
        }),
      },
    ],
  };
  return {
    commitMessage: `test: prove the Action\n\n${encodeCarrier(envelope)}\n`,
    bundle: {
      schemaVersion: "1",
      projectId: "project-1",
      repositoryId: "12",
      ownerId: "34",
      activePolicyDigest: POLICY_DIGEST,
      policy: {
        schemaVersion: "1",
        projectId: "project-1",
        repositoryId: "12",
        ownerId: "34",
        version: 1,
        securityProfile: "fast",
        minimumPermission: "write",
        allowAuthorAsSigner: true,
        allowedKeyAlgorithms: ["ssh-ed25519"],
        lease: { required: false, maxAgeSeconds: 1_800 },
        pipeline: { digest: PIPELINE_DIGEST, runner: "command", requiredSuites: ["test"] },
        proofMaxAgeSeconds: 86_400,
      },
      keys: [
        {
          keyId: "device-key",
          githubUserId: "78",
          algorithm: "ssh-ed25519",
          publicKey,
          revokedAt: null,
        },
      ],
      grants: [{ githubUserId: "78", permission: "admin", active: true }],
      leaseIssuerJwks: [],
      issuedAt: new Date(now.getTime() - 30_000).toISOString(),
      expiresAt: new Date(now.getTime() + 300_000).toISOString(),
    },
  };
}

async function signedBundle(bundle: VerificationBundleV1, kid: string): Promise<{ jws: string; key: JWK }> {
  const pair = await generateKeyPair("ES256", { extractable: true });
  const key = { ...(await exportJWK(pair.publicKey)), kid, alg: "ES256", use: "sig" };
  const jws = await new CompactSign(new TextEncoder().encode(JSON.stringify(bundle)))
    .setProtectedHeader({ alg: "ES256", kid, typ: "thwip-bundle+jws" })
    .sign(pair.privateKey);
  return { jws, key };
}

function pullRequestEnvironment(endpoint?: string): { summaryPath: string } {
  const eventPath = eventFile({
    repository: { id: 12, full_name: "example/project", owner: { id: 34 } },
    pull_request: {
      number: 56,
      draft: false,
      base: { ref: "main" },
      head: { sha: HEAD },
      user: { id: 78 },
    },
  });
  const summaryPath = join(mkdtempSync(join(tmpdir(), "thwip-summary-")), "summary.md");
  process.env = {
    ...originalEnv,
    GITHUB_EVENT_NAME: "pull_request",
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_RUN_ID: "90",
    GITHUB_API_URL: "https://api.github.test",
    GITHUB_STEP_SUMMARY: summaryPath,
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.example/token",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
    "INPUT_GITHUB-TOKEN": "github-token",
    ...(endpoint !== undefined ? { INPUT_ENDPOINT: endpoint } : {}),
  };
  return { summaryPath };
}

function pullRequestFetch(input: {
  endpoint: string;
  bundle: string;
  keys: readonly JWK[];
  commitMessage: string;
  authorizeStatus?: number;
}): { fetch: typeof globalThis.fetch; paths: string[] } {
  const paths: string[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (request, init) => {
    const url = String(request);
    paths.push(url);
    if (url.startsWith("https://oidc.example/token")) return json(200, { value: "oidc" });
    if (url === `${input.endpoint}/.well-known/thwip-keys`) return json(200, { keys: input.keys });
    if (url.endsWith(`/repos/example/project/git/commits/${HEAD}`)) {
      return json(200, {
        sha: HEAD,
        tree: { sha: TREE },
        parents: [{ sha: PARENT }],
        message: input.commitMessage,
      });
    }
    if (url.includes("/repos/example/project/compare/")) return json(200, { merge_base_commit: { sha: BASE } });
    if (url.endsWith("/repos/example/project/check-runs") && init?.method === "POST") return json(201, {});
    if (url.endsWith("/v1/verification-bundles:resolve")) {
      return json(200, { state: "active", bundle: input.bundle });
    }
    if (url.endsWith("/v1/verification-observations")) return json(200, {});
    if (url.endsWith("/v1/queue/12/authorize")) {
      return json(input.authorizeStatus ?? 200, { reason: "AUTHORIZED" });
    }
    throw new Error(`unexpected request: ${url}`);
  });
  return { fetch, paths };
}

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("the pull-request entry point", () => {
  it.each([
    ["the hosted service", "https://thwip.ai"],
    ["a self-hosted service", "https://self-hosted.example"],
  ])("completes proof verification and queue enrolment against %s", async (label, endpoint) => {
    pullRequestEnvironment(endpoint === "https://thwip.ai" ? undefined : endpoint);
    const evidence = await proof(new Date());
    const active = await signedBundle(evidence.bundle, `${label}-active`);
    const retired = await signedBundle(evidence.bundle, `${label}-retired`);
    const requests = pullRequestFetch({
      endpoint,
      bundle: active.jws,
      keys: [retired.key, active.key],
      commitMessage: evidence.commitMessage,
    });

    vi.stubGlobal("fetch", requests.fetch);
    await expect(runAction()).resolves.toBe(0);
    expect(requests.paths).toContain(`${endpoint}/.well-known/thwip-keys`);
    expect(requests.paths.some((path) => path.endsWith("/v1/verification-observations"))).toBe(true);
    expect(requests.paths.at(-1)).toBe(`${endpoint}/v1/queue/12/authorize`);
  });

  it("shows a visible retry warning when queue enrolment is unavailable", async () => {
    const { summaryPath } = pullRequestEnvironment();
    const evidence = await proof(new Date());
    const active = await signedBundle(evidence.bundle, "hosted-active");
    const requests = pullRequestFetch({
      endpoint: "https://thwip.ai",
      bundle: active.jws,
      keys: [active.key],
      commitMessage: evidence.commitMessage,
      authorizeStatus: 403,
    });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    vi.stubGlobal("fetch", requests.fetch);
    await expect(runAction()).resolves.toBe(0);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("::warning::Queue enrolment did not complete"));
    expect(readFileSync(summaryPath, "utf8")).toContain("Re-run this job to try enrolment again");
  });
});

describe("the trusted candidate-report entry point", () => {
  it("validates the event, obtains OIDC and sends only the nonce", async () => {
    const eventPath = eventFile({
      action: "thwip-queue-verify",
      repository: { id: 12 },
      client_payload: {
        dispatchNonce: "nonce",
        workflowCommitSha: "workflow-sha",
        candidateSha: "must-not-cross-the-boundary",
      },
    });
    process.env = {
      ...originalEnv,
      GITHUB_EVENT_NAME: "repository_dispatch",
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_WORKFLOW_SHA: "workflow-sha",
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.example/token",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
      INPUT_ENDPOINT: "https://thwip.example",
    };
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json(200, { value: "oidc" }))
      .mockResolvedValueOnce(json(202, {}));

    vi.stubGlobal("fetch", fetch);
    await expect(runAction()).resolves.toBe(0);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1]?.[1]?.body).toBe(JSON.stringify({ dispatchNonce: "nonce" }));
  });
});
