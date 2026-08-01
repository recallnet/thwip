import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DSSE_PAYLOAD_TYPE,
  PREDICATE_TYPE,
  STATEMENT_TYPE,
  b64stdEncode,
  dssePae,
  encodeCarrier,
  utf8Encode,
  type DsseEnvelope,
  type InTotoStatementV1,
  type VerificationBundleV1,
} from "@thwip/protocol";
import { verifyProof, type GithubFacts } from "./index.js";
import { verifySshSignature } from "./ssh-signature.js";

const execFileP = promisify(execFile);
const NAMESPACE = "thwip-ci-dsse-v1";
const message = new TextEncoder().encode("the exact bytes a proof is signed over");

const TREE = "a".repeat(40);
const PARENT = "b".repeat(40);
const BASE = "c".repeat(40);
const POLICY_DIGEST = `sha256:${"1".repeat(64)}` as const;
const PIPELINE_DIGEST = `sha256:${"2".repeat(64)}` as const;
const NOW = "2026-07-28T12:00:00Z";

function makeStatement(): InTotoStatementV1 {
  return {
    _type: STATEMENT_TYPE,
    subject: [{ name: "git-tree", digest: { sha1: TREE } }],
    predicateType: PREDICATE_TYPE,
    predicate: {
      schemaVersion: "1",
      repository: { provider: "github", ownerId: "162603603", repositoryId: "1315419165" },
      git: {
        objectFormat: "sha1",
        treeOid: TREE,
        parentOids: [PARENT],
        baseRef: "refs/heads/main",
        baseSha: BASE,
        evaluationMode: "head-tree",
      },
      policy: { digest: POLICY_DIGEST, version: 1 },
      pipeline: { digest: PIPELINE_DIGEST, runner: "command" },
      run: {
        startedAt: "2026-07-28T11:50:00Z",
        finishedAt: "2026-07-28T11:59:00Z",
        networkMode: "unrestricted",
        cacheMode: "read-write",
        suites: [{ id: "test", status: "passed", durationMs: 300 }],
      },
      signer: { keyId: "key_test1", githubUserId: "264261678" },
    },
  };
}

function makeFacts(): GithubFacts {
  return {
    ownerId: "162603603",
    repositoryId: "1315419165",
    headSha: "d".repeat(40),
    treeOid: TREE,
    parentOids: [PARENT],
    baseRef: "refs/heads/main",
    baseSha: BASE,
    objectFormat: "sha1",
  };
}

function makeBundle(publicKey: string): VerificationBundleV1 {
  return {
    schemaVersion: "1",
    projectId: "prj_thwip",
    repositoryId: "1315419165",
    ownerId: "162603603",
    activePolicyDigest: POLICY_DIGEST,
    gracePolicyDigests: [],
    policy: {
      schemaVersion: "1",
      projectId: "prj_thwip",
      repositoryId: "1315419165",
      ownerId: "162603603",
      version: 1,
      securityProfile: "fast",
      minimumPermission: "write",
      allowAuthorAsSigner: true,
      allowedKeyAlgorithms: ["ssh-ed25519"],
      lease: { required: false, maxAgeSeconds: 1800 },
      pipeline: { digest: PIPELINE_DIGEST, runner: "command", requiredSuites: ["test"] },
      proofMaxAgeSeconds: 86400,
    },
    keys: [{ keyId: "key_test1", githubUserId: "264261678", algorithm: "ssh-ed25519", publicKey, revokedAt: null }],
    grants: [{ githubUserId: "264261678", permission: "admin", active: true }],
    leaseIssuerJwks: [],
    issuedAt: NOW,
    expiresAt: "2026-07-28T12:05:00Z",
  };
}

/**
 * The signature check decides whether a proof is a proof. It is WebCrypto
 * arithmetic over bytes, with nothing environmental in it, so the verifier owns
 * it rather than asking a caller to hand one in.
 */
async function keyPair(dir: string, name: string) {
  const path = join(dir, name);
  await execFileP("ssh-keygen", ["-t", "ed25519", "-N", "", "-C", name, "-f", path]);
  return { path, publicKey: (await readFile(`${path}.pub`, "utf8")).trim() };
}

let signCount = 0;

async function sign(privateKeyPath: string, bytes: Uint8Array, namespace = NAMESPACE): Promise<string> {
  const file = `${privateKeyPath}.message.${signCount++}`;
  await writeFile(file, bytes);
  await execFileP("ssh-keygen", ["-Y", "sign", "-f", privateKeyPath, "-n", namespace, file]);
  const armored = await readFile(`${file}.sig`, "utf8");
  return armored
    .replace("-----BEGIN SSH SIGNATURE-----", "")
    .replace("-----END SSH SIGNATURE-----", "")
    .replace(/\s+/g, "");
}

describe("checking an SSHSIG signature", () => {
  let dir: string;
  let mine: Awaited<ReturnType<typeof keyPair>>;
  let theirs: Awaited<ReturnType<typeof keyPair>>;
  let signatureBase64: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "thwip-verifier-sshsig-"));
    mine = await keyPair(dir, "mine");
    theirs = await keyPair(dir, "theirs");
    signatureBase64 = await sign(mine.path, message);
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("accepts a signature the enrolled key really made", async () => {
    expect(await verifySshSignature({ publicKey: mine.publicKey, namespace: NAMESPACE, message, signatureBase64 })).toBe(
      true,
    );
  });

  it("refuses a signature over other bytes", async () => {
    const other = new TextEncoder().encode("bytes nobody signed");
    expect(
      await verifySshSignature({ publicKey: mine.publicKey, namespace: NAMESPACE, message: other, signatureBase64 }),
    ).toBe(false);
  });

  it("refuses a signature made by another key", async () => {
    expect(
      await verifySshSignature({ publicKey: theirs.publicKey, namespace: NAMESPACE, message, signatureBase64 }),
    ).toBe(false);
  });

  it("refuses a signature made for another namespace", async () => {
    const elsewhere = await sign(mine.path, message, "thwip-enroll-v1");
    expect(
      await verifySshSignature({
        publicKey: mine.publicKey,
        namespace: NAMESPACE,
        message,
        signatureBase64: elsewhere,
      }),
    ).toBe(false);
  });

  it("is what a caller who injects nothing gets", async () => {
    // Not "a caller who injects nothing is refused" — a verifier that refuses
    // everything would pass that. A genuine signature has to be accepted with
    // no dependency handed in at all.
    const statement = makeStatement();
    const payload = utf8Encode(JSON.stringify(statement));
    const envelope: DsseEnvelope = {
      payloadType: DSSE_PAYLOAD_TYPE,
      payload: b64stdEncode(payload),
      signatures: [{ keyid: "key_test1", sig: await sign(mine.path, dssePae(DSSE_PAYLOAD_TYPE, payload)) }],
    };
    const result = await verifyProof(
      {
        commitMessage: `feat: something\n\n${encodeCarrier(envelope)}\n`,
        facts: makeFacts(),
        bundle: makeBundle(mine.publicKey),
        now: NOW,
      },
      {},
    );
    expect(result.code).toBe("PASS");
  });

  it("refuses a signature it cannot read at all", async () => {
    expect(
      await verifySshSignature({ publicKey: mine.publicKey, namespace: NAMESPACE, message, signatureBase64: "nonsense" }),
    ).toBe(false);
  });
});
