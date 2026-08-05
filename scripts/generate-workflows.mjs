#!/usr/bin/env node
/** Generate the repository workflows shared with newly enrolled projects. */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  QUEUE_ACTION_REF,
  setupPullRequestFiles,
} from "../apps/control-plane/src/queue/bootstrap-workflows.ts";

/** Where the deployed control plane answers. Same value as wrangler.jsonc. */
export const PRODUCTION_ENDPOINT = "https://thwip.recall.net";

/**
 * The workflows this repository checks in and the template writes. Not the
 * proof workflow: this repository's copy runs the action from its own checkout,
 * which no other repository can do.
 */
export const RENDERED_HERE = [
  ".github/workflows/thwip-queue-verify.yml",
];

/** Every workflow the template emits, by path. */
export function generatedWorkflows() {
  const files = setupPullRequestFiles({
    endpoint: PRODUCTION_ENDPOINT,
    actionRef: QUEUE_ACTION_REF,
  });
  return Object.fromEntries(
    files.filter((f) => f.path.startsWith(".github/workflows/")).map((f) => [f.path, f.content]),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const [path, content] of Object.entries(generatedWorkflows())) {
    if (!RENDERED_HERE.includes(path)) continue;
    writeFileSync(path, content);
    console.log(`wrote ${path}`);
  }
}
