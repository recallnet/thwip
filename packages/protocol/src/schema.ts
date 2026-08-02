import {
  DSSE_PAYLOAD_TYPE,
  PREDICATE_TYPE,
  STATEMENT_TYPE,
  type DsseEnvelope,
  type InTotoStatementV1,
  type SuiteResult,
  type ThwipCiRunPredicateV1,
} from "./types.js";

type ParseResult<T> = { ok: true; value: T } | { ok: false; detail: string };

const DECIMAL_RE = /^[0-9]+$/;
const OID_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const SHA256_RE = /^sha256:[0-9a-f]{64}$/;
const SUITE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function fail(detail: string): { ok: false; detail: string } {
  return { ok: false, detail };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown, name: string, max = 4096): ParseResult<string> {
  if (typeof v !== "string" || v.length === 0 || v.length > max) return fail(`${name} invalid`);
  return { ok: true, value: v };
}

export function parseEnvelope(v: unknown): ParseResult<DsseEnvelope> {
  if (!isRecord(v)) return fail("envelope not an object");
  if (v["payloadType"] !== DSSE_PAYLOAD_TYPE) return fail("payloadType unsupported");
  const payload = str(v["payload"], "payload", 32768);
  if (!payload.ok) return payload;
  const sigs = v["signatures"];
  if (!Array.isArray(sigs) || sigs.length !== 1) return fail("signatures must contain exactly one entry");
  const s0 = sigs[0];
  if (!isRecord(s0)) return fail("signature not an object");
  const keyid = str(s0["keyid"], "keyid", 256);
  if (!keyid.ok) return keyid;
  const sig = str(s0["sig"], "sig", 8192);
  if (!sig.ok) return sig;
  return {
    ok: true,
    value: {
      payloadType: DSSE_PAYLOAD_TYPE,
      payload: payload.value,
      signatures: [{ keyid: keyid.value, sig: sig.value }],
    },
  };
}

function parseSuite(v: unknown, i: number): ParseResult<SuiteResult> {
  if (!isRecord(v)) return fail(`suite[${i}] not an object`);
  const id = v["id"];
  if (typeof id !== "string" || !SUITE_ID_RE.test(id)) return fail(`suite[${i}].id invalid`);
  const status = v["status"];
  if (status !== "passed" && status !== "failed" && status !== "skipped") return fail(`suite[${i}].status invalid`);
  const durationMs = v["durationMs"];
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0) {
    return fail(`suite[${i}].durationMs invalid`);
  }
  const out: SuiteResult = { id, status, durationMs };
  if (v["reportDigest"] !== undefined) {
    if (typeof v["reportDigest"] !== "string" || !SHA256_RE.test(v["reportDigest"])) {
      return fail(`suite[${i}].reportDigest invalid`);
    }
    out.reportDigest = v["reportDigest"] as `sha256:${string}`;
  }
  return { ok: true, value: out };
}

export function parseStatement(v: unknown): ParseResult<InTotoStatementV1> {
  if (!isRecord(v)) return fail("statement not an object");
  if (v["_type"] !== STATEMENT_TYPE) return fail("statement _type unsupported");
  if (v["predicateType"] !== PREDICATE_TYPE) return fail("predicateType unsupported");

  const subject = v["subject"];
  if (!Array.isArray(subject) || subject.length !== 1) return fail("subject must contain exactly one entry");
  const sub0 = subject[0];
  if (!isRecord(sub0) || sub0["name"] !== "git-tree" || !isRecord(sub0["digest"])) return fail("subject invalid");
  const digest: Partial<Record<"sha1" | "sha256", string>> = {};
  for (const [k, val] of Object.entries(sub0["digest"])) {
    if (k !== "sha1" && k !== "sha256") return fail("subject digest algorithm unsupported");
    if (typeof val !== "string" || !OID_RE.test(val)) return fail("subject digest value invalid");
    digest[k] = val;
  }
  if (digest.sha1 === undefined && digest.sha256 === undefined) return fail("subject digest empty");

  const pred = parsePredicate(v["predicate"]);
  if (!pred.ok) return pred;

  return {
    ok: true,
    value: {
      _type: STATEMENT_TYPE,
      subject: [{ name: "git-tree", digest }],
      predicateType: PREDICATE_TYPE,
      predicate: pred.value,
    },
  };
}

