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
    | "MISSING_RECORD"
    | "WRONG_SUBJECT";
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
  /**
   * What this chain was asked for. Optional so an existing caller that has
   * not passed one keeps working: without it, a record's own repository and
   * ref are trusted rather than checked against a request.
   *
   * When present, a parsed record naming a different repository or ref is a
   * finding, not a silent pass — a chain served from the wrong branch must
   * not verify clean just because its own links join up internally.
   */
  subject?: { readonly repositoryId: string; readonly baseRef: string };
}

/**
 * What `verifyChain` learned about a chain: the findings, and how many
 * signatures were actually checked. `signaturesChecked` exists because
 * `epochStartsAt` decides which links get their signature checked at all —
 * an untrusted, too-large `epochStartsAt` makes every readable link skip
 * verification, and that skip produces no finding on its own. A caller that
 * only looked at `findings` being empty would report a clean chain having
 * checked nothing. Returning the count forces every caller to say what it
 * actually checked, not just what it failed to complain about.
 */
export interface ChainVerification {
  readonly findings: readonly ChainFinding[];
  readonly signaturesChecked: number;
}

export async function verifyChain(
  links: readonly ChainLink[],
  ports: ChainVerifierPorts,
): Promise<ChainVerification> {
  const findings: ChainFinding[] = [];
  let signaturesChecked = 0;
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
    if (parsed.signatureChecked) signaturesChecked++;

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

  return { findings, signaturesChecked };
}

async function inspect(
  link: ChainLink,
  ports: ChainVerifierPorts,
): Promise<{
  readable: boolean;
  sequence: number | null;
  previousDigest: string | null;
  signatureChecked: boolean;
  findings: ChainFinding[];
}> {
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
    return { readable: false, sequence: null, previousDigest: null, signatureChecked: false, findings };
  }

  const record = parseTransitionRecord(value);
  if (!record.ok) {
    findings.push({ code: "UNPARSEABLE", sequence: null, digest: link.digest, detail: record.detail });
    return { readable: false, sequence: null, previousDigest: null, signatureChecked: false, findings };
  }

  if (
    ports.subject !== undefined &&
    (record.value.repositoryId !== ports.subject.repositoryId || record.value.baseRef !== ports.subject.baseRef)
  ) {
    findings.push({
      code: "WRONG_SUBJECT",
      sequence: record.value.transitionSequence,
      digest: link.digest,
      detail: `names ${record.value.repositoryId}@${record.value.baseRef}, not the branch this chain was requested for`,
    });
  }

  let signatureChecked = false;
  if (record.value.transitionSequence >= ports.epochStartsAt) {
    signatureChecked = true;
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
    signatureChecked,
    findings,
  };
}
