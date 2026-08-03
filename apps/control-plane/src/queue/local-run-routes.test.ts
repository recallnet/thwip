import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { signSsh } from "@thwip/sshsig";
import { testD1 } from "../../test/d1.js";
import { queueRoutes, type QueueRouteEnv } from "./routes.js";
import {
  integrationReceiptBytes,
  INTEGRATION_RECEIPT_NAMESPACE,
  type SubmittedReceipt,
} from "./integration-receipt.js";
import { sha256Fingerprint } from "../sshsig-verify.js";
import {
  canonicalRecordBytes,
  parseMergeIntent,
  parseTransitionRecord,
  QUEUE_PREDICATE_TYPES,
  QUEUE_SIGN_NAMESPACE,
  queueSigningBytes,
} from "@thwip/queue-protocol";
import { buildSnapshot, commandsFor } from "./queue-operations.js";
import { withQueueState } from "./queue-state.js";
import { tickAllQueues } from "./scheduled-tick.js";
import type { D1Like } from "./projection.js";

/**
 * `fresh`, from the offer to the merge, over the storage and the routes that
 * actually run it.
 *
 * The device claims the turn, is handed a signed assignment naming the exact
 * integrated candidate, signs an account of what it ran with the key it enrolled,
 * and only then is the merge authorized. Every refusal on the way is a refusal
 * the profile is defined by, so each one is asserted against the same routes a
 * real runner calls rather than against the functions underneath them.
 *
 * The receipt signature is a real ed25519 SSHSIG over the real canonical bytes,
 * made by `ssh-keygen` and checked by the production verifier. A test that
 * signed with a stub would pass while the route accepted anything.
 */

const execFileP = promisify(execFile);

const open: Array<{ close(): void }> = [];
let raw: import("better-sqlite3").Database;
let keyDir: string;
let keyPath: string;
let publicKey: string;
let deviceKeyId: string;

beforeAll(async () => {
  keyDir = await mkdtemp(join(tmpdir(), "thwip-local-run-"));
  keyPath = join(keyDir, "id_ed25519");
  await execFileP("ssh-keygen", ["-t", "ed25519", "-f", keyPath, "-N", "", "-C", "thwip-test"]);
  publicKey = (await readFile(`${keyPath}.pub`, "utf8")).trim();
  deviceKeyId = await sha256Fingerprint(publicKey);
});

afterAll(async () => {
  await rm(keyDir, { recursive: true, force: true });
});

afterEach(() => {
  while (open.length > 0) open.pop()!.close();
});

const REPO = "1315419165";
const REF = "refs/heads/main";
const ORG = "org_1";
const PR = 82;
const BASE = "b".repeat(40);
const HEAD = "e".repeat(40);
const CANDIDATE = "c".repeat(40);
const TREE = "7".repeat(40);
const OTHER_TREE = "8".repeat(40);
const MERGE_SHA = "d".repeat(40);
const MOVED_HEAD = "f".repeat(40);

/** A real carrier, so the head's proof digest is a digest of something. */
const CARRIER =
  "v1.eyJwYXlsb2FkVHlwZSI6ImFwcGxpY2F0aW9uL3ZuZC5pbi10b3RvK2pzb24iLCJwYXlsb2FkIjoiZXlKZmRIbHdaU0k2SW1oMGRIQnpPaTh2YVc0dGRHOTBieTVwYnk5VGRHRjBaVzFsYm5RdmRqRWlmUT09Iiwic2lnbmF0dXJlcyI6W3sia2V5aWQiOiJTSEEyNTY6ayIsInNpZyI6IkFBQUEifV19";

function env(): QueueRouteEnv {
  const t = testD1();
  open.push(t);
  raw = t.raw;
  seed();
  return { DB: t.db, PUBLIC_ORIGIN: "https://thwip.test" } as unknown as QueueRouteEnv;
}

