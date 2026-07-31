import { envelopeDigest } from "./canonical.js";
import { parseTransitionRecord } from "./transition-record.js";

/**
 * Walking a branch's chain and saying whether it holds.
 *
 * The chain was a claim until this existed. Records were built, signed and
 * stored, and nothing ever checked that the links joined up, that a digest named
 * its own bytes, or that a signature was real. Two merges landed with no record
 * at all and it went unnoticed until somebody looked by hand.
 *
 * Pure. Signature verification is injected so the same walk runs in the Worker,
 * in the CLI, and in a test, and so this file never needs a key or a network.
 */

export interface ChainLink {
  readonly digest: string;
  /** The exact bytes that were signed. Empty when there is no record to read. */
  readonly bytes: Uint8Array;
  readonly jws: string;
  /**
   * Where the store says this link sits. Supplied because a link whose bytes are
   * missing cannot say so itself, and "written before records existed" and "a
   * record that belongs here is gone" are different facts that must not collapse
   * into one.
   */
  readonly sequence?: number;
}

export interface ChainFinding {
  readonly code:
    | "DIGEST_MISMATCH"
    | "BROKEN_LINK"
    | "SEQUENCE_GAP"
    | "BAD_SIGNATURE"
    | "UNPARSEABLE"
    | "PRE_ATTESTATION"
    | "MISSING_RECORD";
  readonly sequence: number | null;
  readonly digest: string;
  readonly detail: string;
}

export interface ChainVerifierPorts {
  /** True when the JWS is a valid signature over these bytes by a published key. */
  verifySignature(jws: string, bytes: Uint8Array): Promise<boolean>;
  /**
   * The first sequence number that is a real record. Anything below it was
   * written before records existed and is reported, not failed.
   */
  epochStartsAt: number;
}

export async function verifyChain(
  links: readonly ChainLink[],
  ports: ChainVerifierPorts,
): Promise<readonly ChainFinding[]> {
  const findings: ChainFinding[] = [];
  let previous: { digest: string; sequence: number | null } | null = null;

  for (const link of links) {
    if (link.bytes.length === 0) {
      const history = link.sequence === undefined || link.sequence < ports.epochStartsAt;
      findings.push(
        history
          ? {
              code: "PRE_ATTESTATION",
              sequence: link.sequence ?? null,
              digest: link.digest,
              detail: "written before signed records; nothing to verify",
            }
          : {
              code: "MISSING_RECORD",
              sequence: link.sequence ?? null,
              digest: link.digest,
              detail: "this link belongs to the attested range and has no record",
            },
      );
      // The digest still anchors what comes next. A link we cannot read must not
      // hide a break in the link after it.
      previous = { digest: link.digest, sequence: null };
      continue;
    }

    const parsed = await inspect(link, ports);
    findings.push(...parsed.findings);

    if (previous !== null && parsed.readable) {
      if (parsed.previousDigest !== previous.digest) {
        findings.push({
          code: "BROKEN_LINK",
          sequence: parsed.sequence,
          digest: link.digest,
          detail: `names ${parsed.previousDigest ?? "nothing"} as its predecessor, which is not the link before it`,
        });
      }
      if (previous.sequence !== null && parsed.sequence !== null && parsed.sequence !== previous.sequence + 1) {
        findings.push({
          code: "SEQUENCE_GAP",
          sequence: parsed.sequence,
          digest: link.digest,
          detail: `link ${parsed.sequence} follows ${previous.sequence}; a merge landed without a record`,
        });
      }
    }
    previous = { digest: link.digest, sequence: parsed.sequence };
  }

  return findings;
}

async function inspect(
  link: ChainLink,
  ports: ChainVerifierPorts,
): Promise<{ readable: boolean; sequence: number | null; previousDigest: string | null; findings: ChainFinding[] }> {
  const findings: ChainFinding[] = [];
  const actual = await envelopeDigest(link.bytes);
  if (actual !== link.digest) {
    findings.push({
      code: "DIGEST_MISMATCH",
      sequence: null,
      digest: link.digest,
      detail: `these bytes digest to ${actual}`,
    });
  }

  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(link.bytes));
  } catch {
    findings.push({ code: "UNPARSEABLE", sequence: null, digest: link.digest, detail: "not JSON" });
    return { readable: false, sequence: null, previousDigest: null, findings };
  }

  const record = parseTransitionRecord(value);
  if (!record.ok) {
    findings.push({ code: "UNPARSEABLE", sequence: null, digest: link.digest, detail: record.detail });
    return { readable: false, sequence: null, previousDigest: null, findings };
  }

  if (record.value.transitionSequence >= ports.epochStartsAt) {
    const signed = await ports.verifySignature(link.jws, link.bytes);
    if (!signed) {
      findings.push({
        code: "BAD_SIGNATURE",
        sequence: record.value.transitionSequence,
        digest: link.digest,
        detail: "no published key verifies this record",
      });
    }
  }

  return {
    readable: true,
    sequence: record.value.transitionSequence,
    previousDigest: record.value.previousTransitionDigest,
    findings,
  };
}
