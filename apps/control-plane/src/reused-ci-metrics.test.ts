import { afterEach, describe, expect, it } from "vitest";
import {
  PREDICATE_TYPE,
  STATEMENT_TYPE,
  type InTotoStatementV1,
} from "@thwip/protocol";
import { testD1, type TestD1 } from "../test/d1.js";
import {
  PUBLIC_METRICS_MINIMUM_MERGED_PROOFS,
  publicReusedCiMetrics,
  recordProofCompletion,
  reusedCiMetrics,
  signedProofDurations,
} from "./reused-ci-metrics.js";

const HEAD = "a".repeat(40);
const POLICY = `sha256:${"b".repeat(64)}`;
const opened: TestD1[] = [];

afterEach(() => {
  while (opened.length > 0) opened.pop()!.close();
});

function fresh(): TestD1 {
  const value = testD1();
  opened.push(value);
  return value;
}

function statement(): InTotoStatementV1 {
  return {
    _type: STATEMENT_TYPE,
    subject: [{ name: "git-tree", digest: { sha1: "c".repeat(40) } }],
    predicateType: PREDICATE_TYPE,
    predicate: {
      schemaVersion: "1",
      repository: { provider: "github", ownerId: "1", repositoryId: "10" },
      git: {
        objectFormat: "sha1",
        treeOid: "c".repeat(40),
        parentOids: ["d".repeat(40)],
        baseRef: "refs/heads/main",
        baseSha: "e".repeat(40),
        evaluationMode: "head-tree",
      },
      policy: { digest: POLICY as `sha256:${string}`, version: 1 },
      pipeline: { digest: `sha256:${"f".repeat(64)}`, runner: "command" },
      run: {
        startedAt: "2026-08-11T10:00:00.000Z",
        finishedAt: "2026-08-11T10:01:30.000Z",
        networkMode: "disabled",
        cacheMode: "disabled",
        suites: [
          { id: "lint", status: "passed", durationMs: 10_000 },
          { id: "test", status: "passed", durationMs: 75_000 },
        ],
      },
      signer: { keyId: "key_1", githubUserId: "2" },
    },
  };
}

function organization(t: TestD1, id: string): void {
  t.raw
    .prepare("INSERT INTO organizations (id, github_org_id, github_login) VALUES (?, ?, ?)")
    .run(id, `github_${id}`, id);
}

function project(t: TestD1, id: string, organizationId: string, repositoryId: string): void {
  t.raw
    .prepare(
      "INSERT INTO projects (id, organization_id, github_repository_id, github_name) VALUES (?, ?, ?, ?)",
    )
    .run(id, organizationId, repositoryId, `${organizationId}/${id}`);
}

function verification(
  t: TestD1,
  input: {
    id: string;
    projectId: string;
    checkRunId: string;
    outcome?: string;
    head?: string;
    policy?: string;
    suiteMs?: number | null;
    wallMs?: number | null;
    overheadMs?: number | null;
  },
): void {
  t.raw
    .prepare(
      `INSERT INTO proof_verifications
         (id, project_id, event, subject_sha, base_ref, policy_digest, verifier_version, mode,
          request_json, status, outcome, check_name, check_run_id, started_at, completed_at,
          signed_suite_duration_ms, signed_wall_clock_duration_ms, verification_duration_ms)
       VALUES (?, ?, 'pull_request', ?, 'refs/heads/main', ?, 'verifier-1', 'enforced', '{}',
               'completed', ?, 'thwip', ?, '2026-08-11T10:00:00.000Z', '2026-08-11T10:00:00.100Z', ?, ?, ?)`,
    )
    .run(
      input.id,
      input.projectId,
      input.head ?? HEAD,
      input.policy ?? POLICY,
      input.outcome ?? "PASS",
      input.checkRunId,
      input.suiteMs === undefined ? 1_000 : input.suiteMs,
      input.wallMs === undefined ? 2_000 : input.wallMs,
      input.overheadMs === undefined ? 10 : input.overheadMs,
    );
}

function reusedMerge(
  t: TestD1,
  input: {
    digest: string;
    attemptId: string;
    repositoryId: string;
    checkRunId: string;
    sequence: number;
    head?: string;
    policy?: string;
    kind?: string;
  },
): void {
  const project = t.raw
    .prepare("SELECT id FROM projects WHERE github_repository_id = ?")
    .get(input.repositoryId) as { id: string };
  const recordKind = input.kind ?? "reused-proof-merge";
  const bytes = JSON.stringify({
    kind: recordKind,
    reusedProof: {
      checkRunId: input.checkRunId,
      headSha: input.head ?? HEAD,
      policyDigest: input.policy ?? POLICY,
    },
  });
  t.raw
    .prepare(
      `INSERT INTO queue_attestations
         (digest, kind, github_repository_id, base_ref, transition_sequence, attempt_id, bytes, jws, project_id)
       VALUES (?, ?, ?, 'refs/heads/main', ?, ?, ?, 'signed', ?)`,
    )
    .run(input.digest, recordKind, input.repositoryId, input.sequence, input.attemptId, bytes, project.id);
}

