export interface ReusedCiMetrics {
  status: "empty" | "partial" | "complete";
  signedSuiteDurationMs: number;
  signedWallClockDurationMs: number;
  verificationOverheadMs: number;
  mergedProofs: number;
  knownReusedMerges: number;
  unmeasuredMergedProofs: number;
}

export type PublicReusedCiMetrics =
  | { status: "insufficient-sample"; minimumMergedProofs: number }
  | (ReusedCiMetrics & { minimumMergedProofs: number });

/** A compact duration that keeps small verification costs visible. */
export function durationText(milliseconds: number): string {
  if (milliseconds < 1_000) return `${Math.round(milliseconds)}ms`;
  if (milliseconds < 60_000) return `${Math.round(milliseconds / 100) / 10}s`;
  const minutes = Math.floor(milliseconds / 60_000);
  if (minutes < 60) return `${minutes}m ${Math.floor((milliseconds % 60_000) / 1_000)}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function metricHistory(metrics: ReusedCiMetrics): string {
  if (metrics.status === "partial") {
    const old = metrics.unmeasuredMergedProofs === 1 ? "1 older merge" : `${metrics.unmeasuredMergedProofs} older merges`;
    const verb = metrics.unmeasuredMergedProofs === 1 ? "has" : "have";
    return `${metrics.mergedProofs} measured · ${old} ${verb} no timing`;
  }
  return metrics.mergedProofs === 1 ? "1 merged proof" : `${metrics.mergedProofs} merged proofs`;
}
