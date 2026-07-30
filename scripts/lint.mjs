#!/usr/bin/env node
// Minimal repo lint: every tracked JSON/JSONC manifest parses, and no
// source file imports node builtins inside the Worker bundle.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { validateWorkflow } from "./workflow-lint.mjs";

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

if (failures > 0) {
  console.error(`lint: ${failures} problem(s)`);
  process.exit(1);
}
// Workflows must parse. One that does not is silently not run by GitHub, which is
// worse than one that fails — I shipped exactly that mistake once.
{
  const dir = ".github/workflows";
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".yml") || n.endsWith(".yaml"))) {
    const path = `${dir}/${f}`;
    validateWorkflow(path, readFileSync(path, "utf8"));
  }
}

console.log("lint: ok");
