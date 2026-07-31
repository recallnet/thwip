# Verifiable Chain and Durable Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make thwip's merge records checkable by someone other than thwip, make the queue move without CI traffic, close the two live queue defects, put the chain somewhere durable, and build the assignment and receipt path that Fresh and Audited need.

**Architecture:** Five phases. Phase 1 makes signatures verifiable and adds a chain walker. Phase 2 gives the queue a heartbeat. Phase 3 fixes two defects seen in production. Phase 4 mirrors every signed record into R2. Phase 5 builds the assignment and integration receipt so `verified-merge` becomes reachable. Phases 1 through 4 are independent of Phase 5 and each ships value alone.

**Tech Stack:** TypeScript, Cloudflare Workers, D1 (SQLite), R2, Hono, jose (ES256 / JWS), vitest, better-sqlite3 for D1 tests.

---

## Context an engineer needs before starting

Read these first. They are short and they explain why the code looks the way it does.

- `apps/control-plane/src/queue/attestation.ts` builds and signs the two records a merge produces, and stores them in D1.
- `apps/control-plane/src/queue/evidence.ts` holds the rule that matters most: a record is validated before it is signed, and its digest is taken over the exact bytes that were signed. Never re-serialize a parsed record and digest that.
- `packages/queue-protocol/src/transition-record.ts` defines the record kinds. The parser refuses fields a kind must not carry. That is deliberate.
- `apps/control-plane/test/d1.ts` gives you a real SQLite database with every migration applied. Use `testD1()` in any test that touches D1.
- `migrations/0014_signed_queue_attestations.sql` created `queue_attestations`, which stores the signed bytes keyed by digest.

Two facts about the current production state that these tasks depend on:

