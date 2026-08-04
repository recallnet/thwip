import { afterEach, describe, expect, it } from "vitest";
import { testD1 } from "../../test/d1.js";
import { queueRoutes, type QueueRouteEnv } from "./routes.js";

/**
 * Who says a head's proof passed.
 *
 * `/authorize` used to believe `proofAccepted` from the request body. That body
 * is composed by a workflow living in the branch under test, so the one fact the
 * whole product exists to establish was asserted by the thing being checked. The
 * App verifies the proof itself and stores the verdict; the queue reads that.
 */

const REPO = "1315419165";
const REF = "refs/heads/main";
const HEAD = "a".repeat(40);

const open: Array<{ close(): void }> = [];
let raw: import("better-sqlite3").Database;

afterEach(() => {
  while (open.length > 0) open.pop()!.close();
});

function env(): QueueRouteEnv {
  const t = testD1();
  open.push(t);
  raw = t.raw;
  raw.prepare("INSERT INTO organizations (id, github_org_id, github_login) VALUES (?, ?, ?)").run("org_1", "1", "acme");
  raw
    .prepare(
      "INSERT INTO projects (id, organization_id, github_repository_id, github_name, enabled) VALUES (?, ?, ?, ?, 1)",
    )
    .run("proj_1", "org_1", REPO, "acme/repo");
  raw
    .prepare(
      "INSERT INTO principals (id, organization_id, github_user_id, github_login, activated_at) VALUES (?, ?, ?, ?, datetime('now'))",
    )
    .run("principal_1", "org_1", "1", "alice");
  return { DB: t.db, PUBLIC_ORIGIN: "https://thwip.test" } as unknown as QueueRouteEnv;
}

function verified(outcome: string): void {
  raw
    .prepare(
      `INSERT INTO proof_verifications
         (id, project_id, event, subject_sha, base_ref, verifier_version, mode, request_json,
          status, outcome, check_name, started_at, completed_at)
       VALUES ('pv_1', 'proj_1', 'pull_request', ?, ?, 'v1', 'observe', '{}', 'completed', ?, 'thwip',
               '2026-08-04T00:00:00.000Z', '2026-08-04T01:00:00.000Z')`,
    )
    .run(HEAD, REF, outcome);
}

function app() {
  return queueRoutes({
    authenticate: async () => ({ ok: true, principalId: "principal_1", githubUserId: "1", isAdmin: true }),
    verifyOidc: async () => ({ repository_id: REPO }),
    pinnedVerifier: async () => null,
    activePolicy: async () => null,
    dispatchCandidateVerification: async () => ({ ok: true }),
    queueProject: async () => ({ activationState: "enforced", mergeMethod: "merge" as const }),
    principalFor: async () => "principal_1",
    pullRequestPlacement: async () => ({ authorGithubUserId: "1", baseRef: REF, authorIsBot: false }),
    driveTurn: async () => {},
    commitFacts: async () => ({ treeOid: "t".repeat(40), parentShas: ["p".repeat(40)] }),
    proofCheckRunId: async () => null,
    baseContainsSha: async () => true,
    signRecordBytes: async () => "jws",
  } as unknown as Parameters<typeof queueRoutes>[0]);
}

async function ask(e: QueueRouteEnv, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await app().request(
    `/v1/queue/${REPO}/authorize`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseRef: REF, pullRequestNumber: 1, headSha: HEAD, authorGithubUserId: "1", ...body }),
    },
    e,
  );
  return (await response.json()) as Record<string, unknown>;
}

describe("the proof verdict the queue acts on", () => {
  it("refuses a caller's claim that the proof passed when the App has verified nothing", async () => {
    const e = env();
    const answer = await ask(e, { proofAccepted: true });
    expect(answer["reason"]).toBe("LOCAL_RECEIPT_MISSING");
  });

  it("offers the turn on the App's own passing verdict, with the caller claiming nothing", async () => {
    const e = env();
    verified("PASS");
    const answer = await ask(e, {});
    expect(answer["reason"]).toBe("HOLDS_TURN");
  });

  it("refuses on the App's own refusal, whatever the caller claims", async () => {
    const e = env();
    verified("PROOF_INVALID");
    const answer = await ask(e, { proofAccepted: true });
    expect(answer["reason"]).toBe("LOCAL_RECEIPT_MISSING");
  });
});
