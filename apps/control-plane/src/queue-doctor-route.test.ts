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
const NAME = "recallnet/repo";
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
      "INSERT INTO organizations (id, github_org_id, github_login, installation_id) VALUES ('org_1', '1', 'recallnet', '42')",
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
  invalidRulesetList?: boolean;
  invalidRuleset?: boolean;
  firstPage?: Array<{ id: number; name: string; enforcement: string }>;
  workflowChange?: { path: string; content: string | null };
  invalidWorkflow?: string;
  actionStatus?: number;
  actionSha?: string;
  actionTokenStatus?: number;
  invalidTargetToken?: boolean;
  invalidActionToken?: boolean;
  invalidTargetTokenJson?: boolean;
  invalidActionTokenJson?: boolean;
  installationStatus?: number;
  invalidInstallation?: boolean;
  installationFailures?: number;
  beforeAction?: (authorization: string | null) => void;
}) {
  const stored = input.rulesets ?? exactRulesets();
  const workflows = Object.fromEntries(
    setupPullRequestFiles({ endpoint: "https://thwip.test", actionRef: QUEUE_ACTION_REF }).map((file) => [
      file.path,
      file.content,
    ]),
  ) as Record<string, string | null>;
  if (input.workflowChange !== undefined) workflows[input.workflowChange.path] = input.workflowChange.content;
  let accessTokenCount = 0;
  let installationReads = 0;
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (request, init) => {
    const url = String(request);
    if (url.endsWith("/app/installations/42")) {
      installationReads += 1;
      if (input.installationStatus !== undefined) {
        return new Response("installation failure", { status: input.installationStatus });
      }
      if (installationReads <= (input.installationFailures ?? 0)) return new Response("retry", { status: 503 });
      return Response.json({
        id: 42,
        account: { id: 1, login: "recallnet", type: "Organization" },
        repository_selection: "selected",
        permissions: input.invalidInstallation === true ? ["contents"] : REQUIRED_APP_PERMISSIONS,
        events: [...REQUIRED_WEBHOOK_EVENTS],
      });
    }
    if (url.endsWith("/app/installations/42/access_tokens")) {
      accessTokenCount += 1;
      if (accessTokenCount === 2 && input.actionTokenStatus !== undefined) {
        return new Response("action token failure", { status: input.actionTokenStatus });
      }
      if (
        (accessTokenCount === 1 && input.invalidTargetToken === true) ||
        (accessTokenCount === 2 && input.invalidActionToken === true)
      ) return Response.json({ expires_at: "tomorrow" });
      if (
        (accessTokenCount === 1 && input.invalidTargetTokenJson === true) ||
        (accessTokenCount === 2 && input.invalidActionTokenJson === true)
      ) return new Response("not json", { status: 200 });
      return Response.json({ token: accessTokenCount === 1 ? "target-token" : "action-token" });
    }
    const page = /[?&]page=(\d+)/.exec(url)?.[1];
    if (url.includes(`/repos/${NAME}/rulesets?`) && page !== undefined) {
      if (input.listFailure !== undefined) return new Response("failed", { status: input.listFailure });
      if (input.invalidRulesetList === true) return new Response("not json", { status: 200 });
      if (page === "1" && input.firstPage !== undefined) return Response.json(input.firstPage);
      if (page !== "1") {
        return Response.json(stored.map(({ id, ruleset }) => ({ id, name: ruleset.name, enforcement: ruleset.enforcement })));
      }
      return Response.json(stored.map(({ id, ruleset }) => ({ id, name: ruleset.name, enforcement: ruleset.enforcement })));
    }
    const id = /\/rulesets\/(\d+)$/.exec(url)?.[1];
    if (id !== undefined) {
      const ruleset = stored.find((candidate) => candidate.id === Number(id));
      if (ruleset === undefined) return new Response("missing", { status: 404 });
      return input.invalidRuleset === true
        ? Response.json({ ...ruleset.ruleset, bypass_actors: [{ actor_id: "not-a-number" }] })
        : Response.json(ruleset.ruleset);
    }
    const content = /\/contents\/(.+)\?ref=/.exec(url)?.[1];
    if (content !== undefined) {
      const path = content.split("/").map(decodeURIComponent).join("/");
      const value = workflows[path];
      if (path === input.invalidWorkflow) return Response.json({ type: "file", encoding: "base64" });
      return value === null || value === undefined
        ? new Response("missing", { status: 404 })
        : Response.json({
            type: "file",
            encoding: "base64",
            content: btoa(String.fromCharCode(...new TextEncoder().encode(value))),
          });
    }
    if (url.includes("/repos/recallnet/thwip/git/commits/")) {
      input.beforeAction?.(new Headers(init?.headers).get("authorization"));
      return input.actionStatus === undefined
        ? Response.json({ sha: input.actionSha ?? QUEUE_ACTION_REF.split("@")[1] })
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

  it("uses one installation read and an exact action-repository token", async () => {
    const env = await environment();
    let actionAuthorization: string | null = null;
    const fetcher = github({ beforeAction: (authorization) => { actionAuthorization = authorization; } });

    const response = await doctor(env);

    expect(response.status).toBe(200);
    const urls = fetcher.mock.calls.map(([request]) => String(request));
    expect(urls.filter((url) => url.endsWith("/app/installations/42"))).toHaveLength(1);
    expect(urls.some((url) => url.includes("/app/installations?"))).toBe(false);
    const tokenBodies = fetcher.mock.calls
      .filter(([request]) => String(request).endsWith("/app/installations/42/access_tokens"))
      .map(([, init]) => JSON.parse(String(init?.body)) as unknown);
    expect(tokenBodies).toEqual([
      { repository_ids: [Number(REPO)] },
      { repositories: ["thwip"] },
    ]);
    expect(actionAuthorization).toBe("Bearer action-token");
  });

  it("reports an authoritative installation 404 as uninstalled", async () => {
    const env = await environment();
    github({ installationStatus: 404 });

    const response = await doctor(env);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: "no installation for recallnet" });
  });

  it("reports a malformed installation payload under the exact read operation", async () => {
    const env = await environment();
    github({ invalidInstallation: true });

    const response = await doctor(env);

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      code: "GITHUB_UNAVAILABLE",
      evidence: {
        operation: "github.installation.read",
        status: "unreadable",
        httpStatus: 200,
      },
    });
  });

  it("reports a malformed target token payload under the exact create operation", async () => {
    const env = await environment();
    github({ invalidTargetToken: true });

    const response = await doctor(env);

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      code: "GITHUB_UNAVAILABLE",
      evidence: {
        operation: "github.installation-token.create",
        status: "unreadable",
        httpStatus: 200,
      },
    });
  });

  it("reports invalid target-token JSON under the exact create operation", async () => {
    const env = await environment();
    github({ invalidTargetTokenJson: true });

    const response = await doctor(env);

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      code: "GITHUB_UNAVAILABLE",
      evidence: {
        operation: "github.installation-token.create",
        status: "unreadable",
        httpStatus: 200,
      },
    });
  });

  it("retries a transient exact-installation read without scanning every installation", async () => {
    const env = await environment();
    const fetcher = github({ installationFailures: 2 });

    const response = await doctor(env);

    expect(response.status).toBe(200);
    const urls = fetcher.mock.calls.map(([request]) => String(request));
    expect(urls.filter((url) => url.endsWith("/app/installations/42"))).toHaveLength(3);
    expect(urls.some((url) => url.includes("/app/installations?"))).toBe(false);
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
      evidence: {
        operation: "github.rulesets.list",
        status: "unavailable",
        httpStatus: 503,
        attempts: 3,
      },
    });
  });

  it("reports invalid ruleset JSON under the exact read operation", async () => {
    const env = await environment();
    github({ invalidRulesetList: true });

    const response = await doctor(env);

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      code: "GITHUB_RULESETS_UNAVAILABLE",
      evidence: {
        operation: "github.rulesets.list",
        status: "unreadable",
        httpStatus: 200,
        resource: NAME,
      },
    });
  });

  it("reports a malformed full ruleset under the exact read operation", async () => {
    const env = await environment();
    github({ invalidRuleset: true });

    const response = await doctor(env);

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      code: "GITHUB_RULESETS_UNAVAILABLE",
      evidence: {
        operation: "github.ruleset.read",
        status: "unreadable",
        httpStatus: 200,
        resource: "1",
      },
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

  it("does not report a failed action-commit read as a missing verifier", async () => {
    const env = await environment();
    github({
      workflowChange: { path: ".github/workflows/thwip-required.yml", content: "permissions:\n  contents: write\n" },
      actionStatus: 404,
    });

    const response = await doctor(env);

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      code: "GITHUB_WORKFLOWS_UNAVAILABLE",
      evidence: {
        operation: "github.action-commit.read",
        status: "unreadable",
        httpStatus: 404,
      },
    });
  });

  it("uses anonymous evidence when a public action is readable after scoped-token failure", async () => {
    const env = await environment();
    let actionAuthorization: string | null = "not-read";
    github({
      actionTokenStatus: 503,
      beforeAction: (authorization) => { actionAuthorization = authorization; },
    });

    const response = await doctor(env);

    expect(response.status).toBe(200);
    expect(actionAuthorization).toBeNull();
  });

  it("preserves scoped action-token failure when anonymous evidence is unreadable", async () => {
    const env = await environment();
    github({ actionTokenStatus: 503, actionStatus: 404 });

    const response = await doctor(env);

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      code: "GITHUB_WORKFLOWS_UNAVAILABLE",
      evidence: {
        operation: "github.action-repository-token.create",
        status: "unavailable",
        httpStatus: 503,
        resource: "recallnet/thwip",
      },
    });
  });

  it("preserves scoped action-token failure when anonymous evidence is malformed", async () => {
    const env = await environment();
    github({ actionTokenStatus: 503, actionSha: "0".repeat(40) });

    const response = await doctor(env);

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      code: "GITHUB_WORKFLOWS_UNAVAILABLE",
      evidence: {
        operation: "github.action-repository-token.create",
        status: "unavailable",
        httpStatus: 503,
      },
    });
  });

  it("reports a malformed action-token payload when anonymous evidence is unreadable", async () => {
    const env = await environment();
    github({ invalidActionToken: true, actionStatus: 404 });

    const response = await doctor(env);

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      code: "GITHUB_WORKFLOWS_UNAVAILABLE",
      evidence: {
        operation: "github.action-repository-token.create",
        status: "unreadable",
        httpStatus: 200,
      },
    });
  });

  it("reports invalid action-token JSON when anonymous evidence is unreadable", async () => {
    const env = await environment();
    github({ invalidActionTokenJson: true, actionStatus: 404 });

    const response = await doctor(env);

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      code: "GITHUB_WORKFLOWS_UNAVAILABLE",
      evidence: {
        operation: "github.action-repository-token.create",
        status: "unreadable",
        httpStatus: 200,
      },
    });
  });

  it("reports an invalid workflow payload under the exact read operation", async () => {
    const env = await environment();
    const path = ".github/workflows/thwip-required.yml";
    github({ invalidWorkflow: path });

    const response = await doctor(env);

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      code: "GITHUB_WORKFLOWS_UNAVAILABLE",
      evidence: {
        operation: "github.workflow.read",
        status: "unreadable",
        httpStatus: 200,
        resource: path,
      },
    });
  });

  it("reports an invalid action payload under the exact read operation", async () => {
    const env = await environment();
    github({ actionSha: "0".repeat(40) });

    const response = await doctor(env);

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      code: "GITHUB_WORKFLOWS_UNAVAILABLE",
      evidence: {
        operation: "github.action-commit.read",
        status: "unreadable",
        httpStatus: 200,
        resource: QUEUE_ACTION_REF,
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
