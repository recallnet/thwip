#!/usr/bin/env node

import { appendFileSync } from "node:fs";

import { evaluateDeployEvidence, waitForDeployEvidence } from "./deploy-evidence.mjs";
import { printChainReport, verifyPublishedChain } from "./verify-chain.mjs";

const [repositoryId, ref, expectedSha, ...options] = process.argv.slice(2);
const waitIndex = options.indexOf("--wait-seconds");
const waitSeconds = waitIndex === -1 ? 120 : Number(options[waitIndex + 1]);

if (!/^[0-9]+$/.test(repositoryId ?? "")) {
  console.error("Refusing: verify-deploy-evidence.mjs needs the numeric GitHub repository id.");
  process.exit(1);
}
if (!/^refs\/heads\/[A-Za-z0-9._/-]+$/.test(ref ?? "")) {
  console.error("Refusing: verify-deploy-evidence.mjs needs a full branch ref.");
  process.exit(1);
}
if (!/^[0-9a-f]{40,64}$/.test(expectedSha ?? "")) {
  console.error("Refusing: verify-deploy-evidence.mjs needs the full landed Git object id.");
  process.exit(1);
}
if (!Number.isFinite(waitSeconds) || waitSeconds < 0 || waitSeconds > 600) {
  console.error("Refusing: --wait-seconds must be between 0 and 600.");
  process.exit(1);
}

let acceptedReport = null;
const outcome = await waitForDeployEvidence({
  timeoutMs: waitSeconds * 1000,
  check: async () => {
    const report = await verifyPublishedChain({
      repo: repositoryId,
      ref,
      expectedSha,
      api: process.env.THWIP_API ?? "https://thwip.ai",
    });
    const evaluated = evaluateDeployEvidence(report, expectedSha);
    if (evaluated.status === "accepted") acceptedReport = report;
    return evaluated;
  },
  onProgress: ({ attempt, waitedMs, reason }) => {
    console.log(`[${Math.round(waitedMs / 1000)}s] evidence attempt ${attempt}: ${reason}`);
  },
});

if (outcome.status !== "accepted" || acceptedReport === null) {
  console.error(`\nRefusing deploy: ${outcome.reason}`);
  process.exit(1);
}

printChainReport(acceptedReport);
const evidence = outcome.evidence;
console.log(
  `\nverified deploy evidence: record ${evidence.sequence} (${evidence.kind}) binds PR #${evidence.pullRequestNumber} ` +
    `to ${evidence.sha}`,
);

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    [
      `record_digest=${evidence.digest}`,
      `record_sequence=${evidence.sequence}`,
      `merge_kind=${evidence.kind}`,
      `pull_request=${evidence.pullRequestNumber}`,
      `verified_sha=${evidence.sha}`,
    ].join("\n") + "\n",
  );
}
