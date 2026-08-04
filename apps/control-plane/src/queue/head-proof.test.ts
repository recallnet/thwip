import { afterEach, describe, expect, it } from "vitest";
import { testD1 } from "../../test/d1.js";
import { headProofAccepted } from "./head-proof.js";
import type { D1Like } from "./projection.js";

/**
 * Whose word the queue takes for "this head's proof passed".
 *
 * It used to take the caller's. `/authorize` read `proofAccepted` off the
 * request body, which a workflow inside the branch under test composed, and the
 * `pull_request` webhook had no way to assert it at all — so enrolment from the
 * webhook always read `missing` and no pull request placed by GitHub's own
 * delivery could ever become ready.
 *
 * The App holds the real answer. It runs `verifyProof` itself and writes the
 * verdict to `proof_verifications`, so the queue reads a row it wrote rather
 * than a field somebody sent it.
 */

const REPO = "1315419165";
const HEAD = "a".repeat(40);

const open: Array<{ close(): void }> = [];
let raw: import("better-sqlite3").Database;

afterEach(() => {
  while (open.length > 0) open.pop()!.close();
});

function db(): D1Like {
  const t = testD1();
  open.push(t);
  raw = t.raw;
  raw
    .prepare("INSERT INTO organizations (id, github_org_id, github_login) VALUES (?, ?, ?)")
    .run("org_1", "1", "acme");
  raw
    .prepare(
      "INSERT INTO projects (id, organization_id, github_repository_id, github_name, enabled) VALUES (?, ?, ?, ?, 1)",
    )
    .run("proj_1", "org_1", REPO, "acme/repo");
  return t.db;
}

/** One verification attempt, as the App writes it. */
function verification(input: {
  id: string;
  projectId?: string;
  sha?: string;
  status: string;
  outcome: string | null;
  completedAt: string | null;
}): void {
  raw
    .prepare(
      `INSERT INTO proof_verifications
         (id, project_id, event, subject_sha, base_ref, verifier_version, mode, request_json,
          status, outcome, check_name, started_at, completed_at)
       VALUES (?, ?, 'pull_request', ?, 'refs/heads/main', 'v1', 'observe', '{}', ?, ?, 'thwip', ?, ?)`,
    )
    .run(
      input.id,
      input.projectId ?? "proj_1",
      input.sha ?? HEAD,
      input.status,
      input.outcome,
      input.completedAt ?? "2026-08-04T00:00:00.000Z",
      input.completedAt,
    );
}

describe("the App's own verdict on a head", () => {
  it("is missing when nothing has verified the head", async () => {
    expect(await headProofAccepted(db(), REPO, HEAD)).toBe(false);
  });

  it("is accepted when the App's verification of that exact head passed", async () => {
    const d = db();
    verification({ id: "pv_1", status: "completed", outcome: "PASS", completedAt: "2026-08-04T01:00:00.000Z" });
    expect(await headProofAccepted(d, REPO, HEAD)).toBe(true);
  });

  it("is missing when the verification failed", async () => {
    const d = db();
    verification({ id: "pv_1", status: "completed", outcome: "PROOF_INVALID", completedAt: "2026-08-04T01:00:00.000Z" });
    expect(await headProofAccepted(d, REPO, HEAD)).toBe(false);
  });

  it("is missing while a verification is still running", async () => {
    const d = db();
    verification({ id: "pv_1", status: "in_progress", outcome: null, completedAt: null });
    expect(await headProofAccepted(d, REPO, HEAD)).toBe(false);
  });

  it("takes the newest completed answer, so a later refusal replaces an earlier pass", async () => {
    const d = db();
    verification({ id: "pv_1", status: "completed", outcome: "PASS", completedAt: "2026-08-04T01:00:00.000Z" });
    verification({ id: "pv_2", status: "completed", outcome: "POLICY_CHANGED", completedAt: "2026-08-04T02:00:00.000Z" });
    expect(await headProofAccepted(d, REPO, HEAD)).toBe(false);
  });

  it("does not read another repository's verdict on the same commit", async () => {
    const d = db();
    raw
      .prepare(
        "INSERT INTO projects (id, organization_id, github_repository_id, github_name, enabled) VALUES (?, ?, ?, ?, 1)",
      )
      .run("proj_2", "org_1", "999", "acme/other");
    verification({
      id: "pv_1",
      projectId: "proj_2",
      status: "completed",
      outcome: "PASS",
      completedAt: "2026-08-04T01:00:00.000Z",
    });
    expect(await headProofAccepted(d, REPO, HEAD)).toBe(false);
  });

  it("does not read the verdict on a different head", async () => {
    const d = db();
    verification({
      id: "pv_1",
      sha: "b".repeat(40),
      status: "completed",
      outcome: "PASS",
      completedAt: "2026-08-04T01:00:00.000Z",
    });
    expect(await headProofAccepted(d, REPO, HEAD)).toBe(false);
  });
});