export function parsePredicate(v: unknown): ParseResult<ThwipCiRunPredicateV1> {
  if (!isRecord(v)) return fail("predicate not an object");
  if (v["schemaVersion"] !== "1") return fail("predicate schemaVersion unsupported");

  const repo = v["repository"];
  if (!isRecord(repo) || repo["provider"] !== "github") return fail("repository invalid");
  const ownerId = repo["ownerId"];
  const repositoryId = repo["repositoryId"];
  if (typeof ownerId !== "string" || !DECIMAL_RE.test(ownerId)) return fail("repository.ownerId invalid");
  if (typeof repositoryId !== "string" || !DECIMAL_RE.test(repositoryId)) return fail("repository.repositoryId invalid");

  const git = v["git"];
  if (!isRecord(git)) return fail("git invalid");
  const objectFormat = git["objectFormat"];
  if (objectFormat !== "sha1" && objectFormat !== "sha256") return fail("git.objectFormat invalid");
  const treeOid = git["treeOid"];
  if (typeof treeOid !== "string" || !OID_RE.test(treeOid)) return fail("git.treeOid invalid");
  const parentOids = git["parentOids"];
  if (!Array.isArray(parentOids) || parentOids.length > 16) return fail("git.parentOids invalid");
  for (const p of parentOids) if (typeof p !== "string" || !OID_RE.test(p)) return fail("git.parentOids entry invalid");
  const baseRef = str(git["baseRef"], "git.baseRef", 512);
  if (!baseRef.ok) return baseRef;
  const baseSha = git["baseSha"];
  if (typeof baseSha !== "string" || !OID_RE.test(baseSha)) return fail("git.baseSha invalid");
  // A proof covers the head tree. A proof claiming to cover anything else is
  // a proof this schema has no rules for, so it is not a proof.
  const evaluationMode = git["evaluationMode"];
  if (evaluationMode !== "head-tree") return fail("git.evaluationMode invalid");

  const policy = v["policy"];
  if (!isRecord(policy)) return fail("policy invalid");
  const policyDigest = policy["digest"];
  if (typeof policyDigest !== "string" || !SHA256_RE.test(policyDigest)) return fail("policy.digest invalid");
  const policyVersion = policy["version"];
  if (typeof policyVersion !== "number" || !Number.isInteger(policyVersion) || policyVersion < 1) {
    return fail("policy.version invalid");
  }

  const pipeline = v["pipeline"];
  if (!isRecord(pipeline)) return fail("pipeline invalid");
  const pipelineDigest = pipeline["digest"];
  if (typeof pipelineDigest !== "string" || !SHA256_RE.test(pipelineDigest)) return fail("pipeline.digest invalid");
  const runner = pipeline["runner"];
  if (runner !== "dagger" && runner !== "command") return fail("pipeline.runner invalid");

  const run = v["run"];
  if (!isRecord(run)) return fail("run invalid");
  const startedAt = str(run["startedAt"], "run.startedAt", 64);
  if (!startedAt.ok) return startedAt;
  const finishedAt = str(run["finishedAt"], "run.finishedAt", 64);
  if (!finishedAt.ok) return finishedAt;
  let lease: string | undefined;
  if (run["lease"] !== undefined) {
    const l = str(run["lease"], "run.lease", 8192);
    if (!l.ok) return l;
    lease = l.value;
  }
  const networkMode = run["networkMode"];
  if (networkMode !== "disabled" && networkMode !== "restricted" && networkMode !== "unrestricted") {
    return fail("run.networkMode invalid");
  }
  const cacheMode = run["cacheMode"];
  if (cacheMode !== "disabled" && cacheMode !== "read-only" && cacheMode !== "read-write") {
    return fail("run.cacheMode invalid");
  }
  const suitesRaw = run["suites"];
  if (!Array.isArray(suitesRaw) || suitesRaw.length === 0 || suitesRaw.length > 64) return fail("run.suites invalid");
  const suites: SuiteResult[] = [];
  for (let i = 0; i < suitesRaw.length; i++) {
    const s = parseSuite(suitesRaw[i], i);
    if (!s.ok) return s;
    suites.push(s.value);
  }

  const signer = v["signer"];
  if (!isRecord(signer)) return fail("signer invalid");
  const keyId = str(signer["keyId"], "signer.keyId", 256);
  if (!keyId.ok) return keyId;
  const githubUserId = signer["githubUserId"];
  if (typeof githubUserId !== "string" || !DECIMAL_RE.test(githubUserId)) return fail("signer.githubUserId invalid");

  const predicate: ThwipCiRunPredicateV1 = {
    schemaVersion: "1",
    repository: { provider: "github", ownerId, repositoryId },
    git: {
      objectFormat,
      treeOid,
      parentOids: parentOids as string[],
      baseRef: baseRef.value,
      baseSha,
      evaluationMode,
    },
    policy: { digest: policyDigest as ThwipCiRunPredicateV1["policy"]["digest"], version: policyVersion },
    pipeline: { digest: pipelineDigest as ThwipCiRunPredicateV1["pipeline"]["digest"], runner },
    run: {
      startedAt: startedAt.value,
      finishedAt: finishedAt.value,
      ...(lease !== undefined ? { lease } : {}),
      networkMode,
      cacheMode,
      suites,
    },
    signer: { keyId: keyId.value, githubUserId },
  };
  return { ok: true, value: predicate };
}
