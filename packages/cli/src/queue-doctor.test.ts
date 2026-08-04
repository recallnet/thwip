import { describe, expect, it } from "vitest";
import { EXIT } from "./queue-exit.js";
import { doctorProbes, reportDoctor, type DoctorObservation } from "./queue-doctor.js";

/**
 * `thwip queue doctor` used to be one request to an operator-only endpoint, so
 * the only people it answered for were the people who never needed to ask. It
 * now reads what a member may read, and says plainly which part it could not.
 */

const REPO = "acme/widgets";
const REF = "refs/heads/main";

function observation(over: Partial<DoctorObservation> & Pick<DoctorObservation, "section">): DoctorObservation {
  return { status: 200, body: {}, ...over };
}

const installed = observation({ section: "repository", body: { repositoryId: "12345" } });
const running = observation({
  section: "queue",
  body: { snapshot: { paused: false, pauseReason: null, activeAttemptId: null, entries: [] }, why: [] },
});

describe("what doctor asks for", () => {
  it("asks a member endpoint first, and only then the one that needs admin", () => {
    const probes = doctorProbes({ repo: REPO, ref: REF, events: 5 });
    expect(probes.map((p) => p.section)).toEqual(["repository", "queue", "app"]);
    expect(probes.filter((p) => !p.requiresAdmin).map((p) => p.section)).toEqual(["repository", "queue"]);
  });

  it("reads the queue through the route any member of the repository may call", () => {
    const [, queue] = doctorProbes({ repo: REPO, ref: REF, events: 5 });
    expect(queue?.path).toContain("/v1/queue/{repositoryId}/explain");
    expect(queue?.path).not.toContain("/admin/");
    expect(queue?.requiresAdmin).toBe(false);
  });
});