describe("accepted proof duration collection", () => {
  it("keeps signed suite work separate from the signed run window", () => {
    expect(signedProofDurations(statement())).toEqual({ suiteDurationMs: 85_000, wallClockDurationMs: 90_000 });
  });

  it("does not invalidate a proof whose durations cannot be stored safely", () => {
    const value = statement();
    value.predicate.run.suites[1]!.durationMs = Number.MAX_VALUE;
    expect(signedProofDurations(value)).toBeNull();
  });

  it("stores accepted signed durations and computes verification overhead separately", async () => {
    const t = fresh();
    organization(t, "org_1");
    project(t, "project_1", "org_1", "10");
    t.raw
      .prepare(
        `INSERT INTO proof_verifications
           (id, project_id, event, subject_sha, base_ref, verifier_version, mode, request_json, status,
            check_name, started_at)
         VALUES ('proof_1', 'project_1', 'pull_request', ?, 'refs/heads/main', 'verifier-1',
                 'enforced', '{}', 'in_progress', 'thwip', '2026-08-11T10:00:00.000Z')`,
      )
      .run(HEAD);

    await recordProofCompletion(
      t.db,
      "proof_1",
      { outcome: "PASS", policyDigest: POLICY, durations: { suiteDurationMs: 85_000, wallClockDurationMs: 90_000 } },
      "audit",
      "2026-08-11T10:00:00.125Z",
    );

    expect(
      t.raw
        .prepare(
          `SELECT signed_suite_duration_ms, signed_wall_clock_duration_ms, verification_duration_ms
             FROM proof_verifications WHERE id = 'proof_1'`,
        )
        .get(),
    ).toEqual({
      signed_suite_duration_ms: 85_000,
      signed_wall_clock_duration_ms: 90_000,
      verification_duration_ms: 125,
    });
  });

  it("never stores proof durations on a failed verification", async () => {
    const t = fresh();
    organization(t, "org_1");
    project(t, "project_1", "org_1", "10");
    t.raw
      .prepare(
        `INSERT INTO proof_verifications
           (id, project_id, event, subject_sha, base_ref, verifier_version, mode, request_json, status,
            check_name, started_at)
         VALUES ('proof_bad', 'project_1', 'pull_request', ?, 'refs/heads/main', 'verifier-1',
                 'enforced', '{}', 'in_progress', 'thwip', '2026-08-11T10:00:00.000Z')`,
      )
      .run(HEAD);

    await recordProofCompletion(
      t.db,
      "proof_bad",
      { outcome: "SIGNATURE_INVALID", policyDigest: POLICY, durations: { suiteDurationMs: 9_999, wallClockDurationMs: 9_999 } },
      "audit",
      "2026-08-11T10:00:00.125Z",
    );

    expect(
      t.raw
        .prepare(
          `SELECT signed_suite_duration_ms, signed_wall_clock_duration_ms, verification_duration_ms
             FROM proof_verifications WHERE id = 'proof_bad'`,
        )
        .get(),
    ).toEqual({
      signed_suite_duration_ms: null,
      signed_wall_clock_duration_ms: null,
      verification_duration_ms: null,
    });
  });
});

