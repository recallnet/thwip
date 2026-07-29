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
import { discoverSigningKey, fingerprintOfPublicKey, githubSigningKeys } from "./signing-key.js";
import { developerSetupPrompt } from "@thwip/prompts";
import { attachTrailer, buildStatement, signStatement } from "./proof.js";

/** Optional overrides only. Identity and keys live in GitHub. */
interface CliConfig {
  endpoint?: string;
  /** path to a private signing key, when the machine has several */
  signingKey?: string;
  /** GitHub login, when it cannot be derived from gh or the remote */
  githubLogin?: string;
}

const CONFIG_PATH = join(homedir(), ".config", "thwip", "config.json");

async function loadConfig(): Promise<CliConfig> {
  try {
    return JSON.parse(await readFile(CONFIG_PATH, "utf8")) as CliConfig;
  } catch {
    return {};
  }
}

/** Who GitHub says we are: gh's own auth, else the configured login. */
async function resolveGithubIdentity(config: CliConfig): Promise<{ login: string; id: string }> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileP = promisify(execFile);
  try {
    const { stdout } = await execFileP("gh", ["api", "user", "--jq", "{login: .login, id: .id}"]);
    const u = JSON.parse(stdout) as { login: string; id: number };
    return { login: u.login, id: String(u.id) };
  } catch {
    /* gh missing or signed out */
  }
  if (config.githubLogin) {
    const res = await fetch(`https://api.github.com/users/${encodeURIComponent(config.githubLogin)}`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "thwip-cli" },
    });
    if (res.ok) {
      const u = (await res.json()) as { login: string; id: number };
      return { login: u.login, id: String(u.id) };
    }
  }
  throw new Error(
    "cannot determine your GitHub identity; sign in with 'gh auth login' or set githubLogin in ~/.config/thwip/config.json",
  );
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}


/**
 * The key must be one GitHub already lists as a signing key for this user —
 * GitHub owns the key-to-identity binding, so an unregistered key cannot be
 * attributed to anyone and thwip will not sign with it.
 */
async function requireRegisteredKey(cwd: string, config: CliConfig, login: string) {
  const key = await discoverSigningKey(cwd, config.signingKey);
  if (!key) {
    throw new Error(
      [
        "no ed25519 signing key found on this machine.",
        "  create one:  ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519",
        "  register it: gh ssh-key add ~/.ssh/id_ed25519.pub --type signing",
      ].join("\n"),
    );
  }
  const listed = await githubSigningKeys(login);
  const fingerprints = await Promise.all(listed.map((k) => fingerprintOfPublicKey(k.key)));
  if (!fingerprints.includes(key.fingerprint)) {
    throw new Error(
      [
        `the key at ${key.privateKeyPath} (${key.fingerprint}) is not registered as a signing key for ${login}.`,
        `  register it: gh ssh-key add ${key.privateKeyPath}.pub --type signing`,
        "  or point thwip at another key with signingKey in ~/.config/thwip/config.json",
      ].join("\n"),
    );
  }
  return key;
}

/** Report which key would sign here and whether GitHub lists it. */
async function cmdKeysStatus(): Promise<number> {
  const cwd = process.cwd();
  const config = await loadConfig();
  const identity = await resolveGithubIdentity(config);
  const key = await discoverSigningKey(cwd, config.signingKey);
  if (!key) {
    process.stderr.write(
      "no ed25519 signing key found.\n  ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519\n  gh ssh-key add ~/.ssh/id_ed25519.pub --type signing\n",
    );
    return 1;
  }
  const listed = await githubSigningKeys(identity.login);
  const fingerprints = await Promise.all(listed.map((k) => fingerprintOfPublicKey(k.key)));
  const registered = fingerprints.includes(key.fingerprint);
  process.stdout.write(
    JSON.stringify(
      {
        githubLogin: identity.login,
        githubUserId: identity.id,
        privateKeyPath: key.privateKeyPath,
        fingerprint: key.fingerprint,
        source: key.source,
        registeredWithGithub: registered,
        githubSigningKeys: listed.map((k, i) => ({ title: k.title, fingerprint: fingerprints[i] })),
      },
      null,
      2,
    ) + "\n",
  );
  if (!registered) {
    process.stderr.write(`\nnot registered. run: gh ssh-key add ${key.privateKeyPath}.pub --type signing\n`);
    return 1;
  }
  return 0;
}

