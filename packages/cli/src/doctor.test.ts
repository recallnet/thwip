import { describe, expect, it } from "vitest";
import { EXIT } from "./queue-exit.js";
import { runDoctor, type LocalReads } from "./doctor.js";
import type { DoctorObservation } from "./queue-doctor.js";

const REPO = "acme/widgets";
const REF = "refs/heads/main";
const POLICY = `sha256:${"a".repeat(64)}`;

const LOCAL: LocalReads = {
  cli: {
    version: "0.1.1",
    commit: "11c012e10db6",
    path: "/repo/packages/cli/dist/main.js",
    checkoutRoot: "/repo",
    checkoutMatch: true,
  },
  session: "signed-in",
  signingKey: { kind: "registered", fingerprint: "SHA256:abc", path: "/home/dev/.ssh/id_ed25519" },
  policy: {
    kind: "read",
    policyDigest: POLICY,
    pipelineDigest: `sha256:${"b".repeat(64)}`,
    version: 4,
    requiredSuites: ["lint", "test"],
    configSource: "repository",
  },
};

const REMOTE: DoctorObservation[] = [
  {
    section: "repository",
    status: 200,
    body: { ownerId: "7", repositoryId: "12345", projectId: "project_current" },
  },
  {
    section: "queue",
    status: 200,
    body: {
      projectId: "project_current",
      repositoryId: "12345",
      baseRef: REF,
      projectEnabled: true,
      activePolicyDigest: POLICY,
      queueConfigured: true,
      queueEnabled: true,
      activationState: "enforced",
      setupComplete: true,
    },
  },
  {
    section: "app",
    status: 200,
    body: {
      missingPermissions: {},
      canPublishMergeCheck: true,
      canMerge: true,
      canComment: true,
      receivesEveryHandledEvent: true,
      rulesetHealth: {
        healthy: true,
        expectedNames: ["Thwip Queue Ownership", "Thwip Repository Policy"],
        missing: [],
        duplicate: [],
        drifted: [],
        bypassActorsKnown: true,
      },
      workflowHealth: {
        healthy: true,
        expectedPaths: [".github/workflows/thwip-required.yml", ".github/workflows/thwip-queue-verify.yml"],
        missing: [],
        drifted: [],
        actionRef: `recallnet/thwip@${"a".repeat(40)}`,
        actionAccessible: true,
      },
    },
  },
];

function doctor(over: { local?: Partial<LocalReads>; remote?: DoctorObservation[]; allowUnread?: boolean } = {}) {
  return runDoctor({
    local: { ...LOCAL, ...over.local },
    observations: over.remote ?? REMOTE,
    repo: REPO,
    ref: REF,
    allowUnread: over.allowUnread ?? false,
  });
}

describe("the end-to-end exit contract", () => {
  it("exits zero only on a fully healthy production-shaped report", () => {
    const report = doctor();
    expect(report.exitCode).toBe(EXIT.ok);
    expect(report.checks.map((check) => check.check)).toEqual([
      "cli",
      "session",
      "signing-key",
      "policy",
      "repository",
      "queue",
      "app",
    ]);
    expect(report.checks.every((check) => check.status === "pass")).toBe(true);
  });

  it("fails an unstamped or foreign CLI build with its exact path", () => {
    const report = doctor({
      local: {
        cli: {
          ...LOCAL.cli,
          version: "unknown",
          checkoutMatch: false,
          path: "/other/packages/cli/dist/main.js",
        },
      },
    });
    const cli = report.checks.find((check) => check.check === "cli");
    expect(cli).toMatchObject({ status: "fail", reasonCode: "LOCAL_FAILURE" });
    expect(cli?.facts).toMatchObject({ executablePath: "/other/packages/cli/dist/main.js", checkoutMatch: false });
    expect(report.exitCode).not.toBe(EXIT.ok);
  });

  it("fails a missing or unregistered signing key", () => {
    expect(doctor({ local: { signingKey: { kind: "missing" } } }).exitCode).toBe(EXIT.authRequired);
    expect(
      doctor({
        local: { signingKey: { kind: "unregistered", fingerprint: "SHA256:abc", path: "/key" } },
      }).checks.find((check) => check.check === "signing-key")?.reasonCode,
    ).toBe("SIGNER_KEY_UNKNOWN");
  });

  it("fails a signed-out session", () => {
    const report = doctor({ local: { session: "signed-out" }, remote: [] });
    expect(report.exitCode).toBe(EXIT.authRequired);
    expect(report.checks.find((check) => check.check === "session")?.reasonCode).toBe("LOGIN_REQUIRED");
  });

  it("allows only unread repository-admin diagnostics to be waived", () => {
    const remote = [REMOTE[0]!, REMOTE[1]!, { section: "app" as const, status: 403, body: {} }];
    expect(doctor({ remote }).exitCode).toBe(EXIT.permission);
    expect(doctor({ remote, allowUnread: true }).exitCode).toBe(EXIT.ok);
  });
});

