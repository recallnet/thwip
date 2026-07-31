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
import { headProofState } from "./head-proof.js";
import { runSuites } from "./pipeline.js";
import { loadProjectConfigAtHead } from "./config.js";
import { discoverSigningKey, fingerprintOfPublicKey, githubSigningKeys } from "./signing-key.js";
import { developerSetupPrompt } from "@thwip/prompts";
import { planQueueCommand } from "./queue-commands.js";
import { installInterruptHandler, readGitState, runShip, type ShipPorts } from "./ship-io.js";
import { EXIT } from "./queue-exit.js";
import { attachTrailer, buildStatement, signStatement } from "./proof.js";
import { executeCli, type CommandInvocation } from "./cli-args.js";
import type { JSONWebKeySet } from "jose";
import { summarize, verifyPublishedChain, type ChainResponse } from "./verify-chain.js";

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

  // Parsing is not the question. A proof binds one tree, and a rebase leaves the
  // proof behind on a commit whose tree has moved, so reporting "it parses" for
  // one of those would be true and useless.
  const state = headProofState(message, await currentTree(cwd));
  if (state === "stale") {
    process.stderr.write(
      "[thwip] PROOF_STALE this proof names a different tree, which is what a rebase leaves behind; run thwip ship to sign again\n",
    );
    return 1;
  }
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
        configSource: project.configSource,
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

/**
 * `thwip ship`. The loop and every decision it makes are tested in ship.ts and
 * ship-io.ts; this supplies only the ports that touch git, gh, and the queue.
 */
