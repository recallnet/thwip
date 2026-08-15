import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  deriveProjectConfig,
  parseThwipYaml,
  repositoryDirectoryPrefix,
  type RepositorySnapshot,
} from "@thwip/policy";
import {
  activatePolicyFromDefaultBranchPush,
  policyPushFromGithubWebhook,
  reconcileInstallationPolicies,
  type PolicyActivationDependencies,
} from "./policy-activation.js";
import { projectPolicyState } from "./policy-state.js";
import type { Env } from "./env.js";

class MemorySnapshot implements RepositorySnapshot {
  private readonly files = new Map<string, Uint8Array>();

  constructor(files: Record<string, string>) {
    const encoder = new TextEncoder();
    for (const [path, content] of Object.entries(files)) this.files.set(path, encoder.encode(content));
  }

  async hasFile(path: string): Promise<boolean> {
    return this.files.has(path);
  }

  async listFiles(path: string): Promise<string[]> {
    const prefix = repositoryDirectoryPrefix(path);
    return [...this.files.keys()].filter((candidate) => candidate.startsWith(prefix));
  }

  async readFile(path: string): Promise<Uint8Array> {
    const bytes = this.files.get(path);
    if (bytes === undefined) throw new Error(`missing ${path}`);
    return bytes;
  }
}

class BoundStatement {
  private values: unknown[] = [];

  constructor(
    private readonly database: Database.Database,
    private readonly sql: string,
  ) {}

  bind(...values: unknown[]): BoundStatement {
    this.values = values;
    return this;
  }

  first<T>(): T | null {
    return (this.database.prepare(this.sql).get(...this.values) as T | undefined) ?? null;
  }

  all<T>(): { results: T[] } {
    return { results: this.database.prepare(this.sql).all(...this.values) as T[] };
  }

  run(): { meta: { changes: number } } {
    const result = this.database.prepare(this.sql).run(...this.values);
    return { meta: { changes: result.changes } };
  }
}

class TestD1 {
  constructor(readonly database: Database.Database) {}

  prepare(sql: string): BoundStatement {
    return new BoundStatement(this.database, sql);
  }

  batch(statements: BoundStatement[]): unknown[] {
    return this.database.transaction(() => statements.map((statement) => statement.run()))();
  }
}

