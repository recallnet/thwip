import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DSSE_PAYLOAD_TYPE,
  PREDICATE_TYPE,
  STATEMENT_TYPE,
  b64stdEncode,
  encodeCarrier,
  utf8Encode,
  type DsseEnvelope,
  type InTotoStatementV1,
  type VerificationBundleV1,
} from "@thwip/protocol";
import {
  APP_PROOF_CHECK,
  APP_PROOF_OBSERVE_CHECK,
  MERGED_OUTCOME,
  appProofTaskFromWebhook,
  evaluateAppProof,
  loadGithubProofTarget,
  pendingCheckOutput,
  processAppProofVerification,
  proofHints,
  reconcileInstallationProofChecks,
  type AppProofEvaluation,
  type AppProofProcessDependencies,
  type AppProofRequest,
  type AppProofTarget,
} from "./app-proof-verification.js";
import { VerificationBundleError } from "./verification-bundle.js";
import type { Env } from "./env.js";
import { testD1 } from "../test/d1.js";
import { reconcileInstalledProjects } from "./project-lifecycle.js";

const REPOSITORY_ID = "1315419165";
const OWNER_ID = "162603603";
const SIGNER_ID = "264261678";
const HEAD = "d".repeat(40);
const TREE = "a".repeat(40);
const PARENT = "b".repeat(40);
const BASE = "c".repeat(40);
const POLICY_DIGEST = `sha256:${"1".repeat(64)}` as const;
const PIPELINE_DIGEST = `sha256:${"2".repeat(64)}` as const;
const NOW = "2026-07-30T20:00:00Z";

afterEach(() => {
  vi.unstubAllGlobals();
});

function request(overrides: Partial<AppProofRequest> = {}): AppProofRequest {
  return {
    repositoryId: REPOSITORY_ID,
    repository: "recallnet/thwip",
    ownerId: OWNER_ID,
    installationId: "99",
    subjectSha: HEAD,
    baseRef: "refs/heads/main",
    pullRequestNumber: 53,
    prAuthorGithubUserId: "100",
    ...overrides,
  };
}

function statement(overrides?: (value: InTotoStatementV1) => void): InTotoStatementV1 {
  const value: InTotoStatementV1 = {
    _type: STATEMENT_TYPE,
    subject: [{ name: "git-tree", digest: { sha1: TREE } }],
    predicateType: PREDICATE_TYPE,
    predicate: {
      schemaVersion: "1",
      repository: { provider: "github", ownerId: OWNER_ID, repositoryId: REPOSITORY_ID },
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
        startedAt: "2026-07-30T19:50:00Z",
        finishedAt: "2026-07-30T19:59:00Z",
        networkMode: "disabled",
        cacheMode: "disabled",
        suites: [{ id: "test", status: "passed", durationMs: 100 }],
      },
      signer: { keyId: "key_test", githubUserId: SIGNER_ID },
    },
  };
  overrides?.(value);
  return value;
}

function envelope(value = statement()): DsseEnvelope {
  return {
    payloadType: DSSE_PAYLOAD_TYPE,
    payload: b64stdEncode(utf8Encode(JSON.stringify(value))),
    signatures: [{ keyid: value.predicate.signer.keyId, sig: "GOOD" }],
  };
}

function commitMessage(value = statement()): string {
  return `test: proof\n\n${encodeCarrier(envelope(value))}\n`;
}

function target(overrides: Partial<AppProofTarget> = {}): AppProofTarget {
  return {
    sha: HEAD,
    treeOid: TREE,
    parentOids: [PARENT],
    message: commitMessage(),
    baseSha: BASE,
    prAuthorGithubUserId: "100",
    ...overrides,
  };
}

function bundle(keyId = "key_test", signerId = SIGNER_ID): VerificationBundleV1 {
  return {
    schemaVersion: "1",
    projectId: "project_1",
    repositoryId: REPOSITORY_ID,
    ownerId: OWNER_ID,
    activePolicyDigest: POLICY_DIGEST,
    policy: {
      schemaVersion: "1",
      projectId: "project_1",
      repositoryId: REPOSITORY_ID,
      ownerId: OWNER_ID,
      version: 1,
      securityProfile: "fast",
      minimumPermission: "write",
      allowAuthorAsSigner: true,
      allowedKeyAlgorithms: ["ssh-ed25519"],
      lease: { required: false, maxAgeSeconds: 1800 },
      pipeline: {
        digest: PIPELINE_DIGEST,
        runner: "command",
        requiredSuites: ["test"],
      },
      proofMaxAgeSeconds: 86400,
    },
    keys: [
      {
        keyId,
        githubUserId: signerId,
        algorithm: "ssh-ed25519",
        publicKey: "ssh-ed25519 AAAATEST",
        revokedAt: null,
      },
    ],
    grants: [{ githubUserId: signerId, permission: "admin", active: true }],
    leaseIssuerJwks: [],
    issuedAt: NOW,
    expiresAt: "2026-07-30T20:05:00Z",
  };
}

