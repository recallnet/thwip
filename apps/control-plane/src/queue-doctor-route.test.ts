import { exportPKCS8, generateKeyPair } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testD1, type TestD1 } from "../test/d1.js";
import worker from "./index.js";
import { REQUIRED_APP_PERMISSIONS } from "./app-permissions.js";
import { REQUIRED_WEBHOOK_EVENTS } from "./github-events.js";
import type { Env } from "./env.js";
import {
  appOwnershipRuleset,
  GITHUB_ACTIONS_INTEGRATION_ID,
  policyRuleset,
  type Ruleset,
} from "./queue/rulesets.js";
import { QUEUE_ACTION_REF, setupPullRequestFiles } from "./queue/bootstrap-workflows.js";

vi.mock("./queue/BranchQueue.js", () => ({ BranchQueue: class {} }));

const REPO = "1315419165";
const NAME = "acme/repo";
const APP_ID = 31415;
const ADMIN = "operator-token";
const REF = "refs/heads/main";
let opened: TestD1 | null = null;

afterEach(() => {
  vi.restoreAllMocks();
  opened?.close();
  opened = null;
});

async function environment(): Promise<Env> {
  opened = testD1();
  opened.raw
    .prepare(
      "INSERT INTO organizations (id, github_org_id, github_login, installation_id) VALUES ('org_1', '1', 'acme', '42')",
    )
    .run();
  opened.raw
    .prepare(
      `INSERT INTO projects
         (id, organization_id, github_repository_id, github_name, default_branch, enabled, proof_check_mode)
       VALUES ('project_1', 'org_1', ?, ?, 'main', 1, 'enforced')`,
    )
    .run(REPO, NAME);
  const pair = await generateKeyPair("RS256", { extractable: true });
  return {
    DB: opened.db,
    PUBLIC_ORIGIN: "https://thwip.test",
    GITHUB_APP_ID: String(APP_ID),
    GITHUB_APP_PRIVATE_KEY: await exportPKCS8(pair.privateKey),
    THWIP_ADMIN_TOKEN: ADMIN,
  } as unknown as Env;
}

function exactRulesets(): Array<{ id: number; ruleset: Ruleset }> {
  return [
    { id: 1, ruleset: appOwnershipRuleset({ baseRef: REF, integrationId: APP_ID }) },
    {
      id: 2,
      ruleset: policyRuleset({
        baseRef: REF,
        integrationId: APP_ID,
        actionsIntegrationId: GITHUB_ACTIONS_INTEGRATION_ID,
        proofCheckMode: "enforced",
        enforcement: "active",
        pinCheckSource: true,
      }),
    },
  ];
}

function github(input: {
  rulesets?: Array<{ id: number; ruleset: Ruleset }>;
  listFailure?: number;
  firstPage?: Array<{ id: number; name: string; enforcement: string }>;
  workflowChange?: { path: string; content: string | null };
  actionStatus?: number;
  beforeAction?: () => void;
}) {
  const stored = input.rulesets ?? exactRulesets();
  const workflows = Object.fromEntries(
    setupPullRequestFiles({ endpoint: "https://thwip.test", actionRef: QUEUE_ACTION_REF }).map((file) => [
      file.path,
      file.content,
    ]),
  ) as Record<string, string | null>;
  if (input.workflowChange !== undefined) workflows[input.workflowChange.path] = input.workflowChange.content;
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (request) => {
    const url = String(request);
    if (url.includes("/app/installations?")) {
      return Response.json([
        {
          id: 42,
          account: { id: 1, login: "acme", type: "Organization" },
          repository_selection: "selected",
          permissions: REQUIRED_APP_PERMISSIONS,
          events: [...REQUIRED_WEBHOOK_EVENTS],
        },
      ]);
    }
    if (url.endsWith("/app/installations/42/access_tokens")) return Response.json({ token: "installation-token" });
    const page = /[?&]page=(\d+)/.exec(url)?.[1];
    if (url.includes(`/repos/${NAME}/rulesets?`) && page !== undefined) {
      if (input.listFailure !== undefined) return new Response("failed", { status: input.listFailure });
      if (page === "1" && input.firstPage !== undefined) return Response.json(input.firstPage);
      if (page !== "1") {
        return Response.json(stored.map(({ id, ruleset }) => ({ id, name: ruleset.name, enforcement: ruleset.enforcement })));
      }
      return Response.json(stored.map(({ id, ruleset }) => ({ id, name: ruleset.name, enforcement: ruleset.enforcement })));
    }
    const id = /\/rulesets\/(\d+)$/.exec(url)?.[1];
    if (id !== undefined) {
      const ruleset = stored.find((candidate) => candidate.id === Number(id));
      return ruleset === undefined ? new Response("missing", { status: 404 }) : Response.json(ruleset.ruleset);
    }
    const content = /\/contents\/(.+)\?ref=/.exec(url)?.[1];
    if (content !== undefined) {
      const path = content.split("/").map(decodeURIComponent).join("/");
      const value = workflows[path];
      return value === null || value === undefined
        ? new Response("missing", { status: 404 })
        : Response.json({
            type: "file",
            encoding: "base64",
            content: btoa(String.fromCharCode(...new TextEncoder().encode(value))),
          });
    }
    if (url.includes("/repos/recallnet/thwip/git/commits/")) {
      input.beforeAction?.();
      return input.actionStatus === undefined
        ? Response.json({ sha: QUEUE_ACTION_REF.split("@")[1] })
        : new Response("action failure", { status: input.actionStatus });
    }
    throw new Error(`unexpected GitHub request ${url}`);
  });
}

