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

/**
 * What one merge traded: the CI that already ran locally, then the time to
 * check it. A reader can hold this against their own repository, which a count
 * of our merges never lets them do.
 *
 * Null when nothing in scope carries a duration, so no tile claims an average
 * over zero merges.
 */
export function perMergeTradeText(metrics: ReusedCiMetrics): string | null {
  if (metrics.mergedProofs === 0) return null;
  const ran = durationText(metrics.signedWallClockDurationMs / metrics.mergedProofs);
  const checked = durationText(metrics.verificationOverheadMs / metrics.mergedProofs);
  return `${ran} \u2192 ${checked}`;
}

export function measuredRunsText(count: number): string {
  return count === 1 ? "1 measured run" : `${count} measured runs`;
}

export function reusedMergesText(count: number): string {
  return count === 1 ? "1 signed merge record" : `${count} signed merge records`;
}