async function cmdRun(argv: string[]): Promise<number> {
  const cwd = process.cwd();
  const baseRef = flag(argv, "--base") ?? "origin/main";
  const config = await loadConfig();
  const endpoint = config.endpoint ?? process.env["THWIP_ENDPOINT"] ?? "https://thwip.recall.net";

  const identity = await resolveGithubIdentity(config);
  const key = await requireRegisteredKey(cwd, config, identity.login);

  await requireCleanTree(cwd);
  const subject = await freezeSubject(cwd, baseRef);
  const project = await loadProjectConfigAtHead(cwd, endpoint, await apiAuthHeader());
  const { policy, policyDigest } = project;
  const def = project.pipeline;
  const pDigest = project.pipelineDigest;

  const startedAt = new Date().toISOString();
  let suites;
  if (def.runner === "dagger") {
    const { ensureDagger, requireContainerRuntime, runDaggerSuites } = await import("./dagger.js");
    await requireContainerRuntime();
    process.stderr.write(`[thwip] provisioning dagger ${def.daggerVersion} (thwip cache, not a global install)\n`);
    const bin = await ensureDagger(def.daggerVersion!);
    suites = await runDaggerSuites({
      bin,
      module: def.module!,
      suites: def.suites.map((x) => x.id),
      cwd,
    });
  } else {
    suites = await runSuites(def, cwd);
  }
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
    keyId: key.fingerprint,
    githubUserId: identity.id,
    privateKeyPath: key.privateKeyPath,
  });
  const envelope = await signStatement(statement, key.fingerprint, key.privateKeyPath);

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

async function cmdPolicyDigest(): Promise<number> {
  const cwd = process.cwd();
  const endpoint = process.env["THWIP_ENDPOINT"] ?? "https://thwip.recall.net";
  const project = await loadProjectConfigAtHead(cwd, endpoint, await apiAuthHeader());
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
 * optionally point git's SSH commit signing at the same key thwip signs with.
 */
async function cmdInit(argv: string[]): Promise<number> {
  const cwd = process.cwd();
  const { existsSync } = await import("node:fs");
  const { writeFile } = await import("node:fs/promises");
  const { git } = await import("./git.js");

  if (argv.includes("--sign-commits")) {
    const config = await loadConfig();
    const key = await discoverSigningKey(cwd, config.signingKey);
    if (!key) {
      process.stderr.write("no ed25519 signing key found; see: thwip keys status\n");
      return 1;
    }
    await git(["config", "gpg.format", "ssh"], cwd);
    await git(["config", "user.signingkey", `${key.privateKeyPath}.pub`], cwd);
    await git(["config", "commit.gpgsign", "true"], cwd);
    process.stderr.write(`[thwip] git signs commits with ${key.fingerprint} (repo-local config)\n`);
    if (!existsSync(`${cwd}/thwip.yaml`)) return 0;
  }

  if (existsSync(`${cwd}/thwip.yaml`)) {
    process.stderr.write("thwip.yaml already exists; edit it directly\n");
    return 0;
  }
  const requiredArg = flag(argv, "--required");
  if (!requiredArg) {
    process.stderr.write('usage: thwip init --required "lint,typecheck,test" [--profile fast] [--sign-commits]\n');
    return 1;
  }
  const profile = flag(argv, "--profile") ?? "fast";
  const required = requiredArg
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const yaml = [
    "# thwip.yaml — thwip settings for this repository",
    "# docs: https://thwip.recall.net/faq",
    "# Repository identity comes from the git remote; suite commands come from",
    "# package.json scripts (or an explicit `suites:` map for non-node repos).",
    "version: 1",
    `profile: ${profile}`,
    "required:",
    ...required.map((id) => `  - ${id}`),
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
  init --required "a,b,.."  Write thwip.yaml for this repository. Suite ids
       [--profile fast]     name package.json scripts; profile is one of
       [--sign-commits]     fast | fresh | audited | remote (see /faq).
                            --sign-commits also makes git sign commits with
                            the enrolled thwip key.
  keys status               Show which key would sign here and whether GitHub
                            lists it as a signing key for your account.
  setup                     Print the agent prompt for preparing a machine
                            (install, sign in, register a signing key).
  run [--base origin/main]  Run the approved suites against the committed
                            tree and attach a signed proof to HEAD.
                            Refuses dirty trees; exit 1 and no proof if any
                            suite fails or the tree changes mid-run.
  verify [--json]           Parse and print the proof on HEAD.
  policy digest             Print the policy/pipeline digests for HEAD.

EXAMPLES
  thwip login
  thwip keys enroll --public-key ~/.config/thwip/keys/laptop.pub --label laptop
  thwip init --required "lint,typecheck,test"
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
  else if (cmd === "keys" && (sub === "status" || sub === undefined)) code = await cmdKeysStatus();
  else if (cmd === "setup") {
    // Printed for agents: the human-guided machine setup, verbatim.
    process.stdout.write(developerSetupPrompt() + "\n");
    code = 0;
  }
  else if (cmd === "policy" && sub === "digest") code = await cmdPolicyDigest();
  else {
    process.stderr.write("usage: thwip <login|run|verify|policy digest|keys enroll> [options]\n");
  }
  process.exit(code);
}

void main();
export { verifySshSignature };