- Chain links 1 through 41 are merge commit ids padded with zeroes. They are not records. Real signed records begin at link 42.
- Links 47 and 48 are missing because two merges landed without records (see task #47 in the task list). The verifier must report gaps rather than crash on them.

**Worktree:** create one with `wtnew verifiable-chain` before starting. Never use raw `git worktree add`.

**Running things:**
- All tests: `pnpm vitest run`
- One file: `pnpm vitest run apps/control-plane/src/queue/foo.test.ts`
- Lint and types: `pnpm lint && pnpm typecheck`
- Never pass `--maxWorkers`, and never use `--no-verify` on a commit.

---

## File Structure

**Phase 1, verifiable signatures and a chain walker**

- Create `packages/queue-protocol/src/verify-chain.ts`: pure chain verification. No network, no storage. Takes links and a signature checker, returns findings.
- Create `packages/queue-protocol/src/verify-chain.test.ts`.
- Create `apps/control-plane/src/service-keys.ts`: the public half of the signing key, by key id, including retired keys.
- Create `apps/control-plane/src/service-keys.test.ts`.
- Create `migrations/0015_service_key_history.sql`: `service_keys` table and the attestation epoch column.
- Modify `apps/control-plane/src/index.ts`: serve `GET /.well-known/thwip-keys`, record the active key on boot.
- Modify `apps/control-plane/src/queue/routes.ts`: add `GET /v1/queue/:repositoryId/chain` returning every link with its bytes and JWS.
- Create `packages/cli/src/verify-chain.ts` and `packages/cli/src/verify-chain.test.ts`: fetch, verify, print.
- Modify `packages/cli/src/cli-args.ts` and `packages/cli/src/main.ts`: register `thwip verify-chain`.

**Phase 2, the queue heartbeat**

- Create `apps/control-plane/src/queue/scheduled-tick.ts` and its test: enumerate enabled queues, run their deadlines, drive whoever holds the lane.
- Modify `apps/control-plane/src/index.ts`: call it from `scheduled()`.
- Modify `wrangler.jsonc`: add a five minute cron alongside the daily one.

**Phase 3, the two live defects**

- Modify `apps/control-plane/src/index.ts`: cancel an entry when its pull request closes, even mid-attempt.
- Modify `apps/control-plane/src/queue/routes.ts`: drive the lane after an eject.
- Modify `apps/control-plane/src/queue/adverse-conditions.test.ts`: regression tests for both.

**Phase 4, durable export**

- Modify `apps/control-plane/src/queue/attestation.ts`: mirror each signed record into R2 as it is stored.
- Modify `apps/control-plane/src/queue/routes.ts`: pass the bucket through.
- Create `apps/control-plane/src/queue/attestation-backfill.ts` and its test: copy records already in D1 into R2.

**Phase 5, assignment and integration receipt**

- Modify `apps/control-plane/src/active-policy.ts`: return the policy document, its version, and the Dagger digests.
- Create `apps/control-plane/src/queue/assignment.ts` and its test: build, sign, store an assignment when a turn is offered.
- Create `apps/control-plane/src/queue/integration-receipt.ts` and its test: accept and validate a signed receipt.
- Modify `apps/control-plane/src/queue/routes.ts`: issue the assignment, accept the receipt, produce a `verified-merge` record.
- Modify `packages/policy/src/index.ts`: allow `fresh` and `audited` again.

---

## Phase 1: Make a signature something anyone can check

### Task 1.1: Serve the public half of the signing key

Nothing outside the Worker can verify a record today. `serviceKey()` reads a private JWK from an environment variable and there is no endpoint publishing the public half.

**Files:**
- Create: `apps/control-plane/src/service-keys.ts`
- Test: `apps/control-plane/src/service-keys.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/control-plane/src/service-keys.test.ts
import { describe, expect, it } from "vitest";
import { publicJwkFrom } from "./service-keys.js";

/**
 * A signature nobody else can check is decoration. This turns the private key
 * the Worker signs with into the public key a reader verifies with, and it must
 * never leak the private half while doing so.
 */
describe("the public half of the signing key", () => {
  const privateJwk = {
    kty: "EC",
    crv: "P-256",
    x: "f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU",
    y: "x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0",
    d: "jpsQnnGQmL-YBIffH1136cspYG6-0iY7X1fCE9-E9LI",
    kid: "thwip-svc-1",
  };

  it("keeps every field a verifier needs", () => {
    const pub = publicJwkFrom(privateJwk);
    expect(pub).toMatchObject({ kty: "EC", crv: "P-256", x: privateJwk.x, y: privateJwk.y, kid: "thwip-svc-1" });
  });

  it("never carries the private scalar", () => {
    expect(publicJwkFrom(privateJwk)).not.toHaveProperty("d");
  });

  it("marks the key as verification-only", () => {
    expect(publicJwkFrom(privateJwk)).toMatchObject({ use: "sig", alg: "ES256" });
  });

  it("refuses a key with no id, because a verifier selects by id", () => {
    const { kid: _drop, ...anonymous } = privateJwk;
    expect(() => publicJwkFrom(anonymous)).toThrow(/kid/i);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run apps/control-plane/src/service-keys.test.ts`
Expected: FAIL, `Cannot find module './service-keys.js'`

- [ ] **Step 3: Write the implementation**

```ts
// apps/control-plane/src/service-keys.ts
import type { JWK } from "jose";

/**
 * The public half of a signing key, for anyone verifying a record.
 *
 * Every signed record the queue produces carries a JWS, and until this existed
 * the only party able to check one was the party that made it. A signature only
 * its author can verify proves nothing to a reader.
 *
 * The private scalar is dropped explicitly rather than by picking fields off a
 * spread, because a future key type with a different private field would
 * otherwise be published whole.
 */
export function publicJwkFrom(jwk: JWK): JWK {
  if (typeof jwk.kid !== "string" || jwk.kid.length === 0) {
    throw new Error("a signing key needs a kid; verifiers select the key by id");
  }
  const { d: _private, ...rest } = jwk as JWK & { d?: string };
  return { ...rest, use: "sig", alg: "ES256" };
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `pnpm vitest run apps/control-plane/src/service-keys.test.ts`
Expected: PASS, 4 tests

- [ ] **Step 5: Commit**

```bash
git add apps/control-plane/src/service-keys.ts apps/control-plane/src/service-keys.test.ts
git commit -m "feat(keys): derive the public half of the service signing key"
```

---

### Task 1.2: Keep retired keys, so old records stay verifiable

A rotation today would make every record signed with the previous key unverifiable. The chain is append-only and permanent; the keys that signed it have to outlive the rotation.

**Files:**
- Create: `migrations/0015_service_key_history.sql`
- Modify: `apps/control-plane/src/service-keys.ts`
- Test: `apps/control-plane/src/service-keys.test.ts`

- [ ] **Step 1: Write the migration**

```sql
-- migrations/0015_service_key_history.sql
-- Every key the service has ever signed with.
--
-- The chain is permanent and its records are signed. Rotating the signing key
-- without keeping the old public half would make every record signed before the
-- rotation unverifiable, which is indistinguishable from those records being
-- forged. So keys are retired, never removed.
CREATE TABLE service_keys (
  kid TEXT PRIMARY KEY,
  public_jwk TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  -- Set when the key stops signing. It still verifies everything it signed.
  retired_at TEXT
);

-- Where a branch's real records begin.
--
-- Links below this number are merge commit ids padded with zeroes, written
-- before records existed. A verifier must report them as pre-attestation rather
-- than as broken signatures, and it can only tell the difference if the boundary
-- is recorded.
ALTER TABLE queue_projects ADD COLUMN attested_from_sequence INTEGER NOT NULL DEFAULT 0;
```

- [ ] **Step 2: Write the failing test**

Append to `apps/control-plane/src/service-keys.test.ts`:

```ts
import { afterEach } from "vitest";
import { testD1 } from "../test/d1.js";
import { recordActiveKey, verificationKeys } from "./service-keys.js";
import type { D1Like } from "./queue/projection.js";

describe("the keys a reader can verify with", () => {
  const open: Array<{ close(): void }> = [];
  afterEach(() => {
    while (open.length > 0) open.pop()!.close();
  });
  function db(): D1Like {
    const t = testD1();
    open.push(t);
    return t.db as unknown as D1Like;
  }

  const key = (kid: string) => ({ kty: "EC", crv: "P-256", x: "a", y: "b", d: "secret", kid });

  it("publishes the active key", async () => {
    const store = db();
    await recordActiveKey(store, key("thwip-svc-1"));
    const keys = await verificationKeys(store);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({ kid: "thwip-svc-1", use: "sig" });
    expect(keys[0]).not.toHaveProperty("d");
  });

  it("records the same key twice without duplicating it", async () => {
    const store = db();
    await recordActiveKey(store, key("thwip-svc-1"));
    await recordActiveKey(store, key("thwip-svc-1"));
    expect(await verificationKeys(store)).toHaveLength(1);
  });

  /** The point of the table: a rotation must not orphan what the old key signed. */
  it("keeps a retired key alongside the new one", async () => {
    const store = db();
    await recordActiveKey(store, key("thwip-svc-1"));
    await recordActiveKey(store, key("thwip-svc-2"));
    const kids = (await verificationKeys(store)).map((k) => k.kid).sort();
    expect(kids).toEqual(["thwip-svc-1", "thwip-svc-2"]);
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `pnpm vitest run apps/control-plane/src/service-keys.test.ts`
Expected: FAIL, `recordActiveKey is not a function`

- [ ] **Step 4: Write the implementation**

Append to `apps/control-plane/src/service-keys.ts`:

```ts
import type { D1Like } from "./queue/projection.js";

/**
 * Remember the key the service is signing with.
 *
 * Called on the paths that sign, so a key that has ever produced a signature is
 * always publishable. Writing on conflict does nothing: the row is the public
 * half and it never changes for a given id.
 */
export async function recordActiveKey(db: D1Like, jwk: JWK): Promise<void> {
  const pub = publicJwkFrom(jwk);
  await db
    .prepare("INSERT INTO service_keys (kid, public_jwk) VALUES (?, ?) ON CONFLICT(kid) DO NOTHING")
    .bind(pub.kid, JSON.stringify(pub))
    .run();
}

/** Every key a reader may need, active and retired alike. */
export async function verificationKeys(db: D1Like): Promise<JWK[]> {
  const rows = await db.prepare("SELECT public_jwk FROM service_keys ORDER BY created_at").all<{ public_jwk: string }>();
  return rows.results.map((r) => JSON.parse(r.public_jwk) as JWK);
}
```

- [ ] **Step 5: Run it and watch it pass**

Run: `pnpm vitest run apps/control-plane/src/service-keys.test.ts`
Expected: PASS, 7 tests

- [ ] **Step 6: Commit**

```bash
git add migrations/0015_service_key_history.sql apps/control-plane/src/service-keys.ts apps/control-plane/src/service-keys.test.ts
git commit -m "feat(keys): keep every key the service has signed with"
```

---

### Task 1.3: Publish the keys over HTTP

**Files:**
- Modify: `apps/control-plane/src/index.ts`
- Modify: `apps/control-plane/src/service-signing.ts`

- [ ] **Step 1: Record the key whenever the service signs**

In `apps/control-plane/src/service-signing.ts`, replace the body of `serviceKey`:

```ts
import { CompactSign, importJWK, type JWK } from "jose";
import type { Env } from "./env.js";
import { recordActiveKey } from "./service-keys.js";
import type { D1Like } from "./queue/projection.js";

const te = new TextEncoder();

/**
 * Keys this isolate has already published. A Worker has no boot, so the key is
 * remembered on the path every signature passes through, and this keeps that
 * from costing a database write per signature.
 */
const published = new Set<string>();

export async function serviceKey(env: Env) {
  const jwk = JSON.parse(env.THWIP_SERVICE_SIGNING_PRIVATE_JWK) as JWK;
  const kid = jwk.kid ?? "thwip-svc-1";
  if (!published.has(kid)) {
    // A key that has signed is a key a reader must be able to fetch, so it is
    // recorded before the signature exists rather than after.
    await recordActiveKey(env.DB as unknown as D1Like, { ...jwk, kid });
    published.add(kid);
  }
  return { key: await importJWK(jwk, "ES256"), kid };
}
```

- [ ] **Step 2: Add the endpoint**

In `apps/control-plane/src/index.ts`, next to the other public routes, add:

```ts
/**
 * The keys that verify thwip's signed records.
 *
 * Public and unauthenticated on purpose. A merge record is only evidence if
 * somebody who does not run this service can check it, and that means the
 * verifying key has to be fetchable by anyone holding the record.
 */
app.get("/.well-known/thwip-keys", async (c) => {
  const keys = await verificationKeys(c.env.DB as unknown as D1Like);
  return c.json({ keys }, 200, { "cache-control": "public, max-age=300" });
});
```

Add the import at the top of the file:

```ts
import { verificationKeys } from "./service-keys.js";
```

- [ ] **Step 3: Check it compiles and the suite is green**

Run: `pnpm typecheck && pnpm vitest run`
Expected: no type errors, all tests pass

- [ ] **Step 4: Commit**

```bash
git add apps/control-plane/src/index.ts apps/control-plane/src/service-signing.ts
git commit -m "feat(keys): publish the verification keys at /.well-known/thwip-keys"
```

---

### Task 1.4: Verify one chain, as a pure function

This is the piece that turns the chain from an assertion into something checkable. It does no I/O so it can run in the Worker, in the CLI, and in a test.

Two rules this module lives or dies by, both learned the hard way in review:

- A link the walk cannot read must not hide a break in the link after it. Carry the claimed digest forward even when the record itself is unreadable.
- A record that has gone missing is not the same fact as history written before records existed. `ChainLink` therefore carries the position the store recorded, and an empty link inside the attested range is `MISSING_RECORD` rather than `PRE_ATTESTATION`.

**Files:**
- Create: `packages/queue-protocol/src/verify-chain.ts`
- Test: `packages/queue-protocol/src/verify-chain.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/queue-protocol/src/verify-chain.test.ts
import { describe, expect, it } from "vitest";
import { canonicalBytes, envelopeDigest } from "./canonical.js";
import { verifyChain, type ChainLink } from "./verify-chain.js";

/**
 * Walking a branch's chain and saying whether it holds.
 *
 * Until this existed the chain was a claim. Records were signed and stored and
 * nothing ever checked that the links joined up, that a digest named its own
 * bytes, or that the signature was real. The first two merges to land without a
 * record went unnoticed for exactly that reason.
 *
 * Pure on purpose. Signature checking is injected so this runs unchanged in the
 * Worker, in the CLI, and here.
 */

const BASE = "1".repeat(40);
const HEAD = "2".repeat(40);
const TREE = "4".repeat(40);
const D = (c: string) => `sha256:${c.repeat(64)}`;

async function link(sequence: number, previous: string | null, over: Record<string, unknown> = {}): Promise<ChainLink> {
  const record = {
    schemaVersion: "1",
    kind: "reused-proof-merge",
    repositoryId: "1315419165",
    baseRef: "refs/heads/main",
    queueEpoch: 1,
    transitionSequence: sequence,
    previousTransitionDigest: previous,
    before: { baseSha: BASE, treeOid: "5".repeat(40) },
    after: {
      baseSha: "3".repeat(40),
      treeOid: TREE,
      parentOids: [BASE, HEAD],
      parentCount: 2,
      parentOidsDigest: D("7"),
      parentsComplete: true,
    },
    observedAt: "2026-07-31T12:00:00Z",
    reusedProof: {
      attemptId: `att-${sequence}`,
      mergeIntentDigest: D("1"),
      pullRequestNumber: sequence,
      headSha: HEAD,
      candidateSha: "3".repeat(40),
      candidateTreeOid: TREE,
      mergeMethod: "merge",
      workReceiptDigest: D("2"),
      policyDigest: D("6"),
      pipelineDigest: D("8"),
      requiredSuitesDigest: D("9"),
      checkRunId: "778899",
    },
    ...over,
  };
  const bytes = canonicalBytes(JSON.stringify(record));
  return { digest: await envelopeDigest(bytes), bytes, jws: "signature" };
}

const signedOk = { verifySignature: async () => true, epochStartsAt: 1 };

describe("verifying a chain", () => {
  it("accepts a chain whose links join up", async () => {
    const one = await link(1, null);
    const two = await link(2, one.digest);
    expect(await verifyChain([one, two], signedOk)).toEqual([]);
  });

  it("reports a digest that does not name its own bytes", async () => {
    const one = await link(1, null);
    const tampered = { ...one, digest: D("0") };
    const findings = await verifyChain([tampered], signedOk);
    expect(findings.map((f) => f.code)).toContain("DIGEST_MISMATCH");
  });

  it("reports a link that names the wrong predecessor", async () => {
    const one = await link(1, null);
    const two = await link(2, D("0"));
    const findings = await verifyChain([one, two], signedOk);
    expect(findings.map((f) => f.code)).toContain("BROKEN_LINK");
  });

  /** The failure that actually happened: two merges landed and wrote no record. */
  it("reports a gap where a sequence number is missing", async () => {
    const one = await link(1, null);
    const three = await link(3, one.digest);
    const findings = await verifyChain([one, three], signedOk);
    expect(findings.map((f) => f.code)).toContain("SEQUENCE_GAP");
  });

  it("reports a signature that does not verify", async () => {
    const one = await link(1, null);
    const findings = await verifyChain([one], { verifySignature: async () => false, epochStartsAt: 1 });
    expect(findings.map((f) => f.code)).toContain("BAD_SIGNATURE");
  });

  it("reports bytes that are not a record at all", async () => {
    const junk: ChainLink = {
      digest: await envelopeDigest(canonicalBytes("{}")),
      bytes: canonicalBytes("{}"),
      jws: "signature",
    };
    const findings = await verifyChain([junk], signedOk);
    expect(findings.map((f) => f.code)).toContain("UNPARSEABLE");
  });

  /**
   * Links written before records existed are padded commit ids. They are history,
   * not forgery, and a verifier that cannot tell the two apart is useless on any
   * repository that predates the change.
   */
  it("calls pre-epoch links out separately instead of failing them", async () => {
    const old: ChainLink = { digest: D("a"), bytes: new Uint8Array(), jws: "" };
    const findings = await verifyChain([old], { verifySignature: async () => false, epochStartsAt: 2 });
    expect(findings.map((f) => f.code)).toEqual(["PRE_ATTESTATION"]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run packages/queue-protocol/src/verify-chain.test.ts`
Expected: FAIL, `Cannot find module './verify-chain.js'`

- [ ] **Step 3: Write the implementation**

```ts
// packages/queue-protocol/src/verify-chain.ts
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
  /** The exact bytes that were signed. Empty for a link written before records. */
  readonly bytes: Uint8Array;
  readonly jws: string;
}

export interface ChainFinding {
  readonly code:
    | "DIGEST_MISMATCH"
    | "BROKEN_LINK"
    | "SEQUENCE_GAP"
    | "BAD_SIGNATURE"
    | "UNPARSEABLE"
    | "PRE_ATTESTATION";
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
  let previous: { digest: string; sequence: number } | null = null;

  for (const link of links) {
    const parsed = await inspect(link, ports);
    if (parsed === null) {
      // Pre-epoch: no bytes to check, and the sequence cannot be read from them.
      findings.push({
        code: "PRE_ATTESTATION",
        sequence: null,
        digest: link.digest,
        detail: "written before signed records; nothing to verify",
      });
      previous = null;
      continue;
    }
    findings.push(...parsed.findings);
    if (parsed.sequence === null) {
      previous = null;
      continue;
    }

    if (previous !== null) {
      if (parsed.sequence !== previous.sequence + 1) {
        findings.push({
          code: "SEQUENCE_GAP",
          sequence: parsed.sequence,
          digest: link.digest,
          detail: `link ${parsed.sequence} follows ${previous.sequence}; a merge landed without a record`,
        });
      }
      if (parsed.previousDigest !== previous.digest) {
        findings.push({
          code: "BROKEN_LINK",
          sequence: parsed.sequence,
          digest: link.digest,
          detail: `names ${parsed.previousDigest ?? "nothing"} as its predecessor, which is not the link before it`,
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
): Promise<{ sequence: number | null; previousDigest: string | null; findings: ChainFinding[] } | null> {
  if (link.bytes.length === 0) return null;

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
    return { sequence: null, previousDigest: null, findings };
  }

  const record = parseTransitionRecord(value);
  if (!record.ok) {
    findings.push({ code: "UNPARSEABLE", sequence: null, digest: link.digest, detail: record.detail });
    return { sequence: null, previousDigest: null, findings };
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
    sequence: record.value.transitionSequence,
    previousDigest: record.value.previousTransitionDigest,
    findings,
  };
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `pnpm vitest run packages/queue-protocol/src/verify-chain.test.ts`
Expected: PASS, 7 tests

- [ ] **Step 5: Export it from the package**

In `packages/queue-protocol/src/index.ts`, add:

```ts
export * from "./verify-chain.js";
```

- [ ] **Step 6: Commit**

```bash
git add packages/queue-protocol/src/verify-chain.ts packages/queue-protocol/src/verify-chain.test.ts packages/queue-protocol/src/index.ts
git commit -m "feat(protocol): walk a chain and say whether it holds"
```

---

### Task 1.5: Serve a whole chain for verification

`GET /v1/queue/records/:digest` serves one record. A verifier needs all of them with their bytes, in order.

**Files:**
- Modify: `apps/control-plane/src/queue/attestation.ts`
- Modify: `apps/control-plane/src/queue/routes.ts`
- Test: `apps/control-plane/src/queue/attestation.test.ts`

- [ ] **Step 1: Write the failing test**

Append to the `describe("keeping the signed bytes", ...)` block in `apps/control-plane/src/queue/attestation.test.ts`:

```ts
  it("hands back a whole branch's records in chain order", async () => {
    const store = db();
    const first = await record(D("f"));
    await storeAttestation(store, {
      digest: first.digest,
      kind: "reused-proof-merge",
      repositoryId: "1315419165",
      baseRef: "refs/heads/main",
      transitionSequence: 9,
      attemptId: "att-1",
      bytes: first.bytes,
      jws: first.jws,
    });
    await storeAttestation(store, {
      digest: D("e"),
      kind: "merge-intent",
      repositoryId: "1315419165",
      baseRef: "refs/heads/main",
      transitionSequence: null,
      attemptId: "att-1",
      bytes: new TextEncoder().encode("{}"),
      jws: "j",
    });

    const chain = await readChain(store, "1315419165", "refs/heads/main");
    // Intents are cited by records; they are not links, so they are not returned.
    expect(chain).toHaveLength(1);
    expect(chain[0]?.digest).toBe(first.digest);
    expect(new TextDecoder().decode(chain[0]!.bytes)).toBe(new TextDecoder().decode(first.bytes));
  });
```

Add `readChain` to the import at the top of that file.

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run apps/control-plane/src/queue/attestation.test.ts`
Expected: FAIL, `readChain is not exported`

- [ ] **Step 3: Write the implementation**

Append to `apps/control-plane/src/queue/attestation.ts`:

```ts
/**
 * Every signed link on a branch, oldest first.
 *
 * Only records occupy a position in the chain, so intents are left out: they are
 * cited by the record that follows them and are fetched by digest when a reader
 * wants one.
 */
export async function readChain(
  db: D1Like,
  repositoryId: string,
  baseRef: string,
): Promise<Array<{ digest: string; sequence: number; bytes: Uint8Array; jws: string }>> {
  const rows = await db
    .prepare(
      `SELECT digest, transition_sequence AS sequence, bytes, jws
         FROM queue_attestations
        WHERE github_repository_id = ? AND base_ref = ? AND transition_sequence IS NOT NULL
        ORDER BY transition_sequence`,
    )
    .bind(repositoryId, baseRef)
    .all<{ digest: string; sequence: number; bytes: string; jws: string }>();
  const encoder = new TextEncoder();
  return rows.results.map((r) => ({
    digest: r.digest,
    sequence: r.sequence,
    bytes: encoder.encode(r.bytes),
    jws: r.jws,
  }));
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `pnpm vitest run apps/control-plane/src/queue/attestation.test.ts`
Expected: PASS

- [ ] **Step 5: Add the endpoint**

In `apps/control-plane/src/queue/routes.ts`, beside the existing `GET /v1/queue/records/:digest`:

```ts
  /**
   * A branch's whole chain, with the bytes each link was signed over.
   *
   * Open, like the records it serves. A reader fetches this, fetches the keys
   * from /.well-known/thwip-keys, and checks the chain without trusting this
   * service for anything except the bytes it is being asked to verify.
   */
  app.get("/v1/queue/:repositoryId/chain", async (c) => {
    const repositoryId = decimal(c.req.param("repositoryId"));
    const baseRef = branchRef(c.req.query("ref"));
    if (repositoryId === null || baseRef === null) return c.json({ error: "invalid queue key" }, 400);

    const project = await c.env.DB.prepare(
      "SELECT attested_from_sequence AS epoch FROM queue_projects WHERE github_repository_id = ? AND base_ref = ?",
    )
      .bind(repositoryId, baseRef)
      .first<{ epoch: number }>();
    if (project === null) return c.json({ error: "no queue for that branch" }, 404);

    const links = await readChain(c.env.DB as unknown as D1Like, repositoryId, baseRef);
    const decoder = new TextDecoder();
    return c.json({
      epochStartsAt: project.epoch,
      links: links.map((l) => ({ digest: l.digest, sequence: l.sequence, record: decoder.decode(l.bytes), jws: l.jws })),
    });
  });
```

Add `readChain` to the `./attestation.js` import.

- [ ] **Step 6: Check types and the suite**

Run: `pnpm typecheck && pnpm vitest run`
Expected: no errors, all pass

- [ ] **Step 7: Commit**

```bash
git add apps/control-plane/src/queue/attestation.ts apps/control-plane/src/queue/attestation.test.ts apps/control-plane/src/queue/routes.ts
git commit -m "feat(queue): serve a branch's whole chain for verification"
```

---

### Task 1.6: `thwip verify-chain`

**Files:**
- Create: `packages/cli/src/verify-chain.ts`
- Test: `packages/cli/src/verify-chain.test.ts`
- Modify: `packages/cli/src/cli-args.ts`, `packages/cli/src/main.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/src/verify-chain.test.ts
import { describe, expect, it } from "vitest";
import { summarize } from "./verify-chain.js";

/**
 * What a person sees. A verifier that prints "3 findings" tells them nothing
 * about whether to trust the branch, so the summary leads with the answer and
 * separates history from failure.
 */
describe("the verification summary", () => {
  it("says a clean chain holds", () => {
    expect(summarize(42, [])).toContain("42 links verified");
  });

  it("separates pre-attestation history from real problems", () => {
    const text = summarize(3, [
      { code: "PRE_ATTESTATION", sequence: null, digest: "sha256:a", detail: "written before signed records" },
    ]);
    expect(text).toContain("1 link predates signed records");
    expect(text).not.toMatch(/fail/i);
  });

  it("names a broken link and fails", () => {
    const text = summarize(2, [
      { code: "BROKEN_LINK", sequence: 7, digest: "sha256:b", detail: "names the wrong predecessor" },
    ]);
    expect(text).toMatch(/BROKEN_LINK/);
    expect(text).toMatch(/link 7/);
  });

  it("reports a gap as a merge that landed without a record", () => {
    const text = summarize(2, [
      { code: "SEQUENCE_GAP", sequence: 48, digest: "sha256:c", detail: "a merge landed without a record" },
    ]);
    expect(text).toContain("landed without a record");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run packages/cli/src/verify-chain.test.ts`
Expected: FAIL, `Cannot find module './verify-chain.js'`

- [ ] **Step 3: Write the implementation**

```ts
// packages/cli/src/verify-chain.ts
import { createLocalJWKSet, compactVerify, type JSONWebKeySet } from "jose";
import { verifyChain, type ChainFinding, type ChainLink } from "@thwip/queue-protocol";

/**
 * Check a branch's chain against the keys thwip publishes.
 *
 * Everything is fetched: the links, and the keys that signed them. Nothing is
 * taken on trust except that the digest in a link names the bytes beside it,
 * which is the one thing this checks first.
 */

export function summarize(verified: number, findings: readonly ChainFinding[]): string {
  const history = findings.filter((f) => f.code === "PRE_ATTESTATION");
  const problems = findings.filter((f) => f.code !== "PRE_ATTESTATION");

  const lines: string[] = [];
  if (problems.length === 0) {
    lines.push(`${verified} links verified.`);
  } else {
    lines.push(`${problems.length} problem${problems.length === 1 ? "" : "s"} in ${verified} links.`);
  }
  if (history.length > 0) {
    lines.push(`${history.length} link${history.length === 1 ? "" : "s"} predates signed records.`);
  }
  for (const p of problems) {
    const where = p.sequence === null ? p.digest.slice(0, 16) : `link ${p.sequence}`;
    lines.push(`  ${p.code} at ${where}: ${p.detail}`);
  }
  return lines.join("\n");
}

export interface ChainResponse {
  readonly epochStartsAt: number;
  readonly links: ReadonlyArray<{ digest: string; sequence: number; record: string; jws: string }>;
}

export async function verifyPublishedChain(
  chain: ChainResponse,
  jwks: JSONWebKeySet,
): Promise<{ verified: number; findings: readonly ChainFinding[] }> {
  const keys = createLocalJWKSet(jwks);
  const encoder = new TextEncoder();
  const links: ChainLink[] = chain.links.map((l) => ({
    digest: l.digest,
    bytes: encoder.encode(l.record),
    jws: l.jws,
    // The position the store recorded. A link whose record is missing cannot say
    // where it sits, and that is how a lost record is told from history.
    sequence: l.sequence,
  }));

  const findings = await verifyChain(links, {
    epochStartsAt: chain.epochStartsAt,
    async verifySignature(jws, bytes) {
      try {
        const { payload } = await compactVerify(jws, keys);
        return new TextDecoder().decode(payload) === new TextDecoder().decode(bytes);
      } catch {
        return false;
      }
    },
  });
  return { verified: links.length, findings };
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `pnpm vitest run packages/cli/src/verify-chain.test.ts`
Expected: PASS, 4 tests

- [ ] **Step 5: Register the command**

In `packages/cli/src/cli-args.ts`, add `"verify-chain"` to the `CliCommand` union and a line to the `COMMANDS` block of `HELP`:

```
  verify-chain              Fetch and verify a branch's merge chain.
```

In `packages/cli/src/main.ts`, add the dispatch case beside `case "verify":`:

```ts
    case "verify-chain":
      return cmdVerifyChain([...invocation.argv]);
```

And the command itself:

```ts
async function cmdVerifyChain(argv: string[]): Promise<number> {
  const endpoint = process.env["THWIP_ENDPOINT"] ?? "https://thwip.recall.net";
  const repo = valueOf(argv, "--repo");
  const branch = valueOf(argv, "--branch") ?? "main";
  if (repo === undefined) {
    process.stderr.write("usage: thwip verify-chain --repo OWNER/NAME [--branch BRANCH]\n");
    return EXIT.usage;
  }
  const repositoryId = await githubRepositoryId(repo);
  const ref = encodeURIComponent(`refs/heads/${branch}`);

  const [chainRes, keysRes] = await Promise.all([
    fetch(`${endpoint}/v1/queue/${repositoryId}/chain?ref=${ref}`),
    fetch(`${endpoint}/.well-known/thwip-keys`),
  ]);
  if (!chainRes.ok) {
    process.stderr.write(`could not read the chain (${chainRes.status})\n`);
    return EXIT.failure;
  }
  const chain = (await chainRes.json()) as ChainResponse;
  const jwks = (await keysRes.json()) as JSONWebKeySet;

  const { verified, findings } = await verifyPublishedChain(chain, jwks);
  process.stdout.write(summarize(verified, findings) + "\n");
  return findings.some((f) => f.code !== "PRE_ATTESTATION") ? EXIT.failure : 0;
}
```

`packages/cli/src/queue-commands.ts` already parses `--repo owner/name` and validates it against `/^[\w.-]+\/[\w.-]+$/`. Reuse that parsing rather than writing a second copy, and resolve `OWNER/NAME` to a repository id the same way `thwip queue status` already does.

- [ ] **Step 6: Verify end to end against staging**

```bash
pnpm --filter @thwip/cli build
node packages/cli/dist/main.js verify-chain --repo recallnet/thwip
```

Expected today, given the two known gaps: a `SEQUENCE_GAP` finding and a count of pre-attestation links. That output is the proof this works.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/verify-chain.ts packages/cli/src/verify-chain.test.ts packages/cli/src/cli-args.ts packages/cli/src/main.ts
git commit -m "feat(cli): thwip verify-chain checks a branch against the published keys"
```

---

### Task 1.7: Record where this repository's real chain begins

**Files:**
- Create: `migrations/0016_attestation_epoch_for_thwip.sql`

- [ ] **Step 1: Write the migration**

```sql
-- migrations/0016_attestation_epoch_for_thwip.sql
-- Link 42 is the first signed record on this repository's chain.
--
-- Everything below it is a merge commit id padded with zeroes, written before
-- records existed. Recording the boundary lets a verifier report that history as
-- history instead of as forty-one broken signatures.
UPDATE queue_projects
   SET attested_from_sequence = 42
 WHERE github_repository_id = '1315419165' AND base_ref = 'refs/heads/main';
```

- [ ] **Step 2: Apply and verify**

```bash
cd apps/control-plane
pnpm exec wrangler d1 migrations apply thwip-staging-wnam --env staging --remote
pnpm exec wrangler d1 execute thwip-staging-wnam --env staging --remote \
  --command "SELECT github_repository_id, attested_from_sequence FROM queue_projects"
```

Expected: `attested_from_sequence` is 42.

- [ ] **Step 3: Commit**

```bash
git add migrations/0016_attestation_epoch_for_thwip.sql
git commit -m "chore(queue): record where this repository's signed chain begins"
```

---

## Phase 2: Give the queue a heartbeat

The queue advances deadlines inside `runOnQueue`, which only runs when a request arrives. The daily cron syncs installations and policies and never ticks a queue. An offer expires and nothing notices, which is why a pull request sat idle tonight until it was pushed to by hand.

### Task 2.1: Tick every enabled queue

**Files:**
- Create: `apps/control-plane/src/queue/scheduled-tick.ts`
- Test: `apps/control-plane/src/queue/scheduled-tick.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/control-plane/src/queue/scheduled-tick.test.ts
import { afterEach, describe, expect, it } from "vitest";
import { testD1 } from "../../test/d1.js";
import { tickAllQueues } from "./scheduled-tick.js";
import type { QueueRouteEnv } from "./routes.js";

/**
 * The queue moves when something calls it, and nothing called it on a timer.
 *
 * Deadlines are advanced inside a queue transaction, so an expired offer went
 * unnoticed until unrelated traffic arrived. On a quiet repository that is
 * indefinitely. This is the heartbeat, and it must be cheap enough to run often
 * and quiet enough not to drive a lane nobody holds.
 */

const open: Array<{ close(): void }> = [];
let raw: import("better-sqlite3").Database;

function env(): QueueRouteEnv {
  const t = testD1();
  open.push(t);
  raw = t.raw;
  return { DB: t.db, PUBLIC_ORIGIN: "https://thwip.test" } as unknown as QueueRouteEnv;
}

afterEach(() => {
  while (open.length > 0) open.pop()!.close();
});

function queue(repositoryId: string, enabled: number) {
  raw
    .prepare(
      `INSERT INTO queue_projects (id, organization_id, github_repository_id, base_ref, enabled, activation_state)
       VALUES (?, 'org_1', ?, 'refs/heads/main', ?, 'enforced')`,
    )
    .run(`qp_${repositoryId}`, repositoryId, enabled);
}

describe("the queue heartbeat", () => {
  it("visits every enabled queue", async () => {
    const e = env();
    queue("1", 1);
    queue("2", 1);
    const visited: string[] = [];
    const result = await tickAllQueues(e, {
      driveTurn: async () => {},
      onQueueTicked: (repositoryId) => visited.push(repositoryId),
    });
    expect(visited.sort()).toEqual(["1", "2"]);
    expect(result.ticked).toBe(2);
  });

  it("leaves a disabled queue alone", async () => {
    const e = env();
    queue("1", 0);
    const result = await tickAllQueues(e, { driveTurn: async () => {}, onQueueTicked: () => {} });
    expect(result.ticked).toBe(0);
  });

  /** A lane nobody holds needs no dispatch, and dispatching costs a CI run. */
  it("drives nobody when no lane is held", async () => {
    const e = env();
    queue("1", 1);
    let drives = 0;
    await tickAllQueues(e, { driveTurn: async () => void drives++, onQueueTicked: () => {} });
    expect(drives).toBe(0);
  });

  /** One queue failing must not stop the rest from being ticked. */
  it("keeps going when one queue throws", async () => {
    const e = env();
    queue("1", 1);
    queue("2", 1);
    const result = await tickAllQueues(e, {
      driveTurn: async () => {
        throw new Error("github is down");
      },
      onQueueTicked: () => {},
    });
    expect(result.ticked).toBe(2);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run apps/control-plane/src/queue/scheduled-tick.test.ts`
Expected: FAIL, `Cannot find module './scheduled-tick.js'`

- [ ] **Step 3: Write the implementation**

```ts
// apps/control-plane/src/queue/scheduled-tick.ts
import { commandsFor, buildSnapshot } from "./queue-operations.js";
import { withQueueState } from "./queue-state.js";
import type { D1Like } from "./projection.js";
import type { QueueRouteEnv } from "./routes.js";

/**
 * Move every queue's clock forward on a timer.
 *
 * Deadlines are advanced inside a queue transaction, so before this existed an
 * expired offer went unnoticed until unrelated traffic happened to arrive. On a
 * quiet repository that is indefinitely: the lane sits held by an offer nobody
 * can take, and the pull request behind it waits forever.
 *
 * Deliberately cheap. One row read per queue, a write only when the clock
 * actually changed something, and a dispatch only when a lane is held.
 */
export interface TickPorts {
  driveTurn(repositoryId: string, pullRequestNumber: number): Promise<void>;
  onQueueTicked(repositoryId: string): void;
}

export async function tickAllQueues(
  env: QueueRouteEnv,
  ports: TickPorts,
): Promise<{ ticked: number; driven: number }> {
  const rows = await env.DB.prepare(
    "SELECT github_repository_id AS repositoryId, base_ref AS baseRef FROM queue_projects WHERE enabled = 1",
  ).all<{ repositoryId: string; baseRef: string }>();

  let ticked = 0;
  let driven = 0;
  for (const row of rows.results) {
    try {
      const snapshot = await withQueueState(
        env.DB as unknown as D1Like,
        row.repositoryId,
        row.baseRef,
        (store) => {
          const commands = commandsFor(store);
          commands.runAlarm();
          return buildSnapshot(store);
        },
      );
      ticked += 1;
      ports.onQueueTicked(row.repositoryId);

      // Only a held lane needs driving. Dispatching for an idle queue would
      // spend a CI run to be told there is nothing to do.
      const holder = snapshot.entries.find((e) => e.state === "Offered" || e.state === "Active");
      if (holder !== undefined) {
        await ports.driveTurn(row.repositoryId, holder.pullRequestNumber);
        driven += 1;
      }
    } catch {
      // One queue's problem is not the others'. The next tick retries it.
      ticked += 1;
    }
  }
  return { ticked, driven };
}
```

`withQueueState(db, repositoryId, baseRef, decide, options?)` is the real signature and it handles the compare-and-swap retry itself, so the call above is correct as written. It saves only when the decision changed something, which is what keeps a five minute tick cheap on an idle queue.

- [ ] **Step 4: Run it and watch it pass**

Run: `pnpm vitest run apps/control-plane/src/queue/scheduled-tick.test.ts`
Expected: PASS, 4 tests

- [ ] **Step 5: Commit**

```bash
git add apps/control-plane/src/queue/scheduled-tick.ts apps/control-plane/src/queue/scheduled-tick.test.ts
git commit -m "feat(queue): tick every enabled queue on a timer"
```

---

### Task 2.2: Wire the heartbeat to a cron

**Files:**
- Modify: `apps/control-plane/src/index.ts`
- Modify: `wrangler.jsonc`

- [ ] **Step 1: Add the cron trigger**

In `wrangler.jsonc`, change the staging triggers block:

```jsonc
      "triggers": { "crons": ["17 3 * * *", "*/5 * * * *"] },
```

- [ ] **Step 2: Split the scheduled handler by trigger**

Replace the body of `scheduled()` in `apps/control-plane/src/index.ts`:

```ts
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    // The five minute trigger is the queue's clock. It is separate from the
    // daily reconciliation because a queue that only moves when CI traffic
    // arrives will sit on an expired offer indefinitely on a quiet repository.
    if (controller.cron === "*/5 * * * *") {
      await tickAllQueues(env as unknown as QueueRouteEnv, {
        driveTurn: (repositoryId, pullRequestNumber) => driveTurnFor(env, repositoryId, pullRequestNumber),
        onQueueTicked: () => {},
      });
      return;
    }

    const orgs = await env.DB.prepare(
      "SELECT installation_id FROM organizations WHERE installation_id IS NOT NULL AND status = 'active'",
    ).all<{ installation_id: string }>();
    for (const o of orgs.results) {
      try {
        await syncInstallation(env, o.installation_id);
        await reconcileInstallationPolicies(env, o.installation_id);
        await reconcileInstallationProofChecks(env, o.installation_id);
      } catch {
        /* retried next run */
      }
    }
  },
```

The `driveTurn` implementation already exists inside the `queueRoutes` deps object in this file. Extract it to a module-level `async function driveTurnFor(env: Env, repositoryId: string, pullRequestNumber: number)` and have the deps object call it, so both callers share one implementation rather than a copy.

- [ ] **Step 3: Check types and the suite**

Run: `pnpm typecheck && pnpm vitest run && pnpm lint`
Expected: all clean

- [ ] **Step 4: Commit**

```bash
git add apps/control-plane/src/index.ts wrangler.jsonc
git commit -m "feat(queue): run the queue clock every five minutes"
```

- [ ] **Step 5: Verify live after deploy**

```bash
cd apps/control-plane && pnpm deploy:staging
pnpm exec wrangler tail --env staging --format pretty
```

Expected within five minutes: a scheduled invocation that reads `queue_projects` and exits without dispatching, because no lane is held.

---

## Phase 3: The two defects seen in production

### Task 3.1: An entry whose pull request closed must not take a turn

Twice tonight a merged pull request was still an entry, was offered the turn, and starved everyone behind it. Both had to be ejected by hand.

**Files:**
- Modify: `apps/control-plane/src/index.ts` (the `queueFromPullRequest` function)
- Test: `apps/control-plane/src/queue/adverse-conditions.test.ts`

- [ ] **Step 1: Reproduce it in a test first**

Add to `apps/control-plane/src/queue/adverse-conditions.test.ts`:

```ts
/**
 * A pull request that has left must not keep taking turns.
 *
 * Twice in production a merged pull request was still an entry, was offered the
 * turn, and starved the queue behind it until an operator ejected it by hand.
 * The `closed` webhook does cancel an entry, so what matters is the case it was
 * missing: the entry holding a live attempt when its pull request goes away.
 */
describe("a pull request that leaves while holding the lane", () => {
  it("frees the lane instead of holding it", async () => {
    const e = env();
    const app = routes();
    const holder = await authorize(app, e, 59, {
      prepare: true,
      candidate: {
        baseSha: "b".repeat(40),
        candidateSha: "c".repeat(40),
        candidateTreeOid: TREE,
        parentShas: ["b".repeat(40), "6".repeat(40)],
      },
    });
    expect(holder.operationId).not.toBeNull();

    const response = await app.request(
      `/v1/queue/${REPO}/entries/entry_${REPO}_59?ref=${encodeURIComponent(REF)}&reason=${encodeURIComponent("the pull request was closed")}`,
      { method: "DELETE" },
      e,
    );
    expect(response.status).toBe(200);

    const after = await liveState(app, e);
    expect(after.activeAttemptId).toBeNull();
    expect(stateOf(after, 59)).toBe("Cancelled");
  });
});
```

- [ ] **Step 2: Run it and see what actually happens**

Run: `pnpm vitest run apps/control-plane/src/queue/adverse-conditions.test.ts -t "frees the lane"`

Two possible outcomes, and which one you get determines the fix:
- If it fails because `cancel` was rejected while the attempt is live, the reducer needs to terminate the attempt before cancelling the entry.
- If it passes, the defect is upstream in `queueFromPullRequest`, and the missing piece is that the `closed` webhook never reaches the cancel because of one of its early returns.

Record which one you saw in the commit message. Do not guess; the fix differs.

- [ ] **Step 3: Fix whichever it is**

If the reducer refuses the cancel, in `packages/queue-domain/src/reducer.ts` under `EntryCancelled`, terminate a live attempt first:

```ts
      // A pull request that has gone away is never coming back to take its turn,
      // so its attempt ends with it. Leaving the attempt live held the lane
      // indefinitely, twice, and each time needed an operator to clear it.
      if (state.activeAttemptId !== null) {
        const attempt = state.attempts.get(state.activeAttemptId);
        if (attempt !== undefined && attempt.entryId === entry.entryId) {
          terminate(state, attempt, "SUPERSEDED");
        }
      }
```

If instead the webhook never arrives at the cancel, add a log line naming the early return it took, deploy, close a test pull request, and read the tail. Fix the branch that fired.

- [ ] **Step 4: Run it and watch it pass**

Run: `pnpm vitest run apps/control-plane/src/queue/adverse-conditions.test.ts`
Expected: PASS, every test in the file

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "fix(queue): a pull request that leaves frees the lane it held"
```

---

### Task 3.2: Ejecting an entry drives whoever gets the turn next

After ejecting the lane holder tonight the queue offered the turn to the next pull request and told nobody, so the offer expired unclaimed.

**Files:**
- Modify: `apps/control-plane/src/queue/routes.ts`
- Test: `apps/control-plane/src/queue/adverse-conditions.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
  it("drives whoever gets the turn after an eject", async () => {
    const e = env();
    const driven: number[] = [];
    const app = routes({ driveTurn: async (_e, _r, pr) => void driven.push(pr) });
    await authorize(app, e, 59);
    await authorize(app, e, 60);

    driven.length = 0;
    await app.request(
      `/v1/queue/${REPO}/entries/entry_${REPO}_59?ref=${encodeURIComponent(REF)}`,
      { method: "DELETE" },
      e,
    );

    // The lane moved, so something has to tell the new holder. Nothing did, and
    // the offer expired unclaimed.
    expect(driven).toContain(60);
  });
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run apps/control-plane/src/queue/adverse-conditions.test.ts -t "drives whoever gets the turn"`
Expected: FAIL, `expected [] to contain 60`

- [ ] **Step 3: Drive the lane after the eject**

In `apps/control-plane/src/queue/routes.ts`, in the `DELETE /v1/queue/:repositoryId/entries/:entryId` handler, replace the final lines:

```ts
    const { result, snapshot } = await onQueue(c.env, repositoryId, baseRef, ({ commands }) =>
      commands.cancel({
        idempotencyKey: idempotencyKey(c.req.header("idempotency-key"), `cancel:${entryId}`),
        entryId,
        actorPrincipalId: who.principalId,
        reason,
      }),
    );

    // Ejecting frees the lane, and a freed lane is offered to somebody else. That
    // offer expires in ninety seconds, so telling nobody about it wastes a turn
    // and, on a quiet queue, stalls it entirely.
    await driveLane(c.env, deps, repositoryId, snapshot);
    return c.json({ result }, result.status === "rejected" ? 409 : 200);
```

- [ ] **Step 4: Run it and watch it pass**

Run: `pnpm vitest run apps/control-plane/src/queue/adverse-conditions.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/control-plane/src/queue/routes.ts apps/control-plane/src/queue/adverse-conditions.test.ts
git commit -m "fix(queue): ejecting an entry drives whoever gets the turn next"
```

---

### Task 3.3: Pin the merge race that lost two records

The workflow fix is already on main. This pins the queue-side behaviour it depends on: reporting the same merge twice must produce one link, and reporting a merge for an attempt already told it did not merge must not silently succeed.

**Files:**
- Test: `apps/control-plane/src/queue/adverse-conditions.test.ts`

- [ ] **Step 1: Write the test**

```ts
  /**
   * Two merge runs raced for one turn. One merged; the other was told 405 and
   * reported not-merged, so the queue terminated the attempt and refused the real
   * confirmation. Two merges landed with no record. The workflow now asks GitHub
   * what happened rather than trusting its own status code, and both runs report
   * the same merge, so this pins what the queue does with that.
   */
  it("records one link however many times the same merge is reported", async () => {
    const e = env();
    const app = routes();
    const holder = await authorize(app, e, 59, {
      prepare: true,
      candidate: {
        baseSha: "b".repeat(40),
        candidateSha: "c".repeat(40),
        candidateTreeOid: TREE,
        parentShas: ["b".repeat(40), "6".repeat(40)],
      },
    });
    const body = JSON.stringify({
      baseRef: REF,
      attemptId: holder.operationId!.replace("merge_", ""),
      operationId: holder.operationId,
      mergeSha: "9".repeat(40),
      mergeTree: TREE,
      parentShas: ["b".repeat(40), String(59).padStart(40, "a")],
    });
    const post = () =>
      app.request(
        `/v1/queue/${REPO}/merged`,
        { method: "POST", headers: { "content-type": "application/json" }, body },
        e,
      );

    const first = (await (await post()).json()) as { transitionDigest: string | null };
    const second = (await (await post()).json()) as { transitionDigest: string | null };
    expect(first.transitionDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(second.transitionDigest).toBe(first.transitionDigest);

    const links = raw
      .prepare("SELECT COUNT(*) AS c FROM queue_transitions_index WHERE github_repository_id = ?")
      .get(REPO) as { c: number };
    expect(links.c).toBe(1);
  });
```

- [ ] **Step 2: Run it**

Run: `pnpm vitest run apps/control-plane/src/queue/adverse-conditions.test.ts -t "however many times"`

If it fails, the second report is producing a different digest or a second link. Both are bugs. The record is keyed by attempt, so the second call must return the stored digest rather than sign a new record over a new `observedAt`. Fix by looking up an existing record for the attempt before signing.

- [ ] **Step 3: Commit**

```bash
git add apps/control-plane/src/queue/adverse-conditions.test.ts
git commit -m "test(queue): one merge reported twice is one chain link"
```

---

## Phase 4: Put the chain somewhere durable

D1 holds the only copy of every signed record. Compaction drops old links from the queue document, the event tail keeps 200 entries, and there is no export. R2 already stores evidence bytes keyed by digest and already has `merge-intent` and `transition-record` in its `EvidenceKind` union, so the destination exists.

### Task 4.1: Mirror every signed record into R2 as it is written

**Files:**
- Modify: `apps/control-plane/src/queue/attestation.ts`
- Modify: `apps/control-plane/src/queue/routes.ts`
- Test: `apps/control-plane/src/queue/attestation.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
  it("mirrors the signed bytes into the bucket it is given", async () => {
    const store = db();
    const signed = await record(D("f"));
    const puts: Array<{ kind: string; digest: string }> = [];

    await storeAttestation(store, {
      digest: signed.digest,
      kind: "reused-proof-merge",
      repositoryId: "1315419165",
      baseRef: "refs/heads/main",
      transitionSequence: 9,
      attemptId: "att-1",
      bytes: signed.bytes,
      jws: signed.jws,
      mirror: async (input) => void puts.push({ kind: input.kind, digest: input.digest }),
      organizationId: "org_1",
    });

    expect(puts).toEqual([{ kind: "transition-record", digest: signed.digest }]);
  });

  /** A bucket that is down must never cost the record itself. */
  it("keeps the record when the mirror fails", async () => {
    const store = db();
    const signed = await record(D("f"));
    await storeAttestation(store, {
      digest: signed.digest,
      kind: "reused-proof-merge",
      repositoryId: "1315419165",
      baseRef: "refs/heads/main",
      transitionSequence: 9,
      attemptId: "att-1",
      bytes: signed.bytes,
      jws: signed.jws,
      organizationId: "org_1",
      mirror: async () => {
        throw new Error("bucket unavailable");
      },
    });
    expect(await readAttestation(store, signed.digest)).not.toBeNull();
  });
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run apps/control-plane/src/queue/attestation.test.ts`
Expected: FAIL, `puts` is empty

- [ ] **Step 3: Extend `storeAttestation`**

In `apps/control-plane/src/queue/attestation.ts`, widen the row type and add the mirror:

```ts
export async function storeAttestation(
  db: D1Like,
  row: {
    readonly digest: string;
    readonly kind: string;
    readonly repositoryId: string;
    readonly baseRef: string;
    readonly transitionSequence: number | null;
    readonly attemptId: string;
    readonly bytes: Uint8Array;
    readonly jws: string;
    /** Tenant scope for the durable copy. */
    readonly organizationId?: string;
    /**
     * Where the second copy goes.
     *
     * D1 is the only home a record has, and the queue document that references
     * it is compacted. A signed record is meant to outlive the queue that made
     * it, so it is written to content-addressed storage as well. Failing to
     * mirror never costs the record: the row is already written by then.
     */
    readonly mirror?: (input: {
      organizationId: string;
      repositoryId: string;
      kind: "merge-intent" | "transition-record";
      digest: string;
      bytes: Uint8Array;
    }) => Promise<void>;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO queue_attestations
         (digest, kind, github_repository_id, base_ref, transition_sequence, attempt_id, bytes, jws)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(digest) DO NOTHING`,
    )
    .bind(
      row.digest,
      row.kind,
      row.repositoryId,
      row.baseRef,
      row.transitionSequence,
      row.attemptId,
      new TextDecoder().decode(row.bytes),
      row.jws,
    )
    .run();

  if (row.mirror === undefined || row.organizationId === undefined) return;
  try {
    await row.mirror({
      organizationId: row.organizationId,
      repositoryId: row.repositoryId,
      kind: row.kind === "merge-intent" ? "merge-intent" : "transition-record",
      digest: row.digest,
      bytes: row.bytes,
    });
  } catch {
    /* the record is stored; the durable copy is retried by the backfill */
  }
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `pnpm vitest run apps/control-plane/src/queue/attestation.test.ts`
Expected: PASS

- [ ] **Step 5: Pass the bucket at both call sites**

In `apps/control-plane/src/queue/routes.ts`, both `storeAttestation` calls gain:

```ts
          organizationId: reuse.organizationId,
          mirror: (input) =>
            storeEvidence(c.env, {
              organizationId: input.organizationId,
              repositoryId: input.repositoryId,
              kind: input.kind,
              digest: input.digest as `sha256:${string}`,
              bytes: input.bytes,
            }).then(() => undefined),
```

`reuseEvidenceFor` does not currently return `organizationId`. Add it: `readActivePolicy` already returns it, so thread it through `ReuseEvidence` the same way `policyDigest` is.

- [ ] **Step 6: Check types and the suite**

Run: `pnpm typecheck && pnpm vitest run && pnpm lint`
Expected: all clean

- [ ] **Step 7: Commit**

```bash
git add apps/control-plane/src/queue/attestation.ts apps/control-plane/src/queue/attestation.test.ts apps/control-plane/src/queue/routes.ts
git commit -m "feat(queue): mirror every signed record into content-addressed storage"
```

---

### Task 4.2: Backfill the records already in D1

**Files:**
- Create: `apps/control-plane/src/queue/attestation-backfill.ts`
- Test: `apps/control-plane/src/queue/attestation-backfill.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/control-plane/src/queue/attestation-backfill.test.ts
import { afterEach, describe, expect, it } from "vitest";
import { testD1 } from "../../test/d1.js";
import { backfillAttestations } from "./attestation-backfill.js";
import type { D1Like } from "./projection.js";

/**
 * Every record signed before the mirror existed lives only in D1. This copies
 * them out, and it has to be safe to run repeatedly because that is how it will
 * be run: from the daily cron, until it reports nothing left to do.
 */
const open: Array<{ close(): void }> = [];
let raw: import("better-sqlite3").Database;

function db(): D1Like {
  const t = testD1();
  open.push(t);
  raw = t.raw;
  return t.db as unknown as D1Like;
}

afterEach(() => {
  while (open.length > 0) open.pop()!.close();
});

function stored(digest: string, kind: string) {
  raw
    .prepare(
      `INSERT INTO queue_attestations (digest, kind, github_repository_id, base_ref, transition_sequence, attempt_id, bytes, jws)
       VALUES (?, ?, '1315419165', 'refs/heads/main', 1, 'att-1', '{"a":1}', 'jws')`,
    )
    .run(digest, kind);
}

describe("backfilling the durable copy", () => {
  it("copies out every record it has not seen", async () => {
    const store = db();
    stored(`sha256:${"a".repeat(64)}`, "reused-proof-merge");
    stored(`sha256:${"b".repeat(64)}`, "merge-intent");

    const copied: string[] = [];
    const result = await backfillAttestations(store, {
      organizationIdFor: async () => "org_1",
      has: async () => false,
      put: async (input) => void copied.push(input.digest),
    });

    expect(result.copied).toBe(2);
    expect(copied).toHaveLength(2);
  });

  it("skips what the bucket already holds", async () => {
    const store = db();
    stored(`sha256:${"a".repeat(64)}`, "reused-proof-merge");
    const result = await backfillAttestations(store, {
      organizationIdFor: async () => "org_1",
      has: async () => true,
      put: async () => {
        throw new Error("should not have written");
      },
    });
    expect(result.copied).toBe(0);
    expect(result.alreadyThere).toBe(1);
  });

  it("says nothing is left when everything is copied", async () => {
    const result = await backfillAttestations(db(), {
      organizationIdFor: async () => "org_1",
      has: async () => true,
      put: async () => {},
    });
    expect(result).toMatchObject({ copied: 0, alreadyThere: 0 });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run apps/control-plane/src/queue/attestation-backfill.test.ts`
Expected: FAIL, module not found

- [ ] **Step 3: Write the implementation**

```ts
// apps/control-plane/src/queue/attestation-backfill.ts
import type { D1Like } from "./projection.js";

/**
 * Copy signed records out of D1 into content-addressed storage.
 *
 * Every record written before the mirror existed lives in exactly one place, and
 * the queue document that references it is compacted. Safe to run repeatedly:
 * it asks what the bucket already holds and writes only the difference, so it is
 * run from the daily cron until it reports nothing left.
 */
export interface BackfillPorts {
  organizationIdFor(repositoryId: string): Promise<string | null>;
  has(input: { organizationId: string; repositoryId: string; kind: string; digest: string }): Promise<boolean>;
  put(input: {
    organizationId: string;
    repositoryId: string;
    kind: "merge-intent" | "transition-record";
    digest: string;
    bytes: Uint8Array;
  }): Promise<void>;
}

export async function backfillAttestations(
  db: D1Like,
  ports: BackfillPorts,
  limit = 200,
): Promise<{ copied: number; alreadyThere: number; skipped: number }> {
  const rows = await db
    .prepare(
      `SELECT digest, kind, github_repository_id AS repositoryId, bytes
         FROM queue_attestations
        ORDER BY created_at
        LIMIT ?`,
    )
    .bind(limit)
    .all<{ digest: string; kind: string; repositoryId: string; bytes: string }>();

  const encoder = new TextEncoder();
  let copied = 0;
  let alreadyThere = 0;
  let skipped = 0;

  for (const row of rows.results) {
    const organizationId = await ports.organizationIdFor(row.repositoryId);
    if (organizationId === null) {
      // No tenant to scope the object under. Recording it anywhere else would
      // put one customer's evidence outside their own prefix.
      skipped += 1;
      continue;
    }
    const kind = row.kind === "merge-intent" ? "merge-intent" : "transition-record";
    if (await ports.has({ organizationId, repositoryId: row.repositoryId, kind, digest: row.digest })) {
      alreadyThere += 1;
      continue;
    }
    await ports.put({
      organizationId,
      repositoryId: row.repositoryId,
      kind,
      digest: row.digest,
      bytes: encoder.encode(row.bytes),
    });
    copied += 1;
  }

  return { copied, alreadyThere, skipped };
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `pnpm vitest run apps/control-plane/src/queue/attestation-backfill.test.ts`
Expected: PASS, 3 tests

- [ ] **Step 5: Call it from the daily cron**

In the daily branch of `scheduled()` in `apps/control-plane/src/index.ts`, after the per-organization loop:

```ts
    // Copy anything the mirror missed. Idempotent, bounded, and it reports zero
    // once the backlog is gone.
    await backfillAttestations(env.DB as unknown as D1Like, {
      organizationIdFor: async (repositoryId) => {
        const row = await env.DB.prepare(
          "SELECT organization_id AS id FROM projects WHERE github_repository_id = ?",
        )
          .bind(repositoryId)
          .first<{ id: string }>();
        return row?.id ?? null;
      },
      has: async (input) =>
        env.EVIDENCE === undefined
          ? true
          : hasEvidence(env.EVIDENCE as unknown as R2Like, {
              organizationId: input.organizationId,
              repositoryId: input.repositoryId,
              kind: input.kind as never,
              digest: input.digest as `sha256:${string}`,
            }),
      put: async (input) => {
        if (env.EVIDENCE === undefined) return;
        await putEvidence(env.EVIDENCE as unknown as R2Like, {
          organizationId: input.organizationId,
          repositoryId: input.repositoryId,
          kind: input.kind,
          digest: input.digest as `sha256:${string}`,
          bytes: input.bytes,
        });
      },
    });
```

Add `EVIDENCE?: R2Bucket` to the `Env` interface in `apps/control-plane/src/env.ts`; it is bound in `wrangler.jsonc` but missing from the type.

- [ ] **Step 6: Check and commit**

```bash
pnpm typecheck && pnpm vitest run && pnpm lint
git add -A
git commit -m "feat(queue): backfill signed records into durable storage"
```

---

## Phase 5: Assignment and integration receipt

This is the largest phase and the only one that unlocks a product tier. `verified-merge` binds an assignment and an integration receipt, and nothing issues either, which is why `fresh` and `audited` are currently refused.

**Open decision before starting:** who runs the integration suites for `fresh`. The plan below assumes the existing CLI agent does it on the developer's machine, because `buildAssignment` and the `IntegrationReceipt` schema already describe that shape. If the answer is a hosted runner instead, tasks 5.2 and 5.3 change substantially and this phase should be re-planned first.

### Task 5.1: Give the assignment builder what it needs

`buildAssignment` in `apps/control-plane/src/queue/evidence.ts` wants the policy document, its version, and the Dagger module and engine digests. `readActivePolicy` returns none of them.

**Files:**
- Modify: `apps/control-plane/src/active-policy.ts`
- Test: `apps/control-plane/src/active-policy.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `apps/control-plane/src/active-policy.test.ts`:

```ts
  /**
   * An assignment digests the policy document rather than trusting a digest
   * passed alongside it, so the reader needs the document itself.
   */
  it("returns the document and version an assignment has to bind", async () => {
    const store = db();
    project("fast", bundle({ securityProfile: "remote", version: 4 }));

    const policy = await readActivePolicy(store, REPO);
    expect(policy?.version).toBe(4);
    expect(policy?.document).toMatchObject({ securityProfile: "remote" });
  });

  it("reports the dagger digests when the pipeline names them", async () => {
    const store = db();
    project(
      "fast",
      bundle({
        pipeline: {
          digest: `sha256:${"c".repeat(64)}`,
          runner: "dagger",
          requiredSuites: ["test"],
          moduleDigest: `sha256:${"d".repeat(64)}`,
          engineDigest: `sha256:${"e".repeat(64)}`,
        },
      }),
    );

    const policy = await readActivePolicy(store, REPO);
    expect(policy?.daggerModuleDigest).toBe(`sha256:${"d".repeat(64)}`);
    expect(policy?.daggerEngineDigest).toBe(`sha256:${"e".repeat(64)}`);
  });

  /** A command pipeline has no Dagger digests, and inventing them is the bug
   *  this whole line of work removed. */
  it("reports no dagger digests for a command pipeline", async () => {
    const store = db();
    project("fast", bundle());
    const policy = await readActivePolicy(store, REPO);
    expect(policy?.daggerModuleDigest).toBeNull();
  });
```

Update the `bundle` helper in that file to accept a `version` field and default it to 4.

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run apps/control-plane/src/active-policy.test.ts`
Expected: FAIL, `policy?.version` is undefined

- [ ] **Step 3: Extend the reader**

In `apps/control-plane/src/active-policy.ts`, widen `ActivePolicy` and the return:

```ts
export interface ActivePolicy {
  readonly policyDigest: string;
  readonly pipelineDigest: string | null;
  readonly requiredSuites: readonly string[];
  readonly securityProfile: string;
  readonly organizationId: string;
  readonly verifier: { workflowRef: string; workflowSha: string | null } | null;
  /** The document itself. An assignment digests it rather than trusting a value. */
  readonly document: unknown;
  readonly version: number;
  /** Null for a command pipeline, which has no Dagger anything. */
  readonly daggerModuleDigest: string | null;
  readonly daggerEngineDigest: string | null;
}
```

and in the returned object:

```ts
    document: bundle,
    version: typeof bundle.version === "number" ? bundle.version : 0,
    daggerModuleDigest: typeof bundle.pipeline?.moduleDigest === "string" ? bundle.pipeline.moduleDigest : null,
    daggerEngineDigest: typeof bundle.pipeline?.engineDigest === "string" ? bundle.pipeline.engineDigest : null,
```

widening the parsed `bundle` type to include `version?: unknown` and the two pipeline fields.

- [ ] **Step 4: Run it and watch it pass**

Run: `pnpm vitest run apps/control-plane/src/active-policy.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/control-plane/src/active-policy.ts apps/control-plane/src/active-policy.test.ts
git commit -m "feat(policy): expose the document and dagger digests an assignment binds"
```

---

### Task 5.2: Issue and sign an assignment when a turn is claimed

**Files:**
- Create: `apps/control-plane/src/queue/assignment.ts`
- Test: `apps/control-plane/src/queue/assignment.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/control-plane/src/queue/assignment.test.ts
import { parseIntegrationAssignment, envelopeDigest } from "@thwip/queue-protocol";
import type { GitSubject, Sha256 } from "@thwip/queue-protocol";
import { describe, expect, it } from "vitest";
import { signIntegrationAssignment } from "./assignment.js";

/**
 * The queue telling a runner to run something.
 *
 * This is what `fresh` and `audited` mean and what nothing produced, which is
 * why a verified merge was unreachable and why both profiles are refused today.
 * The policy document is digested here rather than passed as a value, so an
 * assignment cannot bind a policy nobody resolved.
 */
const D = (c: string) => `sha256:${c.repeat(64)}` as Sha256;
const BASE = "1".repeat(40);
const HEAD = "2".repeat(40);

const git: GitSubject = {
  objectFormat: "sha1",
  repositoryId: "1315419165",
  baseRef: "refs/heads/main",
  baseSha: BASE,
  headRepositoryId: "1315419165",
  headSha: HEAD,
  candidateSha: "3".repeat(40),
  candidateTreeOid: "4".repeat(40),
  candidateParentOids: [BASE, HEAD],
};

const signer = { async sign(bytes: Uint8Array) { return `jws.${await envelopeDigest(bytes)}`; } };

const input = {
  assignmentId: "asg-1",
  attemptId: "att-1",
  ownerId: "1626036 03",
  git,
  queue: {
    queueEpoch: 1,
    turnSequence: 4,
    entryId: "entry-1",
    pullRequestNumber: 82,
    sponsorPrincipalId: "prn_1",
    queueDecisionDigest: D("a"),
  },
  policy: {
    version: 4,
    securityProfile: "fresh" as const,
    daggerModuleDigest: D("b"),
    daggerEngineDigest: D("c"),
    requiredSuites: ["lint", "test"],
    document: { schemaVersion: "1", securityProfile: "fresh" },
  },
  workReceiptDigest: D("d"),
  previousTransitionDigest: D("e"),
  issuedAt: "2026-07-31T12:00:00Z",
  executionSeconds: 1800,
  nonce: "nonce-1",
  execution: { mode: "run", profile: "fresh", runnerPrincipalId: "prn_1", deviceKeyId: "dev-1" } as const,
  verifier: {
    workflowRef: "recallnet/thwip/.github/workflows/thwip-queue-verify.yml@refs/heads/main",
    workflowSha: "3d1c4ea5a1d723fed245221d44d769829d7c365f",
    reusableWorkflowRef: "recallnet/thwip/.github/workflows/thwip-queue-verify.yml@refs/heads/main",
    reusableWorkflowSha: "3d1c4ea5a1d723fed245221d44d769829d7c365f",
    verifierDigest: D("f"),
  },
  signer,
};

describe("the assignment the queue signs", () => {
  it("parses as an assignment, so what is signed is what a runner will accept", async () => {
    const signed = await signIntegrationAssignment(input);
    if ("error" in signed) throw new Error(signed.error);
    const parsed = parseIntegrationAssignment(JSON.parse(new TextDecoder().decode(signed.bytes)));
    expect(parsed).toMatchObject({ ok: true });
  });

  it("binds the policy by digesting the document, not by taking a digest", async () => {
    const signed = await signIntegrationAssignment(input);
    if ("error" in signed) throw new Error(signed.error);
    const doc = JSON.parse(new TextDecoder().decode(signed.bytes)) as { policy: { digest: string } };
    const { recordDigest } = await import("@thwip/queue-protocol");
    expect(doc.policy.digest).toBe(await recordDigest(input.policy.document));
  });

  it("expires, so a runner cannot present it forever", async () => {
    const signed = await signIntegrationAssignment(input);
    if ("error" in signed) throw new Error(signed.error);
    const doc = JSON.parse(new TextDecoder().decode(signed.bytes)) as { timing: { expiresAt: string } };
    expect(Date.parse(doc.timing.expiresAt)).toBe(Date.parse(input.issuedAt) + 1800 * 1000);
  });

  it("refuses to sign an assignment the parser rejects", async () => {
    const broken = { ...input, git: { ...git, headSha: "not-an-oid" } };
    expect(await signIntegrationAssignment(broken)).toMatchObject({ error: expect.any(String) });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run apps/control-plane/src/queue/assignment.test.ts`
Expected: FAIL, module not found

- [ ] **Step 3: Write the implementation**

```ts
// apps/control-plane/src/queue/assignment.ts
import type { GitSubject, IntegrationAssignmentV1, Sha256 } from "@thwip/queue-protocol";
import { buildAssignment, signAssignment, type SignedRecord, type Signer } from "./evidence.js";

/**
 * The queue telling a runner to run something, signed.
 *
 * This is the piece `fresh` and `audited` are defined around and the piece that
 * did not exist, which is why a verified merge was unreachable and why both
 * profiles are refused. Everything a runner needs to reproduce the queue's
 * expectations is bound here, and the policy is bound by digesting the document
 * rather than by trusting a digest handed alongside it.
 */
export async function signIntegrationAssignment(input: {
  readonly assignmentId: string;
  readonly attemptId: string;
  readonly ownerId: string;
  readonly git: GitSubject;
  readonly queue: {
    readonly queueEpoch: number;
    readonly turnSequence: number;
    readonly entryId: string;
    readonly pullRequestNumber: number;
    readonly sponsorPrincipalId: string;
    readonly queueDecisionDigest: Sha256;
  };
  readonly policy: {
    readonly version: number;
    readonly securityProfile: "fast" | "fresh" | "audited" | "remote";
    readonly daggerModuleDigest: Sha256;
    readonly daggerEngineDigest: Sha256;
    readonly requiredSuites: readonly string[];
    readonly document: unknown;
  };
  readonly workReceiptDigest: Sha256;
  readonly previousTransitionDigest: Sha256 | null;
  readonly issuedAt: string;
  readonly executionSeconds: number;
  readonly nonce: string;
  /** For fresh and audited this is the local run; see the note below on modes. */
  readonly execution: IntegrationAssignmentV1["execution"];
  readonly verifier: IntegrationAssignmentV1["verifier"];
  readonly signer: Signer;
}): Promise<SignedRecord<IntegrationAssignmentV1> | { error: string }> {
  const doc = await buildAssignment({
    assignmentId: input.assignmentId,
    attemptId: input.attemptId,
    ownerId: input.ownerId,
    git: input.git,
    queue: input.queue,
    policy: input.policy,
    execution: input.execution,
    evidence: {
      workReceiptDigest: input.workReceiptDigest,
      previousTransitionDigest: input.previousTransitionDigest,
    },
    verifier: input.verifier,
    issuedAt: input.issuedAt,
    executionSeconds: input.executionSeconds,
    nonce: input.nonce,
  });
  return signAssignment(doc, input.signer);
}
```

**The two shapes this needs, and one gap you will hit.**

`AssignmentExecution` for a local run is:

```ts
{ mode: "run", profile: "fresh" | "audited", runnerPrincipalId: string, deviceKeyId: string }
```

so the caller supplies the principal whose device claimed the offer and that device's key id. Both are already known at claim time from `OfferClaimed`.

`verifier` is required and has five fields:

```ts
{ workflowRef: string; workflowSha: string; reusableWorkflowRef: string; reusableWorkflowSha: string; verifierDigest: Sha256 }
```

The pinned verifier stored in `queue_projects.verifier_json` carries only `workflowRef` and a nullable `workflowSha`. The remaining three have no source today. Resolve this before writing the code, and resolve it by deciding rather than by filling the fields in:

- If `fresh` genuinely has no GitHub verifier, the schema is wrong and `verifier` should become optional for a local-run assignment. Change the schema, with a test that a local-run assignment parses without one.
- If `fresh` keeps a verifier for the audited second execution, extend the pinned verifier record to carry all five fields and refuse to issue an assignment until a repository has them.

Do not synthesise `reusableWorkflowRef` or `verifierDigest` from what is at hand. An assignment that names a verifier nobody pinned is the same class of untruth as the padded chain link.

- [ ] **Step 4: Run it and watch it pass**

Run: `pnpm vitest run apps/control-plane/src/queue/assignment.test.ts`
Expected: PASS, 4 tests

- [ ] **Step 5: Commit**

```bash
git add apps/control-plane/src/queue/assignment.ts apps/control-plane/src/queue/assignment.test.ts
git commit -m "feat(queue): sign the assignment a fresh integration runs under"
```

---

### Task 5.3: Accept a signed integration receipt

**Files:**
- Create: `apps/control-plane/src/queue/integration-receipt.ts`
- Test: `apps/control-plane/src/queue/integration-receipt.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/control-plane/src/queue/integration-receipt.test.ts
import { describe, expect, it } from "vitest";
import { acceptIntegrationReceipt } from "./integration-receipt.js";

/**
 * The runner's account of what it ran.
 *
 * A receipt is only worth accepting if it is about the assignment the queue
 * issued and about the tree the queue is going to merge. Anything else is a
 * receipt for different work, and accepting one would certify a candidate on the
 * strength of a run against something else.
 */
const D = (c: string) => `sha256:${c.repeat(64)}`;
const TREE = "4".repeat(40);

const receipt = (over: Record<string, unknown> = {}) => ({
  assignmentDigest: D("a"),
  candidateTreeOid: TREE,
  suites: [{ name: "lint", outcome: "passed", durationMs: 10 }],
  ...over,
});

const assignment = { digest: D("a"), candidateTreeOid: TREE, requiredSuites: ["lint"] };

describe("accepting an integration receipt", () => {
  it("accepts one that matches the assignment and the tree", () => {
    expect(acceptIntegrationReceipt(receipt(), assignment)).toMatchObject({ ok: true });
  });

  it("refuses a receipt for a different assignment", () => {
    const result = acceptIntegrationReceipt(receipt({ assignmentDigest: D("z") }), assignment);
    expect(result).toMatchObject({ ok: false, code: "ASSIGNMENT_MISMATCH" });
  });

  it("refuses a receipt about a different tree", () => {
    const result = acceptIntegrationReceipt(receipt({ candidateTreeOid: "9".repeat(40) }), assignment);
    expect(result).toMatchObject({ ok: false, code: "CANDIDATE_TREE_MISMATCH" });
  });

  it("refuses a receipt missing a required suite", () => {
    const result = acceptIntegrationReceipt(receipt({ suites: [] }), assignment);
    expect(result).toMatchObject({ ok: false, code: "SUITE_MISSING" });
  });

  it("refuses a receipt whose suite failed", () => {
    const result = acceptIntegrationReceipt(
      receipt({ suites: [{ name: "lint", outcome: "failed", durationMs: 10 }] }),
      assignment,
    );
    expect(result).toMatchObject({ ok: false, code: "SUITE_FAILED" });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run apps/control-plane/src/queue/integration-receipt.test.ts`
Expected: FAIL, module not found

- [ ] **Step 3: Write the implementation**

```ts
// apps/control-plane/src/queue/integration-receipt.ts

/**
 * The runner's account of what it ran, checked against what it was asked to run.
 *
 * A receipt is only evidence if it is about this assignment and this tree. One
 * about a different tree is an account of different code, and accepting it would
 * certify a candidate on the strength of a run that never touched it.
 */
export interface ReceiptSuite {
  readonly name: string;
  readonly outcome: string;
  readonly durationMs: number;
}

export interface SubmittedReceipt {
  readonly assignmentDigest: string;
  readonly candidateTreeOid: string;
  readonly suites: readonly ReceiptSuite[];
}

export interface IssuedAssignment {
  readonly digest: string;
  readonly candidateTreeOid: string;
  readonly requiredSuites: readonly string[];
}

export type ReceiptVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: "ASSIGNMENT_MISMATCH" | "CANDIDATE_TREE_MISMATCH" | "SUITE_MISSING" | "SUITE_FAILED";
      readonly detail: string;
    };

export function acceptIntegrationReceipt(
  receipt: SubmittedReceipt,
  assignment: IssuedAssignment,
): ReceiptVerdict {
  if (receipt.assignmentDigest !== assignment.digest) {
    return {
      ok: false,
      code: "ASSIGNMENT_MISMATCH",
      detail: "this receipt is about a different assignment",
    };
  }
  if (receipt.candidateTreeOid !== assignment.candidateTreeOid) {
    return {
      ok: false,
      code: "CANDIDATE_TREE_MISMATCH",
      detail: "this receipt is about a different tree than the one being merged",
    };
  }
  for (const required of assignment.requiredSuites) {
    const ran = receipt.suites.find((s) => s.name === required);
    if (ran === undefined) {
      return { ok: false, code: "SUITE_MISSING", detail: `required suite ${required} did not run` };
    }
    if (ran.outcome !== "passed") {
      return { ok: false, code: "SUITE_FAILED", detail: `required suite ${required} ${ran.outcome}` };
    }
  }
  return { ok: true };
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `pnpm vitest run apps/control-plane/src/queue/integration-receipt.test.ts`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add apps/control-plane/src/queue/integration-receipt.ts apps/control-plane/src/queue/integration-receipt.test.ts
git commit -m "feat(queue): check an integration receipt against the assignment it answers"
```

---

### Task 5.4: Produce a verified-merge record

**Files:**
- Modify: `apps/control-plane/src/queue/attestation.ts`
- Test: `apps/control-plane/src/queue/attestation.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `apps/control-plane/src/queue/attestation.test.ts`:

```ts
/**
 * The strongest record, and the only one that was ever unreachable. It binds an
 * assignment and an integration receipt, which exist now, so the claim it makes
 * is finally one the system can back.
 */
describe("a merge with an assignment and a receipt behind it", () => {
  const full = {
    ...evidence,
    verifierResultDigest: D("9"),
    assignmentDigest: D("8"),
    integrationEvidenceDigest: D("7"),
    actionRunId: "112233",
  };

  it("is recorded as a verified merge", async () => {
    const signed = await signVerifiedRecord({
      attemptId: "att-1",
      git,
      position,
      pullRequestNumber: 82,
      evidence: full,
      mergeIntentDigest: D("f"),
      before: { baseSha: BASE, treeOid: "5".repeat(40) },
      final: { sha: CANDIDATE, treeOid: TREE, parentShas: [BASE, HEAD] },
      observedAt: "2026-07-31T12:01:00Z",
      signer,
    });
    if ("error" in signed) throw new Error(signed.error);
    const parsed = parseTransitionRecord(JSON.parse(new TextDecoder().decode(signed.bytes)));
    if (!parsed.ok || parsed.value.kind !== "verified-merge") throw new Error("wrong kind");
    expect(parsed.value.verifiedMerge.assignmentDigest).toBe(D("8"));
    expect(parsed.value.verifiedMerge.integrationEvidenceDigest).toBe(D("7"));
    expect(parsed.value.verifiedMerge.verifierResultDigest).toBe(D("9"));
  });
});
```

Add `signVerifiedRecord` to the import at the top of the file.

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run apps/control-plane/src/queue/attestation.test.ts`
Expected: FAIL, `signVerifiedRecord is not exported`

- [ ] **Step 3: Write the implementation**

Append to `apps/control-plane/src/queue/attestation.ts`:

```ts
/**
 * The record for a merge with a signed assignment and a signed receipt behind
 * it. The only kind that may claim both, and until the assignment and receipt
 * existed, the only kind nothing could produce.
 */
export async function signVerifiedRecord(input: {
  readonly attemptId: string;
  readonly git: GitSubject;
  readonly position: ChainPosition;
  readonly pullRequestNumber: number;
  readonly evidence: ReuseEvidence & {
    readonly verifierResultDigest: Sha256;
    readonly assignmentDigest: Sha256;
    readonly integrationEvidenceDigest: Sha256;
    readonly actionRunId: string;
  };
  readonly mergeIntentDigest: Sha256;
  readonly before: { readonly baseSha: string | null; readonly treeOid: string | null };
  readonly final: { readonly sha: string; readonly treeOid: string; readonly parentShas: readonly string[] };
  readonly observedAt: string;
  readonly signer: Signer;
}): Promise<SignedRecord<unknown> | { error: string }> {
  const doc = await buildTransitionRecord({
    git: input.git,
    queueEpoch: input.position.queueEpoch,
    transitionSequence: input.position.transitionSequence,
    previousTransitionDigest: input.position.previousTransitionDigest,
    before: input.before,
    final: input.final,
    observedAt: input.observedAt,
    mergeMethod: "merge",
    attemptId: input.attemptId,
    pullRequestNumber: input.pullRequestNumber,
    mergeIntentDigest: input.mergeIntentDigest,
    workReceiptDigest: input.evidence.workReceiptDigest,
    assignmentDigest: input.evidence.assignmentDigest,
    integrationEvidenceDigest: input.evidence.integrationEvidenceDigest,
    verifierResultDigest: input.evidence.verifierResultDigest,
    checkRunId: input.evidence.proofCheckRunId,
    actionRunId: input.evidence.actionRunId,
  });
  return signTransitionRecord(doc, input.signer);
}
```

Add `buildTransitionRecord` to the `./evidence.js` import at the top of the file.

- [ ] **Step 4: Run it and watch it pass**

Run: `pnpm vitest run apps/control-plane/src/queue/attestation.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/control-plane/src/queue/attestation.ts apps/control-plane/src/queue/attestation.test.ts
git commit -m "feat(queue): produce the verified-merge record"
```

---

### Task 5.5: Let fresh and audited be selected again

Only do this once tasks 5.1 through 5.4 are merged and a fresh merge has produced a `verified-merge` record on staging. Re-enabling before that puts back the misrepresentation this removed.

**Files:**
- Modify: `packages/policy/src/index.ts`
- Modify: `packages/policy/src/index.test.ts`
- Modify: `THWIP.md`

- [ ] **Step 1: Flip the test**

In `packages/policy/src/index.test.ts`, change the `profiles the service can actually deliver` block so all four profiles resolve, and delete the two tests asserting a refusal.

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run packages/policy`
Expected: FAIL, the refusal is still in place

- [ ] **Step 3: Remove the refusal**

Delete the `if (y.profile === "fresh" || y.profile === "audited")` block from `validatedThwipYaml` in `packages/policy/src/index.ts`.

- [ ] **Step 4: Run it and watch it pass**

Run: `pnpm vitest run packages/policy && pnpm vitest run`
Expected: PASS

- [ ] **Step 5: Update the documentation**

In `THWIP.md`, replace the "Which profile to choose" section so it describes all four, with `fresh` and `audited` explained as issuing an assignment and requiring an integration receipt signed where the suites ran.

- [ ] **Step 6: Commit**

```bash
git add packages/policy/src THWIP.md
git commit -m "feat(policy): fresh and audited are deliverable again"
```

---

## Verification, end to end

After every phase is merged and deployed:

- [ ] `node packages/cli/dist/main.js verify-chain --repo recallnet/thwip` reports the pre-attestation history, the known gap at links 47 and 48, and no other findings.
- [ ] A new pull request merges and `verify-chain` reports one more verified link with no new findings.
- [ ] `wrangler tail` shows the five minute cron reading queues and dispatching nothing while the lane is idle.
- [ ] Ejecting an entry while another pull request waits results in the waiting one being driven within seconds, with no manual re-run.
- [ ] Every record in `queue_attestations` has a matching object in R2, confirmed by a backfill run reporting `copied: 0`.
- [ ] A repository set to `fresh` merges and produces a `verified-merge` record naming a real assignment and a real integration receipt.