function seed(): void {
  raw.prepare("INSERT INTO organizations (id, github_org_id, github_login) VALUES (?, ?, ?)").run(ORG, "1", "acme");
  raw
    .prepare(
      "INSERT INTO projects (id, organization_id, github_repository_id, github_name, enabled) VALUES (?, ?, ?, ?, 1)",
    )
    .run("proj_1", ORG, REPO, "acme/repo");
  raw
    .prepare(
      `INSERT INTO queue_projects (id, organization_id, github_repository_id, base_ref, enabled, activation_state)
       VALUES ('qp_1', ?, ?, ?, 1, 'enforced')`,
    )
    .run(ORG, REPO, REF);
  for (const [id, githubUserId] of [
    ["alice", "1"],
    ["bob", "2"],
  ]) {
    raw
      .prepare(
        "INSERT INTO principals (id, organization_id, github_user_id, github_login, activated_at) VALUES (?, ?, ?, ?, datetime('now'))",
      )
      .run(id, ORG, githubUserId, id);
  }
  raw
    .prepare(
      `INSERT INTO device_keys (key_id, github_user_id, algorithm, public_key, fingerprint, device_label)
       VALUES (?, '1', 'ssh-ed25519', ?, ?, 'laptop')`,
    )
    .run(deviceKeyId, publicKey, deviceKeyId);
  // So `readActivePolicy` — which the heartbeat sweep reads directly rather than
  // through the deps object — sees the same `fresh` this suite is about.
  raw
    .prepare("INSERT INTO policy_bundles (digest, project_id, version, canonical_json, status) VALUES (?, ?, 1, ?, 'active')")
    .run(
      `sha256:${"a".repeat(64)}`,
      "proj_1",
      JSON.stringify({ schemaVersion: "1", securityProfile: "fresh", version: 1, pipeline: { requiredSuites: ["lint"] } }),
    );
  raw.prepare("UPDATE projects SET active_policy_digest = ? WHERE id = 'proj_1'").run(`sha256:${"a".repeat(64)}`);
}

const policy = {
  policyDigest: `sha256:${"a".repeat(64)}`,
  pipelineDigest: `sha256:${"b".repeat(64)}`,
  requiredSuites: ["lint"],
  securityProfile: "fresh",
  organizationId: ORG,
  verifier: null,
  document: { version: 1, securityProfile: "fresh", pipeline: { requiredSuites: ["lint"] } },
  version: 1,
  daggerModuleDigest: null,
  daggerEngineDigest: null,
};

const driven: number[] = [];

function app(over: Partial<Parameters<typeof queueRoutes>[0]> = {}, principalId = "alice", githubUserId = "1") {
  driven.length = 0;
  return queueRoutes({
    authenticate: async () => ({ ok: true, principalId, githubUserId, isAdmin: false }),
    verifyOidc: async () => ({ repository_id: REPO }),
    pinnedVerifier: async () => null,
    activePolicy: async () => policy,
    dispatchCandidateVerification: async () => ({ ok: true }),
    queueProject: async () => ({ activationState: "enforced", mergeMethod: "merge" }),
    principalFor: async () => "alice",
    pullRequestPlacement: async () => ({ authorGithubUserId: "1", baseRef: REF }),
    driveTurn: async (_e, _r, pullRequestNumber) => {
      driven.push(pullRequestNumber);
    },
    commitFacts: async () => ({
      treeOid: TREE,
      parentShas: [BASE],
      message: `feat: work\n\nthwip-proof: ${CARRIER}\n`,
    }),
    integratedCandidate: async () => ({
      baseSha: BASE,
      headSha: HEAD,
      candidateSha: CANDIDATE,
      candidateTreeOid: TREE,
    }),
    proofCheckRunId: async () => "998877",
    signRecordBytes: async () => "eyJhbGciOiJFUzI1NiJ9.payload.signature",
    baseContainsSha: async () => true,
    ...over,
  });
}

type Routes = ReturnType<typeof app>;

function post(routes: Routes, e: QueueRouteEnv, path: string, body: unknown): Promise<Response> {
  return routes.request(
    `/v1/queue/${REPO}/${path}?ref=${encodeURIComponent(REF)}`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    e,
  );
}

function heartbeat(routes: Routes, e: QueueRouteEnv, device = deviceKeyId): Promise<Response> {
  return routes.request(
    `/v1/queue/${REPO}/runners/heartbeat`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deviceKeyId: device }) },
    e,
  );
}

function authorize(routes: Routes, e: QueueRouteEnv, over: Record<string, unknown> = {}): Promise<Response> {
  return routes.request(
    `/v1/queue/${REPO}/authorize`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        pullRequestNumber: PR,
        headSha: HEAD,
        baseRef: REF,
        authorGithubUserId: "1",
        proofAccepted: true,
        draft: false,
        ...over,
      }),
    },
    e,
  );
}

/**
 * What `thwip-merge.yml` does when the queue drives the lane: ask `authorize`
 * with the candidate GitHub integrated, and report back what landed. Written out
 * here rather than stubbed, because a stub would let the merge succeed without
 * the gate the whole profile is.
 */