function evaluationDependencies(target: AppProofTarget) {
  return {
    loadTarget: vi.fn(async () => target),
    resolveBundle: vi.fn(async () => ({
      kind: "active" as const,
      projectId: "project_1",
      repository: "recallnet/thwip",
      defaultBranch: "main",
      configSource: "repository-override",
      bundle: bundle(),
    })),
    remoteCheckConclusions: vi.fn(async () => new Map<string, string>()),
    verifySshSignature: vi.fn(async () => true),
    now: () => NOW,
  };
}

describe("App-native webhook planning", () => {
  const repository = {
    installation: { id: 99 },
    repository: { id: Number(REPOSITORY_ID), full_name: "recallnet/thwip", owner: { id: Number(OWNER_ID) } },
  };

  it.each(["opened", "reopened", "synchronize", "ready_for_review", "edited"])(
    "plans a fresh check for pull_request.%s",
    (action) => {
      expect(
        appProofTaskFromWebhook("pull_request", {
          ...repository,
          action,
          pull_request: {
            number: 53,
            user: { id: 100 },
            head: { sha: HEAD },
            base: { ref: "main" },
          },
        }),
      ).toEqual({ kind: "verify", request: request() });
    },
  );

  it("does not queue a fresh check when the delivery already reports the pull request merged", () => {
    expect(
      appProofTaskFromWebhook("pull_request", {
        ...repository,
        action: "synchronize",
        pull_request: {
          number: 53,
          merged: true,
          user: { id: 100 },
          head: { sha: HEAD },
          base: { ref: "main" },
        },
      }),
    ).toBeNull();
  });

  it("accepts rerequests only for a Thwip-owned external id", () => {
    expect(
      appProofTaskFromWebhook("check_run", {
        action: "rerequested",
        check_run: { name: APP_PROOF_CHECK, external_id: "proof-verification:proof_12345678" },
      }),
    ).toEqual({ kind: "rerequest", verificationId: "proof_12345678" });
    expect(
      appProofTaskFromWebhook("check_run", {
        action: "rerequested",
        check_run: { name: "build", external_id: "proof-verification:proof_12345678" },
      }),
    ).toBeNull();
  });

  it("turns a check-suite rerequest into a fresh PR evaluation", () => {
    expect(
      appProofTaskFromWebhook("check_suite", {
        ...repository,
        action: "rerequested",
        check_suite: {
          head_sha: HEAD,
          pull_requests: [
            {
              number: 53,
              head: { sha: HEAD },
              base: { ref: "main", repo: { id: Number(REPOSITORY_ID) } },
            },
          ],
        },
      }),
    ).toEqual({
      kind: "verify",
      request: request({ prAuthorGithubUserId: undefined }),
    });
  });
});

