/** The exact cancellation emitted only by scheduled GitHub reconciliation. */
export const TERMINAL_RECONCILIATION_CANCEL_REASON =
  "GitHub reports the pull request closed without merge";

/** Observe-mode work that GitHub merged before Thwip ever authorized it. */
export const EXTERNAL_MERGE_RECONCILIATION_CANCEL_REASON =
  "GitHub reports the pull request merged outside Thwip";
