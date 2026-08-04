import { describe, expect, it } from "vitest";
import { EXIT } from "./queue-exit.js";
import { runDoctor, type LocalReads } from "./doctor.js";
import type { DoctorObservation } from "./queue-doctor.js";

/**
 * `thwip doctor` answers one question: can this project produce a proof and
 * have it verified remotely, from here, right now. Every check it runs already
 * existed as a probe somewhere else, and every check can come back unread.
 */

const REPO = "acme/widgets";
const REF = "refs/heads/main";

const LOCAL: LocalReads = {
  session: "signed-in",
  signingKey: { kind: "registered", fingerprint: "SHA256:abc", path: "/home/dev/.ssh/id_ed25519" },
  policy: {
    kind: "read",
    policyDigest: "sha256:pol",
    pipelineDigest: "sha256:pipe",
    version: 4,
    requiredSuites: ["lint", "test"],
    configSource: "repository",
  },
};

const REMOTE: DoctorObservation[] = [
  { section: "repository", status: 200, body: { repositoryId: "12345" } },
  {
    section: "queue",
    status: 200,
    body: { snapshot: { paused: false, pauseReason: null, activeAttemptId: null, entries: [] }, why: [] },
  },
  { section: "app", status: 200, body: { missingPermissions: {}, canPublishMergeCheck: true, rulesets: [{}] } },
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

describe("the exit contract", () => {
  it("exits zero when every check passed", () => {
    const report = doctor();
    expect(report.exitCode).toBe(EXIT.ok);
    expect(report.checks.every((c) => c.status === "pass")).toBe(true);
  });

  it("never exits zero on a check nobody could read", () => {
    const report = doctor({
      remote: [REMOTE[0]!, REMOTE[1]!, { section: "app", status: 403, body: {} }],
    });
    expect(report.exitCode).not.toBe(EXIT.ok);
    expect(report.checks.find((c) => c.check === "app")?.status).toBe("unread");
  });

  it("exits zero on an unread check only when the caller says so out loud", () => {
    const report = doctor({
      remote: [REMOTE[0]!, REMOTE[1]!, { section: "app", status: 403, body: {} }],
      allowUnread: true,
    });
    expect(report.exitCode).toBe(EXIT.ok);
  });

  it("fails when this machine cannot sign at all", () => {
    const report = doctor({ local: { signingKey: { kind: "missing" } } });
    expect(report.exitCode).toBe(EXIT.authRequired);
    expect(report.checks.find((c) => c.check === "signing-key")?.reasonCode).toBe("DEVICE_NOT_ENROLLED");
  });

  it("fails when GitHub does not register the key that would sign", () => {
    const report = doctor({
      local: { signingKey: { kind: "unregistered", fingerprint: "SHA256:abc", path: "/k" } },
    });
    expect(report.checks.find((c) => c.check === "signing-key")?.reasonCode).toBe("SIGNER_KEY_UNKNOWN");
    expect(report.exitCode).not.toBe(EXIT.ok);
  });

  it("fails when nobody is signed in, because nothing remote can be verified", () => {
    const report = doctor({ local: { session: "signed-out" } });
    expect(report.exitCode).toBe(EXIT.authRequired);
    expect(report.checks.find((c) => c.check === "session")?.reasonCode).toBe("LOGIN_REQUIRED");
  });

  it("fails when thwip is not installed on the repository", () => {
    const report = doctor({
      remote: [{ section: "repository", status: 404, body: {} }],
    });
    expect(report.checks.find((c) => c.check === "repository")?.reasonCode).toBe("APP_UNINSTALLED");
    expect(report.exitCode).toBe(EXIT.setupInvalid);
  });

  it("fails when the branch has no queue", () => {
    const report = doctor({
      remote: [REMOTE[0]!, { section: "queue", status: 404, body: {} }, REMOTE[2]!],
    });
    expect(report.checks.find((c) => c.check === "queue")?.reasonCode).toBe("QUEUE_NOT_CONFIGURED");
  });

  it("fails when the App cannot publish the check the branch requires", () => {
    const report = doctor({
      remote: [
        REMOTE[0]!,
        REMOTE[1]!,
        { section: "app", status: 200, body: { missingPermissions: { checks: "write" }, canPublishMergeCheck: false, rulesets: [] } },
      ],
    });
    expect(report.checks.find((c) => c.check === "app")?.reasonCode).toBe("APP_PERMISSION_DRIFT");
  });

  it("reports a policy it could not read as unread rather than as a policy with nothing wrong", () => {
    const report = doctor({ local: { policy: { kind: "unread", detail: "no thwip.yaml and no organization default" } } });
    expect(report.checks.find((c) => c.check === "policy")?.status).toBe("unread");
    expect(report.exitCode).not.toBe(EXIT.ok);
  });
});

describe("what --json carries", () => {
  it("gives every check a name, a status, a reason code and the facts it read", () => {
    const report = doctor();
    expect(report.checks.map((c) => c.check)).toEqual([
      "session",
      "signing-key",
      "policy",
      "repository",
      "queue",
      "app",
    ]);
    for (const check of report.checks) {
      expect(typeof check.reasonCode).toBe("string");
      expect(check.facts).toBeTypeOf("object");
    }
  });

  it("carries the digests a verifier would compare, from the read that produced them", () => {
    const facts = doctor().checks.find((c) => c.check === "policy")?.facts;
    expect(facts).toMatchObject({
      policyDigest: "sha256:pol",
      pipelineDigest: "sha256:pipe",
      requiredSuites: ["lint", "test"],
      configSource: "repository",
    });
  });

  it("carries the fingerprint of the key that would sign, and never the key", () => {
    const facts = doctor().checks.find((c) => c.check === "signing-key")?.facts;
    expect(facts).toMatchObject({ fingerprint: "SHA256:abc", registeredWithGithub: true });
    expect(JSON.stringify(facts)).not.toContain("PRIVATE");
  });

  it("carries the repository id the control plane resolved", () => {
    expect(doctor().checks.find((c) => c.check === "repository")?.facts).toMatchObject({ repositoryId: "12345" });
  });

  it("says PASS for a check with nothing wrong, so no surface has to guess", () => {
    expect(doctor().checks.map((c) => c.reasonCode)).toEqual(["PASS", "PASS", "PASS", "PASS", "PASS", "PASS"]);
  });
});