async function mergeAsActionsWould(routes: Routes, e: QueueRouteEnv): Promise<void> {
  const verdict = (await (await authorize(routes, e, { prepare: true, candidate })).json()) as Verdict;
  if (verdict.operationId === null) return;
  const id = await attemptId(e);
  await routes.request(
    `/v1/queue/${REPO}/merged`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseRef: REF,
        attemptId: id,
        operationId: verdict.operationId,
        mergeSha: MERGE_SHA,
        mergeTree: TREE,
        parentShas: [BASE, HEAD],
      }),
    },
    e,
  );
}

async function attemptId(e: QueueRouteEnv): Promise<string> {
  const snapshot = await withQueueState(e.DB as unknown as D1Like, REPO, REF, (store) => buildSnapshot(store));
  if (snapshot.activeAttemptId === null) throw new Error("no attempt holds the lane");
  return snapshot.activeAttemptId;
}

/** Enqueue, become eligible on a live heartbeat, and be offered the turn. */
async function offered(routes: Routes, e: QueueRouteEnv): Promise<string> {
  await heartbeat(routes, e);
  await authorize(routes, e);
  return attemptId(e);
}

async function signedReceipt(
  receipt: SubmittedReceipt,
  over: { namespace?: string; keyPath?: string } = {},
): Promise<Record<string, unknown>> {
  const signature = await signSsh({
    privateKeyPath: over.keyPath ?? keyPath,
    namespace: over.namespace ?? INTEGRATION_RECEIPT_NAMESPACE,
    message: integrationReceiptBytes(receipt),
  });
  return { ...receipt, suites: [...receipt.suites], signature };
}

/** What the merge workflow tells the queue GitHub integrated for this turn. */
const candidate = {
  baseSha: BASE,
  candidateSha: CANDIDATE,
  candidateTreeOid: TREE,
  parentShas: [BASE, HEAD],
};

interface Verdict {
  authorized: boolean;
  reason: string;
  operationId: string | null;
}

interface Claimed {
  assignmentId: string;
  assignmentDigest: string;
  assignment: string;
  candidateSha: string;
  candidateTreeOid: string;
  requiredSuites: string[];
  executionSeconds: number;
}

