#!/usr/bin/env node
// Check a published thwip merge chain from outside thwip.
//
// Everything this needs is public: the chain endpoint, the service keys at
// `/.well-known/thwip-keys`, and the branch head from GitHub. No account, no
// token, no thwip install. It runs the same `verifyChain` the control plane
// runs, from `packages/queue-protocol`, so a reader is checking our claim with
// our code rather than a retelling of it.
//
//   node scripts/verify-chain.mjs [owner/repo] [ref]
//
// Signature verification uses Node's WebCrypto rather than a JWS library, so
// this file has no dependencies beyond the workspace package. Build first:
// `pnpm build`.
//
// It exits non-zero when the chain has findings, and it prints what it checked
// rather than only what it failed to complain about. A walk that verified no
// signatures reports zero verified, because an empty findings list on its own
// says nothing about whether anything was read.

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { parseTransitionRecord } from "../packages/queue-protocol/dist/transition-record.js";
import { verifyChain } from "../packages/queue-protocol/dist/verify-chain.js";

const b64url = (s) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

async function getJson(fetchImpl, url, init) {
  const res = await fetchImpl(url, init);
  if (!res.ok) throw new Error(`${url} -> ${res.status} ${res.statusText}`);
  return res.json();
}

const enc = new TextEncoder();

/**
 * Fetch and verify the public chain with the same verifier used by the Worker.
 * `expectedSha` lets a caller supply an independently checked branch head. The
 * deploy workflow does that from its freshly fetched canonical main checkout,
 * so an internal repository does not have to grant Thwip or this script another
 * GitHub credential just to verify the public evidence.
 */
export async function verifyPublishedChain({
  repo = "recallnet/thwip",
  ref = "refs/heads/main",
  api = "https://thwip.ai",
  expectedSha = null,
  githubToken = "",
  fetchImpl = fetch,
}) {
  const gh = {
    accept: "application/vnd.github+json",
    "user-agent": "thwip-verify-chain",
    ...(githubToken.length === 0 ? {} : { authorization: `Bearer ${githubToken}` }),
  };

  // The chain route is keyed by GitHub's numeric repository id rather than the
  // name a human types. A numeric argument avoids a GitHub read, which is useful
  // for an internal repository whose signed chain is deliberately public.
  const numeric = /^[0-9]+$/.test(repo);
  const repositoryId = numeric
    ? repo
    : String((await getJson(fetchImpl, `https://api.github.com/repos/${repo}`, { headers: gh })).id);
  const chain = await getJson(
    fetchImpl,
    `${api.replace(/\/$/, "")}/v1/queue/${repositoryId}/chain?ref=${encodeURIComponent(ref)}`,
  );
  const jwks = await getJson(fetchImpl, `${api.replace(/\/$/, "")}/.well-known/thwip-keys`);
  const keys = new Map();
  for (const jwk of jwks.keys) {
    keys.set(
      jwk.kid,
      await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]),
    );
  }

  const branch = ref.replace(/^refs\/heads\//, "");
  const headSha =
    expectedSha ??
    (numeric
      ? null
      : (await getJson(fetchImpl, `https://api.github.com/repos/${repo}/commits/${branch}`, { headers: gh })).sha);

  async function verifySignature(jws, bytes) {
    const [h, p, s] = String(jws).split(".");
    if (!h || !p || !s) return false;
    const header = JSON.parse(b64url(h).toString("utf8"));
    const key = keys.get(header.kid);
    if (key === undefined || header.alg !== "ES256") return false;
    const valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      b64url(s),
      enc.encode(`${h}.${p}`),
    );
    if (!valid) return false;
    return Buffer.compare(b64url(p), Buffer.from(bytes)) === 0;
  }

  const links = chain.links.map((link) => ({
    digest: link.digest,
    sequence: link.sequence,
    bytes: link.record === undefined || link.record === null ? new Uint8Array() : enc.encode(link.record),
    jws: link.jws ?? link.signature ?? "",
  }));
  const result = await verifyChain(links, {
    verifySignature,
    epochStartsAt: chain.epochStartsAt,
    subject: { repositoryId, baseRef: ref },
    ...(headSha === null ? {} : { head: { baseSha: headSha } }),
  });

  const records = [];
  const kinds = {};
  for (const link of chain.links) {
    if (!link.record) continue;
    let decoded;
    try {
      decoded = JSON.parse(link.record);
    } catch {
      continue;
    }
    const parsed = parseTransitionRecord(decoded);
    if (!parsed.ok) continue;
    records.push({ digest: link.digest, sequence: link.sequence, record: parsed.value });
    kinds[parsed.value.kind] = (kinds[parsed.value.kind] ?? 0) + 1;
  }

  return { repo, ref, repositoryId, epochStartsAt: chain.epochStartsAt, links, headSha, records, kinds, result };
}

export function printChainReport(report) {
  console.log(`${report.repo} ${report.ref}`);
  console.log(
    `links ${report.links.length}, epoch starts at ${report.epochStartsAt}, ` +
      (report.headSha === null
        ? "branch head not read, so nothing is claimed about it"
        : `head ${report.headSha.slice(0, 12)}`),
  );
  console.log(`signatures verified ${report.result.signaturesChecked} of ${report.links.length}`);
  for (const [kind, n] of Object.entries(report.kinds).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${kind}: ${n}`);
  }
  for (const correction of report.result.corrections) {
    console.log(
      `correction at ${correction.sequence}: ${correction.correctsDigest} said ${correction.from}, ` +
        `branch took ${correction.to} (${correction.reason})`,
    );
  }
  for (const finding of report.result.findings) {
    console.log(`finding ${finding.code} at ${finding.sequence}: ${finding.detail}`);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const report = await verifyPublishedChain({
    repo: process.argv[2] ?? "recallnet/thwip",
    ref: process.argv[3] ?? "refs/heads/main",
    api: process.env.THWIP_API ?? "https://thwip.ai",
    githubToken: process.env.GITHUB_TOKEN ?? "",
  });
  printChainReport(report);
  if (report.result.findings.length > 0) {
    console.log(`\n${report.result.findings.length} finding(s). Please open an issue with this output.`);
    process.exit(1);
  }
  console.log("\nno findings");
}
