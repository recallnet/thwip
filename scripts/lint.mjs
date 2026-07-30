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
// Workflows must parse. One that does not is silently not run by GitHub, which is
// worse than one that fails — I shipped exactly that mistake once.
{
  const { readdirSync, readFileSync } = await import("node:fs");
  const { execFileSync } = await import("node:child_process");
  const dir = ".github/workflows";
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".yml") || n.endsWith(".yaml"))) {
    execFileSync("python3", ["-c", "import yaml,sys;yaml.safe_load(open(sys.argv[1]))", `${dir}/${f}`]);
    if (!/^on:/m.test(readFileSync(`${dir}/${f}`, "utf8"))) throw new Error(`${f}: no trigger`);
  }
}

console.log("lint: ok");
