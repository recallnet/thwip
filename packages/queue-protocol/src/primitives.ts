/**
 * Shared primitives and the hard carrier bounds from plan.md §21.1 and §21.9.
 *
 * Bounds are applied to UTF-8 bytes after NFC normalization and before
 * allocation or signing. Oversize caller input is rejected; a signed field is
 * never truncated, because a truncated signed field is a different claim.
 *
 * The validator style here matches @thwip/protocol deliberately. The plan
 * recommends Effect Schema, but this repository already validates its
 * attestations with hand-written strict decoders, and adding a second
 * validation library is the "parallel validators" failure the same table warns
 * against. One style, one place to audit.
 */

export type DecimalId = string;
export type GitOid = string;
export type Sha256 = `sha256:${string}`;
export type IsoDateTime = string;
export type BaseRef = `refs/heads/${string}`;

export type ParseResult<T> = { ok: true; value: T } | { ok: false; detail: string };

/** §21.9 hard bounds. */
export const BOUNDS = {
  opaqueId: 64,
  decimalId: 32,
  baseRef: 1024,
  reason: 512,
  reasonCodeArray: 32,
  suiteEntries: 32,
  suiteName: 64,
  transitionParentOids: 16,
  overrideIntentEnvelope: 16 * 1024,
  transitionEnvelope: 12 * 1024,
  overrideCandidateEvidence: 32 * 1024,
  finalCertificateEvidence: 16 * 1024,
} as const;

export const DECIMAL_RE = /^[0-9]+$/;
export const OID_RE = /^([0-9a-f]{40}|[0-9a-f]{64})$/;
export const SHA256_RE = /^sha256:[0-9a-f]{64}$/;
export const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

export function fail(detail: string): { ok: false; detail: string } {
  return { ok: false, detail };
}

export function ok<T>(value: T): { ok: true; value: T } {
  return { ok: true, value };
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** UTF-8 byte length after NFC normalization, which is what the bound means. */
export function byteLength(value: string): number {
  return new TextEncoder().encode(value.normalize("NFC")).length;
}

export function boundedString(v: unknown, name: string, maxBytes: number): ParseResult<string> {
  if (typeof v !== "string") return fail(`${name} must be a string`);
  if (v.length === 0) return fail(`${name} must not be empty`);
  const bytes = byteLength(v);
  if (bytes > maxBytes) return fail(`${name} exceeds ${maxBytes} bytes (${bytes})`);
  return ok(v.normalize("NFC"));
}

export function opaqueId(v: unknown, name: string): ParseResult<string> {
  return boundedString(v, name, BOUNDS.opaqueId);
}

/** GitHub ids are never JavaScript numbers on the wire (§21.1). */
export function decimalId(v: unknown, name: string): ParseResult<DecimalId> {
  if (typeof v !== "string" || !DECIMAL_RE.test(v)) return fail(`${name} must be decimal digits`);
  if (v.length > BOUNDS.decimalId) return fail(`${name} exceeds ${BOUNDS.decimalId} digits`);
  return ok(v);
}

export function gitOid(v: unknown, name: string): ParseResult<GitOid> {
  if (typeof v !== "string" || !OID_RE.test(v)) return fail(`${name} must be a lowercase hex object id`);
  return ok(v);
}

export function sha256(v: unknown, name: string): ParseResult<Sha256> {
  if (typeof v !== "string" || !SHA256_RE.test(v)) return fail(`${name} must be sha256:<64 hex>`);
  return ok(v as Sha256);
}

export function nullableSha256(v: unknown, name: string): ParseResult<Sha256 | null> {
  if (v === null) return ok(null);
  return sha256(v, name);
}

export function baseRef(v: unknown, name: string): ParseResult<BaseRef> {
  const s = boundedString(v, name, BOUNDS.baseRef);
  if (!s.ok) return s;
  if (!s.value.startsWith("refs/heads/")) return fail(`${name} must be refs/heads/<branch>`);
  if (s.value.length === "refs/heads/".length) return fail(`${name} names no branch`);
  return ok(s.value as BaseRef);
}

export function isoDateTime(v: unknown, name: string): ParseResult<IsoDateTime> {
  if (typeof v !== "string" || !ISO_RE.test(v)) return fail(`${name} must be an ISO-8601 UTC instant`);
  if (!Number.isFinite(Date.parse(v))) return fail(`${name} is unparseable`);
  return ok(v);
}

/** A whole, non-negative, safely representable integer. */
export function counter(v: unknown, name: string): ParseResult<number> {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) {
    return fail(`${name} must be a non-negative safe integer`);
  }
  return ok(v);
}

export function positiveCounter(v: unknown, name: string): ParseResult<number> {
  const n = counter(v, name);
  if (!n.ok) return n;
  if (n.value === 0) return fail(`${name} must be positive`);
  return n;
}

export function reasonText(v: unknown, name: string): ParseResult<string> {
  const s = boundedString(v, name, BOUNDS.reason);
  if (!s.ok) return s;
  if (s.value.trim().length === 0) return fail(`${name} must not be blank`);
  return s;
}

export function literal<const T extends string>(
  v: unknown,
  name: string,
  allowed: readonly T[],
): ParseResult<T> {
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) {
    return fail(`${name} must be one of ${allowed.join(", ")}`);
  }
  return ok(v as T);
}

