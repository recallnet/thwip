import { describe, expect, it } from "vitest";
import { testD1 } from "../test/d1.js";
import { principalForRepository, resolveRepositoryFor } from "./repository-resolution.js";

describe("repository name resolution", () => {
  it("resolves principals only inside the repository owner's organization", async () => {
    const t = testD1();
    try {
      t.raw.prepare("INSERT INTO organizations (id, github_org_id, github_login) VALUES ('a', '1', 'alpha')").run();
      t.raw.prepare("INSERT INTO organizations (id, github_org_id, github_login) VALUES ('b', '2', 'beta')").run();
      t.raw.prepare("INSERT INTO projects (id, organization_id, github_repository_id, github_name) VALUES ('pa', 'a', '10', 'alpha/repo')").run();
      t.raw.prepare("INSERT INTO principals (id, organization_id, github_user_id, github_login) VALUES ('foreign', 'b', '7', 'same')").run();
      await expect(principalForRepository(t.db, "10", "7")).resolves.toBeNull();
      t.raw.prepare("INSERT INTO principals (id, organization_id, github_user_id, github_login) VALUES ('exact', 'a', '7', 'same')").run();
      await expect(principalForRepository(t.db, "10", "7")).resolves.toBe("exact");
      t.raw.prepare("INSERT INTO project_release_requests (github_repository_id, project_id, organization_id, github_name, default_branch) VALUES ('10', 'pa', 'a', 'alpha/repo', 'main')").run();
      await expect(principalForRepository(t.db, "10", "7")).resolves.toBeNull();
    } finally {
      t.close();
    }
  });

  it("does not reveal another tenant, an inactive grant, or a releasing incarnation", async () => {
    const t = testD1();
    try {
      t.raw.prepare("INSERT INTO organizations (id, github_org_id, github_login) VALUES ('a', '1', 'alpha')").run();
      t.raw.prepare("INSERT INTO organizations (id, github_org_id, github_login) VALUES ('b', '2', 'beta')").run();
      t.raw.prepare("INSERT INTO projects (id, organization_id, github_repository_id, github_name) VALUES ('pa', 'a', '10', 'alpha/repo')").run();
      t.raw.prepare("INSERT INTO projects (id, organization_id, github_repository_id, github_name) VALUES ('pb', 'b', '20', 'beta/private')").run();
      t.raw.prepare("INSERT INTO repository_grants (project_id, github_user_id, github_login, permission, active) VALUES ('pa', 'alice', 'alice', 'admin', 1)").run();
      t.raw.prepare("INSERT INTO repository_grants (project_id, github_user_id, github_login, permission, active) VALUES ('pb', 'bob', 'bob', 'write', 1)").run();

      await expect(resolveRepositoryFor(t.db, { kind: "user", githubUserId: "alice" }, "beta/private"))
        .resolves.toBeNull();
      await expect(resolveRepositoryFor(t.db, { kind: "user", githubUserId: "bob" }, "beta/private"))
        .resolves.toEqual({ ownerId: "2", repositoryId: "20", projectId: "pb" });

      t.raw.prepare("UPDATE repository_grants SET active = 0 WHERE project_id = 'pb'").run();
      await expect(resolveRepositoryFor(t.db, { kind: "user", githubUserId: "bob" }, "beta/private"))
        .resolves.toBeNull();
      t.raw.prepare("UPDATE repository_grants SET active = 1 WHERE project_id = 'pb'").run();
      t.raw.prepare("INSERT INTO project_release_requests (github_repository_id, project_id, organization_id, github_name, default_branch) VALUES ('20', 'pb', 'b', 'beta/private', 'main')").run();
      await expect(resolveRepositoryFor(t.db, { kind: "user", githubUserId: "bob" }, "beta/private"))
        .resolves.toBeNull();
      await expect(resolveRepositoryFor(t.db, { kind: "admin" }, "beta/private"))
        .resolves.toBeNull();
    } finally {
      t.close();
    }
  });
});
