import { afterEach, describe, expect, it } from "vitest";
import type { Env } from "./env.js";
import { reconcileInstalledProjects } from "./project-lifecycle.js";
import { testD1, type TestD1 } from "../test/d1.js";
import { recordVerificationObservation } from "./verification-observation.js";

const REPOSITORY_ID = "901";
const ORGANIZATION_ID = "org_observation";
const OLD_PROJECT_ID = "project_observation_old";

describe("verification observation project incarnation", () => {
  let test: TestD1;
  afterEach(() => test?.close());

  it("rejects a delayed Action result after clean removal and re-selection", async () => {
    test = testD1();
    test.raw
      .prepare(
        `INSERT INTO organizations (id, github_org_id, github_login, status)
         VALUES (?, '501', 'example', 'active')`,
      )
      .run(ORGANIZATION_ID);
    test.raw
      .prepare(
        `INSERT INTO projects
           (id, organization_id, github_repository_id, github_name, default_branch, enabled)
         VALUES (?, ?, ?, 'example/repository', 'main', 1)`,
      )
      .run(OLD_PROJECT_ID, ORGANIZATION_ID, REPOSITORY_ID);
    const env = {
      DB: test.db,
      EVIDENCE: { list: async () => ({ objects: [], truncated: false }), delete: async () => undefined },
      BRANCH_QUEUE: { idFromName: (name: string) => name, get: () => ({ purge: async () => undefined }) },
    } as unknown as Pick<Env, "DB" | "EVIDENCE" | "BRANCH_QUEUE">;
    const observation = {
      repositoryId: REPOSITORY_ID,
      projectId: OLD_PROJECT_ID,
      headSha: "a".repeat(40),
      outcome: "PASS",
      runId: "42",
    };

    await expect(recordVerificationObservation(test.db, observation)).resolves.toBe(true);
    await reconcileInstalledProjects(env, ORGANIZATION_ID, []);
    await reconcileInstalledProjects(env, ORGANIZATION_ID, [
      { id: REPOSITORY_ID, fullName: "example/repository", defaultBranch: "main" },
    ], { now: () => new Date(Date.now() + 2 * 60 * 60_000) });
    const current = test.raw
      .prepare("SELECT id, enabled FROM projects WHERE github_repository_id = ?")
      .get(REPOSITORY_ID) as { id: string; enabled: number };
    expect(current.id).not.toBe(OLD_PROJECT_ID);
    expect(current.enabled).toBe(0);

    await expect(recordVerificationObservation(test.db, observation)).resolves.toBe(false);
    expect(test.raw.prepare("SELECT COUNT(*) AS count FROM verification_observations").get()).toEqual({ count: 0 });
  });
});
