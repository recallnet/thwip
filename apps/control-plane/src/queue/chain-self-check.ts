import { compactVerify, createLocalJWKSet, type JSONWebKeySet } from "jose";
import {
  parseTransitionRecord,
  verifyChain,
  type ChainFinding,
  type ChainLink,
  type ChainVerifierPorts,
} from "@thwip/queue-protocol";
import { countChain, readChain, readChainWindow } from "./attestation.js";
import { verificationKeys } from "../service-keys.js";
import type { D1Like } from "./projection.js";

/**
 * Reading the queue's own chain the way an outsider would.
 *
 * A verifier that is never run cannot protect the chain. The control plane runs
 * the same check an outside reader would use and publishes the result.
 *
 * `NOTHING_CHECKED` is this module's own finding rather than the verifier's. An
 * `epochStartsAt` past the end of the chain makes every link skip its signature
 * and produces no finding at all, so a caller reading only `findings.length`
 * would call that chain clean having verified nothing.
 */
export type SelfCheckFinding = ChainFinding | { code: "NOTHING_CHECKED"; sequence: null; digest: ""; detail: string };

export async function checkOwnChain(
  links: readonly ChainLink[],
  ports: ChainVerifierPorts,
): Promise<SelfCheckFinding[]> {
  const result = await verifyChain(links, ports);
  const findings: SelfCheckFinding[] = [...result.findings];
  if (links.length > 0 && result.signaturesChecked === 0) {
    findings.push({
      code: "NOTHING_CHECKED",
      sequence: null,
      digest: "",
      detail: `the walk read ${links.length} link(s) and verified no signature`,
    });
  }
  return findings;
}

/**
 * Read one branch's chain out of D1 and check it, with the keys the service
 * publishes.
 *
 * One producer, so the heartbeat and the project page cannot disagree about
 * whether a chain is whole. An administrator acting on a finding has to be
 * acting on the same finding the tick reported, and two call sites assembling
 * the verifier by hand is how that stops being true.
 *
 * The heartbeat and the project page check different scopes, on purpose
 * (issue #465): `findingsForChainWindow` bounds what a five-minute tick pays,
 * while this full walk serves the heal plan an administrator acts on and the
 * `/chain` route an outside verifier reads. Both build the verifier the same
 * way, so a finding means the same thing wherever it surfaced.
 *
 * The key set is read here, per call, rather than handed in. A record signed
 * moments ago under a kid this isolate has only just published would be checked
 * against a key set taken before that insert and reported as `BAD_SIGNATURE`:
 * a false alarm on the exact signal this exists to make trustworthy, and one
 * that clears itself on the next read, which makes it rarer and harder to
 * diagnose rather than less bad.
 */
export async function findingsForChain(
  db: D1Like,
  input: { readonly repositoryId: string; readonly baseRef: string; readonly epochStartsAt: number },
): Promise<SelfCheckFinding[]> {
  const ports = await selfCheckPorts(db, input);
  const links = await readChain(db, input.repositoryId, input.baseRef, input.epochStartsAt);
  // An attested range that starts past every record this branch has serves
  // nothing, and a walk over nothing reports nothing. That reads as a clean
  // chain to anybody counting findings, which is the same silent zero
  // `NOTHING_CHECKED` was written for. The second read happens only when the
  // range is empty, so a healthy queue pays for it never.
  if (links.length === 0) {
    const empty = await emptyRangeFinding(db, input);
    if (empty !== null) return [empty];
  }
  return checkOwnChain(links, { ...ports, epochStartsAt: input.epochStartsAt });
}

/** The verifier pieces both chain checks share: published keys and the subject. */
async function selfCheckPorts(
  db: D1Like,
  input: { readonly repositoryId: string; readonly baseRef: string },
): Promise<Pick<ChainVerifierPorts, "subject" | "verifySignature">> {
  const published: JSONWebKeySet = { keys: await verificationKeys(db) };
  const keySet = createLocalJWKSet(published);
  return {
    subject: { repositoryId: input.repositoryId, baseRef: input.baseRef },
    async verifySignature(jws, bytes) {
      try {
        const { payload } = await compactVerify(jws, keySet);
        return new TextDecoder().decode(payload) === new TextDecoder().decode(bytes);
      } catch {
        return false;
      }
    },
  };
}