describe("local and active remote policy", () => {
  it("carries both matching digests as non-secret facts", () => {
    expect(doctor().checks.find((check) => check.check === "policy")?.facts).toMatchObject({
      policyDigest: POLICY,
      remotePolicyDigest: POLICY,
      requiredSuites: ["lint", "test"],
      configSource: "repository",
    });
  });

  it("fails a stale local policy digest", () => {
    const staleRemote: DoctorObservation[] = [
      REMOTE[0]!,
      {
        ...REMOTE[1]!,
        body: { ...REMOTE[1]!.body, activePolicyDigest: `sha256:${"c".repeat(64)}` },
      },
      REMOTE[2]!,
    ];
    const report = doctor({ remote: staleRemote });
    expect(report.checks.find((check) => check.check === "policy")).toMatchObject({
      status: "fail",
      reasonCode: "POLICY_CHANGED",
    });
    expect(report.exitCode).toBe(EXIT.sourceChanged);
  });

  it("fails when no remote policy is active", () => {
    const remote: DoctorObservation[] = [
      REMOTE[0]!,
      { ...REMOTE[1]!, body: { ...REMOTE[1]!.body, activePolicyDigest: null } },
      REMOTE[2]!,
    ];
    const report = doctor({ remote });
    expect(report.checks.find((check) => check.check === "policy")?.reasonCode).toBe("POLICY_CHANGED");
    expect(report.exitCode).not.toBe(EXIT.ok);
  });

  it("marks the comparison unread when the readiness API fails", () => {
    const remote: DoctorObservation[] = [
      REMOTE[0]!,
      { section: "queue", status: 503, body: { error: "unavailable" } },
      REMOTE[2]!,
    ];
    const report = doctor({ remote });
    expect(report.checks.find((check) => check.check === "policy")).toMatchObject({
      status: "unread",
      reasonCode: "SERVICE_UNAVAILABLE",
    });
    expect(report.exitCode).toBe(EXIT.unavailable);
  });

  it("keeps a local policy read failure unread", () => {
    const report = doctor({
      local: { policy: { kind: "unread", detail: "no thwip.yaml and no organization default" } },
    });
    expect(report.checks.find((check) => check.check === "policy")?.status).toBe("unread");
    expect(report.exitCode).not.toBe(EXIT.ok);
  });
});

describe("machine output", () => {
  it("gives every check a stable name, status, reason and facts", () => {
    for (const check of doctor().checks) {
      expect(typeof check.check).toBe("string");
      expect(typeof check.status).toBe("string");
      expect(typeof check.reasonCode).toBe("string");
      expect(check.facts).toBeTypeOf("object");
    }
  });

  it("reports the CLI version, commit and path that actually ran", () => {
    expect(doctor().checks.find((check) => check.check === "cli")?.facts).toMatchObject({
      version: "0.1.1",
      commit: "11c012e10db6",
      executablePath: "/repo/packages/cli/dist/main.js",
      checkoutMatch: true,
    });
  });

  it("never includes private signing-key material", () => {
    const facts = doctor().checks.find((check) => check.check === "signing-key")?.facts;
    expect(facts).toMatchObject({ fingerprint: "SHA256:abc", registeredWithGithub: true });
    expect(JSON.stringify(facts)).not.toContain("PRIVATE");
  });
});