describe("claiming the turn as the machine that will run it", () => {
  it("hands back the signed assignment, the candidate and the suites", async () => {
    const e = env();
    const routes = app();
    const attempt = await offered(routes, e);

    const response = await post(routes, e, "claim", { attemptId: attempt, deviceKeyId });
    expect(response.status).toBe(200);
    const claimed = (await response.json()) as Claimed;
    expect(claimed).toMatchObject({
      assignmentId: `asg_${attempt}`,
      candidateSha: CANDIDATE,
      candidateTreeOid: TREE,
      requiredSuites: ["lint"],
    });
    expect(claimed.assignmentDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(claimed.assignment).toBe("eyJhbGciOiJFUzI1NiJ9.payload.signature");
    expect(claimed.executionSeconds).toBeGreaterThan(0);
  });

  it("refuses a machine with no live heartbeat", async () => {
    const e = env();
    const routes = app();
    await authorize(routes, e);
    // No offer is made to a principal with nobody connected, so the refusal
    // that arrives first is that there is no turn to take.
    const response = await post(routes, e, "claim", { attemptId: "att_nobody", deviceKeyId });
    expect(response.status).toBe(409);
    expect((await response.json()) as { error: string }).toMatchObject({ error: "ATTEMPT_NOT_CURRENT" });
  });

  it("refuses a principal the turn was not offered to", async () => {
    const e = env();
    const attempt = await offered(app(), e);

    // Bob's own machine, so the refusal is about whose turn it is rather than
    // about a device key that belongs to somebody else.
    const other = app({}, "bob", "2");
    const response = await post(other, e, "claim", { attemptId: attempt, deviceKeyId: `SHA256:${"y".repeat(43)}` });
    expect(response.status).toBe(403);
    expect((await response.json()) as { error: string }).toMatchObject({ error: "NOT_YOUR_OFFER" });
  });

  it("refuses a second machine once one holds the attempt", async () => {
    const e = env();
    const routes = app();
    const attempt = await offered(routes, e);
    await post(routes, e, "claim", { attemptId: attempt, deviceKeyId });

    const second = await post(routes, e, "claim", {
      attemptId: attempt,
      deviceKeyId: `SHA256:${"z".repeat(43)}`,
    });
    expect(second.status).toBe(409);
    expect((await second.json()) as { error: string }).toMatchObject({ error: "ALREADY_CLAIMED" });
  });

  it("hands the same machine the same assignment when it asks again", async () => {
    const e = env();
    const routes = app();
    const attempt = await offered(routes, e);
    const first = (await (await post(routes, e, "claim", { attemptId: attempt, deviceKeyId })).json()) as Claimed;
    const again = (await (await post(routes, e, "claim", { attemptId: attempt, deviceKeyId })).json()) as Claimed;
    expect(again.assignmentDigest).toBe(first.assignmentDigest);
  });

  it("refuses to dispatch anything under a profile that runs nothing on a device", async () => {
    const e = env();
    const routes = app({ activePolicy: async () => ({ ...policy, securityProfile: "fast" }) });
    await authorize(routes, e);
    const attempt = await attemptId(e);
    const response = await post(routes, e, "claim", { attemptId: attempt, deviceKeyId });
    expect(response.status).toBe(409);
    expect((await response.json()) as { error: string }).toMatchObject({ error: "PROFILE_DOES_NOT_DISPATCH" });
  });
});

describe("the receipt the machine signs", () => {
  async function claim(routes: Routes, e: QueueRouteEnv): Promise<Claimed> {
    const attempt = await offered(routes, e);
    const response = await post(routes, e, "claim", { attemptId: attempt, deviceKeyId });
    if (response.status !== 200) throw new Error(`claim refused: ${await response.text()}`);
    return (await response.json()) as Claimed;
  }

  function receipt(claimed: Claimed, over: Partial<SubmittedReceipt> = {}): SubmittedReceipt {
    return {
      assignmentId: claimed.assignmentId,
      assignmentDigest: claimed.assignmentDigest,
      candidateTreeOid: claimed.candidateTreeOid,
      deviceKeyId,
      suites: [{ name: "lint", outcome: "passed" }],
      ...over,
    };
  }

  it("is accepted when it answers the assignment it was given", async () => {
    const e = env();
    const routes = app();
    const claimed = await claim(routes, e);

    const response = await post(routes, e, "receipt", await signedReceipt(receipt(claimed)));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accepted: true });
  });

  it("refuses one signed under another namespace", async () => {
    const e = env();
    const routes = app();
    const claimed = await claim(routes, e);

    const body = await signedReceipt(receipt(claimed), { namespace: "thwip-ci-dsse-v1" });
    const response = await post(routes, e, "receipt", body);
    expect(response.status).toBe(403);
    expect((await response.json()) as { error: string }).toMatchObject({ error: "RECEIPT_SIGNATURE_INVALID" });
  });

  it("refuses one whose suites were changed after it was signed", async () => {
    const e = env();
    const routes = app();
    const claimed = await claim(routes, e);

    const body = await signedReceipt(receipt(claimed, { suites: [{ name: "lint", outcome: "failed" }] }));
    const response = await post(routes, e, "receipt", { ...body, suites: [{ name: "lint", outcome: "passed" }] });
    expect(response.status).toBe(403);
    expect((await response.json()) as { error: string }).toMatchObject({ error: "RECEIPT_SIGNATURE_INVALID" });
  });

  it("refuses one about a tree the assignment did not name", async () => {
    const e = env();
    const routes = app();
    const claimed = await claim(routes, e);

    const response = await post(
      routes,
      e,
      "receipt",
      await signedReceipt(receipt(claimed, { candidateTreeOid: OTHER_TREE })),
    );
    expect(response.status).toBe(409);
    expect((await response.json()) as { error: string }).toMatchObject({ error: "CANDIDATE_TREE_MISMATCH" });
  });

  it("refuses one that leaves a required suite out", async () => {
    const e = env();
    const routes = app();
    const claimed = await claim(routes, e);

    const response = await post(routes, e, "receipt", await signedReceipt(receipt(claimed, { suites: [] })));
    expect(response.status).toBe(409);
    expect((await response.json()) as { error: string }).toMatchObject({ error: "SUITE_MISSING" });
  });

  it("refuses one whose required suite did not pass", async () => {
    const e = env();
    const routes = app();
    const claimed = await claim(routes, e);

    const response = await post(
      routes,
      e,
      "receipt",
      await signedReceipt(receipt(claimed, { suites: [{ name: "lint", outcome: "failed" }] })),
    );
    expect(response.status).toBe(409);
    expect((await response.json()) as { error: string }).toMatchObject({ error: "SUITE_FAILED" });
  });

  it("refuses a second, different receipt for the same assignment", async () => {
    const e = env();
    const routes = app();
    const claimed = await claim(routes, e);
    await post(routes, e, "receipt", await signedReceipt(receipt(claimed)));

    const second = await post(
      routes,
      e,
      "receipt",
      await signedReceipt(receipt(claimed, { suites: [{ name: "lint", outcome: "passed" }, { name: "lint", outcome: "passed" }] })),
    );
    expect(second.status).toBe(409);
    expect((await second.json()) as { error: string }).toMatchObject({ error: "RECEIPT_ALREADY_ACCEPTED" });
  });

  it("refuses the merge outright when no device ever took the turn", async () => {
    const e = env();
    const routes = app();
    await offered(routes, e);

    // The head carries an accepted proof and the entry holds the lane, which is
    // everything a `fast` merge needs. Under `fresh` it is not enough, and this
    // is the refusal that says so: the server cannot merge on work done before
    // the branch was integrated.
    const verdict = (await (await authorize(routes, e, { prepare: true, candidate })).json()) as Verdict;
    expect(verdict).toMatchObject({ authorized: false, reason: "INTEGRATION_ASSIGNMENT_MISSING" });
    expect(verdict.operationId).toBeNull();
  });

  it("authorizes the merge once, and only once, the receipt is in", async () => {
    const e = env();
    const routes = app();
    const claimed = await claim(routes, e);

    const before = (await (await authorize(routes, e, { prepare: true, candidate })).json()) as Verdict;
    expect(before).toMatchObject({ authorized: false, reason: "INTEGRATION_RECEIPT_MISSING" });

    await post(routes, e, "receipt", await signedReceipt(receipt(claimed)));

    const after = (await (await authorize(routes, e, { prepare: true, candidate })).json()) as Verdict;
    expect(after).toMatchObject({ authorized: true, reason: "HOLDS_TURN" });
    expect(after.operationId).not.toBeNull();
  });

  it("refuses the merge of a tree the accepted receipt is not about", async () => {
    const e = env();
    const routes = app();
    const claimed = await claim(routes, e);
    await post(routes, e, "receipt", await signedReceipt(receipt(claimed)));

    const verdict = (await (
      await authorize(routes, e, { prepare: true, candidate: { ...candidate, candidateTreeOid: OTHER_TREE } })
    ).json()) as Verdict;
    expect(verdict).toMatchObject({ authorized: false, reason: "INTEGRATION_RECEIPT_TREE_MISMATCH" });
  });

  /**
   * What the chain says a `fresh` merge was. The record kind is the only thing
   * an outside auditor reads, and a merge backed by a signed assignment and a
   * signed receipt from the device that ran the candidate is not the same claim
   * as a merge that reused the proof already on the head.
   */
  describe("what the chain records for a merge under fresh", () => {
    async function merged(routes: Routes, e: QueueRouteEnv): Promise<{ attemptId: string; operationId: string }> {
      const claimed = await claim(routes, e);
      await post(routes, e, "receipt", await signedReceipt(receipt(claimed)));
      const verdict = (await (await authorize(routes, e, { prepare: true, candidate })).json()) as Verdict;
      if (verdict.operationId === null) throw new Error(`not authorized: ${verdict.reason}`);
      const id = await attemptId(e);
      const reported = await routes.request(
        `/v1/queue/${REPO}/merged`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            baseRef: REF,
            attemptId: id,
            operationId: verdict.operationId,
            mergeSha: MERGE_SHA,
            mergeTree: TREE,
            parentShas: [BASE, HEAD],
          }),
        },
        e,
      );
      if (reported.status !== 200) throw new Error(`merged returned ${reported.status}: ${await reported.text()}`);
      return { attemptId: id, operationId: verdict.operationId };
    }

    function stored(kind: string): Array<{ digest: string; bytes: string }> {
      return raw
        .prepare("SELECT digest, bytes FROM queue_attestations WHERE kind = ? ORDER BY created_at")
        .all(kind) as Array<{ digest: string; bytes: string }>;
    }

    it("signs a verified merge intent, naming the assignment and the receipt", async () => {
      const e = env();
      const routes = app();
      const claimed = await claim(routes, e);
      const submitted = receipt(claimed);
      await post(routes, e, "receipt", await signedReceipt(submitted));
      await authorize(routes, e, { prepare: true, candidate });

      const rows = stored("merge-intent");
      expect(rows).toHaveLength(1);
      const parsed = parseMergeIntent(JSON.parse(rows[0]!.bytes) as unknown);
      if (!parsed.ok) throw new Error(parsed.detail);
      expect(parsed.value.kind).toBe("verified");
      if (parsed.value.kind !== "verified") return;
      expect(parsed.value.evidence.assignmentDigest).toBe(claimed.assignmentDigest);
      expect(parsed.value.evidence.execution).toEqual({ ranOn: "device", deviceKeyId });
    });

    it("records a verified merge, citing the assignment and the receipt behind it", async () => {
      const e = env();
      const routes = app();
      await merged(routes, e);

      const rows = stored("verified-merge");
      expect(rows).toHaveLength(1);
      const parsed = parseTransitionRecord(JSON.parse(rows[0]!.bytes) as unknown);
      if (!parsed.ok) throw new Error(parsed.detail);
      expect(parsed.value.kind).toBe("verified-merge");
      if (parsed.value.kind !== "verified-merge") return;
      const assignment = raw
        .prepare("SELECT assignment_digest, receipt_digest FROM queue_assignments")
        .get() as { assignment_digest: string; receipt_digest: string };
      expect(parsed.value.verifiedMerge.assignmentDigest).toBe(assignment.assignment_digest);
      expect(parsed.value.verifiedMerge.integrationEvidenceDigest).toBe(assignment.receipt_digest);
      expect(parsed.value.verifiedMerge.execution).toEqual({ ranOn: "device", deviceKeyId });
      expect(stored("candidate-verified-merge")).toHaveLength(0);
      expect(stored("reused-proof-merge")).toHaveLength(0);
    });

    it("puts that record on the chain, and the intent it cites is readable", async () => {
      const e = env();
      const routes = app();
      await merged(routes, e);

      const link = raw
        .prepare("SELECT digest, kind FROM queue_attestations WHERE transition_sequence IS NOT NULL")
        .get() as { digest: string; kind: string };
      expect(link.kind).toBe("verified-merge");
      const record = parseTransitionRecord(
        JSON.parse(
          (raw.prepare("SELECT bytes FROM queue_attestations WHERE digest = ?").get(link.digest) as { bytes: string })
            .bytes,
        ) as unknown,
      );
      if (!record.ok || record.value.kind !== "verified-merge") throw new Error("wrong kind");
      const intent = raw
        .prepare("SELECT bytes FROM queue_attestations WHERE digest = ?")
        .get(record.value.verifiedMerge.mergeIntentDigest) as { bytes: string } | undefined;
      expect(intent).toBeDefined();
    });
  });

  it("asks for the merge to be written once the run is answered for", async () => {
    const e = env();
    const routes = app();
    const claimed = await claim(routes, e);
    expect(driven).toEqual([]);

    await post(routes, e, "receipt", await signedReceipt(receipt(claimed)));
    expect(driven).toEqual([PR]);
  });

  /**
   * The whole point, with the one dispatch thrown away.
   *
   * Everything up to the receipt worked in production and nothing after it ever
   * did: the receipt route dispatched once, fired and forgot, and no other
   * caller in the system would drive a device-only lane. So a single lost
   * dispatch was the difference between a merge and an attempt sitting in
   * `RECEIPT_SUBMITTED` until its deadline. The merge Actions performs is stood
   * up here for real — the same `authorize` with `prepare` and the same
   * `/merged` report the workflow makes — and the only thing asking for it is
   * the five-minute sweep.
   */
  it("reaches a merge and a verified-merge record when the first dispatch is lost", async () => {
    const e = env();
    const db = e.DB as unknown as D1Like;
    // The dispatch the receipt route makes goes nowhere, as it did in production.
    const routes = app({ driveTurn: async () => {} });
    const claimed = await claim(routes, e);
    await post(routes, e, "receipt", await signedReceipt(receipt(claimed)));

    const held = await attemptId(e);
    expect(
      raw.prepare("SELECT COUNT(*) AS n FROM queue_attestations WHERE kind = 'verified-merge'").get(),
    ).toMatchObject({ n: 0 });

    await tickAllQueues(e, {
      driveTurn: async () => void (await mergeAsActionsWould(routes, e)),
      onQueueTicked: () => {},
      onQueueFailed: () => {},
    });

    const after = await withQueueState(db, REPO, REF, (store) => buildSnapshot(store));
    expect(after.entries[0]).toMatchObject({ state: "Merged" });
    const rows = raw
      .prepare("SELECT bytes FROM queue_attestations WHERE kind = 'verified-merge'")
      .all() as Array<{ bytes: string }>;
    expect(rows).toHaveLength(1);
    const parsed = parseTransitionRecord(JSON.parse(rows[0]!.bytes) as unknown);
    if (!parsed.ok || parsed.value.kind !== "verified-merge") throw new Error("wrong kind");
    expect(parsed.value.verifiedMerge.assignmentDigest).toBe(claimed.assignmentDigest);
    expect(parsed.value.verifiedMerge.attemptId).toBe(held);
  });

  /**
   * And the gate the profile exists for, over the same recovered path. A sweep
   * that drives a lane the device never answered for merges nothing: `fresh`
   * without a receipt is a refusal, and no amount of asking again changes it.
   */
  it("merges nothing on that path when no receipt was ever accepted", async () => {
    const e = env();
    const db = e.DB as unknown as D1Like;
    const routes = app({ driveTurn: async () => {} });
    await claim(routes, e);

    await tickAllQueues(e, {
      driveTurn: async () => void (await mergeAsActionsWould(routes, e)),
      onQueueTicked: () => {},
      onQueueFailed: () => {},
    });

    const after = await withQueueState(db, REPO, REF, (store) => buildSnapshot(store));
    expect(after.entries[0]?.state).not.toBe("Merged");
    expect(raw.prepare("SELECT COUNT(*) AS n FROM queue_attestations WHERE transition_sequence IS NOT NULL").get())
      .toMatchObject({ n: 0 });
  });

  /**
   * The operator's way back in, for the one state it could not see.
   *
   * `/nudge` picked the holder itself, and only ever looked for `Offered` or
   * `Active`. An attempt that had returned its receipt is `Verifying`, so the
   * one lane in flight read as no lane at all: the route answered `LANE_IDLE`
   * and returned before `driveLane` — which does understand `Verifying` — was
   * ever called. Every operator tool reported an idle queue while an attempt
   * held the lane, which is how the merge that never happened stayed invisible.
   */
  it("nudges a lane held by an attempt whose receipt is already in", async () => {
    const e = env();
    const routes = app();
    const claimed = await claim(routes, e);
    await post(routes, e, "receipt", await signedReceipt(receipt(claimed)));
    driven.length = 0;

    const response = await post(routes, e, "nudge", {});
    expect(await response.json()).toMatchObject({ nudged: true, pullRequestNumber: PR, state: "Verifying" });
    expect(driven).toEqual([PR]);
  });

  /**
   * A push under a running turn ends that turn, rather than poisoning it.
   *
   * The queue pins the candidate when it issues the assignment and holds both
   * immutable, and nothing ever told it the pull request had moved on. So a
   * contributor pushing while a device was running kept a turn alive against a
   * tree GitHub no longer integrates: the device asking again was handed back
   * the stale assignment, ran the stale tree, signed a receipt for it, and the
   * queue accepted it — and then refused every merge for that attempt with
   * `INTEGRATION_RECEIPT_TREE_MISMATCH`, forever, because the receipt really was
   * about a different tree. Pull request 2 on `recallnet/thwip-test` sat in
   * `RECEIPT_SUBMITTED` for exactly this reason.
   *
   * `HEAD_MOVED` is the reducer's own answer and nothing was reaching it. It
   * defers, so the place in line is kept and the next turn is taken against
   * what is there now.
   */
  it("ends a turn whose pull request moved under the device running it", async () => {
    const e = env();
    const routes = app();
    const claimed = await claim(routes, e);
    const stale = await attemptId(e);

    await authorize(routes, e, { headSha: MOVED_HEAD });

    const snapshot = await withQueueState(e.DB as unknown as D1Like, REPO, REF, (store) => buildSnapshot(store));
    expect(snapshot.activeAttemptId).toBeNull();
    expect(snapshot.entries[0]).toMatchObject({ state: "Deferred" });

    // And the account of the stale tree is worth nothing: the attempt it
    // answers is over, so there is no lane for it to move.
    const late = await post(routes, e, "receipt", await signedReceipt(receipt(claimed)));
    expect(late.status).toBe(409);
    expect(stale).not.toBe(snapshot.activeAttemptId);
  });

  it("leaves a turn alone while the pull request stays where it was", async () => {
    const e = env();
    const routes = app();
    await claim(routes, e);
    const held = await attemptId(e);

    await authorize(routes, e);

    expect(await attemptId(e)).toBe(held);
  });

  /**
   * A branch that moved without the queue, and the next device turn after it.
   *
   * Somebody pushing straight to the base pauses the queue and asks an operator
   * to rebaseline, which is right. What it also used to do is push an entry onto
   * the queue's chain carrying `external:<sha>` where a record digest belongs.
   * Nothing signs that entry, so no reader can fetch it, and every signature the
   * queue makes afterwards names it as `previousTransitionDigest`: the
   * assignment the device is handed, and the merge intent behind the merge. Both
   * are validated against the protocol before they are signed, and the protocol
   * only knows `sha256:` digests, so the claim came back
   * `ASSIGNMENT_INVALID` 500 and the branch could never take another turn.
   *
   * `recallnet/thwip-test` sat exactly there: one hand-pushed commit on `main`
   * and no device could claim the lane again, rebaselined or not.
   */
  it("hands a device its turn after the branch moved outside the queue", async () => {
    const e = env();
    const db = e.DB as unknown as D1Like;
    const routes = app();
    const moved = "a".repeat(40);
    await withQueueState(db, REPO, REF, (store) => {
      const commands = commandsFor(store);
      commands.observedExternalTransition({ idempotencyKey: `external:${moved}`, observedBaseSha: moved });
      commands.rebaseline({ idempotencyKey: "rebaseline:1", actorPrincipalId: "alice", baseSha: BASE });
      commands.resume({ idempotencyKey: "resume:1", actorPrincipalId: "alice" });
    });

    const claimed = await claim(routes, e);
    expect(claimed.assignmentDigest).toMatch(/^sha256:[0-9a-f]{64}$/);

    // And the whole walk after it, because the same value reaches the merge
    // intent: a chain that starts with something nothing signed cannot be
    // extended by anything either.
    await post(routes, e, "receipt", await signedReceipt(receipt(claimed)));
    await mergeAsActionsWould(routes, e);

    const after = await withQueueState(db, REPO, REF, (store) => buildSnapshot(store));
    expect(after.entries[0]).toMatchObject({ state: "Merged" });
    expect(
      raw.prepare("SELECT COUNT(*) AS n FROM queue_attestations WHERE kind = 'verified-merge'").get(),
    ).toMatchObject({ n: 1 });
  });

  /**
   * The receipt route's own dispatch, all the way to the record.
   *
   * The five-minute sweep is the recovery, not the path. What a developer
   * watching `thwip ship` waits on is the merge the acceptance of their receipt
   * asks for, so this drives nothing else: no sweep, no nudge, only the lane
   * driven at the moment the receipt is accepted.
   */
  it("reaches a verified-merge record from the drive the receipt itself asks for", async () => {
    const e = env();
    const db = e.DB as unknown as D1Like;
    let routes: Routes;
    routes = app({ driveTurn: async () => void (await mergeAsActionsWould(routes, e)) });
    const claimed = await claim(routes, e);

    await post(routes, e, "receipt", await signedReceipt(receipt(claimed)));

    const after = await withQueueState(db, REPO, REF, (store) => buildSnapshot(store));
    expect(after.entries[0]).toMatchObject({ state: "Merged" });
    expect(
      raw.prepare("SELECT COUNT(*) AS n FROM queue_attestations WHERE kind = 'verified-merge'").get(),
    ).toMatchObject({ n: 1 });
  });

  it("still reports an idle lane as idle", async () => {
    const e = env();
    const routes = app();
    const response = await post(routes, e, "nudge", {});
    expect(await response.json()).toMatchObject({ nudged: false, reason: "LANE_IDLE" });
    expect(driven).toEqual([]);
  });
});

