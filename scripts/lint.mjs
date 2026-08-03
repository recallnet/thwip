#!/usr/bin/env node
// Minimal repo lint: every tracked JSON/JSONC manifest parses, and no
// source file imports node builtins inside the Worker bundle.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe as renderDead, uncalledExports } from "./uncalled-exports.mjs";
import { describe as renderUnwritten, unwrittenFields } from "./unwritten-fields.mjs";
import { validateWorkflow } from "./workflow-lint.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0;

const files = execFileSync("git", ["ls-files"], { encoding: "utf8" }).trim().split("\n");

for (const f of files) {
  if (f.endsWith(".json") && !f.endsWith("tsconfig.json") && !f.includes("tsconfig")) {
    try {
      JSON.parse(readFileSync(f, "utf8"));
    } catch (e) {
      console.error(`lint: ${f} is not valid JSON: ${e.message}`);
      failures++;
    }
  }
}

// Tests are excluded: they run under Node and are never bundled into the Worker.
// The rule protects what ships, and widening it to test files would only push a
// test into contortions that prove nothing about the Worker.
const workerSources = files.filter(
  (f) => f.startsWith("apps/control-plane/src/") && !f.endsWith(".test.ts"),
);
for (const f of workerSources) {
  const text = readFileSync(f, "utf8");
  if (/from "node:/.test(text)) {
    console.error(`lint: ${f} imports node builtins; the Worker must stay Web-API only`);
    failures++;
  }
}

// Workflows must parse. One that does not is silently not run by GitHub, which is
// worse than one that fails — I shipped exactly that mistake once. And a workflow
// that moves a branch ref must serialise on the queue it drives.
//
// Reported like every other problem here rather than thrown. A stack trace tells
// a reader where the check lives; the message tells them what is wrong with their
// workflow, and that is the part worth reading.
{
  const dir = ".github/workflows";
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".yml") || n.endsWith(".yaml"))) {
    const path = `${dir}/${f}`;
    try {
      validateWorkflow(path, readFileSync(path, "utf8"));
    } catch (e) {
      console.error(`lint: ${e.message}`);
      failures++;
    }
  }
}

// And the workflows nobody checked in.
//
// `bootstrap-workflows.ts` emits the workflows every adopted repository runs, so
// they are workflows and the rules above are theirs. Reading only
// `.github/workflows` is how this repository's merge came to bind the base it
// verified while the copy that ships to customers went on merging onto whatever
// the branch happened to be.
//
// The merge workflow here is the template rendered at the production endpoint,
// so a change to one is a change to both.
{
  const { generatedWorkflows, RENDERED_HERE } = await import("./generate-workflows.mjs");
  for (const [path, content] of Object.entries(generatedWorkflows())) {
    try {
      validateWorkflow(`bootstrap-workflows.ts -> ${path}`, content);
    } catch (e) {
      console.error(`lint: ${e.message}`);
      failures++;
    }
    if (path === RENDERED_HERE && readFileSync(path, "utf8") !== content) {
      console.error(`lint: ${path} is not what the template renders; run node scripts/generate-workflows.mjs`);
      failures++;
    }
  }
}

// Exported values the shipping code never imports.
//
// This is the largest bug family this repository has produced, and the only one a
// reviewer cannot see: the function is there, it is documented, it has a passing
// test, and the single missing thing is an import. No diff shows an import that was
// never written.
//
// `signLocalRunAssignment` and `acceptIntegrationReceipt` sat here while the `fresh`
// profile enforced nothing. `buildCheck` sat here while the ruleset it fed pinned its
// check as required, so any repository provisioned from it would have blocked forever
// on a check nobody publishes. Each was found by accident, months apart.
//
// There is no allowlist. An allowlist is where a check like this goes to die: the
// entry costs one line, the reason is written once and never reread, and within a
// year the list is longer than the findings it was meant to shrink. That already
// happened here, with fifty-five entries reading "unwired". Modules nothing may
// import are read from the files that declare them instead, in `entryPoints()`, so a
// new bundle entry is known rather than excused.
{
  for (const line of renderDead(uncalledExports({ root }))) {
    console.error(`lint: ${line} is exported and nothing that ships imports it`);
    failures++;
  }
}

// Fields the shipping code reads and never writes, and the branches that
// therefore cannot run.
//
// One level below the check above, and invisible to it: the function is called,
// the branch is written, and the field it inspects was never populated, so the
// branch takes its default forever. `nonThwipChecks` is written once, in the
// `NO_OBJECTION` default, as "passing", so a failing required check reads as
// passing at the merge gate. `proofPolicyDigest` is null everywhere it is set,
// so POLICY_CHANGED never fires. This family has cost production time four
// times, and a suite that builds the object by hand passes every time.
//
// No allowlist here either, for the reason given above. What the check tolerates
// is written into the rules instead: a name declared twice is dropped whole, and
// a shape this repository describes but does not build is left alone.
{
  for (const line of renderUnwritten(unwrittenFields({ root }))) {
    console.error(`lint: ${line}`);
    failures++;
  }
}

// Dependencies nothing imports, imports nothing declares, and files nothing reaches.
//
// knip is deliberately not allowed to judge exports, though it offers to. It counts a
// test file as a consumer, so it would have called all four of the bugs above used.
// The two checks are kept apart so that neither can excuse the other: knip owns
// package manifests and whole files, `uncalledExports` owns what is inside them.
//
// An undeclared import is the interesting half. It resolves through pnpm's store on
// the machine that wrote it and fails on a clean install somewhere else.
{
  const knip = spawnSync("npx", ["knip", "--reporter", "symbols"], {
    cwd: root,
    encoding: "utf8",
  });
  if (knip.status !== 0) {
    console.error(knip.stdout.trim());
    if (knip.stderr.trim().length > 0) console.error(knip.stderr.trim());
    failures++;
  }
}

if (failures > 0) {
  console.error(`lint: ${failures} problem(s)`);
  process.exit(1);
}

console.log("lint: ok");