export function array<T>(
  v: unknown,
  name: string,
  maxEntries: number,
  each: (item: unknown, index: number) => ParseResult<T>,
): ParseResult<T[]> {
  if (!Array.isArray(v)) return fail(`${name} must be an array`);
  if (v.length > maxEntries) return fail(`${name} exceeds ${maxEntries} entries`);
  const out: T[] = [];
  for (let i = 0; i < v.length; i += 1) {
    const parsed = each(v[i], i);
    if (!parsed.ok) return fail(`${name}[${i}]: ${parsed.detail}`);
    out.push(parsed.value);
  }
  return ok(out);
}

/**
 * Reject unexpected keys rather than stripping them (§21.8). A payload carrying
 * a field from another union variant is a different message, and silently
 * dropping it would let an override masquerade as a verified merge.
 */
export function exactKeys(v: Record<string, unknown>, name: string, allowed: readonly string[]): ParseResult<true> {
  for (const key of Object.keys(v)) {
    if (!allowed.includes(key)) return fail(`${name} has unexpected field ${key}`);
  }
  return ok(true);
}

export function requireKeys(
  v: Record<string, unknown>,
  name: string,
  required: readonly string[],
): ParseResult<true> {
  for (const key of required) {
    if (!(key in v)) return fail(`${name} is missing ${key}`);
  }
  return ok(true);
}

/** §21.1 GitSubject: the exact Git identity every queue record binds. */
export interface GitSubject {
  readonly objectFormat: "sha1" | "sha256";
  readonly repositoryId: DecimalId;
  readonly baseRef: BaseRef;
  readonly baseSha: GitOid;
  readonly headRepositoryId: DecimalId;
  readonly headSha: GitOid;
  readonly candidateSha: GitOid;
  readonly candidateTreeOid: GitOid;
  readonly candidateParentOids: readonly GitOid[];
}

const GIT_SUBJECT_KEYS = [
  "objectFormat",
  "repositoryId",
  "baseRef",
  "baseSha",
  "headRepositoryId",
  "headSha",
  "candidateSha",
  "candidateTreeOid",
  "candidateParentOids",
] as const;

export function parseGitSubject(v: unknown, name = "git"): ParseResult<GitSubject> {
  if (!isRecord(v)) return fail(`${name} must be an object`);
  const shape = exactKeys(v, name, GIT_SUBJECT_KEYS);
  if (!shape.ok) return shape;
  const present = requireKeys(v, name, GIT_SUBJECT_KEYS);
  if (!present.ok) return present;

  const objectFormat = literal(v["objectFormat"], `${name}.objectFormat`, ["sha1", "sha256"] as const);
  if (!objectFormat.ok) return objectFormat;
  const repositoryId = decimalId(v["repositoryId"], `${name}.repositoryId`);
  if (!repositoryId.ok) return repositoryId;
  const ref = baseRef(v["baseRef"], `${name}.baseRef`);
  if (!ref.ok) return ref;
  const baseSha = gitOid(v["baseSha"], `${name}.baseSha`);
  if (!baseSha.ok) return baseSha;
  const headRepositoryId = decimalId(v["headRepositoryId"], `${name}.headRepositoryId`);
  if (!headRepositoryId.ok) return headRepositoryId;
  const headSha = gitOid(v["headSha"], `${name}.headSha`);
  if (!headSha.ok) return headSha;
  const candidateSha = gitOid(v["candidateSha"], `${name}.candidateSha`);
  if (!candidateSha.ok) return candidateSha;
  const candidateTreeOid = gitOid(v["candidateTreeOid"], `${name}.candidateTreeOid`);
  if (!candidateTreeOid.ok) return candidateTreeOid;
  const parents = array(v["candidateParentOids"], `${name}.candidateParentOids`, 2, (item, i) =>
    gitOid(item, `parent ${i}`),
  );
  if (!parents.ok) return parents;
  if (parents.value.length < 1) return fail(`${name}.candidateParentOids must name the base commit`);

  // The object format must agree with the width of every id, or a sha1 record
  // could smuggle sha256 values past a length-blind comparison.
  const width = objectFormat.value === "sha1" ? 40 : 64;
  for (const [label, oid] of [
    ["baseSha", baseSha.value],
    ["headSha", headSha.value],
    ["candidateSha", candidateSha.value],
    ["candidateTreeOid", candidateTreeOid.value],
    ...parents.value.map((p, i) => [`candidateParentOids[${i}]`, p] as const),
  ] as ReadonlyArray<readonly [string, string]>) {
    if (oid.length !== width) return fail(`${name}.${label} is not a ${objectFormat.value} object id`);
  }

  return ok({
    objectFormat: objectFormat.value,
    repositoryId: repositoryId.value,
    baseRef: ref.value,
    baseSha: baseSha.value,
    headRepositoryId: headRepositoryId.value,
    headSha: headSha.value,
    candidateSha: candidateSha.value,
    candidateTreeOid: candidateTreeOid.value,
    candidateParentOids: parents.value,
  });
}

/**
 * Two subjects name the same integration. Used by the final live guard, where
 * "close enough" is the failure we are trying to prevent (§18, §23.2).
 */
export function sameGitSubject(a: GitSubject, b: GitSubject): boolean {
  return (
    a.objectFormat === b.objectFormat &&
    a.repositoryId === b.repositoryId &&
    a.baseRef === b.baseRef &&
    a.baseSha === b.baseSha &&
    a.headRepositoryId === b.headRepositoryId &&
    a.headSha === b.headSha &&
    a.candidateSha === b.candidateSha &&
    a.candidateTreeOid === b.candidateTreeOid &&
    a.candidateParentOids.length === b.candidateParentOids.length &&
    a.candidateParentOids.every((oid, i) => oid === b.candidateParentOids[i])
  );
}