/**
 * The finding for an attested range that starts past every record this branch
 * holds, or null when the branch genuinely has nothing in range and nothing
 * stored. Shared by both checks so neither invents its own wording for the
 * same broken state.
 */
async function emptyRangeFinding(
  db: D1Like,
  input: { readonly repositoryId: string; readonly baseRef: string; readonly epochStartsAt: number },
): Promise<SelfCheckFinding | null> {
  const stored = await readChain(db, input.repositoryId, input.baseRef);
  if (stored.length === 0) return null;
  return {
    code: "NOTHING_CHECKED",
    sequence: null,
    digest: "",
    detail:
      `the attested range starts at ${input.epochStartsAt} and this branch's last record is ` +
      `${stored.at(-1)?.sequence ?? "?"}, so the walk read nothing`,
  };
}

/** How many of the newest links every tick verifies: the head window. */
export const CHAIN_SELF_CHECK_HEAD_LINKS = 10;

/** How many older links each tick reaches: the rotation stride. */
export const CHAIN_SELF_CHECK_ROTATION_LINKS = 15;

/** One slice to read, by index into the branch's ordered in-range links. */
export interface ChainSelfCheckWindow {
  readonly offset: number;
  readonly limit: number;
}

/**
 * Which slices of a branch's chain this tick verifies.
 *
 * A chain of at most `HEAD + ROTATION` links is verified whole, so a young queue
 * keeps today's unconditional coverage and the arithmetic below never has to
 * think about a region smaller than one stride. Anything larger is covered by
 * two windows:
 *
 * - the head window, the newest `HEAD` links, on every tick, so a tampered or
 *   mis-recorded recent link is caught on the next tick;
 * - a rotation window, `ROTATION + 1` older links, whose start advances one
 *   stride per tick. The `+ 1` is deliberate: a window one link longer than
 *   its stride means every adjacent pair of links is co-windowed on some tick
 *   of the cycle, so a base discontinuity between two specific links — the
 *   shape an unrecorded merge leaves — is never invisible to every window at
 *   once.
 *
 * Per tick this verifies at most `HEAD + ROTATION + 1` links (26 as sized),
 * whatever the chain has grown to: about 2 ms of signature checking at the
 * ~0.08 ms/link the incident measured, against a 10 ms budget. The rotation
 * covers every in-range link within `ceil(older / ROTATION)` ticks, so a
 * tampered old record surfaces within one cycle rather than instantly.
 *
 * `slot` is the five-minute tick index the scheduler's claim boundary already
 * produces (the same value the maintenance rotation uses). It is a function of
 * the tick's cadence, not of when within the tick this runs, so consecutive
 * ticks take consecutive windows and a restart resumes the cycle rather than
 * resetting it.
 */
export function chainSelfCheckWindows(count: number, slot: number): readonly ChainSelfCheckWindow[] {
  if (count <= 0) return [];
  if (count <= CHAIN_SELF_CHECK_HEAD_LINKS + CHAIN_SELF_CHECK_ROTATION_LINKS) {
    return [{ offset: 0, limit: count }];
  }
  const older = count - CHAIN_SELF_CHECK_HEAD_LINKS;
  const stride = CHAIN_SELF_CHECK_ROTATION_LINKS;
  const cycle = Math.ceil(older / stride);
  const index = ((slot % cycle) + cycle) % cycle;
  return [
    { offset: count - CHAIN_SELF_CHECK_HEAD_LINKS, limit: CHAIN_SELF_CHECK_HEAD_LINKS },
    { offset: index * stride, limit: stride + 1 },
  ];
}

/**
 * Whether this tick's windows contain a base-correction whose target they do
 * not also serve.
 *
 * The walk follows a correction by substituting its edge for the record it
 * corrects, and that needs both records in the same walk. Serving a correction
 * without its target would report `CORRECTION_UNANCHORED` every tick — noise on
 * a chain that is actually fine — so the caller falls back to the full walk,
 * which has both. A correction whose link this tick does not serve at all is
 * skipped: the walk never sees it, so it cannot be misread.
 */
