import { ATTEMPT_OUTCOMES, BLOCKING_REASONS } from "@thwip/queue-domain";
import { REASON_CODES } from "@thwip/protocol";
import { LOCAL_REASONS, SERVICE_REASONS, type ReasonCode } from "../reason-codes.js";

/**
 * Every code the union covers, deduplicated. Only suites iterate the union;
 * shipping code asks `isReasonCode` about one string at a time.
 */
export function reasonCodes(): ReasonCode[] {
  return [
    ...new Set([
      ...BLOCKING_REASONS,
      ...ATTEMPT_OUTCOMES,
      ...REASON_CODES,
      ...SERVICE_REASONS,
      ...LOCAL_REASONS,
    ]),
  ] as ReasonCode[];
}
