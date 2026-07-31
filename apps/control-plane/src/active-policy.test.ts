import { afterEach, describe, expect, it } from "vitest";
import { testD1 } from "../test/d1.js";
import { readActivePolicy } from "./active-policy.js";
import type { D1Like } from "./queue/projection.js";

/**
 * What the queue is allowed to believe about a repository's policy.
 *
 * The security profile decides whether a merge needs the integrated candidate
 * run, and it was read from `projects.security_profile` — a column the
 * enrollment endpoint writes from whatever the caller sends, independently of
 * the policy bundle activated in the same call. The two drifted: the reviewed,
 * digested bundle for this repository said `fast`, the column said `fresh`, and
 * the column won. Every merge paid for a full candidate verification the policy
 * had never asked for.
 *
 * The bundle is the thing a person reviewed and the thing every signed record
 * binds by digest. It is the only honest source.
 */

const open: Array<{ close(): void }> = [];
let raw: import("better-sqlite3").Database;

function db(): D1Like {
  const t = testD1();
  open.push(t);
  raw = t.raw;
  return t.db as unknown as D1Like;
}

afterEach(() => {
  while (open.length > 0) open.pop()!.close();
});

const REPO = "1315419165";

function project(columnProfile: string, bundle: Record<string, unknown>) {
  const digest = `sha256:${"b".repeat(64)}`;
  raw.prepare("INSERT INTO organizations (id, github_org_id, github_login) VALUES ('org_1', '1', 'recallnet')").run();
  raw
    .prepare(
      `INSERT INTO projects (id, organization_id, github_repository_id, github_name, default_branch, enabled, active_policy_digest, security_profile)
       VALUES ('prj_1', 'org_1', ?, 'recallnet/thwip', 'main', 1, ?, ?)`,
    )
    .run(REPO, digest, columnProfile);
  raw
    .prepare(
      "INSERT INTO policy_bundles (digest, project_id, version, canonical_json, status) VALUES (?, 'prj_1', 4, ?, 'active')",
    )
    .run(digest, JSON.stringify(bundle));
  return digest;
}

const bundle = (over: Record<string, unknown> = {}) => ({
  schemaVersion: "1",
  securityProfile: "fast",
  pipeline: { digest: `sha256:${"c".repeat(64)}`, runner: "command", requiredSuites: ["lint", "test"] },
  ...over,
});

describe("the active policy", () => {
  it("takes the security profile from the activated bundle, not the column", async () => {
    const store = db();
    project("fresh", bundle({ securityProfile: "fast" }));

    const policy = await readActivePolicy(store, REPO);
    expect(policy?.securityProfile).toBe("fast");
  });

  it("still reports the suites and pipeline the bundle names", async () => {
    const store = db();
    project("fresh", bundle());

    const policy = await readActivePolicy(store, REPO);
    expect(policy?.requiredSuites).toEqual(["lint", "test"]);
    expect(policy?.pipelineDigest).toBe(`sha256:${"c".repeat(64)}`);
  });

  /**
   * A bundle with no profile cannot say what a merge has to satisfy. Falling back
   * to the column here would restore the very drift this removes, so there is no
   * active policy and the merge refuses rather than guessing.
   */
  it("reports no policy when the bundle names no profile", async () => {
    const store = db();
    const { securityProfile: _drop, ...withoutProfile } = bundle();
    project("fresh", withoutProfile);

    expect(await readActivePolicy(store, REPO)).toBeNull();
  });

  it("reports no policy for a repository it does not know", async () => {
    expect(await readActivePolicy(db(), "404")).toBeNull();
  });
});
