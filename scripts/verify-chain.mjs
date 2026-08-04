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

import { verifyChain } from "../packages/queue-protocol/dist/verify-chain.js";

const repo = process.argv[2] ?? "recallnet/thwip";
const ref = process.argv[3] ?? "refs/heads/main";
const api = process.env.THWIP_API ?? "https://thwip.recall.net";

const b64url = (s) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

async function getJson(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${url} -> ${res.status} ${res.statusText}`);
  return res.json();
}

const gh = { accept: "application/vnd.github+json", "user-agent": "thwip-verify-chain" };

// The chain route is keyed by GitHub's numeric repository id rather than the
// name a human types. Resolve it against GitHub so that nothing in this script
// depends on a thwip endpoint that needs an account. A numeric first argument
// is taken as the id directly, which is what a reader needs when the repository
// itself is not readable by them.
const numeric = /^[0-9]+$/.test(repo);
const repositoryId = numeric ? repo : (await getJson(`https://api.github.com/repos/${repo}`, { headers: gh })).id;

const chain = await getJson(`${api}/v1/queue/${repositoryId}/chain?ref=${encodeURIComponent(ref)}`);

const jwks = await getJson(`${api}/.well-known/thwip-keys`);
const keys = new Map();
for (const jwk of jwks.keys) {
  keys.set(
    jwk.kid,
    await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]),
  );
}

// Where the branch actually stands, from GitHub rather than from thwip. A
// service asked to report both its chain and the head it is behind would
// report a head that matches.
// A chain that simply stops is internally perfect, so the branch's real head is
// the only fact that catches merges nobody recorded. Without it the walk stays
// silent about the head rather than guessing, and the report says so.
const branch = ref.replace(/^refs\/heads\//, "");
const head = numeric
  ? null
  : await getJson(`https://api.github.com/repos/${repo}/commits/${branch}`, { headers: gh });

const enc = new TextEncoder();

async function verifySignature(jws, bytes) {
  const [h, p, s] = String(jws).split(".");
  if (!h || !p || !s) return false;
  const header = JSON.parse(b64url(h).toString("utf8"));
  const key = keys.get(header.kid);
  if (key === undefined || header.alg !== "ES256") return false;
  const ok = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    b64url(s),
    enc.encode(`${h}.${p}`),
  );
  if (!ok) return false;
  // The signature being valid says only that these payload bytes were signed.
  // It does not say they are the record bytes the chain served, so compare them.
  return Buffer.compare(b64url(p), Buffer.from(bytes)) === 0;
}

const links = chain.links.map((l) => ({
  digest: l.digest,
  sequence: l.sequence,
  bytes: l.record === undefined || l.record === null ? new Uint8Array() : enc.encode(l.record),
  jws: l.jws ?? l.signature ?? "",
}));

const result = await verifyChain(links, {
  verifySignature,
  epochStartsAt: chain.epochStartsAt,
  subject: { repositoryId: String(repositoryId), baseRef: ref },
  ...(head === null ? {} : { head: { baseSha: head.sha } }),
});

const kinds = {};
for (const l of chain.links) {
  if (!l.record) continue;
  const kind = JSON.parse(l.record).kind;
  kinds[kind] = (kinds[kind] ?? 0) + 1;
}

console.log(`${repo} ${ref}`);
console.log(
  `links ${links.length}, epoch starts at ${chain.epochStartsAt}, ` +
    (head === null ? "branch head not read, so nothing is claimed about it" : `head ${head.sha.slice(0, 12)}`),
);
console.log(`signatures verified ${result.signaturesChecked} of ${links.length}`);
for (const [kind, n] of Object.entries(kinds).sort((a, b) => b[1] - a[1])) console.log(`  ${kind}: ${n}`);
for (const c of result.corrections) {
  console.log(`correction at ${c.sequence}: ${c.correctsDigest} said ${c.from}, branch took ${c.to} (${c.reason})`);
}
for (const f of result.findings) console.log(`finding ${f.code} at ${f.sequence}: ${f.detail}`);

if (result.findings.length > 0) {
  console.log(`\n${result.findings.length} finding(s). Please open an issue with this output.`);
  process.exit(1);
}
console.log("\nno findings");