describe("App-native exact-subject evaluation", () => {
  it("passes a valid proof using the shared verifier", async () => {
    const dependencies = evaluationDependencies(target());
    const result = await evaluateAppProof(request(), dependencies);

    expect(result).toMatchObject({
      outcome: "PASS",
      policyDigest: POLICY_DIGEST,
      policyVersion: 1,
      configSource: "repository-override",
      targets: [{ headSha: HEAD, treeOid: TREE, outcome: "PASS", signerKeyId: "key_test" }],
    });
    expect(dependencies.resolveBundle).toHaveBeenCalledWith({
      repositoryId: REPOSITORY_ID,
      signerGithubUserId: SIGNER_ID,
      keyFingerprint: "key_test",
    });
  });

  it("classifies a missing proof without signing or executing repository code", async () => {
    const dependencies = evaluationDependencies(target({ message: "no proof" }));
    const result = await evaluateAppProof(request(), dependencies);

    expect(result.outcome).toBe("PROOF_MISSING");
    expect(result.targets[0]).toMatchObject({ outcome: "PROOF_MISSING", headSha: HEAD, treeOid: TREE });
    expect(dependencies.verifySshSignature).not.toHaveBeenCalled();
  });

  it("extracts only selector hints and leaves malformed proofs to the verifier", () => {
    expect(proofHints(commitMessage())).toEqual({
      signerGithubUserId: SIGNER_ID,
      keyFingerprint: "key_test",
    });
    expect(proofHints("thwip-proof: malformed")).toEqual({});
  });

  it("reads a fork PR head through the base repository without fetching or executing fork contents", async () => {
    const requested: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        requested.push(url);
        if (url.endsWith("/pulls/53")) return Response.json({ commits: 1, user: { id: 100 } });
        if (url.includes("/pulls/53/commits")) {
          return Response.json([
            {
              sha: HEAD,
              commit: { message: commitMessage(), tree: { sha: TREE } },
              parents: [{ sha: PARENT }],
            },
          ]);
        }
        if (url.includes(`/compare/main...${HEAD}`)) {
          return Response.json({ merge_base_commit: { sha: BASE } });
        }
        return new Response("unexpected", { status: 500 });
      }),
    );

    const loaded = await loadGithubProofTarget("installation-token", request());

    expect(loaded).toEqual(target());
    expect(requested).toHaveLength(3);
    expect(requested.every((url) => url.startsWith("https://api.github.com/repos/recallnet/thwip/"))).toBe(true);
    expect(requested.some((url) => url.includes("/contents/"))).toBe(false);
  });
});

/** A project whose policy names a remote suite GitHub has not concluded yet. */
function unsettledRemoteSuiteDependencies() {
  const dependencies = evaluationDependencies(target());
  dependencies.resolveBundle = vi.fn(async () => {
    const resolved = bundle();
    resolved.policy.pipeline.remoteSuites = ["build-darwin"];
    return {
      kind: "active" as const,
      projectId: "project_1",
      repository: "recallnet/thwip",
      defaultBranch: "main",
      configSource: "repository-override",
      bundle: resolved,
    };
  });
  dependencies.remoteCheckConclusions = vi.fn(async () => new Map([["build-darwin", "in_progress"]]));
  dependencies.sleep = async () => undefined;
  return dependencies;
}

function processDependencies(options: {
  mode: "observe" | "enforced";
  enabled?: boolean;
  evaluation?: AppProofEvaluation;
}) {
  const completed: Array<{ checkRunId: string; conclusion: string; evaluation: AppProofEvaluation }> = [];
  const pending: Array<{ checkRunId: string; evaluation: AppProofEvaluation }> = [];
  const audits: unknown[] = [];
  const dependencies: AppProofProcessDependencies = {
    markPending: vi.fn(async () => undefined),
    pendingVerificationExists: vi.fn(async () => true),
    pullRequestMerged: vi.fn(async () => false),
    reportPending: vi.fn(async (_project, _request, checkRunId, _name, evaluation) => {
      pending.push({ checkRunId, evaluation });
    }),
    loadProject: vi.fn(async () => ({
      id: "project_1",
      repositoryId: REPOSITORY_ID,
      repository: "recallnet/thwip",
      ownerId: OWNER_ID,
      installationId: "99",
      enabled: options.enabled ?? true,
      mode: options.mode,
    })),
    insertStarted: vi.fn(async () => undefined),
    markCheckStarted: vi.fn(async () => undefined),
    markCompleted: vi.fn(async () => undefined),
    createCheck: vi.fn(async (_project, _request, id) => `check_${id}`),
    completeCheck: vi.fn(async (_project, _request, checkRunId, _name, evaluation, conclusion) => {
      completed.push({ checkRunId, conclusion, evaluation });
    }),
    evaluationDependencies: () => {
      const dependencies = evaluationDependencies(target());
      if (options.evaluation !== undefined) {
        dependencies.loadTarget = vi.fn(async () => {
          if (options.evaluation!.outcome === "PASS") return target();
          return target({ message: "no proof" });
        });
      }
      return dependencies;
    },
    signAudit: vi.fn(async (_env, audit) => {
      audits.push(audit);
      return "signed-audit";
    }),
    now: () => NOW,
    verifierVersion: () => "test-verifier",
  };
  return { dependencies, completed, pending, audits };
}