describe("reused-CI attribution", () => {
  it("counts only a merge that cites the matching accepted proof, once", async () => {
    const t = fresh();
    organization(t, "org_1");
    project(t, "project_1", "org_1", "10");
    verification(t, { id: "proof_1", projectId: "project_1", checkRunId: "check_1" });
    // Even corrupt duplicate storage for one GitHub check contributes one
    // coherent row, never one field or one count from each copy.
    verification(t, {
      id: "proof_z_duplicate",
      projectId: "project_1",
      checkRunId: "check_1",
      suiteMs: 3_000,
      wallMs: 4_000,
      overheadMs: 20,
    });
    // A redelivered verification of the same head is real audit history, but it
    // is not the check run the merge record says it reused.
    verification(t, { id: "proof_redelivery", projectId: "project_1", checkRunId: "check_2" });
    reusedMerge(t, {
      digest: "sha256:merge1",
      attemptId: "attempt_1",
      repositoryId: "10",
      checkRunId: "check_1",
      sequence: 1,
    });
    // Replaying the same signed row changes nothing at the storage boundary.
    t.raw
      .prepare(
        `INSERT OR IGNORE INTO queue_attestations
           (digest, kind, github_repository_id, base_ref, transition_sequence, attempt_id, bytes, jws)
         SELECT digest, kind, github_repository_id, base_ref, transition_sequence, attempt_id, bytes, jws
           FROM queue_attestations WHERE digest = 'sha256:merge1'`,
      )
      .run();

    const metrics = await reusedCiMetrics(t.db, { kind: "project", projectId: "project_1" });
    expect(metrics).toEqual({
      status: "complete",
      signedSuiteDurationMs: 3_000,
      signedWallClockDurationMs: 4_000,
      verificationOverheadMs: 20,
      mergedProofs: 1,
      knownReusedMerges: 1,
      unmeasuredMergedProofs: 0,
    });
    expect(await reusedCiMetrics(t.db, { kind: "project", projectId: "project_1" })).toEqual(metrics);
  });

  it("excludes failed, mismatched, fresh and remote evidence and reports old rows as partial", async () => {
    const t = fresh();
    organization(t, "org_1");
    project(t, "project_1", "org_1", "10");
    verification(t, { id: "proof_good", projectId: "project_1", checkRunId: "check_good" });
    verification(t, { id: "proof_failed", projectId: "project_1", checkRunId: "check_failed", outcome: "PROOF_EXPIRED" });
    verification(t, { id: "proof_old", projectId: "project_1", checkRunId: "check_old", suiteMs: null, wallMs: null, overheadMs: null });
    reusedMerge(t, { digest: "sha256:good", attemptId: "attempt_good", repositoryId: "10", checkRunId: "check_good", sequence: 1 });
    reusedMerge(t, { digest: "sha256:failed", attemptId: "attempt_failed", repositoryId: "10", checkRunId: "check_failed", sequence: 2 });
    reusedMerge(t, { digest: "sha256:old", attemptId: "attempt_old", repositoryId: "10", checkRunId: "check_old", sequence: 3 });
    reusedMerge(t, { digest: "sha256:wrong-policy", attemptId: "attempt_wrong", repositoryId: "10", checkRunId: "check_good", sequence: 4, policy: "sha256:other" });
    reusedMerge(t, { digest: "sha256:fresh", attemptId: "attempt_fresh", repositoryId: "10", checkRunId: "check_good", sequence: 5, kind: "verified-merge" });
    reusedMerge(t, { digest: "sha256:remote", attemptId: "attempt_remote", repositoryId: "10", checkRunId: "check_good", sequence: 6, kind: "candidate-verified-merge" });

    expect(await reusedCiMetrics(t.db, { kind: "project", projectId: "project_1" })).toEqual({
      status: "partial",
      signedSuiteDurationMs: 1_000,
      signedWallClockDurationMs: 2_000,
      verificationOverheadMs: 10,
      mergedProofs: 1,
      knownReusedMerges: 4,
      unmeasuredMergedProofs: 3,
    });
  });

  it("keeps project, organization and public aggregates in their scopes", async () => {
    const t = fresh();
    organization(t, "org_1");
    organization(t, "org_2");
    project(t, "project_1", "org_1", "10");
    project(t, "project_2", "org_1", "20");
    project(t, "project_3", "org_2", "30");
    for (const [index, projectId, repositoryId, wallMs] of [
      [1, "project_1", "10", 1_000],
      [2, "project_2", "20", 2_000],
      [3, "project_3", "30", 4_000],
    ] as const) {
      verification(t, {
        id: `proof_${index}`,
        projectId,
        checkRunId: `check_${index}`,
        suiteMs: wallMs / 2,
        wallMs,
        overheadMs: index,
      });
      reusedMerge(t, {
        digest: `sha256:merge${index}`,
        attemptId: `attempt_${index}`,
        repositoryId,
        checkRunId: `check_${index}`,
        sequence: index,
      });
    }

    expect(await reusedCiMetrics(t.db, { kind: "project", projectId: "project_2" })).toMatchObject({
      mergedProofs: 1,
      signedWallClockDurationMs: 2_000,
    });
    expect(await reusedCiMetrics(t.db, { kind: "organization", organizationId: "org_1" })).toMatchObject({
      mergedProofs: 2,
      signedWallClockDurationMs: 3_000,
      verificationOverheadMs: 3,
    });
    expect(await reusedCiMetrics(t.db, { kind: "public" })).toMatchObject({
      mergedProofs: 3,
      signedWallClockDurationMs: 7_000,
      verificationOverheadMs: 6,
    });
  });
});

describe("the public sample rule", () => {
  it("returns no aggregate or tenant identifiers below ten measured merges", () => {
    const hidden = publicReusedCiMetrics({
      status: "complete",
      signedSuiteDurationMs: 9_000,
      signedWallClockDurationMs: 10_000,
      verificationOverheadMs: 100,
      mergedProofs: PUBLIC_METRICS_MINIMUM_MERGED_PROOFS - 1,
      knownReusedMerges: PUBLIC_METRICS_MINIMUM_MERGED_PROOFS - 1,
      unmeasuredMergedProofs: 0,
    });
    expect(hidden).toEqual({
      status: "insufficient-sample",
      minimumMergedProofs: PUBLIC_METRICS_MINIMUM_MERGED_PROOFS,
    });
  });

  it("publishes aggregate measurements at the documented threshold", () => {
    expect(
      publicReusedCiMetrics({
        status: "complete",
        signedSuiteDurationMs: 9_000,
        signedWallClockDurationMs: 10_000,
        verificationOverheadMs: 100,
        mergedProofs: PUBLIC_METRICS_MINIMUM_MERGED_PROOFS,
        knownReusedMerges: PUBLIC_METRICS_MINIMUM_MERGED_PROOFS,
        unmeasuredMergedProofs: 0,
      }),
    ).toMatchObject({ status: "complete", mergedProofs: 10, signedWallClockDurationMs: 10_000 });
  });
});