describe("what doctor reports", () => {
  it("runs to a clean finish for a member who cannot read App permissions", () => {
    const report = reportDoctor(
      [installed, running, observation({ section: "app", status: 403, body: { error: "repository admin required" } })],
      { repo: REPO, ref: REF, allowUnread: true },
    );
    expect(report.exitCode).toBe(EXIT.ok);
    expect(report.unread).toEqual(["app"]);
    expect(report.lines.join("\n")).toContain("repository admin");
  });

  it("still reports everything a member could see when the admin part is refused", () => {
    const report = reportDoctor(
      [
        installed,
        observation({
          section: "queue",
          body: {
            snapshot: { paused: true, pauseReason: "waiting on the release", activeAttemptId: null, entries: [] },
            why: [],
          },
        }),
        observation({ section: "app", status: 403, body: {} }),
      ],
      { repo: REPO, ref: REF, allowUnread: true },
    );
    const said = report.lines.join("\n");
    expect(said).toContain("paused");
    expect(said).toContain("waiting on the release");
  });

  it("names each entry and what is holding it", () => {
    const report = reportDoctor(
      [
        installed,
        observation({
          section: "queue",
          body: {
            snapshot: {
              paused: false,
              pauseReason: null,
              activeAttemptId: null,
              entries: [{ pullRequestNumber: 12, state: "Ready" }],
            },
            why: [{ pullRequestNumber: 12, state: "Ready", blockedBy: "REVIEW_REQUIRED" }],
          },
        }),
        observation({ section: "app", status: 403, body: {} }),
      ],
      { repo: REPO, ref: REF, allowUnread: true },
    );
    expect(report.lines.join("\n")).toContain("#12");
    expect(report.lines.join("\n")).toContain("Ask for a review");
  });

  it("counts what is still in the queue, not what the document remembers", () => {
    // The queue keeps merged and cancelled entries, and counting them reported
    // twenty-two pull requests waiting on a queue with one live entry.
    const report = reportDoctor(
      [
        installed,
        observation({
          section: "queue",
          body: {
            snapshot: {
              paused: false,
              pauseReason: null,
              activeAttemptId: null,
              entries: [
                { pullRequestNumber: 1, state: "Merged" },
                { pullRequestNumber: 2, state: "Cancelled" },
                { pullRequestNumber: 3, state: "Ready" },
              ],
            },
            why: [{ pullRequestNumber: 3, state: "Ready", blockedBy: "another entry holds the lane" }],
          },
        }),
        observation({ section: "app", status: 403, body: {} }),
      ],
      { repo: REPO, ref: REF, allowUnread: true },
    );
    const said = report.lines.join("\n");
    expect(said).toContain("1 waiting");
    expect(said).toContain("#3");
    expect(said).not.toContain("#1");
    expect(said).not.toContain("#2");
  });

  it("fails when thwip is not installed, because nothing below it can be read", () => {
    const report = reportDoctor([observation({ section: "repository", status: 404, body: {} })], {
      repo: REPO,
      ref: REF,
      allowUnread: true,
    });
    expect(report.exitCode).toBe(EXIT.setupInvalid);
    expect(report.lines.join("\n")).toContain(REPO);
  });

  it("fails when the App cannot publish the check the branch requires", () => {
    const report = reportDoctor(
      [
        installed,
        running,
        observation({
          section: "app",
          body: { missingPermissions: { checks: "write" }, canPublishMergeCheck: false, rulesets: [] },
        }),
      ],
      { repo: REPO, ref: REF, allowUnread: true },
    );
    expect(report.exitCode).toBe(EXIT.setupInvalid);
    expect(report.lines.join("\n")).toContain("checks");
  });

  it("fails on a section it could not read, and passes only when asked to allow that", () => {
    const refused: DoctorObservation[] = [installed, running, observation({ section: "app", status: 403, body: {} })];
    expect(reportDoctor(refused, { repo: REPO, ref: REF, allowUnread: false }).exitCode).toBe(EXIT.permission);
    expect(reportDoctor(refused, { repo: REPO, ref: REF, allowUnread: true }).exitCode).toBe(EXIT.ok);
  });

  it("reports a refused queue as unread rather than as a queue with nothing wrong", () => {
    const report = reportDoctor(
      [installed, observation({ section: "queue", status: 403, body: {} }), observation({ section: "app", status: 403, body: {} })],
      { repo: REPO, ref: REF, allowUnread: false },
    );
    expect(report.exitCode).toBe(EXIT.permission);
    expect(report.unread).toEqual(["queue", "app"]);
  });

  it("carries a status for every section, so nothing unread is filed as a pass", () => {
    const report = reportDoctor(
      [installed, running, observation({ section: "app", status: 403, body: {} })],
      { repo: REPO, ref: REF, allowUnread: true },
    );
    expect(report.sections.map((s) => [s.section, s.status])).toEqual([
      ["repository", "pass"],
      ["queue", "pass"],
      ["app", "unread"],
    ]);
  });

  it("marks a section fail rather than unread when the answer was read and was bad", () => {
    const report = reportDoctor(
      [
        installed,
        running,
        observation({
          section: "app",
          body: { missingPermissions: { checks: "write" }, canPublishMergeCheck: false, rulesets: [] },
        }),
      ],
      { repo: REPO, ref: REF, allowUnread: true },
    );
    expect(report.sections.find((s) => s.section === "app")?.status).toBe("fail");
  });

  it("does not let allow-unread forgive a control plane that never answered", () => {
    // Not being an admin is the caller's standing, which is what the opt-out is
    // for. A service that is down is not, and answering zero there would be the
    // same lie one layer along.
    const report = reportDoctor(
      [installed, observation({ section: "queue", status: 0, body: null }), observation({ section: "app", status: 0, body: null })],
      { repo: REPO, ref: REF, allowUnread: true },
    );
    expect(report.exitCode).toBe(EXIT.unavailable);
  });

  it("does not let allow-unread forgive an unauthenticated session", () => {
    const report = reportDoctor(
      [installed, observation({ section: "queue", status: 401, body: {} }), observation({ section: "app", status: 401, body: {} })],
      { repo: REPO, ref: REF, allowUnread: true },
    );
    expect(report.exitCode).toBe(EXIT.authRequired);
  });

  it("says the control plane was unreachable rather than reporting a healthy queue", () => {
    const report = reportDoctor([observation({ section: "repository", status: 0, body: null })], {
      repo: REPO,
      ref: REF,
      allowUnread: true,
    });
    expect(report.exitCode).toBe(EXIT.unavailable);
  });

  it("tells an unauthenticated caller to sign in rather than guessing at permissions", () => {
    const report = reportDoctor([observation({ section: "repository", status: 401, body: {} })], {
      repo: REPO,
      ref: REF,
      allowUnread: true,
    });
    expect(report.exitCode).toBe(EXIT.authRequired);
    expect(report.lines.join("\n")).toContain("thwip login");
  });
});