describe("App-native check publication", () => {
  const env = { PUBLIC_ORIGIN: "https://thwip.example" } as Env;

  it("publishes a truthful comparison check on the distinct observe context", async () => {
    const state = processDependencies({ mode: "observe" });
    const result = await processAppProofVerification(env, request(), state.dependencies);

    expect(result.evaluation.outcome).toBe("PASS");
    expect(result.evaluation.durations).toEqual({ suiteDurationMs: 100, wallClockDurationMs: 540_000 });
    expect(state.dependencies.insertStarted).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ checkName: APP_PROOF_OBSERVE_CHECK, mode: "observe" }),
    );
    expect(state.completed).toEqual([
      expect.objectContaining({ checkRunId: `check_${result.verificationId}`, conclusion: "success" }),
    ]);
    expect(state.audits[0]).toMatchObject({
      verificationId: result.verificationId,
      subjectSha: HEAD,
      outcome: "PASS",
      mode: "observe",
      checkRunId: `check_${result.verificationId}`,
    });
  });

  /**
   * PR #219 merged at 22:46:12 with a successful App proof. Work from an
   * earlier delivery began at 22:46:15, compared its old head with the new
   * base, and published SUBJECT_BASE_MISMATCH after the merge. Queue time is
   * the race: the webhook payload was valid when received and stale when used.
   */
  it("does not publish a check when a queued verification starts after the pull request merged", async () => {
    const state = processDependencies({ mode: "enforced" });
    const evaluator = vi.fn(() => evaluationDependencies(target()));
    state.dependencies.pullRequestMerged = vi.fn(async () => true);
    state.dependencies.evaluationDependencies = evaluator;

    const result = await processAppProofVerification(env, request(), state.dependencies);

    expect(result).toMatchObject({
      verificationId: "",
      checkRunId: "",
      evaluation: { outcome: MERGED_OUTCOME },
    });
    expect(state.dependencies.insertStarted).not.toHaveBeenCalled();
    expect(state.dependencies.createCheck).not.toHaveBeenCalled();
    expect(evaluator).not.toHaveBeenCalled();
    expect(state.completed).toEqual([]);
  });

  it("fails the required App check when enforcement is enabled", async () => {
    const state = processDependencies({ mode: "enforced" });
    state.dependencies.evaluationDependencies = () => evaluationDependencies(target({ message: "no proof" }));
    const result = await processAppProofVerification(env, request(), state.dependencies);

    expect(result.evaluation.outcome).toBe("PROOF_MISSING");
    expect(result.evaluation.durations).toBeUndefined();
    expect(state.dependencies.insertStarted).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ checkName: APP_PROOF_CHECK, mode: "enforced" }),
    );
    expect(state.completed[0]).toMatchObject({ conclusion: "failure" });
  });

  it("reports disabled projects loudly without reading proof targets", async () => {
    const state = processDependencies({ mode: "observe", enabled: false });
    const evaluator = vi.fn(() => evaluationDependencies(target()));
    state.dependencies.evaluationDependencies = evaluator;

    const result = await processAppProofVerification(env, request(), state.dependencies);

    expect(result.evaluation).toMatchObject({ outcome: "PROJECT_DISABLED" });
    expect(evaluator).not.toHaveBeenCalled();
    expect(state.completed[0]).toMatchObject({ conclusion: "failure" });
  });

  it("gives concurrent evaluations distinct check runs so an older result cannot overwrite a newer one", async () => {
    let releaseOld!: () => void;
    const oldGate = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    const completions: string[] = [];
    const make = (wait: boolean): AppProofProcessDependencies => {
      const state = processDependencies({ mode: "enforced" }).dependencies;
      const base = evaluationDependencies(target());
      if (wait) {
        base.loadTarget = vi.fn(async () => {
          await oldGate;
          return target({ message: "no proof" });
        });
      }
      state.evaluationDependencies = () => base;
      state.completeCheck = vi.fn(async (_project, _request, checkRunId) => {
        completions.push(checkRunId);
      });
      return state;
    };
    const oldRun = processAppProofVerification(env, request(), make(true));
    await vi.waitFor(() => expect(completions).toHaveLength(0));
    const newRun = await processAppProofVerification(env, request(), make(false));
    releaseOld();
    const oldResult = await oldRun;

    expect(newRun.checkRunId).not.toBe(oldResult.checkRunId);
    expect(completions).toEqual([newRun.checkRunId, oldResult.checkRunId]);
  });
});

