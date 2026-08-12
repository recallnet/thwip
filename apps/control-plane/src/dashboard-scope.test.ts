import { afterEach, describe, expect, it } from "vitest";
import { testD1 } from "../test/d1.js";
import { projectsInReach } from "./dashboard-scope.js";
import { BOOTSTRAP_STEPS } from "./queue/rulesets.js";

/**
 * Which repositories the dashboard lists.
 *
 * It listed the selected organization's projects and nothing else, so somebody
 * invited to one repository signed in and saw an empty page with no way to
 * learn why. A grant is per repository and belongs to a person, so it is read
 * by GitHub user id and it reaches exactly the projects it names.
 */

const open: Array<{ close(): void }> = [];
let raw: import("better-sqlite3").Database;
let db: import("./queue/projection.js").D1Like;

function database(): void {
  const t = testD1();
  open.push(t);
  raw = t.raw;
  db = t.db;
}

afterEach(() => {
  while (open.length > 0) open.pop()!.close();
});

function seed(): void {
  raw.prepare("INSERT INTO organizations (id, github_org_id, github_login) VALUES (?, ?, ?)").run("org_acme", "10", "acme");
  raw.prepare("INSERT INTO organizations (id, github_org_id, github_login) VALUES (?, ?, ?)").run("org_bravo", "20", "bravo");
  for (const [id, org, repositoryId, name] of [
    ["proj_acme", "org_acme", "111", "acme/repo"],
    ["proj_acme_sibling", "org_acme", "222", "acme/other"],
    ["proj_bravo", "org_bravo", "333", "bravo/repo"],
  ] as const) {
    raw
      .prepare(
        "INSERT INTO projects (id, organization_id, github_repository_id, github_name, enabled) VALUES (?, ?, ?, ?, 1)",
      )
      .run(id, org, repositoryId, name);
  }
  raw
    .prepare(
      "INSERT INTO repository_grants (project_id, github_user_id, github_login, permission, active) VALUES (?, ?, ?, ?, 1)",
    )
    .run("proj_acme", "31", "olive", "triage");
}

async function names(reach: { organizationId: string | null; githubUserId: string }): Promise<string[]> {
  return (await projectsInReach(db, reach)).map((p) => p.github_name);
}

describe("the projects a viewer reaches", () => {
  it("lists every project of the organization they are a member of", async () => {
    database();
    seed();

    expect(await names({ organizationId: "org_acme", githubUserId: "11" })).toEqual(["acme/other", "acme/repo"]);
  });

  it("lists only the granted repository for somebody in no organization", async () => {
    database();
    seed();

    expect(await names({ organizationId: null, githubUserId: "31" })).toEqual(["acme/repo"]);
  });

  it("lists nothing for somebody in no organization with no grant", async () => {
    database();
    seed();

    expect(await names({ organizationId: null, githubUserId: "99" })).toEqual([]);
  });

  /** Belonging to one organization is not a way into another one's repositories. */
  it("does not list another organization's projects to a member", async () => {
    database();
    seed();

    expect(await names({ organizationId: "org_bravo", githubUserId: "21" })).toEqual(["bravo/repo"]);
  });

  it("adds a repository a member of another organization was separately invited to", async () => {
    database();
    seed();
    raw
      .prepare(
        "INSERT INTO repository_grants (project_id, github_user_id, github_login, permission, active) VALUES (?, ?, ?, ?, 1)",
      )
      .run("proj_acme_sibling", "21", "bruno", "write");

    expect(await names({ organizationId: "org_bravo", githubUserId: "21" })).toEqual(["acme/other", "bravo/repo"]);
  });

  it("does not list a repository whose grant was withdrawn", async () => {
    database();
    seed();
    raw.prepare("UPDATE repository_grants SET active = 0 WHERE github_user_id = '31'").run();

    expect(await names({ organizationId: null, githubUserId: "31" })).toEqual([]);
  });

  /** The row says how it was reached, so the dashboard can say so too. */
  it("says how each project was reached, and on what permission", async () => {
    database();
    seed();
    const rows = await projectsInReach(db, { organizationId: null, githubUserId: "31" });

    expect(rows[0]).toMatchObject({
      github_name: "acme/repo",
      organization_login: "acme",
      access: "collaborator",
      permission: "triage",
    });
  });

  it("says member for a project reached through the organization", async () => {
    database();
    seed();
    const rows = await projectsInReach(db, { organizationId: "org_acme", githubUserId: "11" });

    expect(rows.every((r) => r.access === "member")).toBe(true);
  });

  it("reports setup complete only after every durable bootstrap step completed", async () => {
    database();
    seed();
    raw
      .prepare(
        `INSERT INTO queue_projects
           (id, organization_id, github_repository_id, base_ref, bootstrap_progress_json)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run("queue_acme", "org_acme", "111", "refs/heads/main", JSON.stringify({ [BOOTSTRAP_STEPS[0]]: true }));

    const incomplete = await projectsInReach(db, { organizationId: "org_acme", githubUserId: "11" });
    expect(incomplete.find((project) => project.github_repository_id === "111")?.queue_setup_complete).toBe(false);

    const completeProgress = Object.fromEntries(BOOTSTRAP_STEPS.map((step) => [step, true]));
    raw
      .prepare("UPDATE queue_projects SET bootstrap_progress_json = ? WHERE id = ?")
      .run(JSON.stringify(completeProgress), "queue_acme");

    const complete = await projectsInReach(db, { organizationId: "org_acme", githubUserId: "11" });
    expect(complete.find((project) => project.github_repository_id === "111")?.queue_setup_complete).toBe(true);
  });
});
