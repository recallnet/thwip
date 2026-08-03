import { spawn } from "node:child_process";
import type { SuiteResult } from "@thwip/protocol";
import type { PipelineDefinition } from "@thwip/policy";

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
