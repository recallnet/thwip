#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  canonicalDigest,
  extractCarrier,
  parseStatement,
  utf8Decode,
  b64stdDecode,
  type PolicyBundleV1,
} from "@thwip/protocol";
import { verifySshSignature } from "@thwip/sshsig";
import {
  amendMessage,
  currentTree,
  freezeSubject,
  headMessage,
  requireCleanTree,
  showFileAtHead,
} from "./git.js";
import { parsePipelineDefinition, pipelineDigest, runSuites } from "./pipeline.js";
import { attachTrailer, buildStatement, signStatement } from "./receipt.js";

interface CliConfig {
  endpoint: string;
  keyId: string;
  privateKeyPath: string;
  githubUserId: string;
}

const CONFIG_PATH = join(homedir(), ".config", "thwip", "config.json");

async function loadConfig(): Promise<CliConfig> {
  try {
    return JSON.parse(await readFile(CONFIG_PATH, "utf8")) as CliConfig;
  } catch {
    throw new Error(`missing or invalid ${CONFIG_PATH}; run: thwip keys enroll`);
  }
}

async function loadPolicyAtHead(cwd: string): Promise<{ policy: PolicyBundleV1; digest: `sha256:${string}` }> {
  const text = await showFileAtHead(cwd, "thwip.policy.json");
  const policy = JSON.parse(text) as PolicyBundleV1;
  const digest = await canonicalDigest(policy);
  return { policy, digest };
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function cmdRun(argv: string[]): Promise<number> {
  const cwd = process.cwd();
  const baseRef = flag(argv, "--base") ?? "origin/main";
  const config = await loadConfig();

  await requireCleanTree(cwd);
  const subject = await freezeSubject(cwd, baseRef);
  const { policy, digest: policyDigest } = await loadPolicyAtHead(cwd);
  const pipelineText = await showFileAtHead(cwd, "thwip.pipeline.json");
  const def = parsePipelineDefinition(pipelineText);
  const pDigest = await pipelineDigest(pipelineText);
  if (pDigest !== policy.pipeline.digest) {
    process.stderr.write(
      `[thwip] pipeline digest ${pDigest} does not match policy-approved ${policy.pipeline.digest}\n`,
    );
    return 1;
  }

  const startedAt = new Date().toISOString();
  const suites = await runSuites(def, cwd);
  const finishedAt = new Date().toISOString();

  const failed = suites.filter((s) => s.status !== "passed");
  const missing = policy.pipeline.requiredSuites.filter((r) => !suites.some((s) => s.id === r));
  if (failed.length > 0 || missing.length > 0) {
    process.stderr.write(`[thwip] not signing: failed=[${failed.map((s) => s.id).join(",")}] missing=[${missing.join(",")}]\n`);
    return 1;
  }

  const treeAfter = await currentTree(cwd);
  if (treeAfter !== subject.treeOid) {
    process.stderr.write("[thwip] bound tree changed during execution; refusing to attach receipt\n");
    return 1;
  }

  const statement = buildStatement({
    subject,
    ownerId: policy.ownerId,
    repositoryId: policy.repositoryId,
    policyDigest,
    policyVersion: policy.version,
    pipelineDigest: pDigest,
    runner: def.runner,
    suites,
    startedAt,
    finishedAt,
    keyId: config.keyId,
    githubUserId: config.githubUserId,
    privateKeyPath: config.privateKeyPath,
  });
  const envelope = await signStatement(statement, config.keyId, config.privateKeyPath);

  const message = await headMessage(cwd);
  const amended = attachTrailer(message, envelope);
  await amendMessage(cwd, amended);
  const newHead = await currentTree(cwd);
  if (newHead !== subject.treeOid) {
    process.stderr.write("[thwip] tree changed while attaching receipt\n");
    return 1;
  }
  process.stderr.write(`[thwip] receipt attached for tree ${subject.treeOid} (policy v${policy.version})\n`);
  return 0;
}

async function cmdVerifyLocal(): Promise<number> {
  const cwd = process.cwd();
  const message = await headMessage(cwd);
  const carrier = extractCarrier(message);
  if (!carrier.ok) {
    process.stderr.write(`[thwip] ${carrier.error.code}\n`);
    return 1;
  }
  const payload = b64stdDecode(carrier.envelope.payload);
  const parsed = parseStatement(JSON.parse(utf8Decode(payload)));
  if (!parsed.ok) {
    process.stderr.write(`[thwip] RECEIPT_MALFORMED ${parsed.detail}\n`);
    return 1;
  }
  process.stdout.write(JSON.stringify(parsed.value.predicate, null, 2) + "\n");
  process.stderr.write(`[thwip] receipt parses; signer key ${carrier.envelope.signatures[0]!.keyid}\n`);
  return 0;
}

async function cmdKeysEnroll(argv: string[]): Promise<number> {
  const endpoint = flag(argv, "--endpoint") ?? process.env["THWIP_ENDPOINT"] ?? "https://thwip.recall.net";
  const publicKeyPath = flag(argv, "--public-key");
  const label = flag(argv, "--label") ?? "device";
  const adminToken = process.env["THWIP_ADMIN_TOKEN"];
  if (!publicKeyPath) {
    process.stderr.write("usage: thwip keys enroll --public-key <path.pub> --label <label>\n");
    return 1;
  }
  if (!adminToken) {
    process.stderr.write("THWIP_ADMIN_TOKEN required for enrollment in this build\n");
    return 1;
  }
  const publicKey = (await readFile(publicKeyPath, "utf8")).trim();

  // Proof of possession: fetch a challenge, sign it, submit.
  const challengeRes = await fetch(`${endpoint}/v1/devices/challenges`, {
    method: "POST",
    headers: { authorization: `Bearer ${adminToken}` },
  });
  if (!challengeRes.ok) {
    process.stderr.write(`challenge failed: ${challengeRes.status}\n`);
    return 1;
  }
  const { challenge } = (await challengeRes.json()) as { challenge: string };
  const { signSsh } = await import("@thwip/sshsig");
  const privateKeyPath = publicKeyPath.replace(/\.pub$/, "");
  const pop = await signSsh({
    privateKeyPath,
    namespace: "thwip-enroll-v1",
    message: new TextEncoder().encode(challenge),
  });

  const githubUserId = flag(argv, "--github-user-id");
  if (!githubUserId) {
    process.stderr.write("--github-user-id required\n");
    return 1;
  }
  const res = await fetch(`${endpoint}/v1/devices`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ publicKey, label, githubUserId, challenge, proofOfPossession: pop }),
  });
  const body = (await res.json()) as { keyId?: string; error?: string };
  if (!res.ok || !body.keyId) {
    process.stderr.write(`enrollment failed: ${res.status} ${JSON.stringify(body)}\n`);
    return 1;
  }
  const { writeFile, mkdir } = await import("node:fs/promises");
  await mkdir(join(homedir(), ".config", "thwip"), { recursive: true });
  const config: CliConfig = { endpoint, keyId: body.keyId, privateKeyPath, githubUserId };
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
  process.stderr.write(`[thwip] enrolled ${body.keyId}; config written to ${CONFIG_PATH}\n`);
  return 0;
}

async function cmdPolicyDigest(): Promise<number> {
  const cwd = process.cwd();
  const { digest } = await loadPolicyAtHead(cwd);
  const pipelineText = await showFileAtHead(cwd, "thwip.pipeline.json");
  process.stdout.write(
    JSON.stringify({ policyDigest: digest, pipelineDigest: await pipelineDigest(pipelineText) }, null, 2) + "\n",
  );
  return 0;
}

async function main(): Promise<void> {
  const [, , cmd, sub, ...rest] = process.argv;
  let code = 1;
  if (cmd === "run") code = await cmdRun([sub ?? "", ...rest]);
  else if (cmd === "verify") code = await cmdVerifyLocal();
  else if (cmd === "keys" && sub === "enroll") code = await cmdKeysEnroll(rest);
  else if (cmd === "policy" && sub === "digest") code = await cmdPolicyDigest();
  else {
    process.stderr.write("usage: thwip <run|verify|policy digest|keys enroll> [options]\n");
  }
  process.exit(code);
}

void main();
export { verifySshSignature };
