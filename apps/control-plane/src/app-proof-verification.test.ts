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
  appProofTaskFromWebhook,
  evaluateAppProof,
  loadGithubProofTargets,
  processAppProofVerification,
  proofHints,
  type AppProofEvaluation,
  type AppProofProcessDependencies,
  type AppProofRequest,
  type AppProofTarget,
} from "./app-proof-verification.js";
import type { Env } from "./env.js";

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
    event: "pull_request",
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
    gracePolicyDigests: [],
    policy: {
      schemaVersion: "1",
      projectId: "project_1",
      repositoryId: REPOSITORY_ID,
      ownerId: OWNER_ID,
      version: 1,
      securityProfile: "fast",
      minimumPermission: "write",
      allowAuthorAsSigner: true,
      evaluationMode: "head-tree",
      allowedKeyAlgorithms: ["ssh-ed25519"],
      requireGithubKeyPresence: false,
      lease: { required: false, maxAgeSeconds: 1800 },
      pipeline: {
        digest: PIPELINE_DIGEST,
        runner: "command",
        requiredSuites: ["test"],
      },
      proofMaxAgeSeconds: 86400,
      audit: { basisPoints: 0, mandatoryPaths: [] },
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

function evaluationDependencies(targets: AppProofTarget[]) {
  return {
    loadTargets: vi.fn(async () => targets),
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

  it("plans the exact merge-group SHA", () => {
    expect(
      appProofTaskFromWebhook("merge_group", {
        ...repository,
        action: "checks_requested",
        merge_group: { head_sha: HEAD, base_sha: BASE, base_ref: "refs/heads/main" },
      }),
    ).toEqual({
      kind: "verify",
      request: request({
        event: "merge_group",
        mergeGroupBaseSha: BASE,
        pullRequestNumber: undefined,
        prAuthorGithubUserId: undefined,
      }),
    });
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
    const dependencies = evaluationDependencies([target()]);
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
    const dependencies = evaluationDependencies([target({ message: "no proof" })]);
    const result = await evaluateAppProof(request(), dependencies);

    expect(result.outcome).toBe("PROOF_MISSING");
    expect(result.targets[0]).toMatchObject({ outcome: "PROOF_MISSING", headSha: HEAD, treeOid: TREE });
    expect(dependencies.verifySshSignature).not.toHaveBeenCalled();
  });

  it("resolves signer facts separately for every merge-group target", async () => {
    const secondHead = "e".repeat(40);
    const secondTree = "f".repeat(40);
    const secondSigner = "300";
    const secondStatement = statement((value) => {
      value.subject[0]!.digest.sha1 = secondTree;
      value.predicate.git.treeOid = secondTree;
      value.predicate.signer = { keyId: "key_second", githubUserId: secondSigner };
    });
    const dependencies = evaluationDependencies([
      target(),
      target({ sha: secondHead, treeOid: secondTree, message: commitMessage(secondStatement) }),
    ]);
    dependencies.resolveBundle.mockImplementation(async (input) => ({
      kind: "active",
      projectId: "project_1",
      repository: "recallnet/thwip",
      defaultBranch: "main",
      configSource: "global",
      bundle:
        input.signerGithubUserId === secondSigner ? bundle("key_second", secondSigner) : bundle(),
    }));

    const result = await evaluateAppProof(request({ event: "merge_group" }), dependencies);

    expect(result.outcome).toBe("PASS");
    expect(result.targets.map((value) => value.signerKeyId)).toEqual(["key_test", "key_second"]);
    expect(dependencies.resolveBundle).toHaveBeenCalledTimes(2);
  });

  it("fails closed if the active policy changes between merge-group members", async () => {
    const secondHead = "e".repeat(40);
    const dependencies = evaluationDependencies([target(), target({ sha: secondHead })]);
    let call = 0;
    dependencies.resolveBundle.mockImplementation(async () => {
      const resolved = bundle();
      if (call++ === 1) resolved.activePolicyDigest = `sha256:${"9".repeat(64)}`;
      return {
        kind: "active",
        projectId: "project_1",
        repository: "recallnet/thwip",
        defaultBranch: "main",
        configSource: "repository-override",
        bundle: resolved,
      };
    });

    await expect(evaluateAppProof(request({ event: "merge_group" }), dependencies)).rejects.toThrow(
      "active policy changed during verification",
    );
  });

  it("reports an empty merge group explicitly", async () => {
    await expect(evaluateAppProof(request({ event: "merge_group" }), evaluationDependencies([]))).resolves.toEqual({
      outcome: "MERGE_GROUP_EMPTY",
      detail: "merge group contains no pull-request heads",
      policyDigest: null,
      policyVersion: null,
      configSource: "unavailable",
      targets: [],
    });
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

    const targets = await loadGithubProofTargets("installation-token", request());

    expect(targets).toEqual([target()]);
    expect(requested).toHaveLength(3);
    expect(requested.every((url) => url.startsWith("https://api.github.com/repos/recallnet/thwip/"))).toBe(true);
    expect(requested.some((url) => url.includes("/contents/"))).toBe(false);
  });
});

function processDependencies(options: {
  mode: "observe" | "enforced";
  enabled?: boolean;
  evaluation?: AppProofEvaluation;
}) {
  const completed: Array<{ checkRunId: string; conclusion: string; evaluation: AppProofEvaluation }> = [];
  const audits: unknown[] = [];
  const dependencies: AppProofProcessDependencies = {
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
      const dependencies = evaluationDependencies([target()]);
      if (options.evaluation !== undefined) {
        dependencies.loadTargets = vi.fn(async () => {
          if (options.evaluation!.outcome === "PASS") return [target()];
          return [target({ message: "no proof" })];
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
  return { dependencies, completed, audits };
}

describe("App-native check publication", () => {
  const env = { PUBLIC_ORIGIN: "https://thwip.example" } as Env;

  it("publishes a truthful comparison check on the distinct observe context", async () => {
    const state = processDependencies({ mode: "observe" });
    const result = await processAppProofVerification(env, request(), state.dependencies);

    expect(result.evaluation.outcome).toBe("PASS");
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

  it("fails the required App check when enforcement is enabled", async () => {
    const state = processDependencies({ mode: "enforced" });
    state.dependencies.evaluationDependencies = () => evaluationDependencies([target({ message: "no proof" })]);
    const result = await processAppProofVerification(env, request(), state.dependencies);

    expect(result.evaluation.outcome).toBe("PROOF_MISSING");
    expect(state.dependencies.insertStarted).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ checkName: APP_PROOF_CHECK, mode: "enforced" }),
    );
    expect(state.completed[0]).toMatchObject({ conclusion: "failure" });
  });

  it("reports disabled projects loudly without reading proof targets", async () => {
    const state = processDependencies({ mode: "observe", enabled: false });
    const evaluator = vi.fn(() => evaluationDependencies([target()]));
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
      const base = evaluationDependencies([target()]);
      if (wait) {
        base.loadTargets = vi.fn(async () => {
          await oldGate;
          return [target({ message: "no proof" })];
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