const databases: Database.Database[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function fixture(): { database: Database.Database; env: Env } {
  const database = new Database(":memory:");
  databases.push(database);
  database.exec(`
    CREATE TABLE organizations (
      id TEXT PRIMARY KEY,
      github_org_id TEXT NOT NULL UNIQUE,
      github_login TEXT NOT NULL,
      installation_id TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      proof_defaults_json TEXT
    );
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      github_repository_id TEXT NOT NULL UNIQUE,
      github_name TEXT NOT NULL,
      default_branch TEXT NOT NULL DEFAULT 'main',
      enabled INTEGER NOT NULL DEFAULT 0,
      active_policy_digest TEXT,
      security_profile TEXT NOT NULL DEFAULT 'fast'
    );
    CREATE TABLE project_release_jobs (
      github_repository_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL UNIQUE,
      organization_id TEXT NOT NULL,
      github_name TEXT NOT NULL,
      default_branch TEXT NOT NULL
    );
    CREATE TABLE project_release_requests (
      github_repository_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL UNIQUE,
      organization_id TEXT NOT NULL,
      github_name TEXT NOT NULL,
      default_branch TEXT NOT NULL
    );
    CREATE TABLE project_write_leases (
      github_repository_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      owner_token TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      PRIMARY KEY (github_repository_id, owner_token)
    );
    CREATE TABLE policy_bundles (
      digest TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      canonical_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'candidate',
      activated_at TEXT,
      source_ref TEXT,
      source_sha TEXT,
      config_source TEXT NOT NULL DEFAULT 'repository'
    );
    INSERT INTO organizations (id, github_org_id, github_login, installation_id)
    VALUES ('org_1', '10', 'recallnet', 'installation_1');
    INSERT INTO projects (id, organization_id, github_repository_id, github_name, default_branch)
    VALUES ('project_1', 'org_1', '20', 'example/project', 'main');
  `);
  const d1 = new TestD1(database);
  // Activation re-verifies every open head under the policy it just activated,
  // so a test env has to carry the queue that carries that message.
  const reconciled: Array<Record<string, unknown>> = [];
  return {
    database,
    reconciled,
    env: {
      DB: d1,
      SYNC_QUEUE: { send: async (m: Record<string, unknown>) => void reconciled.push(m) },
    } as unknown as Env,
  };
}

describe("first-policy activation lifecycle", () => {
  it("routes default-branch push and protected merge deliveries to activation", () => {
    const sha = "a".repeat(40);
    expect(
      policyPushFromGithubWebhook("push", {
        repository: { id: 20 },
        ref: "refs/heads/main",
        after: sha,
      }),
    ).toEqual({ repositoryId: "20", ref: "refs/heads/main", after: sha });
    expect(
      policyPushFromGithubWebhook("pull_request", {
        action: "closed",
        pull_request: {
          merged: true,
          merge_commit_sha: sha,
          base: { ref: "main", repo: { id: 20 } },
        },
      }),
    ).toEqual({ repositoryId: "20", ref: "refs/heads/main", after: sha });
    expect(
      policyPushFromGithubWebhook("pull_request", {
        action: "closed",
        pull_request: { merged: false },
      }),
    ).toBeNull();
  });

  it("moves import → enable → bootstrap → canonical activation, idempotently", async () => {
    const { database, env, reconciled } = fixture();
    const sha1 = "a".repeat(40);
    const sha2 = "b".repeat(40);
    const yaml1 = `
version: 1
profile: fast
required: [test]
suites:
  test: npm test
`;
    const yaml2 = yaml1.replace("version: 1", "version: 2").replace("profile: fast", "profile: remote");
    const snapshots = new Map<string, RepositorySnapshot>([
      [sha1, new MemorySnapshot({ "thwip.yaml": yaml1 })],
      [sha2, new MemorySnapshot({ "thwip.yaml": yaml2 })],
    ]);
    let currentSha = sha1;
    const dependencies: PolicyActivationDependencies = {
      installationToken: async () => "token",
      currentCommitSha: async () => currentSha,
      loadSnapshot: async (_token, _repository, sha) => snapshots.get(sha)!,
    };

    expect(projectPolicyState({ enabled: 0, active_policy_digest: null })).toEqual({
      kind: "disabled",
      code: "PROJECT_DISABLED",
    });
    database.prepare("UPDATE projects SET enabled = 1 WHERE id = 'project_1'").run();
    expect(projectPolicyState({ enabled: 1, active_policy_digest: null })).toEqual({
      kind: "bootstrap_pending",
      code: "POLICY_AWAITING_FIRST_MERGE",
    });

    const candidateOnly = await activatePolicyFromDefaultBranchPush(
      env,
      { repositoryId: "20", ref: "refs/pull/490/head", after: sha1 },
      dependencies,
    );
    expect(candidateOnly).toEqual({ status: "ignored", reason: "push is not for the default branch" });
    expect(database.prepare("SELECT active_policy_digest FROM projects").get()).toEqual({
      active_policy_digest: null,
    });

    const first = await activatePolicyFromDefaultBranchPush(
      env,
      { repositoryId: "20", ref: "refs/heads/main", after: sha1 },
      dependencies,
    );
    const expectedFirst = await deriveProjectConfig(
      parseThwipYaml(yaml1),
      { ownerId: "10", repositoryId: "20" },
      snapshots.get(sha1)!,
    );
    expect(first).toEqual({
      status: "activated",
      digest: expectedFirst.policyDigest,
      version: 1,
      sourceSha: sha1,
    });
    expect(database.prepare("SELECT active_policy_digest, security_profile FROM projects").get()).toEqual({
      active_policy_digest: expectedFirst.policyDigest,
      security_profile: "fast",
    });
    expect(database.prepare("SELECT status, source_ref, source_sha FROM policy_bundles").get()).toEqual({
      status: "active",
      source_ref: "refs/heads/main",
      source_sha: sha1,
    });

    const activatedAt = (
      database.prepare("SELECT activated_at FROM policy_bundles WHERE digest = ?").get(expectedFirst.policyDigest) as {
        activated_at: string;
      }
    ).activated_at;
    const duplicate = await activatePolicyFromDefaultBranchPush(
      env,
      { repositoryId: "20", ref: "refs/heads/main", after: sha1 },
      dependencies,
    );
    expect(duplicate).toEqual({ status: "unchanged", digest: expectedFirst.policyDigest, sourceSha: sha1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM policy_bundles").get()).toEqual({ count: 1 });
    expect(
      (
        database.prepare("SELECT activated_at FROM policy_bundles WHERE digest = ?").get(expectedFirst.policyDigest) as {
          activated_at: string;
        }
      ).activated_at,
    ).toBe(activatedAt);

    const proposedUpdate = await activatePolicyFromDefaultBranchPush(
      env,
      { repositoryId: "20", ref: "refs/pull/491/head", after: sha2 },
      dependencies,
    );
    expect(proposedUpdate.status).toBe("ignored");
    expect(database.prepare("SELECT active_policy_digest FROM projects").get()).toEqual({
      active_policy_digest: expectedFirst.policyDigest,
    });

    currentSha = sha2;
    const second = await activatePolicyFromDefaultBranchPush(
      env,
      { repositoryId: "20", ref: "refs/heads/main", after: sha2 },
      dependencies,
    );
    const expectedSecond = await deriveProjectConfig(
      parseThwipYaml(yaml2),
      { ownerId: "10", repositoryId: "20" },
      snapshots.get(sha2)!,
    );
    expect(second).toEqual({
      status: "activated",
      digest: expectedSecond.policyDigest,
      version: 2,
      sourceSha: sha2,
    });
    expect(
      database.prepare("SELECT digest, status FROM policy_bundles ORDER BY version").all(),
    ).toEqual([
      { digest: expectedFirst.policyDigest, status: "retired" },
      { digest: expectedSecond.policyDigest, status: "active" },
    ]);

    // Each activation asks for the open heads to be judged again. Without this
    // a head keeps the green check it earned under the policy that was retired,
    // and the merge gate refuses it with nothing on the way to clear it.
    expect(reconciled.map((message) => message["event"])).toEqual(["proof_reconcile", "proof_reconcile"]);
    expect(reconciled.every((message) => message["reconcileProofRepositoryId"] === "20")).toBe(true);
    // The push that changed nothing enqueued nothing.
    expect(reconciled).toHaveLength(2);
  });

  it("activates organization defaults and lets canonical repository yaml override them", async () => {
    const { database, env } = fixture();
    const sha1 = "c".repeat(40);
    const sha2 = "d".repeat(40);
    const sha3 = "e".repeat(40);
    const defaults = {
      version: 1,
      profile: "fast",
      required: ["lint", "test"],
      suites: { lint: "npm run lint", test: "npm test" },
      policy: { minimum_permission: "maintain", allow_author_as_signer: true },
    };
    database
      .prepare("UPDATE organizations SET proof_defaults_json = ? WHERE id = 'org_1'")
      .run(JSON.stringify(defaults));
    database.prepare("UPDATE projects SET enabled = 1 WHERE id = 'project_1'").run();

    const repositoryOverride =
      "version: 2\nprofile: remote\nrequired: [test]\npolicy:\n  allow_author_as_signer: false\n";
    const snapshots = new Map<string, RepositorySnapshot>([
      [sha1, new MemorySnapshot({ "package-lock.json": "{}" })],
      [
        sha2,
        new MemorySnapshot({
          "package-lock.json": "{}",
          "thwip.yaml": repositoryOverride,
        }),
      ],
      [sha3, new MemorySnapshot({ "package-lock.json": "{}", "thwip.yaml": repositoryOverride })],
    ]);
    let currentSha = sha1;
    const dependencies: PolicyActivationDependencies = {
      installationToken: async () => "token",
      currentCommitSha: async () => currentSha,
      loadSnapshot: async (_token, _repository, sha) => snapshots.get(sha)!,
    };

    const global = await activatePolicyFromDefaultBranchPush(
      env,
      { repositoryId: "20", ref: "refs/heads/main", after: sha1 },
      dependencies,
    );
    expect(global.status).toBe("activated");
    expect(database.prepare("SELECT config_source FROM policy_bundles WHERE status = 'active'").get()).toEqual({
      config_source: "global",
    });
    expect(
      JSON.parse(
        (
          database.prepare("SELECT canonical_json FROM policy_bundles WHERE status = 'active'").get() as {
            canonical_json: string;
          }
        ).canonical_json,
      ),
    ).toMatchObject({
      securityProfile: "fast",
      minimumPermission: "maintain",
      pipeline: { requiredSuites: ["lint", "test"] },
    });

    currentSha = sha2;
    const overridden = await activatePolicyFromDefaultBranchPush(
      env,
      { repositoryId: "20", ref: "refs/heads/main", after: sha2 },
      dependencies,
    );
    expect(overridden.status).toBe("activated");
    expect(database.prepare("SELECT config_source FROM policy_bundles WHERE status = 'active'").get()).toEqual({
      config_source: "repository-override",
    });
    expect(
      JSON.parse(
        (
          database.prepare("SELECT canonical_json FROM policy_bundles WHERE status = 'active'").get() as {
            canonical_json: string;
          }
        ).canonical_json,
      ),
    ).toMatchObject({
      version: 2,
      securityProfile: "remote",
      minimumPermission: "maintain",
      allowAuthorAsSigner: false,
      pipeline: { requiredSuites: ["test"] },
    });

    database
      .prepare("UPDATE organizations SET proof_defaults_json = ? WHERE id = 'org_1'")
      .run(JSON.stringify({ ...defaults, policy: { ...defaults.policy, minimum_permission: "admin" } }));
    currentSha = sha3;
    const layeredUpdate = await activatePolicyFromDefaultBranchPush(
      env,
      { repositoryId: "20", ref: "refs/heads/main", after: sha3 },
      dependencies,
    );
    expect(layeredUpdate).toMatchObject({ status: "activated", version: 2 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM policy_bundles WHERE version = 2").get()).toEqual({
      count: 2,
    });
  });

  it("ignores a stale delivery instead of rolling policy back", async () => {
    const { env } = fixture();
    const staleSha = "a".repeat(40);
    const currentSha = "b".repeat(40);
    const dependencies: PolicyActivationDependencies = {
      installationToken: async () => "token",
      currentCommitSha: async () => currentSha,
      loadSnapshot: async () => {
        throw new Error("stale content must not be loaded");
      },
    };
    (env.DB.prepare("UPDATE projects SET enabled = 1 WHERE id = 'project_1'") as unknown as BoundStatement).run();
    await expect(
      activatePolicyFromDefaultBranchPush(
        env,
        { repositoryId: "20", ref: "refs/heads/main", after: staleSha },
        dependencies,
      ),
    ).resolves.toEqual({ status: "ignored", reason: "a newer default-branch commit already exists" });
  });

  it("rechecks the moving default branch during reconciliation", async () => {
    const { env } = fixture();
    const staleSha = "a".repeat(40);
    const currentSha = "b".repeat(40);
    let refReads = 0;
    const dependencies: PolicyActivationDependencies = {
      installationToken: async () => "token",
      currentCommitSha: async () => (++refReads === 1 ? staleSha : currentSha),
      loadSnapshot: async () => {
        throw new Error("stale content must not be loaded");
      },
    };
    (env.DB.prepare("UPDATE projects SET enabled = 1 WHERE id = 'project_1'") as unknown as BoundStatement).run();
    await expect(reconcileInstallationPolicies(env, "installation_1", dependencies)).resolves.toEqual([
      { status: "ignored", reason: "a newer default-branch commit already exists" },
    ]);
  });
});