async function doctor(env: Env): Promise<Response> {
  return worker.fetch(
    new Request(`https://thwip.test/admin/queue/doctor?repo=${encodeURIComponent(NAME)}`, {
      headers: { authorization: `Bearer ${ADMIN}` },
    }),
    env,
    { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
  );
}

describe("the production queue doctor route", () => {
  it("returns the exact active managed-ruleset verdict", async () => {
    const env = await environment();
    github({});

    const response = await doctor(env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      repo: NAME,
      missingPermissions: {},
      receivesEveryHandledEvent: true,
      rulesetHealth: { healthy: true, missing: [], duplicate: [], drifted: [] },
      workflowHealth: { healthy: true, missing: [], drifted: [], actionAccessible: true },
    });
  });

  it("reports missing and disabled rulesets as drift, not a successful count", async () => {
    const env = await environment();
    const [ownership, policy] = exactRulesets();
    github({ rulesets: [{ ...policy!, ruleset: { ...policy!.ruleset, enforcement: "disabled" } }] });

    const response = await doctor(env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      rulesetHealth: {
        healthy: false,
        missing: [ownership!.ruleset.name],
        drifted: [policy!.ruleset.name],
      },
    });
  });

  it("reports GitHub evaluate mode as ruleset drift instead of an API-shape failure", async () => {
    const env = await environment();
    const rulesets = exactRulesets();
    rulesets[1] = { ...rulesets[1]!, ruleset: { ...rulesets[1]!.ruleset, enforcement: "evaluate" } };
    github({ rulesets });

    const response = await doctor(env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      rulesetHealth: { healthy: false, drifted: ["Thwip Repository Policy"] },
    });
  });

  it("returns 502 when GitHub refuses the ruleset read", async () => {
    const env = await environment();
    github({ listFailure: 503 });

    const response = await doctor(env);

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      code: "GITHUB_RULESETS_UNAVAILABLE",
      githubStatus: 503,
    });
  });

  it("reads later pages before deciding a managed ruleset is missing", async () => {
    const env = await environment();
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      id: 1000 + index,
      name: `Repository rule ${index}`,
      enforcement: "active",
    }));
    github({ firstPage });

    const response = await doctor(env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ rulesetHealth: { healthy: true } });
  });

  it("reports a changed live workflow and inaccessible pinned action", async () => {
    const env = await environment();
    github({
      workflowChange: { path: ".github/workflows/thwip-required.yml", content: "permissions:\n  contents: write\n" },
      actionStatus: 404,
    });

    const response = await doctor(env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      workflowHealth: {
        healthy: false,
        drifted: [".github/workflows/thwip-required.yml"],
        actionAccessible: false,
      },
    });
  });

  it("does not return stale health after Phase 1 fences the project", async () => {
    const env = await environment();
    github({
      beforeAction: () => {
        opened!.raw
          .prepare(
            `INSERT INTO project_release_requests
               (github_repository_id, project_id, organization_id, github_name, default_branch)
             VALUES (?, 'project_1', 'org_1', ?, 'main')`,
          )
          .run(REPO, NAME);
      },
    });

    const response = await doctor(env);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "PROJECT_RELEASED" });
  });
});
