#!/usr/bin/env node
// Minimal repo lint: every tracked JSON/JSONC manifest parses, and no
// source file imports node builtins inside the Worker bundle.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

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

const workerSources = files.filter((f) => f.startsWith("apps/control-plane/src/"));
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
console.log("lint: ok");
