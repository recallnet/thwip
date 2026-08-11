const VERIFIED_MERGE_KINDS = new Set([
  "verified-merge",
  "reused-proof-merge",
  "candidate-verified-merge",
]);

const mergeFacts = (record) => {
  switch (record.kind) {
    case "verified-merge":
      return record.verifiedMerge;
    case "reused-proof-merge":
      return record.reusedProof;
    case "candidate-verified-merge":
      return record.candidateVerified;
    case "override-merge":
      return record.override;
    default:
      return null;
  }
};

/** Decide whether a verified published chain authorizes this exact deploy. */
export function evaluateDeployEvidence(report, expectedSha) {
  if (report.result.findings.length > 0) {
    const publicationPending = report.result.findings.every((finding) => finding.code === "CHAIN_BEHIND_HEAD");
    return {
      status: publicationPending ? "pending" : "refused",
      reason: report.result.findings.map((finding) => `${finding.code}: ${finding.detail}`).join("; "),
    };
  }
  if (report.result.signaturesChecked === 0) {
    return { status: "refused", reason: "the chain reported no findings but verified no signatures" };
  }

  const matches = report.records.filter(({ record }) => record.after.baseSha === expectedSha);
  if (matches.length === 0) {
    return { status: "pending", reason: `the published chain has no record for ${expectedSha}` };
  }
  if (matches.length > 1) {
    return { status: "refused", reason: `the published chain has ${matches.length} records for ${expectedSha}` };
  }

  const match = matches[0];
  if (!Number.isSafeInteger(match.sequence) || match.sequence < report.epochStartsAt) {
    return {
      status: "refused",
      reason: `record ${match.sequence ?? "without a sequence"} is outside the signed range`,
    };
  }
  if (match.record.kind === "override-merge") {
    return {
      status: "refused",
      reason: `record ${match.sequence} authorized ${expectedSha} as an override merge`,
    };
  }
  if (!VERIFIED_MERGE_KINDS.has(match.record.kind)) {
    return {
      status: "refused",
      reason: `record ${match.sequence} names ${expectedSha} as ${match.record.kind}, not a verified merge`,
    };
  }

  const facts = mergeFacts(match.record);
  return {
    status: "accepted",
    evidence: {
      digest: match.digest,
      sequence: match.sequence,
      kind: match.record.kind,
      pullRequestNumber: facts.pullRequestNumber,
      attemptId: facts.attemptId,
      observedAt: match.record.observedAt,
      sha: expectedSha,
    },
  };
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait briefly for the merge record to be published after GitHub moves main. */
export async function waitForDeployEvidence({
  check,
  timeoutMs = 120_000,
  intervalMs = 3_000,
  sleep = defaultSleep,
  now = Date.now,
  onProgress = () => {},
}) {
  const started = now();
  let attempt = 0;
  let lastReason = "the chain has not been read";

  for (;;) {
    attempt += 1;
    try {
      const checked = await check();
      if (checked.status !== "pending") return { ...checked, attempt, waitedMs: now() - started };
      lastReason = checked.reason;
    } catch (error) {
      lastReason = error instanceof Error ? error.message : String(error);
    }

    const waitedMs = now() - started;
    onProgress({ attempt, waitedMs, reason: lastReason });
    if (waitedMs >= timeoutMs) {
      return { status: "refused", reason: `timed out waiting for merge evidence: ${lastReason}`, attempt, waitedMs };
    }
    await sleep(intervalMs);
  }
}
