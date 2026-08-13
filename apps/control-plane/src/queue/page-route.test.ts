import { afterEach, describe, expect, it } from "vitest";
import { queueRouteDeps } from "../../test/queue-deps.js";
import { testD1 } from "../../test/d1.js";
import { queueRoutes, type QueueRouteEnv } from "./routes.js";

const REPO = "1315419165";
const REF = "refs/heads/main";
const open: Array<{ close(): void }> = [];

afterEach(() => {
  while (open.length > 0) open.pop()!.close();
});

describe("GET /v1/queue/:repositoryId paging", () => {
  it("returns independent 20-row pages and rejects invalid selectors", async () => {
    const t = testD1();
    open.push(t);
    const raw = t.raw;
    raw.prepare("INSERT INTO organizations (id, github_org_id, github_login) VALUES ('org', '1', 'acme')").run();
    raw.prepare(
      "INSERT INTO projects (id, organization_id, github_repository_id, github_name, enabled) VALUES ('project', 'org', ?, 'acme/repo', 1)",
    ).run(REPO);
    raw.prepare(
      "INSERT INTO principals (id, organization_id, github_user_id, github_login, activated_at) VALUES ('alice', 'org', '1', 'alice', datetime('now'))",
    ).run();
    raw.prepare(
      `INSERT INTO queue_projection_marks
         (github_repository_id, base_ref, generation, projected_at, active_attempt_id, paused,
          pause_reason, rebaseline_required, base_sha, queue_epoch, project_id)
       VALUES (?, ?, 7, datetime('now'), NULL, 0, NULL, 0, ?, 0, 'project')`,
    ).run(REPO, REF, "a".repeat(40));

    const insertEntry = raw.prepare(
      `INSERT INTO queue_entries_index
         (id, github_repository_id, base_ref, entry_id, pull_request_number, sponsor_principal_id,
          state, primary_reason, fairness_ordinal, scheduler_eligible, cooldown_until, last_attempt_id,
          head_sha, generation, project_id)
       VALUES (?, ?, ?, ?, ?, 'alice', 'Ready', NULL, ?, 1, NULL, ?, ?, 7, 'project')`,
    );
    const insertTransition = raw.prepare(
      `INSERT INTO queue_transitions_index
         (id, github_repository_id, base_ref, queue_epoch, transition_sequence, kind, digest,
          prior_digest, base_sha, attempt_id, witness_count, observed_at, project_id)
       VALUES (?, ?, ?, 0, ?, 'verified', ?, ?, ?, ?, 1, NULL, 'project')`,
    );
    for (let sequence = 1; sequence <= 45; sequence += 1) {
      const attempt = `att-${sequence}`;
      insertEntry.run(
        `entry-row-${sequence}`,
        REPO,
        REF,
        `entry-${sequence}`,
        100 + sequence,
        String(sequence),
        attempt,
        sequence.toString(16).padStart(40, "f"),
      );
      insertTransition.run(
        `transition-row-${sequence}`,
        REPO,
        REF,
        sequence,
        `sha256:${sequence.toString(16).padStart(64, "0")}`,
        sequence === 1 ? null : `sha256:${(sequence - 1).toString(16).padStart(64, "0")}`,
        sequence.toString(16).padStart(40, "0"),
        attempt,
      );
    }

    const app = queueRoutes(queueRouteDeps({ repositoryId: REPO }));
    const env = { DB: t.db, PUBLIC_ORIGIN: "https://thwip.test" } as unknown as QueueRouteEnv;
    const response = await app.request(
      `/v1/queue/${REPO}?ref=${encodeURIComponent(REF)}&entriesPage=2&transitionsPage=3`,
      {},
      env,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      entries: Array<{ pullRequestNumber: number }>;
      transitions: Array<{ transitionSequence: number; pullRequestNumber: number }>;
      pagination: Record<string, unknown>;
      chainHead: { sequence: number };
    };
    expect(body.entries).toHaveLength(20);
    expect(body.entries[0]?.pullRequestNumber).toBe(121);
    expect(body.transitions.map((row) => row.transitionSequence)).toEqual([5, 4, 3, 2, 1]);
    expect(body.transitions.map((row) => row.pullRequestNumber)).toEqual([105, 104, 103, 102, 101]);
    expect(body.pagination).toEqual({
      entries: { page: 2, pageSize: 20, total: 45, totalPages: 3 },
      transitions: { page: 3, pageSize: 20, total: 45, totalPages: 3 },
    });
    expect(body.chainHead.sequence).toBe(45);

    const invalid = await app.request(
      `/v1/queue/${REPO}?ref=${encodeURIComponent(REF)}&entriesPage=0&transitionsPage=1`,
      {},
      env,
    );
    expect(invalid.status).toBe(400);
  });
});
