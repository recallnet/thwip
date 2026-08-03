import { afterEach, describe, expect, it, vi } from "vitest";
import { testD1 } from "../../test/d1.js";
import { GITHUB_READS } from "./deadlines.js";
import type { QueueRouteEnv } from "./routes.js";

/**
 * Naming the pull request a stranded merge write belonged to.
 *
 * The four writes that stranded on 2 August 2026 carry no pull request number:
 * they were written before the row had one. Nothing else on the row can name the
 * pull request, so the sweep asks git, through
 * `GET /repos/{owner}/{repo}/commits/{sha}/pulls`, which answers with the pull
 * requests associated with a commit. The head commit the write pinned is the sha
 * it asks about.
 */

// The App's installation token is a signed JWT and a round trip to GitHub.
vi.mock("../github-app.js", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  installationToken: async () => "installation-token",
}));

const open: Array<{ close(): void }> = [];
let raw: import("better-sqlite3").Database;

const REPO = "1315419165";
const HEAD = "b2".repeat(20);

function env(): QueueRouteEnv {
  const t = testD1();
  open.push(t);
  raw = t.raw;
  raw
    .prepare("INSERT INTO organizations (id, github_org_id, github_login, installation_id) VALUES (?, ?, ?, ?)")
    .run("org_1", "1", "recallnet", "9001");
  raw
    .prepare(
      `INSERT INTO projects (id, organization_id, github_repository_id, github_name, default_branch, enabled)
       VALUES ('prj_1', 'org_1', ?, 'recallnet/thwip', 'main', 1)`,
    )
    .run(REPO);
  return { DB: t.db, PUBLIC_ORIGIN: "https://thwip.test" } as unknown as QueueRouteEnv;
}

afterEach(() => {
  vi.unstubAllGlobals();
  while (open.length > 0) open.pop()!.close();
});

/** Answer one GitHub path and record what was asked for. */
function github(body: unknown, status = 200): { asked: string[] } {
  const asked: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    asked.push(String(input));
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  });
  return { asked };
}

describe("the pull requests a commit belongs to", () => {
  it("asks the commits endpoint about the head sha and reads each number", async () => {
    const e = env();
    const seen = github([{ number: 117, state: "closed" }]);
    expect(await GITHUB_READS.pullRequestNumbersForCommit(e, REPO, HEAD)).toEqual([117]);
    expect(seen.asked[0]).toBe(`https://api.github.com/repos/recallnet/thwip/commits/${HEAD}/pulls`);
  });

  /** The endpoint answers with an array, and an empty one is a real answer. */
  it("reports no pull request rather than guessing when the commit belongs to none", async () => {
    const e = env();
    github([]);
    expect(await GITHUB_READS.pullRequestNumbersForCommit(e, REPO, HEAD)).toEqual([]);
  });

  it("reports every number when a commit belongs to more than one pull request", async () => {
    const e = env();
    github([{ number: 117 }, { number: 121 }]);
    expect(await GITHUB_READS.pullRequestNumbersForCommit(e, REPO, HEAD)).toEqual([117, 121]);
  });

  /**
   * A read that failed is not an answer. Null keeps it apart from the empty
   * array, so a sweep retries instead of concluding the commit belongs to
   * nothing.
   */
  it("says nothing at all when GitHub refuses the read", async () => {
    const e = env();
    github({ message: "Not Found" }, 404);
    expect(await GITHUB_READS.pullRequestNumbersForCommit(e, REPO, HEAD)).toBeNull();
  });
});
