import { describe, expect, it } from "vitest";
import { EXIT } from "./queue-exit.js";
import { doctorProbes, reportDoctor, type DoctorObservation } from "./queue-doctor.js";

const REPO = "acme/widgets";
const REF = "refs/heads/main";
const POLICY = `sha256:${"a".repeat(64)}`;

function observation(over: Partial<DoctorObservation> & Pick<DoctorObservation, "section">): DoctorObservation {
  return { status: 200, body: {}, ...over };
}

const installed = observation({
  section: "repository",
  body: { ownerId: "7", repositoryId: "12345", projectId: "project_current" },
});
const ready = observation({
  section: "queue",
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
});
const healthyApp = observation({
  section: "app",
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
});

function report(
  observations: DoctorObservation[],
  allowUnread = false,
) {
  return reportDoctor(observations, { repo: REPO, ref: REF, allowUnread });
}

describe("what doctor asks for", () => {
  it("reads exact durable readiness instead of inferring setup from an empty queue document", () => {
    const probes = doctorProbes({ repo: REPO, ref: REF, events: 5 });
    expect(probes.map((probe) => probe.section)).toEqual(["repository", "queue", "app"]);
    expect(probes[1]?.path).toBe(`/v1/queue/{repositoryId}/readiness?ref=${encodeURIComponent(REF)}`);
    expect(probes[1]?.path).not.toContain("/explain");
    expect(probes[1]?.requiresAdmin).toBe(false);
  });
});

describe("queue readiness", () => {
  it("passes only the current enabled, enforced, fully set-up project incarnation", () => {
    const result = report([installed, ready, healthyApp]);
    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.sections.every((section) => section.status === "pass")).toBe(true);
    expect(result.sections.find((section) => section.section === "queue")?.facts).toMatchObject({
      projectId: "project_current",
      projectEnabled: true,
      queueEnabled: true,
      activationState: "enforced",
      setupComplete: true,
    });
  });

  it("fails a disabled project even if an old queue-shaped response says enabled", () => {
    const disabled = observation({
      ...ready,
      section: "queue",
      body: { ...ready.body, projectId: "project_fresh", projectEnabled: false },
    });
    const fresh = observation({
      section: "repository",
      body: { ...installed.body, projectId: "project_fresh" },
    });
    const result = report([fresh, disabled, healthyApp]);
    expect(result.sections.find((section) => section.section === "queue")?.reasonCode).toBe("PROJECT_DISABLED");
    expect(result.exitCode).toBe(EXIT.setupInvalid);
  });

  it.each([
    [{ queueConfigured: false, queueEnabled: false, activationState: null, setupComplete: false }, "missing"],
    [{ queueEnabled: false }, "disabled"],
    [{ activationState: "observe" }, "not enforced"],
    [{ setupComplete: false }, "incomplete"],
  ])("fails a %s queue", (change) => {
    const inactive = observation({ section: "queue", body: { ...ready.body, ...change } });
    const result = report([installed, inactive, healthyApp]);
    expect(result.sections.find((section) => section.section === "queue")?.reasonCode).toBe("QUEUE_NOT_CONFIGURED");
    expect(result.exitCode).not.toBe(EXIT.ok);
  });

  it("fails a project with no active remote policy", () => {
    const noPolicy = observation({ section: "queue", body: { ...ready.body, activePolicyDigest: null } });
    const result = report([installed, noPolicy, healthyApp]);
    expect(result.sections.find((section) => section.section === "queue")?.reasonCode).toBe("POLICY_CHANGED");
    expect(result.exitCode).not.toBe(EXIT.ok);
  });

  it("does not pass a malformed 200 response", () => {
    const result = report([installed, observation({ section: "queue", body: {} }), healthyApp]);
    expect(result.sections.find((section) => section.section === "queue")).toMatchObject({
      status: "unread",
      reasonCode: "INVARIANT_FAILURE",
    });
    expect(result.exitCode).not.toBe(EXIT.ok);
  });

  it("does not mix another incarnation, repository, or branch into a healthy report", () => {
    for (const change of [
      { projectId: "project_old" },
      { repositoryId: "999" },
      { baseRef: "refs/heads/release" },
    ]) {
      const result = report([installed, observation({ section: "queue", body: { ...ready.body, ...change } }), healthyApp]);
      expect(result.sections.find((section) => section.section === "queue")?.reasonCode).toBe("INVARIANT_FAILURE");
      expect(result.exitCode).not.toBe(EXIT.ok);
    }
  });
});