async function cmdShip(argv: string[]): Promise<number> {
  const cwd = process.cwd();
  const endpoint = process.env["THWIP_ENDPOINT"] ?? "https://thwip.recall.net";
  const jsonEvents = argv.includes("--json-events");
  const wait = argv.includes("--wait");
  const useQueue = !argv.includes("--no-queue");
  const auth = await apiAuthHeader();
  if (auth === null) {
    process.stderr.write("not signed in: run `thwip login`\n");
    return EXIT.authRequired;
  }

  const project = await loadProjectConfigAtHead(cwd, endpoint, auth);
  const repositoryId = project.policy.repositoryId;
  // The queue is per base branch, and the branch a pull request targets is what
  // GitHub reports, not something the policy pins.
  const baseRef = "refs/heads/" + (await defaultBranch(cwd));

  let prNumber: number | null = await currentPrNumber(cwd);
  let headProof: "accepted" | "missing" | "stale" = "missing";

  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(endpoint + path, {
      method,
      headers: { authorization: auth, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  };
  const queuePath = (suffix = "") =>
    `/v1/queue/${repositoryId}${suffix}?ref=${encodeURIComponent(baseRef)}`;

  const ports: ShipPorts = {
    async observe() {
      const git = await readGitState(cwd);
      // The queue owns the entry and the turn; git owns the tree. Neither fact is
      // inferred from the other.
      const snapshot = useQueue ? await call("GET", queuePath()) : { status: 404, body: {} };
      const entries = (snapshot.body["entries"] as Array<Record<string, unknown>> | undefined) ?? [];
      const mine = entries.find((e) => String(e["entryId"]).endsWith("_" + String(prNumber)));
      return {
        authenticated: true,
        workingTreeClean: git.workingTreeClean,
        headProof,
        pushedHeadMatchesLocal: git.pushedHeadMatchesLocal,
        pullRequestNumber: prNumber,
        queueEntryExists: mine !== undefined && mine["state"] !== "Cancelled",
        turn: turnFrom(mine?.["state"]),
        options: { wait, queue: useQueue, jsonEvents },
      };
    },
    async runSuites() {
      const code = await cmdRun([]);
      if (code !== 0) return { ok: false, reasonCode: "SUITE_FAILED" };
      headProof = "accepted";
      return { ok: true };
    },
    async push() {
      await run("git", ["push", "--set-upstream", "origin", "HEAD"], cwd);
    },
    async openOrUpdatePullRequest() {
      // gh handles the difference between opening and updating, and is already a
      // prerequisite of this workflow.
      await run("gh", ["pr", "create", "--fill"], cwd).catch(() => "");
      prNumber = await currentPrNumber(cwd);
      return { pullRequestNumber: prNumber ?? 0 };
    },
    async joinQueue() {
      if (prNumber === null) return { reasonCode: "INTERNAL_FAILURE" };
      const git = await readGitState(cwd);
      const result = await call("POST", queuePath("/entries"), {
        pullRequestNumber: prNumber,
        headSha: git.headSha,
      });
      return result.status >= 400
        ? { reasonCode: String(result.body["error"] ?? "SERVICE_UNAVAILABLE") }
        : {};
    },
    async awaitTurn() {
      await sleep(5000);
      const result = await call("POST", queuePath("/tick"));
      return result.status >= 500 ? { reasonCode: "SERVICE_UNAVAILABLE" } : {};
    },
    async executeTurn() {
      // The control plane's workflow drives the turn; the CLI keeps this device
      // present while it runs.
      await sleep(5000);
      return {};
    },
    async awaitMerge() {
      await sleep(5000);
      return {};
    },
    async releaseTurn() {
      if (prNumber === null) return;
      await call(
        "DELETE",
        `/v1/queue/${repositoryId}/entries/entry_${repositoryId}_${prNumber}?ref=${encodeURIComponent(baseRef)}&reason=interrupted`,
      );
    },
  };

  // Compared against the tree, not merely looked for.
  //
  // A rebase keeps the commit message, so the proof outlives the tree it
  // describes. Treating the trailer's presence as proof enough let this skip
  // signing and push a commit the required check then rejected with
  // SUBJECT_TREE_MISMATCH, which costs a full trip through CI to find out.
  headProof = headProofState(await headMessage(cwd), await currentTree(cwd));
  if (headProof === "stale") {
    process.stderr.write(
      "[thwip] this commit carries a proof for a different tree, which is what a rebase leaves behind; signing again\n",
    );
  }

  const detach = installInterruptHandler(ports, (t) => process.stdout.write(t + "\n"), { jsonEvents });
  try {
    const report = await runShip(ports, (t) => process.stdout.write(t + "\n"), { jsonEvents });
    return report.exitCode;
  } finally {
    detach();
  }
}

function turnFrom(
  state: unknown,
): "none" | "offered" | "claimed" | "running" | "verified" | "merging" | "merged" {
  switch (state) {
    case "Offered":
      return "offered";
    case "Active":
    case "ReconnectGrace":
      return "running";
    case "Verifying":
    case "MergeGuard":
      return "verified";
    case "Merging":
    case "Reconciling":
      return "merging";
    case "Merged":
      return "merged";
    default:
      return "none";
  }
}

/** The branch this pull request targets, as GitHub reports it. */
async function defaultBranch(cwd: string): Promise<string> {
  try {
    const out = await run("gh", ["pr", "view", "--json", "baseRefName", "-q", ".baseRefName"], cwd);
    const name = out.trim();
    if (name.length > 0) return name;
  } catch {
    /* no pull request yet */
  }
  try {
    const out = await run("gh", ["repo", "view", "--json", "defaultBranchRef", "-q", ".defaultBranchRef.name"], cwd);
    const name = out.trim();
    if (name.length > 0) return name;
  } catch {
    /* fall through */
  }
  return "main";
}

async function currentPrNumber(cwd: string): Promise<number | null> {
  try {
    const out = await run("gh", ["pr", "view", "--json", "number", "-q", ".number"], cwd);
    const n = Number(out.trim());
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run(cmd: string, args: string[], cwd: string): Promise<string> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { stdout } = await promisify(execFile)(cmd, args, { cwd });
  return stdout;
}

/** Resolve `owner/name` to the numeric GitHub repository id thwip tracks. */
async function resolveRepositoryId(endpoint: string, auth: string, repo: string): Promise<string | null> {
  const resolved = await fetch(endpoint + "/v1/resolve-repo?name=" + encodeURIComponent(repo), {
    headers: { authorization: auth },
  });
  if (!resolved.ok) return null;
  const { repositoryId } = (await resolved.json()) as { repositoryId: string };
  return repositoryId;
}

/** `thwip queue …`. Parsing, authority, and confirmations live in queue-commands.ts. */
async function cmdQueue(argv: string[]): Promise<number> {
  const parsed = planQueueCommand(argv);
  if (!parsed.ok) {
    process.stderr.write(parsed.message + "\n");
    return parsed.exitCode;
  }
  const endpoint = process.env["THWIP_ENDPOINT"] ?? "https://thwip.recall.net";
  const auth = await apiAuthHeader();
  if (auth === null) {
    process.stderr.write("not signed in: run `thwip login`\n");
    return EXIT.authRequired;
  }

  const repo = flag(argv, "--repo") ?? "";
  let path = parsed.plan.path;
  if (path.includes("{repositoryId}")) {
    const repositoryId = await resolveRepositoryId(endpoint, auth, repo);
    if (repositoryId === null) {
      process.stderr.write(`cannot resolve ${repo}\n`);
      return EXIT.setupInvalid;
    }
    path = path.replaceAll("{repositoryId}", repositoryId);
  }

  const res = await fetch(endpoint + path, {
    method: parsed.plan.method,
    headers: {
      authorization: auth,
      "content-type": "application/json",
      ...(parsed.plan.idempotencyKey === undefined
        ? {}
        : { "idempotency-key": parsed.plan.idempotencyKey }),
    },
    ...(parsed.plan.body === undefined ? {} : { body: JSON.stringify(parsed.plan.body) }),
  });
  process.stdout.write((await res.text()) + "\n");
  return res.ok ? 0 : res.status === 403 ? EXIT.permission : EXIT.unavailable;
}

/**
 * Resolve `owner/name` to a numeric GitHub repository id via GitHub's own
 * public API. No thwip session, no credentials: anyone can look up a public
 * repository id this way, which is what an outside auditor is.
 */
async function resolveRepositoryIdFromGithub(repo: string): Promise<string | null> {
  const res = await fetch(`https://api.github.com/repos/${repo}`, {
    headers: { accept: "application/vnd.github+json", "user-agent": "thwip-cli" },
  });
  if (!res.ok) return null;
  const { id } = (await res.json()) as { id: number };
  return String(id);
}

/**
 * Fetch a branch's chain and the keys thwip publishes, then verify it. The
 * chain and keys endpoints are deliberately public, so that a person with no
 * thwip account can check thwip's claims for themselves — that only works if
 * this command itself never needs to sign in. The id lookup goes through
 * GitHub's public API instead of thwip's own (authenticated) resolver, unlike
 * `thwip queue`, which mutates state and legitimately needs an identity.
 */
async function cmdVerifyChain(argv: string[]): Promise<number> {
  const endpoint = process.env["THWIP_ENDPOINT"] ?? "https://thwip.recall.net";
  const repo = flag(argv, "--repo") ?? "";
  const repositoryIdFlag = flag(argv, "--repository-id");
  if (repositoryIdFlag === undefined && !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    process.stderr.write(
      "usage: thwip verify-chain --repo OWNER/NAME [--branch BRANCH]\n" +
        "       thwip verify-chain --repository-id ID [--branch BRANCH]\n",
    );
    return EXIT.usage;
  }
  const branch = flag(argv, "--branch") ?? "main";

  const repositoryId = repositoryIdFlag ?? (await resolveRepositoryIdFromGithub(repo));
  if (repositoryId === null) {
    process.stderr.write(`cannot resolve ${repo} (pass --repository-id to skip GitHub lookup)\n`);
    return EXIT.setupInvalid;
  }
  const ref = encodeURIComponent(`refs/heads/${branch}`);

  let chainRes: Response;
  let keysRes: Response;
  try {
    [chainRes, keysRes] = await Promise.all([
      fetch(`${endpoint}/v1/queue/${repositoryId}/chain?ref=${ref}`),
      fetch(`${endpoint}/.well-known/thwip-keys`),
    ]);
  } catch {
    process.stderr.write("could not reach thwip\n");
    return EXIT.unavailable;
  }
  if (!chainRes.ok) {
    process.stderr.write(`could not read the chain (${chainRes.status})\n`);
    return exitForStatus(chainRes.status);
  }
  const chain = (await chainRes.json()) as ChainResponse;
  const jwks = (await keysRes.json()) as JSONWebKeySet;

  const { verified, findings } = await verifyPublishedChain(chain, jwks);
  process.stdout.write(summarize(verified, findings) + "\n");
  return findings.some((f) => f.code !== "PRE_ATTESTATION") ? EXIT.evidenceRejected : EXIT.ok;
}

/**
 * A 4xx means the request itself is wrong (bad ref, unknown repository) and
 * retrying changes nothing; a 429 is a rate limit; a 5xx is the transient
 * class. See queue-exit.ts for the documented meaning of each.
 */
function exitForStatus(status: number): number {
  if (status === 429) return EXIT.rateLimited;
  if (status >= 400 && status < 500) return EXIT.setupInvalid;
  return EXIT.unavailable;
}

async function dispatchCli(invocation: CommandInvocation): Promise<number> {
  switch (invocation.command) {
    case "run":
      return cmdRun([...invocation.argv]);
    case "ship":
      return cmdShip([...invocation.argv]);
    case "queue":
      return cmdQueue([...invocation.argv]);
    case "login":
      return cmdLogin([...invocation.argv]);
    case "init":
      return cmdInit([...invocation.argv]);
    case "verify":
      return cmdVerifyLocal();
    case "verify-chain":
      return cmdVerifyChain([...invocation.argv]);
    case "keys-status":
      return cmdKeysStatus();
    case "setup":
      process.stdout.write(developerSetupPrompt() + "\n");
      return 0;
    case "policy-digest":
      return cmdPolicyDigest();
  }
}

async function main(): Promise<void> {
  const code = await executeCli(process.argv.slice(2), {
    dispatch: dispatchCli,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  });
  process.exit(code);
}

void main();
export { verifySshSignature };
