#!/usr/bin/env node
/**
 * This repository's merge workflow, written from the template every adopted
 * repository receives.
 *
 * There were two of them. `.github/workflows/thwip-merge.yml` was fixed in PR
 * 123 to compose the merge commit on the base the queue pinned and land it with
 * a ref update that does not force; `bootstrap-workflows.ts` went on calling the
 * merge-pull-request API, which has no expected base, so every enrolled
 * repository kept the defect that merged four unverified trees onto this one.
 * The attribution trailer went missing from one of the two copies the same way.
 *
 * So there is one merge now. The template is it, and this repository's copy is
 * what the template renders at the production endpoint. `scripts/lint.mjs`
 * fails if the checked-in file is not what this writes.
 */
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
  ".github/workflows/thwip-merge.yml",
  ".github/workflows/thwip-queue-verify.yml",
];

/** Every workflow the template emits, by path. */
export function generatedWorkflows() {
  const files = setupPullRequestFiles({
    endpoint: PRODUCTION_ENDPOINT,
    actionRef: QUEUE_ACTION_REF,
    // This repository has not completed its one-time manual writer cutover yet.
    // Keep rendering the compatibility workflow until that follow-up lands.
    mergeWriter: "workflow",
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