describe("App and ruleset readiness", () => {
  it("fails missing App permissions and names the lost capability", () => {
    const app = observation({
      section: "app",
      body: {
        ...healthyApp.body,
        missingPermissions: { checks: "write" },
        canPublishMergeCheck: false,
      },
    });
    const result = report([installed, ready, app]);
    expect(result.sections.find((section) => section.section === "app")?.reasonCode).toBe("APP_PERMISSION_DRIFT");
    expect(result.lines.join("\n")).toContain("nothing will ever merge");
  });

  it("fails a missing managed ruleset", () => {
    const app = observation({
      section: "app",
      body: {
        ...healthyApp.body,
        rulesetHealth: {
          ...((healthyApp.body?.["rulesetHealth"] ?? {}) as Record<string, unknown>),
          healthy: false,
          missing: ["Thwip Queue Ownership"],
        },
      },
    });
    const result = report([installed, ready, app]);
    expect(result.sections.find((section) => section.section === "app")?.reasonCode).toBe("EVIDENCE_MISSING");
    expect(result.lines.join("\n")).toContain("missing Thwip Queue Ownership");
  });

  it.each(["wrong shape", "disabled enforcement"])("fails a ruleset with %s", () => {
    const app = observation({
      section: "app",
      body: {
        ...healthyApp.body,
        rulesetHealth: {
          ...((healthyApp.body?.["rulesetHealth"] ?? {}) as Record<string, unknown>),
          healthy: false,
          drifted: ["Thwip Repository Policy"],
        },
      },
    });
    const result = report([installed, ready, app]);
    expect(result.sections.find((section) => section.section === "app")?.reasonCode).toBe("EVIDENCE_DRIFTED");
    expect(result.exitCode).toBe(EXIT.setupInvalid);
  });

  it("does not pass rulesets whose bypass actors GitHub hid", () => {
    const app = observation({
      section: "app",
      body: {
        ...healthyApp.body,
        rulesetHealth: {
          ...((healthyApp.body?.["rulesetHealth"] ?? {}) as Record<string, unknown>),
          healthy: false,
          bypassActorsKnown: false,
        },
      },
    });
    const result = report([installed, ready, app]);
    expect(result.sections.find((section) => section.section === "app")).toMatchObject({
      status: "unread",
      reasonCode: "OWNER_UNAUTHORIZED",
    });
    expect(result.exitCode).toBe(EXIT.permission);
    expect(report([installed, ready, app], true).exitCode).toBe(EXIT.ok);
  });

  it.each([
    [{ missing: [".github/workflows/thwip-required.yml"] }, "missing .github/workflows/thwip-required.yml", "EVIDENCE_MISSING"],
    [{ drifted: [".github/workflows/thwip-queue-verify.yml"] }, "drifted .github/workflows/thwip-queue-verify.yml", "EVIDENCE_DRIFTED"],
    [{ actionAccessible: false }, "pinned verifier action commit is unreadable", "EVIDENCE_UNREADABLE"],
  ])("fails live workflow readiness: %s", (change, message, reason) => {
    const app = observation({
      section: "app",
      body: {
        ...healthyApp.body,
        workflowHealth: {
          ...((healthyApp.body?.["workflowHealth"] ?? {}) as Record<string, unknown>),
          healthy: false,
          ...change,
        },
      },
    });
    const result = report([installed, ready, app]);
    expect(result.sections.find((section) => section.section === "app")?.reasonCode).toBe(reason);
    expect(result.lines.join("\n")).toContain(message);
    expect(result.exitCode).not.toBe(EXIT.ok);
  });

  it("fails when webhook subscriptions do not reach every handler", () => {
    const app = observation({
      section: "app",
      body: { ...healthyApp.body, receivesEveryHandledEvent: false },
    });
    const result = report([installed, ready, app]);
    expect(result.sections.find((section) => section.section === "app")?.reasonCode).toBe("APP_PERMISSION_DRIFT");
  });

  it("does not pass a 200 body that omits the computed ruleset health", () => {
    const result = report([
      installed,
      ready,
      observation({ section: "app", body: { missingPermissions: {}, canPublishMergeCheck: true } }),
    ]);
    expect(result.sections.find((section) => section.section === "app")?.reasonCode).toBe("INVARIANT_FAILURE");
    expect(result.exitCode).not.toBe(EXIT.ok);
  });
});