function correctionsNeedFullWalk(segments: readonly (readonly ChainLink[])[]): boolean {
  for (const segment of segments) {
    const served = new Set(segment.map((link) => link.digest));
    for (const link of segment) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder().decode(link.bytes));
      } catch {
        continue; // the walk reports UNPARSEABLE for this link; nothing to substitute
      }
      const record = parseTransitionRecord(parsed);
      if (!record.ok || record.value.kind !== "base-correction") continue;
      if (!served.has(record.value.correction.correctsTransitionDigest)) return true;
    }
  }
  return false;
}

/**
 * The heartbeat's bounded chain self-check (issue #465).
 *
 * Same reader, same keys, same finding codes as `findingsForChain`; the only
 * difference is how much of the chain one invocation verifies. Each segment is
 * verified as a chain of its own: `verifyChain` anchors on the first link it
 * is handed and checks pairwise chaining inside what it was handed, so a
 * contiguous slice verifies as exactly what it is — the links it contains —
 * without inventing findings about the links either side of it.
 *
 * What this trades for a constant CPU cost is time, not coverage: every link is
 * verified within one rotation cycle, every adjacent pair is co-windowed every
 * cycle, and the newest links are verified on every tick. The two properties
 * the full walk computes across the whole set at once — a forked base whose two
 * records sit in different windows, and a path that only breaks when followed
 * further than one window reaches — are evaluated here only while the chain is
 * small enough to verify whole. The heal route's full walk still computes them
 * on demand, and `thwip verify-chain` computes them from outside.
 */
export async function findingsForChainWindow(
  db: D1Like,
  input: {
    readonly repositoryId: string;
    readonly baseRef: string;
    readonly epochStartsAt: number;
    readonly slot: number;
  },
): Promise<SelfCheckFinding[]> {
  const count = await countChain(db, input.repositoryId, input.baseRef, input.epochStartsAt);
  if (count === 0) {
    const empty = await emptyRangeFinding(db, input);
    return empty === null ? [] : [empty];
  }
  const ports = await selfCheckPorts(db, input);
  const windows = chainSelfCheckWindows(count, input.slot);
  if (windows.length === 1) {
    // Small chain: the window is the whole range, so this is the full walk.
    const links = await readChainWindow(db, {
      repositoryId: input.repositoryId,
      baseRef: input.baseRef,
      fromSequence: input.epochStartsAt,
      offset: 0,
      limit: count,
    });
    return checkOwnChain(links, { ...ports, epochStartsAt: input.epochStartsAt });
  }
  const segments: ChainLink[][] = [];
  for (const window of windows) {
    segments.push(
      await readChainWindow(db, {
        repositoryId: input.repositoryId,
        baseRef: input.baseRef,
        fromSequence: input.epochStartsAt,
        offset: window.offset,
        limit: window.limit,
      }),
    );
  }
  // A segment anchors on its first link's sequence. `readChainWindow` always
  // returns one, so reaching here means the count and the read disagreed about
  // what is in range — fall back to the full walk rather than reason about a
  // window boundary that did not hold, the same fail-closed posture as the
  // correction fallback below.
  if (segments.some((segment) => segment[0]?.sequence === undefined)) {
    const links = await readChain(db, input.repositoryId, input.baseRef, input.epochStartsAt);
    return checkOwnChain(links, { ...ports, epochStartsAt: input.epochStartsAt });
  }
  if (correctionsNeedFullWalk(segments)) {
    const links = await readChain(db, input.repositoryId, input.baseRef, input.epochStartsAt);
    return checkOwnChain(links, { ...ports, epochStartsAt: input.epochStartsAt });
  }
  const findings: SelfCheckFinding[] = [];
  for (const segment of segments) {
    const anchor = segment[0]!.sequence;
    // Unreachable: guarded above. Skipped rather than anchored at a fabricated
    // epoch, so a future change cannot silently verify a segment from nowhere.
    if (anchor === undefined) continue;
    findings.push(...(await checkOwnChain(segment, { ...ports, epochStartsAt: anchor })));
  }
  return findings;
}
