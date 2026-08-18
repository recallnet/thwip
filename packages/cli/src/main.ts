#!/usr/bin/env node
import { constants, existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalDigest,
  extractCarrier,
  parseStatement,
  utf8Decode,
  b64stdDecode,
  type PolicyBundleV1,
} from "@thwip/protocol";
import {
  amendMessage,
  currentTree,
  freezeSubject,
  git,
  gitInitRead,
  headMessage,
  readTips,
  requireCleanTree,
  showFileAtHead,
  tryGit,
} from "./git.js";
import { proofStateAtCommit } from "./commit-proof.js";
import { headProofState } from "./head-proof.js";
import { runSuites } from "./pipeline.js";
import { loadProjectConfigAtHead, loadProjectConfigForRun } from "./config.js";
import { discoverSigningKey, fingerprintOfPublicKey, githubSigningKeys } from "./signing-key.js";
import { initReport, NPX_COMMAND, queueInstructions, queueSetupPrompt, type InitPromptFacts } from "@thwip/prompts";
import { planQueueCommand } from "./queue-commands.js";
import { installInterruptHandler, readGitState, runShip, type ShipPorts } from "./ship-io.js";
import { EXIT } from "./queue-exit.js";
import { attachTrailer, buildStatement, signStatement } from "./proof.js";
import { acquireRunLease, httpLeasePorts } from "./run-lease.js";
import { type CommandInvocation } from "./cli-args.js";
import { classifyFailure, failureDetail, runCliProcess } from "./cli-failure.js";
import { forceArgs, planPush } from "./push-plan.js";
import { openPullRequest, pullRequestCommand, type OpenPullRequest } from "./pull-request.js";
import {
  buildMismatchFailure,
  findCliCheckout,
  parseBuildStamp,
  setupCommandMayUseForeignBuild,
  versionReport,
  type BuildIdentity,
} from "./build-identity.js";
import { doctorProbes, reportDoctor, type DoctorObservation } from "./queue-doctor.js";
import { runDoctor, type CliRead, type LocalReads, type PolicyRead, type SigningKeyRead } from "./doctor.js";
import { cmdVerifyChain, parseKeySet } from "./verify-chain.js";
import { materializeCandidate, type CandidateWorkspace } from "./candidate.js";
import { signReceipt, type ReceiptSuiteOutcome } from "./receipt.js";
import { runFreshTurn, type FreshTurnResult } from "./fresh-turn.js";
import { flag } from "./cli-flags.js";
import { realHeartbeat, runQueueWork } from "./queue-work.js";
import { DEFAULT_ENDPOINT } from "./endpoint.js";
import { normalizeSessionEndpoint, readStoredSession, writeStoredSession } from "./session-store.js";
import { writeAgentGuidance } from "./agent-guidance.js";
import {
  mayWriteGuidance,
  githubNameFromOrigin,
  observeInitState,
  readInitRepositoryContext,
  resolveDoctorTarget,
  type InitLiveState,
} from "./init-state.js";

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
    const { stdout } = await execFileP("gh", [
      "api",
      "--hostname",
      "github.com",
      "user",
      "--jq",
      "{login: .login, id: .id}",
    ], { timeout: 15_000 });
    const u = JSON.parse(stdout) as { login: string; id: number };
    return { login: u.login, id: String(u.id) };
  } catch {
    /* gh missing or signed out */
  }
  if (config.githubLogin) {
    const res = await fetch(`https://api.github.com/users/${encodeURIComponent(config.githubLogin)}`, {
      signal: AbortSignal.timeout(15_000),
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
  const endpoint = config.endpoint ?? process.env["THWIP_ENDPOINT"] ?? DEFAULT_ENDPOINT;

  const identity = await resolveGithubIdentity(config);
  const key = await requireRegisteredKey(cwd, config, identity.login);

  await requireCleanTree(cwd);
  const subject = await freezeSubject(cwd, baseRef);
  const project = await loadProjectConfigForRun(cwd, endpoint, await apiAuthHeader(endpoint));
  const { policy, policyDigest } = project;
  const def = project.pipeline;
  const pDigest = project.pipelineDigest;

  // The window opens before the suites do. A lease minted afterwards would be
  // a fresh wrapper around a run that already happened, which is the reuse the
  // lease exists to catch, so the verifier refuses one.
  const lease = await acquireRunLease(
    policy.lease.required,
    {
      repositoryId: policy.repositoryId,
      treeOid: subject.treeOid,
      parentOids: subject.parentOids,
      baseSha: subject.baseSha,
      deviceKeyId: key.fingerprint,
    },
    httpLeasePorts(endpoint, await apiAuthHeader(endpoint)),
  );

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
    ...(lease !== undefined ? { lease } : {}),
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

async function cmdVerifyLocal(argv: string[]): Promise<number> {
  const cwd = process.cwd();
  const asked = flag(argv, "--commit");
  if (asked !== undefined && !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(asked)) {
    process.stderr.write("[thwip] --commit must be one exact lowercase git object id\n");
    return EXIT.usage;
  }
  const revision = asked ?? "HEAD";
  let proof;
  try {
    proof = await proofStateAtCommit(cwd, revision);
  } catch {
    process.stderr.write(`[thwip] COMMIT_UNREADABLE ${revision}\n`);
    return 1;
  }
  const { message } = proof;
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
  const { state } = proof;
  if (state === "stale") {
    process.stderr.write(
      "[thwip] PROOF_STALE this proof names a different tree, which is what a rebase leaves behind; run thwip run to sign again\n",
    );
    return 1;
  }
  process.stderr.write(`[thwip] proof parses; signer key ${carrier.envelope.signatures[0]!.keyid}\n`);
  return 0;
}

const SESSION_PATH = join(homedir(), ".config", "thwip", "session.json");

/** RFC 8628 device authorization flow against the thwip control plane. */
async function cmdLogin(argv: string[]): Promise<number> {
  const config = await loadConfig();
  const endpoint = normalizeSessionEndpoint(
    flag(argv, "--endpoint") ?? config.endpoint ?? process.env["THWIP_ENDPOINT"] ?? DEFAULT_ENDPOINT,
  );
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
      await writeStoredSession(SESSION_PATH, { endpoint, token: body.access_token });
      process.stderr.write(`[thwip] signed in; session stored at ${SESSION_PATH}\n`);
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

async function apiAuthHeader(endpoint: string): Promise<string | null> {
  const session = await readStoredSession(SESSION_PATH);
  if (session !== null) {
    const normalized = normalizeSessionEndpoint(endpoint);
    if (normalizeSessionEndpoint(session.endpoint) !== normalized) {
      throw new Error(`the saved user session belongs to ${session.endpoint}, not ${normalized}; sign in to that endpoint first`);
    }
    return `Bearer ${session.token}`;
  }
  const adminToken = process.env["THWIP_ADMIN_TOKEN"];
  return adminToken ? `Bearer ${adminToken}` : null;
}

/** Init uses only a user session minted by the exact endpoint it will call. */
async function initUserAuthHeader(endpoint: string): Promise<string | null> {
  const normalized = normalizeSessionEndpoint(endpoint);
  const session = await readStoredSession(SESSION_PATH);
  if (session === null) return null;
  if (normalizeSessionEndpoint(session.endpoint) !== normalized) {
    throw new Error(`the saved user session belongs to ${session.endpoint}, not ${normalized}; run thwip login --endpoint ${normalized}`);
  }
  return `Bearer ${session.token}`;
}

async function cmdPolicyDigest(): Promise<number> {
  const cwd = process.cwd();
  const config = await loadConfig();
  const endpoint = normalizeSessionEndpoint(config.endpoint ?? process.env["THWIP_ENDPOINT"] ?? DEFAULT_ENDPOINT);
  const project = await loadProjectConfigAtHead(cwd, endpoint, await apiAuthHeader(endpoint));
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

async function planInitConfig(root: string, requiredArg: string | null, profileArg: string | null) {
  if (requiredArg === null) {
    if (profileArg !== null) throw new Error("--profile requires --required");
    return { result: "not-requested" as const, apply: async () => "not-requested" as const };
  }
  const required = requiredArg.split(",").map((value) => value.trim()).filter(Boolean);
  const profile = profileArg ?? "fast";
  if (required.length === 0 || required.some((id) => !/^[A-Za-z0-9_.:-]+$/.test(id))) {
    throw new Error("--required must contain comma-separated suite ids");
  }
  if (!/^[A-Za-z0-9_-]+$/.test(profile)) throw new Error("--profile is invalid");

  const path = join(root, "thwip.yaml");
  const { lstat, open } = await import("node:fs/promises");
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`${path} is not a regular file; init will not replace it`);
    }
    return { result: "unchanged" as const, apply: async () => "unchanged" as const };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const yaml = [
    "# thwip.yaml — repository-specific overrides",
    `# docs: ${DEFAULT_ENDPOINT}/faq`,
    "version: 1",
    `profile: ${profile}`,
    "required:",
    ...required.map((id) => `  - ${id}`),
    "",
  ].join("\n");
  return {
    result: "created" as const,
    apply: async () => {
      const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o644);
      try {
        await handle.writeFile(yaml);
        await handle.sync();
      } finally {
        await handle.close();
      }
      return "created" as const;
    },
  };
}

function promptFactsFor(
  context: { githubName: string; defaultBranch: string },
  state: InitLiveState,
  key: SigningKeyRead,
): InitPromptFacts {
  const repositoryState: InitPromptFacts["repositoryState"] =
    state.kind === "signed-out"
      ? "unreadable"
      : state.kind === "not-visible"
        ? "not-visible"
        : state.kind;
  const repositoryDetail =
    state.kind === "unreadable" || state.kind === "signed-out"
      ? state.detail
      : state.kind === "not-ready"
        ? state.reasons.join("; ")
        : undefined;
  return {
    githubName: context.githubName,
    defaultBranch: context.defaultBranch,
    repositoryState,
    signedIn: state.kind !== "signed-out",
    keyState: key.kind === "unread" ? "unreadable" : key.kind,
    ...(repositoryDetail === undefined ? {} : { repositoryDetail }),
    ...(key.kind === "unread" ? { keyDetail: key.detail } : {}),
  };
}

/**
 * The one setup and refresh command. Remote calls are GET-only. Local writes
 * happen only after the user session, GitHub origin, project incarnation, and
 * default-branch readiness all agree.
 */
async function cmdInit(argv: string[]): Promise<number> {
  let context;
  try {
    context = await readInitRepositoryContext(process.cwd(), gitInitRead);
  } catch (error) {
    process.stderr.write(`[thwip] init stopped: ${failureDetail(error)}\n`);
    return EXIT.setupInvalid;
  }
  const config = await loadConfig();
  const endpoint = normalizeSessionEndpoint(config.endpoint ?? process.env["THWIP_ENDPOINT"] ?? DEFAULT_ENDPOINT);
  let auth: string | null;
  try {
    auth = await initUserAuthHeader(endpoint);
  } catch (error) {
    process.stderr.write(`[thwip] init stopped: ${failureDetail(error)}\n`);
    return EXIT.authRequired;
  }

  let githubUserId = "";
  if (auth !== null) {
    try {
      githubUserId = (await resolveGithubIdentity(config)).id;
    } catch (error) {
      process.stderr.write(`[thwip] init stopped: ${failureDetail(error)}\n`);
      return EXIT.authRequired;
    }
  }
  const live = await observeInitState({ endpoint, authHeader: auth, githubUserId, context, fetch });
  let key: SigningKeyRead = { kind: "unread", detail: "sign in before checking the signing key" };
  if (auth !== null) key = await readSigningKey(context.root);

  let guidance:
    | { state: "blocked" }
    | {
        state: "current" | "changed";
        paths: readonly string[];
        claudeCompatibility: "managed-file" | "agents-symlink";
        cliCommand: string;
      } = { state: "blocked" };
  let configResult: "not-requested" | "unchanged" | "created" = "not-requested";

  if (mayWriteGuidance(live)) {
    const configPlan = await planInitConfig(
      context.root,
      flag(argv, "--required") ?? null,
      flag(argv, "--profile") ?? null,
    );
    const sourceCheckout = findCliCheckout(context.root, existsSync, (path) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    });
    const cliCommand = sourceCheckout === context.root ? "pnpm -w thwip" : NPX_COMMAND;
    const result = await writeAgentGuidance(context.root, queueInstructions({ cliCommand }));
    guidance = {
      state: result.changed.length === 0 ? "current" : "changed",
      paths: result.changed,
      claudeCompatibility: result.claudeCompatibility,
      cliCommand,
    };
    configResult = await configPlan.apply();

  }

  process.stdout.write(initReport(promptFactsFor(context, live, key), { guidance, config: configResult }) + "\n");
  if (live.kind === "signed-out") return EXIT.authRequired;
  if (live.kind === "not-visible") return EXIT.permission;
  if (live.kind === "unreadable") return EXIT.unavailable;
  if (key.kind === "missing" || key.kind === "unregistered") return EXIT.authRequired;
  if (key.kind === "unread") return EXIT.unavailable;
  return EXIT.ok;
}

/**
 * `thwip ship`. The loop and every decision it makes are tested in ship.ts and
 * ship-io.ts; this supplies only the ports that touch git, gh, and the queue.
 */
async function cmdShip(argv: string[]): Promise<number> {
  const cwd = process.cwd();
  const config = await loadConfig();
  const endpoint = normalizeSessionEndpoint(config.endpoint ?? process.env["THWIP_ENDPOINT"] ?? DEFAULT_ENDPOINT);
  const jsonEvents = argv.includes("--json-events");
  const wait = argv.includes("--wait");
  const draft = argv.includes("--draft");
  const useQueue = !draft && !argv.includes("--no-queue");
  const auth = await apiAuthHeader(endpoint);
  if (auth === null) {
    process.stderr.write("not signed in: run `thwip login`\n");
    return EXIT.authRequired;
  }

  const project = await loadProjectConfigAtHead(cwd, endpoint, auth);
  const repositoryId = project.policy.repositoryId;
  // The queue is per base branch, and the branch a pull request targets is what
  // GitHub reports, not something the policy pins.
  const baseRef = "refs/heads/" + (await shipTargetBranch(cwd));

  const initialPullRequest = await currentPullRequest(cwd);
  // A ready pull request must pass through the PR step before draft shipping is
  // complete. Reporting it as present here would let the planner stop without
  // asking GitHub to convert it.
  let prNumber: number | null =
    pullRequestCommand(initialPullRequest, draft) === null ? (initialPullRequest?.number ?? null) : null;
  let headProof: "accepted" | "missing" | "stale" = "missing";
  // Which attempt the queue is running, read from the snapshot each time it is
  // observed. A claim names the attempt it answers, and claiming under a stale
  // one is the mismatch the service refuses.
  let attemptId: string | null = null;

  // A device announces itself with the fingerprint of the key it signs with,
  // which costs a disk read and a call to GitHub. Read once and kept, because
  // ship announces on every loop turn it spends waiting.
  const deviceOnlyProfile =
    project.policy.securityProfile === "fresh" || project.policy.securityProfile === "audited";
  let deviceKeyId: string | null = null;
  const deviceKey = async (): Promise<string> => {
    if (deviceKeyId !== null) return deviceKeyId;
    const config = await loadConfig();
    const identity = await resolveGithubIdentity(config);
    deviceKeyId = (await requireRegisteredKey(cwd, config, identity.login)).fingerprint;
    return deviceKeyId;
  };

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
      const active = snapshot.body["activeAttemptId"];
      const last = mine?.["lastAttemptId"];
      attemptId = typeof active === "string" ? active : typeof last === "string" ? last : null;
      return {
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
      const { branch } = await readGitState(cwd);
      const attempt = await tryGit(cwd, ["push", "--set-upstream", "origin", `HEAD:refs/heads/${branch}`]);
      const plan = planPush(attempt, await readTips(cwd, branch));

      if (plan.kind === "done") return {};
      if (plan.kind === "stop") {
        process.stderr.write(`[thwip] ${plan.detail}\n`);
        return { reasonCode: plan.reasonCode };
      }

      process.stderr.write(`[thwip] ${plan.why}\n`);
      const forced = await tryGit(cwd, forceArgs(plan));
      if (forced.ok) return {};
      // The lease named one commit and the remote holds another, so somebody
      // pushed while this ran. That is theirs to keep.
      process.stderr.write(`[thwip] ${failureDetail({ stderr: forced.stderr })}\n`);
      return { reasonCode: "PUSH_REJECTED" };
    },
    async openOrUpdatePullRequest() {
      // gh handles the difference between opening and updating, and is already a
      // prerequisite of this workflow.
      //
      // Its failure used to be discarded. gh writes what it refused on stderr,
      // and that sentence is the only thing that tells a developer whether they
      // are missing a token, a base branch, or a commit — so it is reported.
      const current = await currentPullRequest(cwd);
      const command = pullRequestCommand(current, draft);
      const operation = command === null ? Promise.resolve("") : run("gh", [...command], cwd);
      const failure = await operation.then(
        () => null,
        (error: unknown) => failureDetail(error),
      );
      const observed = await currentPullRequest(cwd);
      prNumber = observed?.number ?? null;
      if (observed === null || (draft && !observed.isDraft)) {
        process.stderr.write(`[thwip] gh left no ${draft ? "draft " : ""}pull request: ${failure ?? "no error reported"}\n`);
        return { pullRequestNumber: null, reasonCode: "PR_NOT_OPENED" };
      }
      return { pullRequestNumber: prNumber };
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
    async announcePresence() {
      // Only `fresh` and `audited` run the turn on this machine, and only they
      // read presence. Under `fast` or `remote` there is nothing to announce,
      // and a row per shipping developer would be a row nothing ever reads.
      if (!deviceOnlyProfile) return {};
      const key = await deviceKey();
      const outcome = await realHeartbeat(endpoint, auth, repositoryId, key)();
      if (outcome.ok) return {};
      return {
        refusal:
          outcome.status === 0
            ? `could not reach ${endpoint} to say this machine is here; the queue cannot offer a turn to a machine it cannot see`
            : `${endpoint} refused this machine's presence (${outcome.status}) for device ${key}; the queue will not offer a turn until it accepts one`,
      };
    },
    async awaitTurn() {
      await sleep(5000);
      const result = await call("POST", queuePath("/tick"));
      return result.status >= 500 ? { reasonCode: "SERVICE_UNAVAILABLE" } : {};
    },
    async executeTurn() {
      // Under fast and remote the queue runs the turn itself, and this device
      // only has to stay present while it does. Under fresh and audited the
      // turn is this machine's work, and nothing else will do it.
      if (project.policy.securityProfile !== "fresh" && project.policy.securityProfile !== "audited") {
        await sleep(5000);
        return {};
      }
      if (attemptId === null) {
        // The snapshot names the attempt. Without one there is nothing to claim
        // against, and guessing would claim against whatever the queue moves to
        // next.
        await sleep(5000);
        return {};
      }
      const result = await executeFreshTurn({
        cwd,
        endpoint,
        auth,
        repositoryId,
        baseRef,
        attemptId,
        config: await loadConfig(),
        emit: (text) => process.stdout.write(text + "\n"),
      });
      return result.ok ? {} : { reasonCode: result.reasonCode };
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

/**
 * The `fresh` half of a turn: claim the offer, check what thwip signed, run the
 * candidate it names, and send back a signed receipt.
 *
 * Everything that decides anything lives in fresh-turn.ts and is tested there.
 * This assembles the ports: the queue over HTTP, git for the candidate, the
 * project's own pipeline for the suites, and this machine's enrolled key for
 * the signature.
 */
async function executeFreshTurn(input: {
  readonly cwd: string;
  readonly endpoint: string;
  readonly auth: string;
  readonly repositoryId: string;
  readonly baseRef: string;
  readonly attemptId: string;
  readonly config: CliConfig;
  readonly emit: (text: string) => void;
}): Promise<FreshTurnResult> {
  const identity = await resolveGithubIdentity(input.config);
  const key = await requireRegisteredKey(input.cwd, input.config, identity.login);

  const post = async (suffix: string, body: unknown) => {
    const res = await fetch(
      `${input.endpoint}/v1/queue/${input.repositoryId}${suffix}?ref=${encodeURIComponent(input.baseRef)}`,
      {
        method: "POST",
        headers: { authorization: input.auth, "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    return { status: res.status, body: (await res.json().catch(() => null)) as unknown };
  };

  const result = await runFreshTurn(
    { deviceKeyId: key.fingerprint, repositoryId: input.repositoryId, attemptId: input.attemptId },
    {
      claim: () => post("/claim", { attemptId: input.attemptId, deviceKeyId: key.fingerprint }),
      async publishedKeys() {
        // The same public endpoint `thwip verify-chain` reads. A key set that
        // cannot be read means nothing can be checked, which parseKeySet says
        // by returning nothing rather than by handing back an empty set.
        try {
          const res = await fetch(`${input.endpoint}/.well-known/thwip-keys`);
          if (!res.ok) return null;
          return parseKeySet(await res.json().catch(() => null));
        } catch {
          return null;
        }
      },
      materialize: (candidate) =>
        materializeCandidate({
          repoDir: input.cwd,
          candidateSha: candidate.candidateSha,
          candidateTreeOid: candidate.candidateTreeOid,
        }),
      runSuites: (workspace, suites) =>
        runCandidateSuites(workspace, suites, input.endpoint, input.auth, input.emit),
      signReceipt: (receipt) => signReceipt(receipt, key.privateKeyPath),
      submit: (receipt) => post("/receipt", receipt),
      now: () => new Date().toISOString(),
    },
  );

  input.emit(
    result.ok
      ? `[thwip] the candidate ${result.candidateTreeOid} passed here and the receipt was accepted`
      : `[thwip] ${result.reasonCode}: ${result.detail}`,
  );
  return result;
}

/**
 * Run the required suites in the candidate worktree.
 *
 * The pipeline comes from the candidate's own tree, because that is the
 * pipeline the merge would land. Only the suites the assignment requires are
 * run: a receipt is about those, and running more would spend a developer's
 * machine on work the queue is not waiting for.
 */
async function runCandidateSuites(
  workspace: CandidateWorkspace,
  required: readonly string[],
  endpoint: string,
  auth: string,
  emit: (text: string) => void,
): Promise<ReceiptSuiteOutcome[]> {
  const project = await loadProjectConfigAtHead(workspace.dir, endpoint, auth);
  const def = project.pipeline;
  const wanted = def.suites.filter((s) => required.includes(s.id));
  const absent = required.filter((name) => !def.suites.some((s) => s.id === name));
  if (absent.length > 0) {
    // Said here rather than left for the service to refuse, so the developer
    // reads it beside the run rather than after it.
    emit(`[thwip] the candidate's pipeline defines no suite named ${absent.join(", ")}`);
  }

  emit(`[thwip] running ${wanted.map((s) => s.id).join(", ")} against candidate ${workspace.candidateSha}`);
  const results =
    def.runner === "dagger"
      ? await (async () => {
          const { ensureDagger, requireContainerRuntime, runDaggerSuites } = await import("./dagger.js");
          await requireContainerRuntime();
          const bin = await ensureDagger(def.daggerVersion!);
          return runDaggerSuites({ bin, module: def.module!, suites: wanted.map((s) => s.id), cwd: workspace.dir });
        })()
      : await runSuites({ ...def, suites: wanted }, workspace.dir);

  return results.map((r) => ({ name: r.id, outcome: r.status === "passed" ? "passed" : "failed" }));
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

/** The remote's current default branch, independent of the current pull request. */
async function defaultBranch(cwd: string): Promise<string> {
  const remote = await gitInitRead(["ls-remote", "--symref", "origin", "HEAD"], cwd);
  const branch = /^ref:\s+refs\/heads\/([^\s]+)\s+HEAD$/m.exec(remote)?.[1] ?? null;
  if (branch === null || branch.length === 0) throw new Error("could not read origin's current default branch");
  return branch;
}

/** Preserve an existing pull request's target; use remote HEAD before one exists. */
async function shipTargetBranch(cwd: string): Promise<string> {
  try {
    const branch = (await run("gh", ["pr", "view", "--json", "baseRefName", "-q", ".baseRefName"], cwd)).trim();
    if (branch.length > 0) return branch;
  } catch {
    // A branch without a pull request targets the repository default.
  }
  return defaultBranch(cwd);
}

/** The open pull request for this branch, including GitHub's draft state. */
async function currentPullRequest(cwd: string): Promise<OpenPullRequest | null> {
  try {
    return openPullRequest(await run("gh", ["pr", "view", "--json", "number,state,isDraft"], cwd));
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
  const parsed = planQueueCommand(argv, { nonce: crypto.randomUUID() });
  if (!parsed.ok) {
    process.stderr.write(parsed.message + "\n");
    return parsed.exitCode;
  }
  const endpoint = process.env["THWIP_ENDPOINT"] ?? DEFAULT_ENDPOINT;
  const auth = await apiAuthHeader(endpoint);
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

  // The head of the pull request being queued, which is what the entry binds.
  // Read from GitHub rather than from this machine, because the pull request
  // named on the command line is often not the branch checked out here.
  let body = parsed.plan.body;
  if (body?.["headSha"] === "{headSha}") {
    const pr = flag(argv, "--pr") ?? "";
    const headSha = await run(
      "gh",
      ["pr", "view", pr, "--repo", repo, "--json", "headRefOid", "-q", ".headRefOid"],
      process.cwd(),
    )
      .then((out) => out.trim())
      .catch(() => "");
    if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(headSha)) {
      process.stderr.write(
        `cannot read the head of ${repo}#${pr} from GitHub; pass --head-sha <oid> or check that gh is signed in\n`,
      );
      return EXIT.setupInvalid;
    }
    body = { ...body, headSha };
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
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  process.stdout.write((await res.text()) + "\n");
  return res.ok ? 0 : res.status === 403 ? EXIT.permission : EXIT.unavailable;
}

/**
 * `thwip queue doctor`. What it asks for and what it makes of the answers live
 * in queue-doctor.ts; this performs the reads and stops asking once a probe
 * makes the ones below it meaningless.
 */
async function cmdQueueDoctor(argv: string[]): Promise<number> {
  const parsed = planQueueCommand(["doctor", ...argv], { nonce: crypto.randomUUID() });
  if (!parsed.ok) {
    process.stderr.write(parsed.message + "\n");
    return parsed.exitCode;
  }
  const repo = flag(argv, "--repo") ?? "";
  const ref = "refs/heads/" + (flag(argv, "--branch") ?? (await defaultBranch(process.cwd())));
  const allowUnread = argv.includes("--allow-unread");
  const endpoint = process.env["THWIP_ENDPOINT"] ?? DEFAULT_ENDPOINT;
  const auth = await apiAuthHeader(endpoint);
  if (auth === null) {
    process.stderr.write("not signed in: run `thwip login`\n");
    return EXIT.authRequired;
  }

  const observations: DoctorObservation[] = [];
  let repositoryId: string | null = null;

  for (const probe of doctorProbes({ repo, ref, events: argv.includes("--explain") ? 25 : 5 })) {
    if (probe.path.includes("{repositoryId}") && repositoryId === null) break;
    let path = repositoryId === null ? probe.path : probe.path.replaceAll("{repositoryId}", repositoryId);
    if (probe.requiresAdmin && observations[0]?.body?.["projectId"] !== undefined) {
      path += `?projectId=${encodeURIComponent(String(observations[0].body?.["projectId"]))}`;
    }
    // A section that cannot be read is a fact to report, so a network failure
    // is recorded as status 0 rather than ending the command.
    const answer: Pick<DoctorObservation, "status" | "body"> = await fetch(endpoint + path, {
      headers: { authorization: auth },
    })
      .then(async (res) => ({
        status: res.status,
        body: (await res.json().catch(() => null)) as Record<string, unknown> | null,
      }))
      .catch(() => ({ status: 0, body: null }));
    observations.push({ section: probe.section, ...answer });
    if (probe.section === "repository" && answer.status === 200) {
      const id = answer.body?.["repositoryId"];
      repositoryId = typeof id === "string" ? id : null;
    }
  }

  const report = reportDoctor(observations, { repo, ref, allowUnread });
  if (argv.includes("--json")) {
    process.stdout.write(
      JSON.stringify({
        repo,
        ref,
        sections: report.sections.map((section) => ({
          section: section.section,
          status: section.status,
          reasonCode: section.reasonCode,
          facts: section.facts,
        })),
        unread: report.unread,
      }) + "\n",
    );
  } else {
    process.stdout.write(report.lines.join("\n") + "\n");
  }
  return report.exitCode;
}

/**
 * `thwip doctor`. Runs the reads the other commands already make, in one pass,
 * and answers once.
 *
 * The three remote sections are `thwip queue doctor`'s own probes. The session,
 * the signing key and the policy are the reads behind `thwip keys status` and
 * `thwip policy digest`. Nothing is asked for twice and nothing new is invented,
 * so a sentence a developer reads here is the sentence they read there.
 */
async function cmdDoctor(argv: string[]): Promise<number> {
  const cwd = process.cwd();
  const allowUnread = argv.includes("--allow-unread");
  const config = await loadConfig();
  const endpoint = normalizeSessionEndpoint(config.endpoint ?? process.env["THWIP_ENDPOINT"] ?? DEFAULT_ENDPOINT);
  const explicitRepo = flag(argv, "--repo");
  const explicitBranch = flag(argv, "--branch");
  const { repo, branch } = await resolveDoctorTarget(cwd, gitInitRead, {
    ...(explicitRepo === undefined ? {} : { repo: explicitRepo }),
    ...(explicitBranch === undefined ? {} : { branch: explicitBranch }),
  });
  const ref = "refs/heads/" + branch;
  const auth = await apiAuthHeader(endpoint);

  const local: LocalReads = {
    cli: await readCli(cwd),
    session: auth === null ? "signed-out" : "signed-in",
    signingKey: await readSigningKey(cwd),
    policy: await readPolicy(cwd, endpoint, auth),
  };

  // A signed-out session cannot read any of the three remote sections, and
  // asking anyway would report three unreadable things when the one that
  // matters is already named.
  const observations: DoctorObservation[] = auth === null ? [] : await probeRemote(endpoint, auth, repo, ref);

  const report = runDoctor({ local, observations, repo, ref, allowUnread });
  if (argv.includes("--json")) {
    process.stdout.write(
      JSON.stringify(
        {
          repo,
          ref,
          checks: report.checks.map((one) => ({
            check: one.check,
            status: one.status,
            reasonCode: one.reasonCode,
            facts: one.facts,
          })),
        },
        null,
        2,
      ) + "\n",
    );
  } else {
    process.stdout.write(report.lines.join("\n") + "\n");
  }
  return report.exitCode;
}

/** The build identity and checkout relationship already enforced at startup. */
async function readCli(cwd: string): Promise<CliRead> {
  const identity = await runningBuild();
  const checkoutRoot = findCliCheckout(cwd, existsSync, (path) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  });
  return {
    version: identity.version,
    commit: identity.commit,
    path: identity.mainPath,
    checkoutRoot,
    checkoutMatch:
      buildMismatchFailure({
        runningMainPath: identity.mainPath,
        checkoutRoot,
        identity,
      }) === null,
  };
}

/** The key that would sign here, and whether GitHub attributes it to anybody. */
async function readSigningKey(cwd: string): Promise<SigningKeyRead> {
  try {
    const config = await loadConfig();
    const key = await discoverSigningKey(cwd, config.signingKey);
    if (!key) return { kind: "missing" };
    const identity = await resolveGithubIdentity(config);
    const listed = await githubSigningKeys(identity.login);
    const fingerprints = await Promise.all(listed.map((k) => fingerprintOfPublicKey(k.key)));
    const registered = fingerprints.includes(key.fingerprint);
    return {
      kind: registered ? "registered" : "unregistered",
      fingerprint: key.fingerprint,
      path: key.privateKeyPath,
    };
  } catch (error) {
    return { kind: "unread", detail: failureDetail(error) };
  }
}

/** What a proof made here would have to cover, from the policy in force. */
async function readPolicy(cwd: string, endpoint: string, auth: string | null): Promise<PolicyRead> {
  try {
    const project = await loadProjectConfigForRun(cwd, endpoint, auth);
    return {
      kind: "read",
      policyDigest: project.policyDigest,
      pipelineDigest: project.pipelineDigest,
      version: project.policy.version,
      requiredSuites: project.policy.pipeline.requiredSuites,
      configSource: project.configSource,
    };
  } catch (error) {
    return { kind: "unread", detail: failureDetail(error) };
  }
}

/** The three sections `thwip queue doctor` reads, from the same probe list. */
async function probeRemote(
  endpoint: string,
  auth: string,
  repo: string,
  ref: string,
): Promise<DoctorObservation[]> {
  const observations: DoctorObservation[] = [];
  let repositoryId: string | null = null;
  let projectId: string | null = null;
  for (const probe of doctorProbes({ repo, ref, events: 5 })) {
    if (probe.path.includes("{repositoryId}") && repositoryId === null) break;
    let path = repositoryId === null ? probe.path : probe.path.replaceAll("{repositoryId}", repositoryId);
    if (probe.requiresAdmin && projectId !== null) path += `?projectId=${encodeURIComponent(projectId)}`;
    const answer: Pick<DoctorObservation, "status" | "body"> = await fetch(endpoint + path, {
      headers: { authorization: auth },
    })
      .then(async (res) => ({
        status: res.status,
        body: (await res.json().catch(() => null)) as Record<string, unknown> | null,
      }))
      .catch(() => ({ status: 0, body: null }));
    observations.push({ section: probe.section, ...answer });
    if (probe.section === "repository" && answer.status === 200) {
      const id = answer.body?.["repositoryId"];
      repositoryId = typeof id === "string" ? id : null;
      const selectedProject = answer.body?.["projectId"];
      projectId = typeof selectedProject === "string" ? selectedProject : null;
    }
  }
  return observations;
}

/** What this repository is called on GitHub, from the origin remote. */
async function originName(cwd: string): Promise<string | null> {
  try {
    const url = await git(["config", "--get", "remote.origin.url"], cwd);
    return githubNameFromOrigin(url);
  } catch {
    return null;
  }
}

/**
 * Queue enrolment remains a separate human-guided prompt. `thwip init` owns
 * local agent guidance and this command never writes it.
 */
async function cmdQueueSetup(argv: string[]): Promise<number> {
  const cwd = process.cwd();
  const repo = flag(argv, "--repo") ?? (await originName(cwd)) ?? "this repository";
  process.stdout.write(queueSetupPrompt(repo) + "\n");
  return 0;
}

/**
 * `thwip queue work --watch`. Validation and the watch loop itself live in
 * queue-commands.ts and queue-work.ts; this only resolves identity, the
 * registered signing key (its fingerprint is the device key id a heartbeat
 * carries — the same key `thwip run` signs proofs with), and the repository
 * id, then wires a real heartbeat and the process's own interrupt signals
 * into the loop.
 */
async function cmdQueueWork(argv: string[]): Promise<number> {
  const parsed = planQueueCommand(["work", ...argv], { nonce: crypto.randomUUID() });
  if (!parsed.ok) {
    process.stderr.write(parsed.message + "\n");
    return parsed.exitCode;
  }
  const repo = flag(argv, "--repo") ?? "";
  const cwd = process.cwd();
  const endpoint = process.env["THWIP_ENDPOINT"] ?? DEFAULT_ENDPOINT;
  const auth = await apiAuthHeader(endpoint);
  if (auth === null) {
    process.stderr.write("not signed in: run `thwip login`\n");
    return EXIT.authRequired;
  }

  const config = await loadConfig();
  const identity = await resolveGithubIdentity(config);
  const key = await requireRegisteredKey(cwd, config, identity.login);
  const repositoryId = await resolveRepositoryId(endpoint, auth, repo);
  if (repositoryId === null) {
    process.stderr.write(`cannot resolve ${repo}\n`);
    return EXIT.setupInvalid;
  }

  const controller = new AbortController();
  const onSignal = () => controller.abort();
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    return await runQueueWork({
      repo,
      ports: {
        heartbeat: realHeartbeat(endpoint, auth, repositoryId, key.fingerprint),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        signal: controller.signal,
      },
      emit: (text) => process.stdout.write(text + "\n"),
    });
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

async function dispatchCli(invocation: CommandInvocation): Promise<number> {
  switch (invocation.command) {
    case "run":
      return cmdRun([...invocation.argv]);
    case "ship":
      return cmdShip([...invocation.argv]);
    case "queue": {
      const [subcommand, ...rest] = invocation.argv;
      if (subcommand === "work") return cmdQueueWork(rest);
      if (subcommand === "doctor") return cmdQueueDoctor(rest);
      if (subcommand === "setup") return cmdQueueSetup(rest);
      return cmdQueue([...invocation.argv]);
    }
    case "login":
      return cmdLogin([...invocation.argv]);
    case "init":
      return cmdInit([...invocation.argv]);
    case "verify":
      return cmdVerifyLocal([...invocation.argv]);
    case "verify-chain":
      return cmdVerifyChain([...invocation.argv]);
    case "keys-status":
      return cmdKeysStatus();
    case "policy-digest":
      return cmdPolicyDigest();
    case "version":
      process.stdout.write(versionReport(await runningBuild()));
      return 0;
    case "doctor":
      return cmdDoctor([...invocation.argv]);
  }
}

/**
 * What this build is, read from the stamp written beside it at build time.
 * Resolved through `import.meta.url`, so it names the file node is executing
 * rather than whatever checkout the shell happened to be in.
 */
async function runningBuild(): Promise<BuildIdentity> {
  const mainPath = fileURLToPath(import.meta.url);
  const stamp = await readFile(join(dirname(mainPath), "build-stamp.json"), "utf8").catch(() => null);
  return parseBuildStamp(stamp, mainPath);
}

/**
 * Stop when the build that is running did not come from the checkout it is
 * standing in. Continuing after a warning still lets an agent prove and ship
 * with code from another worktree. The failure names the checkout-local root
 * command; deliberate low-level Git remains untouched.
 */
async function rejectForeignBuild(): Promise<boolean> {
  const identity = await runningBuild();
  const failure = buildMismatchFailure({
    runningMainPath: identity.mainPath,
    checkoutRoot: findCliCheckout(process.cwd(), existsSync, (path) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    }),
    identity,
  });
  if (failure === null) return false;
  process.stderr.write(failure + "\n");
  return true;
}

async function main(): Promise<void> {
  // Init is deliberately allowed through npx in a checkout that builds its own
  // CLI. It only performs read-only remote probes and bounded local setup. All
  // proof, signing, and shipping commands keep the strict build identity gate.
  if (!setupCommandMayUseForeignBuild(process.argv.slice(2)) && (await rejectForeignBuild())) {
    process.exitCode = EXIT.setupInvalid;
    return;
  }
  const code = await runCliProcess(process.argv.slice(2), {
    dispatch: dispatchCli,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  });
  // `process.exit` does not wait for an asynchronous stdout write to drain.
  // A queue doctor document larger than the pipe buffer was therefore cut at
  // exactly 65,536 bytes when it was piped to jq. Leaving the event loop sets
  // the same status while allowing stdout and stderr to finish first.
  process.exitCode = code;
}

/**
 * A rejection that never reached the command's own await chain still has to end
 * the way every other failure ends. The interrupt handler runs detached, so this
 * is the only place that can catch what it throws.
 */
process.on("unhandledRejection", (error) => {
  const failure = classifyFailure(error);
  process.stderr.write(failure.text + "\n");
  process.exit(failure.exitCode);
});

void main();