/**
 * The one thing the device and the service have to agree on without ever
 * talking: which bytes the signature covers. They are written out here rather
 * than taken from the function under test, so a change to that function fails
 * this instead of silently rejecting every receipt a released CLI signs.
 */
describe("the bytes a receipt is signed over", () => {
  const receipt = {
    assignmentId: "asg_att_1",
    assignmentDigest: `sha256:${"1".repeat(64)}`,
    candidateTreeOid: TREE,
    deviceKeyId: `SHA256:${"a".repeat(43)}`,
    suites: [{ name: "lint", outcome: "passed" }],
  };

  it("are the queue's own pre-authentication encoding of the receipt, under the queue namespace", () => {
    expect(INTEGRATION_RECEIPT_NAMESPACE).toBe(QUEUE_SIGN_NAMESPACE);
    expect(integrationReceiptBytes(receipt)).toEqual(
      queueSigningBytes(
        QUEUE_PREDICATE_TYPES.integrationRun,
        canonicalRecordBytes({
          assignmentId: receipt.assignmentId,
          assignmentDigest: receipt.assignmentDigest,
          candidateTreeOid: receipt.candidateTreeOid,
          deviceKeyId: receipt.deviceKeyId,
          suites: receipt.suites,
        }),
      ),
    );
  });
});