describe("HTTP and unread branches", () => {
  it("fails when thwip is not installed", () => {
    const result = report([observation({ section: "repository", status: 404, body: {} })]);
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0]?.reasonCode).toBe("APP_UNINSTALLED");
  });

  it("does not turn omitted probes after a successful repository lookup into passes", () => {
    const result = report([installed]);
    expect(result.unread).toEqual(["queue", "app"]);
    expect(result.exitCode).toBe(EXIT.unavailable);
  });

  it("classifies a GitHub API 502 as unavailable", () => {
    const result = report([installed, ready, observation({ section: "app", status: 502, body: { code: "GITHUB_RULESETS_UNAVAILABLE" } })]);
    expect(result.sections.find((section) => section.section === "app")?.reasonCode).toBe("EVIDENCE_UNAVAILABLE");
    expect(result.exitCode).toBe(EXIT.unavailable);
  });

  it("reports the exact failed GitHub evidence operation without response details", () => {
    const result = report([
      installed,
      ready,
      observation({
        section: "app",
        operation: "control-plane.app-evidence.read",
        attempts: 3,
        status: 502,
        body: {
          error: "do not expose this response body",
          evidence: {
            operation: "github.action-commit.read",
            status: "unreadable",
            httpStatus: 404,
            attempts: 1,
            resource: `recallnet/thwip@${"a".repeat(40)}`,
          },
        },
      }),
    ]);
    const app = result.sections.find((section) => section.section === "app");
    expect(app).toMatchObject({
      status: "unread",
      reasonCode: "EVIDENCE_UNREADABLE",
      facts: {
        evidence: {
          operation: "github.action-commit.read",
          status: "unreadable",
          httpStatus: 404,
          attempts: 1,
          controlPlaneAttempts: 3,
        },
      },
    });
    expect(result.lines.join("\n")).toContain("github.action-commit.read (recallnet/thwip@");
    expect(JSON.stringify(result)).not.toContain("do not expose this response body");
    expect(result.exitCode).toBe(EXIT.unavailable);
  });

  it("classifies a missing installation after repository resolution as a setup failure", () => {
    const result = report([installed, ready, observation({ section: "app", status: 404, body: {} })]);
    expect(result.sections.find((section) => section.section === "app")?.reasonCode).toBe("APP_UNINSTALLED");
    expect(result.exitCode).toBe(EXIT.setupInvalid);
  });

  it("allows only repository-admin standing to be waived", () => {
    const refused = [installed, ready, observation({ section: "app", status: 403, body: {} })];
    expect(report(refused).exitCode).toBe(EXIT.permission);
    expect(report(refused, true).exitCode).toBe(EXIT.ok);

    const unavailable = [installed, observation({ section: "queue", status: 0, body: null }), healthyApp];
    expect(report(unavailable, true).exitCode).toBe(EXIT.unavailable);

    const signedOut = [installed, observation({ section: "queue", status: 401, body: {} }), healthyApp];
    expect(report(signedOut, true).exitCode).toBe(EXIT.authRequired);
  });
});
