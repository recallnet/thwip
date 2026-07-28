import { spawn } from "node:child_process";
import { canonicalDigest, type Sha256, type SuiteResult } from "@thwip/protocol";

export interface PipelineDefinition {
  schemaVersion: "1";
  runner: "command" | "dagger";
  suites: Array<{ id: string; command: string[] }>;
}

export function parsePipelineDefinition(jsonText: string): PipelineDefinition {
  const v = JSON.parse(jsonText) as PipelineDefinition;
  if (v.schemaVersion !== "1") throw new Error("unsupported pipeline schemaVersion");
  if (v.runner !== "command" && v.runner !== "dagger") throw new Error("unsupported pipeline runner");
  if (!Array.isArray(v.suites) || v.suites.length === 0) throw new Error("pipeline must declare suites");
  for (const s of v.suites) {
    if (typeof s.id !== "string" || !Array.isArray(s.command) || s.command.length === 0) {
      throw new Error("invalid suite entry");
    }
  }
  return v;
}

export async function pipelineDigest(definitionJsonText: string): Promise<Sha256> {
  return canonicalDigest(JSON.parse(definitionJsonText));
}

function runCommand(command: string[], cwd: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const [cmd, ...argv] = command;
    const child = spawn(cmd!, argv, { cwd, stdio: "inherit", env: process.env });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}

export async function runSuites(def: PipelineDefinition, cwd: string): Promise<SuiteResult[]> {
  const results: SuiteResult[] = [];
  for (const suite of def.suites) {
    const started = Date.now();
    process.stderr.write(`\n[thwip] suite ${suite.id}: ${suite.command.join(" ")}\n`);
    const code = await runCommand(suite.command, cwd);
    results.push({
      id: suite.id,
      status: code === 0 ? "passed" : "failed",
      durationMs: Date.now() - started,
    });
  }
  return results;
}
