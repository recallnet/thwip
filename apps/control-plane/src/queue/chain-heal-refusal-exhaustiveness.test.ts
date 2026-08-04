import { afterEach, describe, expect, it, vi } from "vitest";
import { testD1 } from "../../test/d1.js";
import type { QueueRouteEnv } from "./routes.js";
import type { HealDeps } from "./chain-heal.js";
import type { SelfCheckFinding } from "./chain-self-check.js";

/**
 * `authorizationFor` refuses with one of three codes. `planHeal` matches
 * `AMBIGUOUS_ATTEMPT` and `INTENTS_DISAGREE` by name; anything else used to
 * fall through to `record-movement`, so a fourth refusal code would compile
 * clean and silently plan a signed movement claim for a commit whose refusal
 * nobody actually read. This forces that fourth code past the type system,
 * the way a change to `AuthorizationRefusal.code` would, and checks the
 * planner refuses to guess.
 */
vi.mock("./attestation.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./attestation.js")>();
  return {
    ...actual,
    authorizationFor: vi.fn(async () => ({
      refused: "a refusal code planHeal has never seen",
      code: "SOMETHING_NEW" as unknown as "NO_INTENT",
      attemptIds: [],
      intentDigests: [],
    })),
  };
});

const { planHeal } = await import("./chain-heal.js");

const open: Array<{ close(): void }> = [];
function env(): QueueRouteEnv {
  const t = testD1();
  open.push(t);
  return { DB: t.db, PUBLIC_ORIGIN: "https://thwip.test" } as unknown as QueueRouteEnv;
}
afterEach(() => {
  while (open.length > 0) open.pop()!.close();
});

const REPO = "1315419165";
const REF = "refs/heads/main";

const GAP_FROM = "a".repeat(40);
const GAP_TO = "b".repeat(40);

const deps: HealDeps<QueueRouteEnv> = {
  // One commit in the gap, whose only parent is the near end, so the walk
  // reaches `gap.from` after a single read and calls `authorizationFor` once.
  commitFacts: async (_e, _r, sha) => ({ treeOid: `tree-${sha}`, parentShas: [GAP_FROM] }),
};

const finding: SelfCheckFinding = {
  code: "BASE_DISCONTINUITY",
  sequence: 10,
  digest: `sha256:${"a".repeat(64)}`,
  detail: "the branch moved and no record accounts for it",
  gap: { from: GAP_FROM, to: GAP_TO },
};

describe("planHeal against a refusal code it does not recognize", () => {
  it("throws rather than silently planning a movement record for it", async () => {
    const e = env();

    await expect(
      planHeal(e, e.DB as unknown as import("./projection.js").D1Like, deps, {
        repositoryId: REPO,
        baseRef: REF,
        finding,
      }),
    ).rejects.toThrow(/SOMETHING_NEW/);
  });
});
