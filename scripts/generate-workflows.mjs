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
import { setupPullRequestFiles } from "../apps/control-plane/src/queue/bootstrap-workflows.ts";

/** Where the deployed control plane answers. Same value as wrangler.jsonc. */
export const PRODUCTION_ENDPOINT = "https://thwip.recall.net";

/**
 * The workflow this repository checks in and the template writes. Only the
 * merge: this repository's proof workflow runs the action from its own
 * checkout, which no other repository can do.
 */
export const RENDERED_HERE = ".github/workflows/thwip-merge.yml";

/** Every workflow the template emits, by path. */
export function generatedWorkflows() {
  const files = setupPullRequestFiles({
    endpoint: PRODUCTION_ENDPOINT,
    actionRef: "recallnet/thwip@v1",
  });
  return Object.fromEntries(
    files.filter((f) => f.path.startsWith(".github/workflows/")).map((f) => [f.path, f.content]),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const [path, content] of Object.entries(generatedWorkflows())) {
    if (path !== RENDERED_HERE) continue;
    writeFileSync(path, content);
    console.log(`wrote ${path}`);
  }
}
