import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { describe as render, entryPoints, uncalledExports } from "./uncalled-exports.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * A fixture repository, because the interesting cases are about how modules
 * refer to each other and a real one cannot be made to hold a specific shape.
 */
function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), "uncalled-"));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, dirname(name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  return dir;
}

const found = (dir, entries = new Set()) =>
  uncalledExports({ root: dir, entries }).map((d) => `${d.file}#${d.name}`);

describe("uncalled exports", () => {
  it("reports an exported function nothing imports", () => {
    const dir = fixture({
      "a.ts": "export function used() {}\nexport function orphan() {}\n",
      "b.ts": 'import { used } from "./a.js";\nconst x = used;\nconsole.log(x);\n',
    });
    expect(found(dir)).toEqual(["a.ts#orphan"]);
  });

  it("counts a name the module uses itself", () => {
    // A helper called only by its own module is not dead code. Reporting it
    // would bury the real cases under notes about a keyword.
    const dir = fixture({
      "a.ts": "export function helper() {}\nexport function exported() { helper(); }\n",
      "b.ts": 'import { exported } from "./a.js";\nconst x = exported;\nconsole.log(x);\n',
    });
    expect(found(dir)).toEqual([]);
  });

  it("does not count a test as a caller", () => {
    // Every one of the four cases this exists for had a thorough suite. A test
    // proves a function works, never that anything runs it.
    const dir = fixture({
      "a.ts": "export function orphan() {}\n",
      "a.test.ts": 'import { orphan } from "./a.js";\norphan();\n',
    });
    expect(found(dir)).toEqual(["a.ts#orphan"]);
  });

  it("does not report the test's own exports", () => {
    const dir = fixture({ "a.test.ts": "export function helper() {}\n" });
    expect(found(dir)).toEqual([]);
  });

  it("does not report fixtures kept under test/", () => {
    const dir = fixture({ "test/d1.ts": "export function migrations() {}\n" });
    expect(found(dir)).toEqual([]);
  });

  it("follows a barrel rather than counting it as a caller", () => {
    // The failure mode of every off-the-shelf tool: a package index re-exports
    // everything, so everything looks used and whole packages go unchecked.
    const dir = fixture({
      "pkg/index.ts": 'export * from "./a.js";\n',
      "pkg/a.ts": "export function used() {}\nexport function orphan() {}\n",
      "app.ts": 'import { used } from "./pkg/index.js";\nconst x = used;\nconsole.log(x);\n',
    });
    expect(found(dir)).toEqual(["pkg/a.ts#orphan"]);
  });

  it("follows a named re-export to where the name is declared", () => {
    const dir = fixture({
      "pkg/index.ts": 'export { used, orphan } from "./a.js";\n',
      "pkg/a.ts": "export function used() {}\nexport function orphan() {}\n",
      "app.ts": 'import { used } from "./pkg/index.js";\nconst x = used;\nconsole.log(x);\n',
    });
    expect(found(dir)).toEqual(["pkg/a.ts#orphan"]);
  });

  it("leaves types alone", () => {
    // A type is used structurally, without ever being named in an import, so a
    // check that reads names cannot tell the difference between a spare one and
    // one that every value in the file is shaped by.
    const dir = fixture({
      "a.ts": "export interface Shape { x: number }\nexport type Other = string;\n",
    });
    expect(found(dir)).toEqual([]);
  });

  it("leaves entry points alone", () => {
    const dir = fixture({ "main.ts": "export default {};\nexport class Thing {}\n" });
    expect(found(dir, new Set(["main.ts"]))).toEqual([]);
  });

  it("treats a namespace import as using everything", () => {
    const dir = fixture({
      "a.ts": "export function one() {}\nexport function two() {}\n",
      "b.ts": 'import * as a from "./a.js";\nconst x = a;\nconsole.log(x);\n',
    });
    expect(found(dir)).toEqual([]);
  });
});

describe("entry points", () => {
  /**
   * Read from what declares them, never listed here. A hard-coded list reports
   * the next Durable Object or bundle entry as dead on the day it is added, and
   * whoever hits that reaches for the allowance list instead.
   */
  it("come from the configuration that names them", () => {
    const entries = entryPoints(root);
    expect(entries).toContain("apps/control-plane/src/index.ts");
    expect(entries).toContain("packages/cli/src/main.ts");
    expect(entries).toContain("packages/action/src/main.ts");
    expect(entries).toContain("apps/control-plane/web/src/main.tsx");
  });
});

