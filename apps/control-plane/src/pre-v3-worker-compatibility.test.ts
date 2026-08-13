import { afterEach, describe, expect, it } from "vitest";
import { seedActiveProject, testD1, type TestD1 } from "../test/d1.js";
import { runPrivateFeedbackRetention } from "./private-agent-feedback.js";
import {
  candidateDispatchBindingV2,
  candidateVerdict,
  claimCandidateDispatchV2,
  claimPendingCandidateReports,
  recordCandidateVerdictV2,
} from "./queue/candidate-store.js";
import { readQueueProject } from "./queue/bootstrap.js";
import { readQueueDoctorReadiness } from "./queue/doctor-readiness.js";

const REPOSITORY = "1315419165";
const PROJECT = "project_compat";
const ORG = "organization_compat";
const BASE = "refs/heads/main";
const TREE = "a".repeat(40);
const SHA = "b".repeat(40);
const BASE_SHA = "c".repeat(40);
const open: TestD1[] = [];

afterEach(() => {
  while (open.length > 0) open.pop()!.close();
});

function phaseOne(): TestD1 {
  const test = testD1({ upTo: "0031_finish_github_repository_lifecycle.sql", rollout: "as-migrated" });
  open.push(test);
  seedActiveProject(test, { repositoryId: REPOSITORY, projectId: PROJECT, organizationId: ORG });
  test.raw.prepare(
    `INSERT INTO queue_projects
       (id, organization_id, github_repository_id, base_ref, enabled, activation_state,
        bootstrap_progress_json, project_id, verifier_workflow_version)
     VALUES ('queue_compat', ?, ?, ?, 1, 'enforced', '{}', ?, 2)`,
  ).run(ORG, REPOSITORY, BASE, PROJECT);
  return test;
}

describe("the current Worker on the preparatory schema through 0030", () => {
  it("keeps the v2 queue read, dispatch, verdict, doctor, and dark jobs healthy", async () => {
    const test = phaseOne();
    await expect(readQueueProject(test.db, REPOSITORY, BASE)).resolves.toMatchObject({
      projectId: PROJECT,
      verifierWorkflowVersion: 2,
      verifierProtocol: 2,
    });
    await expect(readQueueDoctorReadiness(test.db, REPOSITORY, BASE)).resolves.toMatchObject({
      projectId: PROJECT,
      queueConfigured: true,
    });
    await expect(claimCandidateDispatchV2(
      test.db, REPOSITORY, BASE, PROJECT, "attempt_compat", 2, TREE,
      "2026-08-13T12:00:00.000Z", 60_000,
    )).resolves.toBe(true);
    await expect(candidateDispatchBindingV2(test.db, REPOSITORY, BASE, TREE, PROJECT)).resolves.toEqual({
      projectId: PROJECT,
      attemptId: "attempt_compat",
      workflowProtocol: 2,
    });
    const verdict = {
      candidateTreeOid: TREE,
      candidateSha: SHA,
      baseSha: BASE_SHA,
      pullRequestNumber: 1,
      accepted: true,
      resultDigest: `sha256:${"d".repeat(64)}`,
      policyDigest: `sha256:${"e".repeat(64)}`,
      suites: [{ name: "test", outcome: "passed" as const, durationMs: 1 }],
      reasonCodes: [],
      workflowRef: "recallnet/thwip/.github/workflows/verify.yml@refs/heads/main",
      workflowSha: SHA,
      runId: "123",
      observedAt: "2026-08-13T12:01:00.000Z",
    };
    await expect(recordCandidateVerdictV2(test.db, REPOSITORY, BASE, PROJECT, verdict))
      .resolves.toEqual({ status: "applied" });
    await expect(candidateVerdict(test.db, REPOSITORY, BASE, TREE, PROJECT)).resolves.toMatchObject({
      resultDigest: verdict.resultDigest,
    });
    await expect(claimPendingCandidateReports(
      test.db, "claim", "2026-08-13T12:02:00.000Z", "2026-08-13T12:03:00.000Z", 5,
    )).resolves.toEqual([]);
    await expect(runPrivateFeedbackRetention(test.db, new Date("2026-08-13T12:02:00.000Z"))).resolves.toEqual({
      skipped: true,
      privateRootsDeleted: 0,
      receiptsDeleted: 0,
    });
  });
});
