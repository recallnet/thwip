import { afterEach, describe, expect, it } from "vitest";
import { seedActiveProject, testD1 } from "../../test/d1.js";
import { queueExternalMove } from "./external-move.js";
import { loadQueueState } from "./queue-state.js";
import type { D1Like } from "./projection.js";
import type { QueueRouteEnv } from "./routes.js";

/**
 * What happens once the queue is told its branch moved.
 *
 * The detector decides whether a push was the queue's own; this decides what to
 * do about one that was not. Pausing is the point — every turn the queue has
 * offered is against a base that no longer exists — and pausing wrongly is
 * expensive, so the cases where it must stay quiet are the ones worth pinning.
 */

const open: Array<{ close(): void }> = [];
let raw: import("better-sqlite3").Database;

function env(): QueueRouteEnv {
  const t = testD1();
  seedActiveProject(t, { repositoryId: REPO, organizationId: "org_1", projectId: "proj_1" });
  open.push(t);
  raw = t.raw;
  return { DB: t.db, PUBLIC_ORIGIN: "https://thwip.test" } as unknown as QueueRouteEnv;
}

afterEach(() => {
  while (open.length > 0) open.pop()!.close();
});

const REPO = "1315419165";
const REF = "refs/heads/main";
const MOVED = "e".repeat(40);

function queueConfigured() {
  raw
    .prepare(
      `INSERT INTO queue_projects (id, organization_id, github_repository_id, base_ref, enabled, activation_state, project_id)
       VALUES ('qp_1', 'org_1', ?, ?, 1, 'enforced', ?)`,
    )
    .run(REPO, REF, "proj_1");
}

async function state(e: QueueRouteEnv) {
  const loaded = await loadQueueState(e.DB as unknown as D1Like, REPO, REF);
  return loaded.store.state();
}

describe("being told the branch moved", () => {
  it("pauses the queue and demands a rebaseline", async () => {
    const e = env();
    queueConfigured();

    const result = await queueExternalMove(e, { repositoryId: REPO, baseRef: REF, observedBaseSha: MOVED });
    expect(result.handled).toBe(true);
    expect(result.detail).toContain(MOVED);

    const after = await state(e);
    expect(after.paused).toBe(true);
    expect(after.pauseReason).toBe("EXTERNAL_TRANSITION");
    expect(after.rebaselineRequired).toBe(true);
    expect(after.baseSha).toBe(MOVED);
  });

  /**
   * The move is recorded, and the signed chain is not touched.
   *
   * A link carrying `external:<sha>` used to go on the chain here. Nothing signs
   * it, so no reader can fetch it, and the queue names its chain head as
   * `previousTransitionDigest` in every assignment and merge intent it signs
   * afterwards — both validated against a protocol that only knows `sha256:`
   * digests. One hand-pushed commit therefore stopped the branch issuing any
   * further turn at all.
   */
  it("records the movement without extending the signed chain", async () => {
    const e = env();
    queueConfigured();
    await queueExternalMove(e, { repositoryId: REPO, baseRef: REF, observedBaseSha: MOVED });

    const after = await state(e);
    expect(after.baseSha).toBe(MOVED);
    expect(after.transitions).toEqual([]);
  });

  /**
   * Delivery is at-least-once, and pausing twice for one move would leave an
   * operator clearing the same thing repeatedly.
   */
  it("says the same thing twice without pausing twice", async () => {
    const e = env();
    queueConfigured();
    const first = await queueExternalMove(e, { repositoryId: REPO, baseRef: REF, observedBaseSha: MOVED });
    const second = await queueExternalMove(e, { repositoryId: REPO, baseRef: REF, observedBaseSha: MOVED });

    expect(first.handled).toBe(true);
    expect(second.handled).toBe(false);
    // One event applied, not two: the second delivery is a duplicate.
    expect((await state(e)).lastSequence).toBe(1);
  });

  it("stays quiet about a branch no queue guards", async () => {
    const e = env();
    // No row in queue_projects at all.
    const result = await queueExternalMove(e, { repositoryId: REPO, baseRef: REF, observedBaseSha: MOVED });
    expect(result).toMatchObject({ handled: false });
    expect(result.detail).toMatch(/no queue configured/i);
  });

  it("stays quiet about a branch whose queue is not enabled", async () => {
    const e = env();
    raw
      .prepare(
        `INSERT INTO queue_projects (id, organization_id, github_repository_id, base_ref, enabled, activation_state, project_id)
         VALUES ('qp_1', 'org_1', ?, ?, 0, 'configured', ?)`,
      )
      .run(REPO, REF, "proj_1");
    expect(await queueExternalMove(e, { repositoryId: REPO, baseRef: REF, observedBaseSha: MOVED })).toMatchObject(
      { handled: false },
    );
  });

  /**
   * The second line of defence behind the detector. If the queue already believes
   * the branch is here, this is its own merge arriving by another route, and
   * pausing for it would stop the queue every time it worked.
   */
  it("stays quiet when the branch is already where the queue thinks it is", async () => {
    const e = env();
    queueConfigured();
    await queueExternalMove(e, { repositoryId: REPO, baseRef: REF, observedBaseSha: MOVED });
    const before = (await state(e)).transitions.length;

    const again = await queueExternalMove(e, { repositoryId: REPO, baseRef: REF, observedBaseSha: MOVED });
    expect(again.handled).toBe(false);
    expect((await state(e)).transitions).toHaveLength(before);
  });
});