describe("installation proof reconciliation project incarnation", () => {
  it("does not adopt a fresh project after a delayed old-installation sweep resumes", async () => {
    const t = testD1();
    try {
      t.raw
        .prepare(
          "INSERT INTO organizations (id, github_org_id, github_login, installation_id) VALUES ('org_old', '1', 'old', '99')",
        )
        .run();
      t.raw
        .prepare(
          "INSERT INTO projects (id, organization_id, github_repository_id, github_name, enabled) VALUES ('project_old', 'org_old', ?, 'old/repo', 1)",
        )
        .run(REPOSITORY_ID);
      t.raw
        .prepare("UPDATE project_lifecycle_rollout SET worker_activated_at = '2000-01-01T00:00:00.000Z' WHERE id = 1")
        .run();
      const lifecycleEnv = {
        DB: t.db,
        EVIDENCE: { list: async () => ({ objects: [], truncated: false }), delete: async () => undefined },
        BRANCH_QUEUE: {
          idFromName: (name: string) => name,
          get: () => ({ purge: async () => undefined }),
        },
      } as unknown as Pick<Env, "DB" | "EVIDENCE" | "BRANCH_QUEUE">;
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);

      let selected!: () => void;
      const didSelect = new Promise<void>((resolve) => {
        selected = resolve;
      });
      let resume!: () => void;
      const mayResume = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const delayed = reconcileInstallationProofChecks(
        { DB: t.db } as Env,
        "99",
        {
          afterSelected: async () => {
            selected();
            await mayResume;
          },
        },
      );
      await didSelect;

      await reconcileInstalledProjects(lifecycleEnv, "org_old", []);
      await reconcileInstalledProjects(lifecycleEnv, "org_old", [
        { id: REPOSITORY_ID, fullName: "old/repo", defaultBranch: "main" },
      ], { now: () => new Date(Date.now() + 2 * 60 * 60_000) });
      const fresh = t.raw
        .prepare("SELECT id, enabled FROM projects WHERE github_repository_id = ?")
        .get(REPOSITORY_ID) as { id: string; enabled: number };
      expect(fresh).toMatchObject({ enabled: 0 });
      expect(fresh.id).not.toBe("project_old");

      resume();
      await expect(delayed).resolves.toBe(0);
      expect(t.raw.prepare("SELECT COUNT(*) AS count FROM proof_verifications").get()).toEqual({ count: 0 });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      t.close();
    }
  });
});

/**
 * The bug: a single read of GitHub decided the proof's fate, so a check that had
 * not finished, and a read that failed outright, both became durable verdicts a
 * developer read as "your tests failed". The merge path lost three merges to the
 * same shape from the earlier settlement investigation.
 */