/**
 * Exports nothing imports, that are staying for now.
 *
 * Every entry is a decision somebody took, not a suppression. The test below
 * fails on an entry that no longer matches, so the list can only shrink, and it
 * fails on a finding that is not here, so nothing new joins quietly.
 */
const ALLOWED = [
  {
    symbol: "apps/control-plane/src/auth.cli.ts#auth",
    why: "read by `@better-auth/cli generate`, which takes a file path rather than an import",
  },

  /* The merge write the Actions workflow performs instead. `mergePullRequest`
     and `landMergeOnPinnedBase` were two more spellings of it and are deleted:
     the shell in bootstrap-workflows.ts is the merge, and this repository's
     workflow is what that renders. */
  { symbol: "apps/control-plane/src/queue/github-port.ts#observeMergeResult", why: "merge write" },
  { symbol: "apps/control-plane/src/queue/github-port.ts#readFinalGuardFacts", why: "merge write" },
  { symbol: "apps/control-plane/src/queue/github-port.ts#dispatchVerifier", why: "merge write" },
  { symbol: "apps/control-plane/src/queue/github-port.ts#classify", why: "merge write" },

  /* Readiness. `deriveReadiness` is now what `routes.ts` and `index.ts` both
     derive from, so it is off this list. The two below report a reason rather
     than decide one, and nothing renders a readiness result yet. */
  { symbol: "apps/control-plane/src/queue/readiness.ts#isKnownReason", why: "readiness drift" },
  { symbol: "apps/control-plane/src/queue/readiness.ts#blockedOnlyByCapability", why: "readiness drift" },

  /* Bootstrap and provisioning surface reached over HTTP or not yet wired. */
  { symbol: "apps/control-plane/src/queue/bootstrap.ts#bootstrapGitHub", why: "bootstrap surface" },
  { symbol: "apps/control-plane/src/queue/bootstrap.ts#handleBootstrapRequest", why: "bootstrap surface" },
  { symbol: "apps/control-plane/src/queue/bootstrap.ts#OWNERSHIP_RULESET_NAME", why: "bootstrap surface" },
  { symbol: "apps/control-plane/src/queue/bootstrap-workflows.ts#SETUP_BRANCH", why: "bootstrap surface" },
  {
    symbol: "apps/control-plane/src/queue/bootstrap-workflows.ts#SETUP_PULL_REQUEST_TITLE",
    why: "bootstrap surface",
  },
  {
    symbol: "apps/control-plane/src/queue/bootstrap-workflows.ts#setupPullRequestBody",
    why: "bootstrap surface",
  },
  { symbol: "apps/control-plane/src/queue/rulesets.ts#isBootstrapCheck", why: "bootstrap surface" },

  /* Control-plane odds and ends. */
  { symbol: "apps/control-plane/src/github-events.ts#INTERNAL_QUEUE_EVENTS", why: "unwired" },
  { symbol: "apps/control-plane/src/queue/candidate.ts#candidateFetchPlan", why: "unwired" },
  { symbol: "apps/control-plane/src/queue/candidate.ts#candidateStillCurrent", why: "unwired" },
  { symbol: "apps/control-plane/src/queue/commands.ts#validateTimings", why: "unwired" },
  { symbol: "apps/control-plane/src/queue/evidence-store.ts#getEvidence", why: "unwired" },
  { symbol: "apps/control-plane/src/queue/evidence.ts#reuseEquivalenceDigests", why: "unwired" },
  { symbol: "apps/control-plane/src/queue/merge-commit.ts#mergeCommitText", why: "unwired" },
  { symbol: "apps/control-plane/src/queue/projection.ts#projectionLag", why: "unwired" },
  { symbol: "apps/control-plane/src/queue/runners.ts#HEARTBEAT_INTERVAL_SECONDS", why: "unwired" },
  { symbol: "apps/control-plane/src/queue/runners.ts#SWEEP_INTERVAL_SECONDS", why: "unwired" },
  { symbol: "apps/control-plane/src/queue/verifier-identity.ts#acceptCallback", why: "unwired" },
  { symbol: "apps/control-plane/web/src/vocabulary.ts#BLOCKED_NEXT_ACTION", why: "unwired" },

  /* CLI. */
  { symbol: "packages/cli/src/config.ts#deriveConfig", why: "unwired" },
  { symbol: "packages/cli/src/dagger.ts#ensureDagger", why: "dagger runner, unwired" },
  { symbol: "packages/cli/src/dagger.ts#moduleDigest", why: "dagger runner, unwired" },
  { symbol: "packages/cli/src/dagger.ts#requireContainerRuntime", why: "dagger runner, unwired" },
  { symbol: "packages/cli/src/dagger.ts#runDaggerSuites", why: "dagger runner, unwired" },
  { symbol: "packages/cli/src/pipeline.ts#parsePipelineDefinition", why: "unwired" },
  { symbol: "packages/cli/src/pipeline.ts#pipelineDigest", why: "unwired" },
  { symbol: "packages/cli/src/queue-commands.ts#isMutating", why: "unwired" },
  { symbol: "packages/cli/src/queue-exit.ts#knownReasonCodes", why: "unwired" },
  { symbol: "packages/cli/src/queue-exit.ts#LOCAL_REASONS", why: "unwired" },
  { symbol: "packages/cli/src/queue-exit.ts#SERVICE_REASONS", why: "unwired" },
  { symbol: "packages/cli/src/ship.ts#describeDecision", why: "unwired" },

  /* Packages. */
  { symbol: "packages/policy/src/index.ts#deriveProjectConfigFromText", why: "unwired" },
  { symbol: "packages/prompts/src/queue.ts#hasQueuePointer", why: "queue prompts, unwired" },
  { symbol: "packages/prompts/src/queue.ts#queueInstructions", why: "queue prompts, unwired" },
  { symbol: "packages/prompts/src/queue.ts#queueSetupPrompt", why: "queue prompts, unwired" },
  { symbol: "packages/prompts/src/queue.ts#withQueuePointer", why: "queue prompts, unwired" },
  { symbol: "packages/queue-domain/src/invariants.ts#witnessDepth", why: "unwired" },
  { symbol: "packages/queue-domain/src/reducer.ts#applyEvents", why: "unwired" },
  {
    symbol: "packages/queue-protocol/src/integration-receipt.ts#parseExactReceiptReuse",
    why: "receipt parsing, unwired",
  },
  {
    symbol: "packages/queue-protocol/src/integration-receipt.ts#parseIntegrationReceipt",
    why: "receipt parsing, unwired",
  },
  {
    symbol: "packages/queue-protocol/src/integration-receipt.ts#receiptSatisfiesPolicy",
    why: "receipt parsing, unwired",
  },
  {
    symbol: "packages/queue-protocol/src/integration-receipt.ts#reuseEquivalenceHolds",
    why: "receipt parsing, unwired",
  },
  { symbol: "packages/queue-protocol/src/primitives.ts#bigintString", why: "unwired" },
  { symbol: "packages/queue-protocol/src/primitives.ts#SUITE_NAME_RE", why: "unwired" },
  { symbol: "packages/queue-protocol/src/queue-decision.ts#parseQueueDecision", why: "unwired" },
  { symbol: "packages/queue-protocol/src/verifier-result.ts#parseVerifierResult", why: "unwired" },
  { symbol: "packages/queue-protocol/src/verifier-result.ts#resultBindsAttempt", why: "unwired" },
  { symbol: "packages/vocabulary/src/reason-codes.ts#reasonCodes", why: "unwired" },
];

describe("this repository", () => {
  const findings = render(uncalledExports({ root })).map((line) => {
    const [where, name] = line.split(" ");
    return `${where.slice(0, where.lastIndexOf(":"))}#${name}`;
  });
  const allowed = new Set(ALLOWED.map((a) => a.symbol));

  it("exports nothing new that nothing imports", () => {
    const unexpected = findings.filter((f) => !allowed.has(f));
    expect(
      unexpected,
      "these are exported and nothing in the shipping code imports them. Delete them, wire them up, " +
        "or add them to ALLOWED with a reason",
    ).toEqual([]);
  });

  it("keeps no allowance for something that is now used", () => {
    const found = new Set(findings);
    const stale = ALLOWED.filter((a) => !found.has(a.symbol)).map((a) => a.symbol);
    expect(stale, "these are allowed and no longer need to be; drop them from ALLOWED").toEqual([]);
  });

  it("gives a reason for every allowance", () => {
    expect(ALLOWED.filter((a) => a.why.trim().length === 0)).toEqual([]);
  });
});
