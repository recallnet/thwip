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
import { runSuites } from "./pipeline.js";
import { loadProjectConfigAtHead } from "./config.js";
import { attachTrailer, buildStatement, signStatement } from "./proof.js";

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
  const project = await loadProjectConfigAtHead(cwd);
  const { policy, policyDigest } = project;
  const def = project.pipeline;
  const pDigest = project.pipelineDigest;

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
    process.stderr.write("[thwip] bound tree changed during execution; refusing to attach proof\n");
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
    process.stderr.write("[thwip] tree changed while attaching proof\n");
    return 1;
  }
  process.stderr.write(`[thwip] proof attached for tree ${subject.treeOid} (policy v${policy.version})\n`);
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
    process.stderr.write(`[thwip] PROOF_MALFORMED ${parsed.detail}\n`);
    return 1;
  }
  process.stdout.write(JSON.stringify(parsed.value.predicate, null, 2) + "\n");
  process.stderr.write(`[thwip] proof parses; signer key ${carrier.envelope.signatures[0]!.keyid}\n`);
  return 0;
}

const TOKEN_PATH = join(homedir(), ".config", "thwip", "session-token");

/** RFC 8628 device authorization flow against the thwip control plane. */
async function cmdLogin(argv: string[]): Promise<number> {
  const endpoint = flag(argv, "--endpoint") ?? process.env["THWIP_ENDPOINT"] ?? "https://thwip.recall.net";
  const codeRes = await fetch(`${endpoint}/api/auth/device/code`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: "thwip-cli" }),
  });
  if (!codeRes.ok) {
    process.stderr.write(`device authorization unavailable: ${codeRes.status} ${await codeRes.text()}\n`);
    return 1;
  }
  const code = (await codeRes.json()) as {
    device_code: string;
    user_code: string;
    verification_uri?: string;
    verification_uri_complete?: string;
    interval?: number;
    expires_in?: number;
  };
  const approveUrl =
    code.verification_uri_complete ?? `${endpoint}/device?user_code=${encodeURIComponent(code.user_code)}`;
  process.stderr.write(`\n[thwip] To sign in, open:\n\n    ${approveUrl}\n\n    code: ${code.user_code}\n\n`);
  const intervalMs = (code.interval ?? 5) * 1000;
  const deadline = Date.now() + (code.expires_in ?? 1800) * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    const tokenRes = await fetch(`${endpoint}/api/auth/device/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: code.device_code,
        client_id: "thwip-cli",
      }),
    });
    const body = (await tokenRes.json().catch(() => ({}))) as { access_token?: string; error?: string };
    if (tokenRes.ok && body.access_token) {
      const { writeFile, mkdir } = await import("node:fs/promises");
      await mkdir(join(homedir(), ".config", "thwip"), { recursive: true });
      await writeFile(TOKEN_PATH, body.access_token, { mode: 0o600 });
      process.stderr.write(`[thwip] signed in; session token stored at ${TOKEN_PATH}\n`);
      return 0;
    }
    if (body.error && body.error !== "authorization_pending" && body.error !== "slow_down") {
      process.stderr.write(`[thwip] login failed: ${body.error}\n`);
      return 1;
    }
  }
  process.stderr.write("[thwip] login timed out\n");
  return 1;
}

async function apiAuthHeader(): Promise<string | null> {
  try {
    const token = (await readFile(TOKEN_PATH, "utf8")).trim();
    if (token) return `Bearer ${token}`;
  } catch {
    /* fall through */
  }
  const adminToken = process.env["THWIP_ADMIN_TOKEN"];
  return adminToken ? `Bearer ${adminToken}` : null;
}

async function cmdKeysEnroll(argv: string[]): Promise<number> {
  const endpoint = flag(argv, "--endpoint") ?? process.env["THWIP_ENDPOINT"] ?? "https://thwip.recall.net";
  const publicKeyPath = flag(argv, "--public-key");
  const label = flag(argv, "--label") ?? "device";
  const authHeader = await apiAuthHeader();
  if (!publicKeyPath) {
    process.stderr.write("usage: thwip keys enroll --public-key <path.pub> --label <label>\n");
    return 1;
  }
  if (!authHeader) {
    process.stderr.write("not signed in; run: thwip login\n");
    return 1;
  }
  const publicKey = (await readFile(publicKeyPath, "utf8")).trim();

  // Proof of possession: fetch a challenge, sign it, submit.
  const challengeRes = await fetch(`${endpoint}/v1/devices/challenges`, {
    method: "POST",
    headers: { authorization: authHeader },
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

  // Session-authenticated enrollment binds to the signed-in GitHub identity;
  // --github-user-id is honored only for the operator admin-token path.
  const githubUserId = flag(argv, "--github-user-id");
  const res = await fetch(`${endpoint}/v1/devices`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: authHeader },
    body: JSON.stringify({ publicKey, label, githubUserId, challenge, proofOfPossession: pop }),
  });
  const body = (await res.json()) as { keyId?: string; githubUserId?: string; error?: string };
  if (!res.ok || !body.keyId) {
    process.stderr.write(`enrollment failed: ${res.status} ${JSON.stringify(body)}\n`);
    return 1;
  }
  const boundUserId = body.githubUserId ?? githubUserId;
  if (!boundUserId) {
    process.stderr.write("enrollment succeeded but no GitHub user id was bound\n");
    return 1;
  }
  const { writeFile, mkdir } = await import("node:fs/promises");
  await mkdir(join(homedir(), ".config", "thwip"), { recursive: true });
  const config: CliConfig = { endpoint, keyId: body.keyId, privateKeyPath, githubUserId: boundUserId };
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
  process.stderr.write(`[thwip] enrolled ${body.keyId}; config written to ${CONFIG_PATH}\n`);
  return 0;
}

async function cmdPolicyDigest(): Promise<number> {
  const cwd = process.cwd();
  const project = await loadProjectConfigAtHead(cwd);
  process.stdout.write(
    JSON.stringify(
      {
        policyDigest: project.policyDigest,
        pipelineDigest: project.pipelineDigest,
        version: project.policy.version,
        profile: project.policy.securityProfile,
        requiredSuites: project.policy.pipeline.requiredSuites,
      },
      null,
      2,
    ) + "\n",
  );
  return 0;
}

/**
 * thwip init: scaffold thwip.yaml (non-interactive; agents pass flags) and
 * optionally configure git to sign commits with the enrolled thwip key.
 */
async function cmdInit(argv: string[]): Promise<number> {
  const cwd = process.cwd();
  const { existsSync } = await import("node:fs");
  const { writeFile } = await import("node:fs/promises");
  const { git } = await import("./git.js");

  if (argv.includes("--sign-commits")) {
    const config = await loadConfig();
    await git(["config", "gpg.format", "ssh"], cwd);
    await git(["config", "user.signingkey", `${config.privateKeyPath}.pub`], cwd);
    await git(["config", "commit.gpgsign", "true"], cwd);
    process.stderr.write("[thwip] git now signs commits with the enrolled thwip key (repo-local config)\n");
    if (!existsSync(`${cwd}/thwip.yaml`)) return 0;
  }

  if (existsSync(`${cwd}/thwip.yaml`)) {
    process.stderr.write("thwip.yaml already exists; edit it directly\n");
    return 0;
  }
  const suitesArg = flag(argv, "--suites");
  if (!suitesArg) {
    process.stderr.write(
      'usage: thwip init --suites "lint=pnpm lint,test=pnpm test" [--profile fast] [--sign-commits]\n',
    );
    return 1;
  }
  const profile = flag(argv, "--profile") ?? "fast";
  let ownerId: string, repositoryId: string;
  try {
    const url = await git(["config", "--get", "remote.origin.url"], cwd);
    const m = /github\.com[:/]([^/]+)\/([^/.]+)/.exec(url);
    if (!m) throw new Error("origin is not a GitHub remote");
    const res = await fetch(`https://api.github.com/repos/${m[1]}/${m[2]}`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "thwip-cli" },
    });
    const repo = (await res.json()) as { id: number; owner: { id: number } };
    ownerId = String(repo.owner.id);
    repositoryId = String(repo.id);
  } catch (e) {
    process.stderr.write(`could not resolve GitHub repository ids: ${e instanceof Error ? e.message : e}\n`);
    return 1;
  }
  const suites = suitesArg
    .split(",")
    .map((pair) => pair.split("=").map((s) => s.trim()))
    .filter((kv): kv is [string, string] => kv.length === 2);
  const yaml = [
    "# thwip.yaml — project configuration for thwip (verified local CI)",
    "# docs: https://thwip.recall.net/faq",
    "version: 1",
    `profile: ${profile}`,
    "repository:",
    `  owner_id: "${ownerId}"`,
    `  repository_id: "${repositoryId}"`,
    "suites:",
    ...suites.map(([id, cmd]) => `  ${id}: ${cmd}`),
    "",
  ].join("\n");
  await writeFile(`${cwd}/thwip.yaml`, yaml);
  process.stderr.write("[thwip] wrote thwip.yaml; review it, commit it, and activate the policy in the dashboard\n");
  return 0;
}

