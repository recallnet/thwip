#!/usr/bin/env node
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
import { verifySshSignature } from "@thwip/sshsig";
import {
  amendMessage,
  currentTree,
  freezeSubject,
  git,
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
import { developerSetupPrompt, queueInstructions, queueSetupPrompt, withQueuePointer } from "@thwip/prompts";
import { planQueueCommand } from "./queue-commands.js";
import { installInterruptHandler, readGitState, runShip, type ShipPorts } from "./ship-io.js";
import { EXIT } from "./queue-exit.js";
import { attachTrailer, buildStatement, signStatement } from "./proof.js";
import { acquireRunLease, httpLeasePorts } from "./run-lease.js";
import { type CommandInvocation } from "./cli-args.js";
import { classifyFailure, failureDetail, runCliProcess } from "./cli-failure.js";
import { forceArgs, planPush } from "./push-plan.js";
import { openPullRequestNumber } from "./pull-request.js";
import {
  buildMismatchFailure,
  findCliCheckout,
  parseBuildStamp,
  versionReport,
  type BuildIdentity,
} from "./build-identity.js";
import { doctorProbes, reportDoctor, type DoctorObservation } from "./queue-doctor.js";
import { runDoctor, type LocalReads, type PolicyRead, type SigningKeyRead } from "./doctor.js";
import { cmdVerifyChain, parseKeySet } from "./verify-chain.js";
import { materializeCandidate, type CandidateWorkspace } from "./candidate.js";
import { signReceipt, type ReceiptSuiteOutcome } from "./receipt.js";
import { runFreshTurn, type FreshTurnResult } from "./fresh-turn.js";
import { flag } from "./cli-flags.js";
import { realHeartbeat, runQueueWork } from "./queue-work.js";
import { installPushWarning } from "./push-hook.js";

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
  const project = await loadProjectConfigForRun(cwd, endpoint, await apiAuthHeader());
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
    httpLeasePorts(endpoint, await apiAuthHeader()),
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

async function cmdSetup(argv: string[]): Promise<number> {
  if (!argv.includes("--install-push-warning")) {
    process.stdout.write(developerSetupPrompt() + "\n");
    return 0;
  }

  const result = await installPushWarning(process.cwd());
  if (result.status === "refused") {
    process.stderr.write(`[thwip] ${result.detail}: ${result.path}\n`);
    return 1;
  }
  process.stderr.write(
    `[thwip] ${result.status} non-blocking push warning at ${result.path}\n` +
      "[thwip] it applies to every linked worktree; remove that marked hook to undo it\n",
  );
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
      const created = await run("gh", ["pr", "create", "--fill"], cwd).then(
        () => null,
        (error: unknown) => failureDetail(error),
      );
      prNumber = await currentPrNumber(cwd);
      if (prNumber === null) {
        process.stderr.write(`[thwip] gh pr create opened nothing: ${created ?? "no error reported"}\n`);
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

/** The open pull request for this branch, or nothing. See pull-request.ts. */
async function currentPrNumber(cwd: string): Promise<number | null> {
  try {
    return openPullRequestNumber(await run("gh", ["pr", "view", "--json", "number,state"], cwd));
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
  const ref = "refs/heads/" + (flag(argv, "--branch") ?? "main");
  const allowUnread = argv.includes("--allow-unread");
  const endpoint = process.env["THWIP_ENDPOINT"] ?? "https://thwip.recall.net";
  const auth = await apiAuthHeader();
  if (auth === null) {
    process.stderr.write("not signed in: run `thwip login`\n");
    return EXIT.authRequired;
  }

  const observations: DoctorObservation[] = [];
  let repositoryId: string | null = null;

  for (const probe of doctorProbes({ repo, ref, events: argv.includes("--explain") ? 25 : 5 })) {
    if (probe.path.includes("{repositoryId}") && repositoryId === null) break;
    const path = repositoryId === null ? probe.path : probe.path.replaceAll("{repositoryId}", repositoryId);
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
    process.stdout.write(JSON.stringify({ repo, ref, sections: observations, unread: report.unread }) + "\n");
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
  const endpoint = process.env["THWIP_ENDPOINT"] ?? "https://thwip.recall.net";
  const repo = flag(argv, "--repo") ?? (await originName(cwd)) ?? "";
  const ref = "refs/heads/" + (flag(argv, "--branch") ?? "main");
  const auth = await apiAuthHeader();

  const local: LocalReads = {
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
    const project = await loadProjectConfigAtHead(cwd, endpoint, auth);
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
  for (const probe of doctorProbes({ repo, ref, events: 5 })) {
    if (probe.path.includes("{repositoryId}") && repositoryId === null) break;
    const path = repositoryId === null ? probe.path : probe.path.replaceAll("{repositoryId}", repositoryId);
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
  return observations;
}

/** What this repository is called on GitHub, from the origin remote. */
async function originName(cwd: string): Promise<string | null> {
  try {
    const url = await git(["config", "--get", "remote.origin.url"], cwd);
    return /github\.com[:/]([^/]+\/[^/.]+)/.exec(url)?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * How far repository activation has got. Enrolment owns it, so it is read from
 * the bootstrap route. A repository that has not been enrolled yet is
 * `configured`, which is what the file should say about it.
 */
async function queueFacts(
  endpoint: string,
  repo: string,
): Promise<{ activationState: "configured" | "observe" | "canary" | "enforced" }> {
  const fallback = { activationState: "configured" } as const;
  const auth = await apiAuthHeader();
  if (auth === null) return fallback;
  const repositoryId = await resolveRepositoryId(endpoint, auth, repo);
  if (repositoryId === null) return fallback;
  const res = await fetch(`${endpoint}/v1/queue/${repositoryId}/bootstrap`, {
    headers: { authorization: auth },
  });
  if (!res.ok) return fallback;
  const body = (await res.json()) as { activationState?: string };
  return {
    activationState:
      body.activationState === "observe" ||
      body.activationState === "canary" ||
      body.activationState === "enforced"
        ? body.activationState
        : "configured",
  };
}

/**
 * `thwip queue setup`. Printing the prompt is the default, the way `thwip setup`
 * prints the developer one, because the rest of enrolment is judgement and a
 * request only an organization administrator may make.
 *
 * `--write` performs the one step of that prompt with a single right answer:
 * THWIP.md, and the bounded pointer in whichever agent instruction files this
 * repository already has. It writes nothing it has not first shown, and the
 * pointer replaces only the text between its own delimiters, so instructions
 * somebody else authored survive.
 */
async function cmdQueueSetup(argv: string[]): Promise<number> {
  const cwd = process.cwd();
  const repo = flag(argv, "--repo") ?? (await originName(cwd)) ?? "this repository";
  if (!argv.includes("--write")) {
    process.stdout.write(queueSetupPrompt(repo) + "\n");
    return 0;
  }

  const { existsSync } = await import("node:fs");
  const { writeFile } = await import("node:fs/promises");
  const endpoint = process.env["THWIP_ENDPOINT"] ?? "https://thwip.recall.net";
  const branch = flag(argv, "--branch") ?? (await defaultBranch(cwd));

  let hasDaggerModule = false;
  try {
    const { parseThwipYaml } = await import("@thwip/policy");
    hasDaggerModule = parseThwipYaml(await readFile(join(cwd, "thwip.yaml"), "utf8")).pipeline !== undefined;
  } catch {
    hasDaggerModule = false;
  }

  const { activationState } = await queueFacts(endpoint, repo);
  const instructions = queueInstructions({
    repositoryName: repo,
    baseRef: `refs/heads/${branch}`,
    activationState,
    hasDaggerModule,
  });

  const written: string[] = [];
  const thwipMd = join(cwd, "THWIP.md");
  const existingMd = existsSync(thwipMd) ? await readFile(thwipMd, "utf8") : null;
  if (existingMd === instructions) {
    process.stderr.write("[thwip] THWIP.md is already current\n");
  } else {
    // Nine documentation commits went into this repository's own THWIP.md. An
    // existing file is the author's, so the generated one goes beside it and
    // they reconcile it, rather than losing that history to a setup command.
    const target = existingMd === null ? thwipMd : `${thwipMd}.new`;
    await writeFile(target, instructions);
    written.push(target);
  }

  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    const path = join(cwd, name);
    if (!existsSync(path)) continue;
    const existing = await readFile(path, "utf8");
    const updated = withQueuePointer(existing);
    if (updated === existing) continue;
    await writeFile(path, updated);
    written.push(path);
  }

  if (written.length === 0) {
    process.stderr.write("[thwip] nothing to change\n");
    return 0;
  }
  process.stderr.write(`[thwip] wrote ${written.join(", ")}; review the diff before committing\n`);
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
  const endpoint = process.env["THWIP_ENDPOINT"] ?? "https://thwip.recall.net";
  const auth = await apiAuthHeader();
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
    case "setup":
      return cmdSetup([...invocation.argv]);
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
 * with code from another worktree. The repair installs the checkout-aware
 * resolver; deliberate low-level Git remains untouched.
 */
async function rejectForeignBuild(): Promise<boolean> {
  const { existsSync } = await import("node:fs");
  const identity = await runningBuild();
  const failure = buildMismatchFailure({
    runningMainPath: identity.mainPath,
    checkoutRoot: findCliCheckout(process.cwd(), existsSync),
    identity,
  });
  if (failure === null) return false;
  process.stderr.write(failure + "\n");
  return true;
}

async function main(): Promise<void> {
  if (await rejectForeignBuild()) {
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
export { verifySshSignature };
