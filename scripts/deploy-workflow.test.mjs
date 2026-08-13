import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const path = fileURLToPath(new URL("../.github/workflows/deploy-staging.yml", import.meta.url));
const source = readFileSync(path, "utf8");
const workflow = parse(source);

const steps = Object.values(workflow.jobs).flatMap((job) => job.steps ?? []);

describe("the canonical main deployment workflow", () => {
  it("runs for main pushes and supports a safe manual rehearsal", () => {
    expect(workflow.on.push.branches).toEqual(["main"]);
    expect(workflow.on.workflow_dispatch.inputs.deploy).toMatchObject({ type: "boolean", default: false });
  });

  it("has read-only GitHub authority and one non-cancelling deployment lane", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.concurrency).toEqual({ group: "thwip-staging-deploy", "cancel-in-progress": false });
  });

  it("pins every third-party action to a full commit", () => {
    for (const step of steps.filter((candidate) => typeof candidate.uses === "string")) {
      expect(step.uses).toMatch(/^[^@]+@[0-9a-f]{40}$/);
    }
  });

  it("checks out and verifies the exact workflow SHA on canonical main", () => {
    const checkouts = steps.filter((step) => step.uses?.startsWith("actions/checkout@"));
    expect(checkouts).toHaveLength(2);
    for (const checkout of checkouts) {
      expect(checkout.with.ref).toBe("${{ github.sha }}");
      expect(checkout.with["fetch-depth"]).toBe(0);
    }
    expect(source).toContain('test "$canonical" = "$EXPECTED_SHA"');
    expect(source.match(/verify-deploy-evidence\.mjs/g)).toHaveLength(2);
  });

  it("stays disabled until the explicit switch and environment credential exist", () => {
    expect(workflow.jobs.deploy.if).toContain("vars.THWIP_STAGING_DEPLOY_ENABLED == 'true'");
    expect(workflow.jobs.deploy.environment.name).toBe("staging");
    expect(source).toContain("secrets.CLOUDFLARE_API_TOKEN");
    expect(source).toContain("vars.CLOUDFLARE_ACCOUNT_ID");
  });

  it("passes the full workflow SHA through the existing gate and health confirmation path", () => {
    const deploy = workflow.jobs.deploy.steps.find((step) => step.id === "deploy");
    expect(deploy.env.BUILD_SHA).toBe("${{ github.sha }}");
    expect(deploy.run).toBe("pnpm --filter @thwip/control-plane run deploy:staging");
    expect(readFileSync(fileURLToPath(new URL("../apps/control-plane/package.json", import.meta.url)), "utf8"))
      .toContain('--var DEPLOYMENT_ID:\\"$DEPLOYMENT_ID\\"');
    expect(source).toContain("/health serves the exact SHA");
    expect(readFileSync(fileURLToPath(new URL("./predeploy.mjs", import.meta.url)), "utf8"))
      .toContain("migrationReleaseState");
  });

  it("contains no command that changes the database", () => {
    expect(source).not.toMatch(/wrangler\s+d1|migrations?\s+apply|migrate:staging/i);
  });
});