const HELP = `thwip — verified local CI (https://thwip.recall.net)

Run CI where the code lives, sign a proof of the exact Git tree, and let a
protected GitHub check verify it. Configuration lives in thwip.yaml.

USAGE
  thwip <command> [options]

COMMANDS
  login                     Sign in via device code. Prints a URL to click
                            (works over SSH; the browser opens on the
                            human's machine, code is prefilled).
  init --suites "a=cmd,.."  Write thwip.yaml for this repository.
       [--profile fast]     fast | fresh | audited | remote (see /faq)
       [--sign-commits]     Also make git sign commits with the enrolled key.
  keys enroll --public-key <path.pub> --label <device>
                            Enroll this machine's dedicated signing key.
  run [--base origin/main]  Run the approved suites against the committed
                            tree and attach a signed proof to HEAD.
                            Refuses dirty trees; exit 1 and no proof if any
                            suite fails or the tree changes mid-run.
  verify [--json]           Parse and print the proof on HEAD.
  policy digest             Print the policy/pipeline digests for HEAD.

EXAMPLES
  thwip login
  thwip keys enroll --public-key ~/.config/thwip/keys/laptop.pub --label laptop
  thwip init --suites "lint=pnpm lint,typecheck=pnpm typecheck,test=pnpm test"
  thwip run && git push

EXIT CODES
  0 success · 1 failure (reason printed to stderr; verification reasons use
  stable codes such as PROOF_MISSING or SUBJECT_TREE_MISMATCH)
`;

async function main(): Promise<void> {
  const [, , cmd, sub, ...rest] = process.argv;
  let code = 1;
  if (cmd === "run") code = await cmdRun([sub ?? "", ...rest]);
  else if (cmd === "login") code = await cmdLogin([sub ?? "", ...rest]);
  else if (cmd === "init") code = await cmdInit([sub ?? "", ...rest]);
  else if (cmd === "--help" || cmd === "-h" || cmd === "help" || cmd === undefined) {
    process.stdout.write(HELP);
    code = 0;
  }
  else if (cmd === "verify") code = await cmdVerifyLocal();
  else if (cmd === "keys" && sub === "enroll") code = await cmdKeysEnroll(rest);
  else if (cmd === "policy" && sub === "digest") code = await cmdPolicyDigest();
  else {
    process.stderr.write("usage: thwip <login|run|verify|policy digest|keys enroll> [options]\n");
  }
  process.exit(code);
}

void main();
export { verifySshSignature };