describe("evidence that has not settled", () => {
  const env = { PUBLIC_ORIGIN: "https://thwip.example" } as Env;

  it("leaves the check running while GitHub's check is still running", async () => {
    const state = processDependencies({ mode: "enforced" });
    state.dependencies.evaluationDependencies = () => unsettledRemoteSuiteDependencies();

    const result = await processAppProofVerification(env, request(), state.dependencies);

    expect(result.evaluation.outcome).toBe("VERIFICATION_PENDING");
    expect(state.completed).toEqual([]);
    expect(state.dependencies.markCompleted).not.toHaveBeenCalled();
    expect(state.dependencies.signAudit).not.toHaveBeenCalled();
    expect(state.pending).toEqual([
      expect.objectContaining({ checkRunId: `check_${result.verificationId}` }),
    ]);
    expect(state.dependencies.markPending).toHaveBeenCalled();
  });

  it("says what is happening and what happens next, in words a person can act on", () => {
    const output = pendingCheckOutput(
      {
        outcome: "VERIFICATION_PENDING",
        detail: "GitHub is still running `build-darwin` on this commit; thwip verifies the proof once that check reports",
        policyDigest: null,
        policyVersion: null,
        configSource: "unavailable",
        targets: [],
      },
      "https://thwip.example/v1/proof-verifications/proof_1",
    );

    expect(output.title).not.toMatch(/reject|fail/i);
    expect(output.summary).toContain("build-darwin");
    expect(output.summary).not.toContain("—");
    expect(output.summary.length).toBeGreaterThan(40);
  });

  it("reads GitHub again before deciding a read that failed means anything", async () => {
    const state = processDependencies({ mode: "enforced" });
    let attempts = 0;
    state.dependencies.evaluationDependencies = () => {
      const dependencies = evaluationDependencies(target());
      dependencies.loadTarget = vi.fn(async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("GitHub recallnet/thwip/pulls/53 -> 502");
        return target();
      });
      return dependencies;
    };
    state.dependencies.sleep = async () => undefined;

    const result = await processAppProofVerification(env, request(), state.dependencies);

    expect(attempts).toBe(2);
    expect(result.evaluation.outcome).toBe("PASS");
    expect(state.completed[0]).toMatchObject({ conclusion: "success" });
  });

  it("never stores a failed read as a verdict", async () => {
    const state = processDependencies({ mode: "enforced" });
    state.dependencies.evaluationDependencies = () => {
      const dependencies = evaluationDependencies(target());
      dependencies.loadTarget = vi.fn(async () => {
        throw new Error("GitHub recallnet/thwip/pulls/53 -> 502");
      });
      return dependencies;
    };
    state.dependencies.sleep = async () => undefined;

    const result = await processAppProofVerification(env, request(), state.dependencies);

    expect(result.evaluation.outcome).toBe("VERIFICATION_PENDING");
    expect(state.completed).toEqual([]);
    expect(state.dependencies.markCompleted).not.toHaveBeenCalled();
  });

  it("still records the outcomes a bundle failure decides", async () => {
    const state = processDependencies({ mode: "enforced" });
    state.dependencies.evaluationDependencies = () => {
      const dependencies = evaluationDependencies(target());
      dependencies.loadTarget = vi.fn(async () => {
        throw new VerificationBundleError(503, "BUNDLE_UNAVAILABLE", "no bundle");
      });
      return dependencies;
    };

    const result = await processAppProofVerification(env, request(), state.dependencies);

    expect(result.evaluation.outcome).toBe("BUNDLE_UNAVAILABLE");
    expect(state.completed[0]).toMatchObject({ conclusion: "failure" });
  });

  it("comes back when a check finishes, so a pending verification settles", () => {
    const repository = {
      installation: { id: 99 },
      repository: { id: Number(REPOSITORY_ID), full_name: "recallnet/thwip", owner: { id: Number(OWNER_ID) } },
    };
    expect(
      appProofTaskFromWebhook("check_run", {
        ...repository,
        action: "completed",
        check_run: {
          name: "build-darwin",
          head_sha: HEAD,
          pull_requests: [{ number: 53, head: { sha: HEAD }, base: { ref: "main", repo: { id: Number(REPOSITORY_ID) } } }],
        },
      }),
    ).toEqual({
      kind: "verify",
      request: request({ prAuthorGithubUserId: undefined, settleIfPending: true }),
    });
  });

  it("ignores its own check finishing, which would otherwise verify forever", () => {
    const repository = {
      installation: { id: 99 },
      repository: { id: Number(REPOSITORY_ID), full_name: "recallnet/thwip", owner: { id: Number(OWNER_ID) } },
    };
    for (const name of [APP_PROOF_CHECK, APP_PROOF_OBSERVE_CHECK]) {
      expect(
        appProofTaskFromWebhook("check_run", {
          ...repository,
          action: "completed",
          check_run: {
            name,
            head_sha: HEAD,
            pull_requests: [
              { number: 53, head: { sha: HEAD }, base: { ref: "main", repo: { id: Number(REPOSITORY_ID) } } },
            ],
          },
        }),
      ).toBeNull();
    }
  });

  it("does no work when nothing on that commit is waiting", async () => {
    const state = processDependencies({ mode: "enforced" });
    state.dependencies.pendingVerificationExists = vi.fn(async () => false);
    const evaluator = vi.fn(() => evaluationDependencies(target()));
    state.dependencies.evaluationDependencies = evaluator;

    const result = await processAppProofVerification(env, request({ settleIfPending: true }), state.dependencies);

    expect(result.evaluation.outcome).toBe("VERIFICATION_PENDING");
    expect(evaluator).not.toHaveBeenCalled();
    expect(state.dependencies.createCheck).not.toHaveBeenCalled();
    expect(state.dependencies.insertStarted).not.toHaveBeenCalled();
  });
});
