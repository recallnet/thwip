import { describe, expect, it } from "vitest";
import { EXIT } from "./queue-exit.js";
import { planQueueCommand } from "./queue-commands.js";

/**
 * Parsing is where the damaging mistakes live. A destructive command that ran with
 * a silently defaulted argument, or an administrative one that accepted a blank
 * reason, would do real harm to a real repository — so these tests are about
 * refusals far more than about happy paths.
 */

const REPO = ["--repo", "recallnet/thwip"];

function planWith(argv: string[], nonce: string) {
  const result = planQueueCommand(argv, { nonce });
  if (!result.ok) throw new Error(`expected a plan, got: ${result.message}`);
  return result.plan;
}

/** Most cases here do not care which invocation they are. */
function plan(argv: string[]) {
  return planWith(argv, "test-nonce");
}

describe("shape", () => {
  it("requires a subcommand", () => {
    expect(planQueueCommand([], { nonce: "test-nonce" })).toMatchObject({ ok: false, exitCode: EXIT.usage });
  });

  it("rejects an unknown subcommand rather than guessing", () => {
    const result = planQueueCommand(["destroy", ...REPO], { nonce: "test-nonce" });
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.message).toMatch(/unknown subcommand/);
  });

  it("rejects an unknown flag rather than ignoring it", () => {
    // A silently dropped flag is how a command does something other than asked.
    const result = planQueueCommand(["status", ...REPO, "--forse", "yes"], { nonce: "test-nonce" });
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.message).toMatch(/unknown flag --forse/);
  });

  it("rejects unexpected positional and short-flag arguments", () => {
    expect(planQueueCommand(["status", ...REPO, "surprise"], { nonce: "test-nonce" })).toMatchObject({ ok: false });
    expect(planQueueCommand(["status", ...REPO, "-x"], { nonce: "test-nonce" })).toMatchObject({ ok: false });
  });

  it("requires a well-formed repository", () => {
    for (const repo of ["thwip", "recallnet/", "/thwip", "recallnet/thwip/extra", ""]) {
      expect(planQueueCommand(["status", "--repo", repo]), repo).toMatchObject({ ok: false });
    }
  });

  it("defaults the branch to main and honours --branch", () => {
    expect(plan(["status", ...REPO]).path).toContain(encodeURIComponent("refs/heads/main"));
    expect(plan(["status", ...REPO, "--branch", "release"]).path).toContain(
      encodeURIComponent("refs/heads/release"),
    );
  });
});

describe("pull request numbers", () => {
  it("requires a positive integer", () => {
    for (const pr of ["0", "-1", "abc", "1.5", "", "1e3"]) {
      expect(planQueueCommand(["join", ...REPO, "--pr", pr]), pr).toMatchObject({ ok: false });
    }
  });

  it("accepts a normal number", () => {
    expect(plan(["join", ...REPO, "--pr", "42"]).body).toMatchObject({ pullRequestNumber: 42 });
  });
});

describe("reasons", () => {
  const needsReason = [
    ["pause", ["pause", ...REPO]],
    ["eject", ["eject", ...REPO, "--pr", "42"]],
    ["rebaseline", ["rebaseline", ...REPO, "--base-sha", "a".repeat(40)]],
  ] as const;

  for (const [name, argv] of needsReason) {
    it(`${name} requires a reason`, () => {
      expect(planQueueCommand([...argv], { nonce: "test-nonce" })).toMatchObject({ ok: false });
    });

    it(`${name} rejects a blank reason`, () => {
      expect(planQueueCommand([...argv, "--reason", "   "], { nonce: "test-nonce" })).toMatchObject({ ok: false });
    });

    it(`${name} rejects a one-word reason that only looks like a justification`, () => {
      const result = planQueueCommand([...argv, "--reason", "broken"], { nonce: "test-nonce" });
      expect(result).toMatchObject({ ok: false });
      if (!result.ok) expect(result.message).toMatch(/explain why/);
    });

    it(`${name} accepts a real reason`, () => {
      expect(planQueueCommand([...argv, "--reason", "release freeze for the 2.0 cut"], { nonce: "test-nonce" })).toMatchObject({
        ok: true,
      });
    });
  }

  it("rejects a reason over the signed bound", () => {
    expect(
      planQueueCommand(["pause", ...REPO, "--reason", "x".repeat(513)]),
    ).toMatchObject({ ok: false });
  });
});

describe("bypass", () => {
  const base = ["bypass", ...REPO, "--pr", "42", "--reason", "verifier outage during a freeze"];

  it("refuses without an exact confirmation", () => {
    const result = planQueueCommand(base);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.message).toMatch(/--confirm recallnet\/thwip#42/);
  });

  it("refuses a confirmation for a different pull request", () => {
    expect(planQueueCommand([...base, "--confirm", "recallnet/thwip#43"], { nonce: "test-nonce" })).toMatchObject({ ok: false });
  });

  it("refuses a confirmation for a different repository", () => {
    expect(planQueueCommand([...base, "--confirm", "someone/else#42"], { nonce: "test-nonce" })).toMatchObject({ ok: false });
  });

  it("refuses a generic force-style confirmation", () => {
    // A `--confirm yes` could be recalled from shell history; a target cannot be
    // typed by accident.
    for (const confirm of ["yes", "true", "force", "1", ""]) {
      expect(planQueueCommand([...base, "--confirm", confirm]), confirm).toMatchObject({ ok: false });
    }
  });

  it("accepts the exact target", () => {
    const p = plan([...base, "--confirm", "recallnet/thwip#42"]);
    expect(p.requiresAdmin).toBe(true);
    expect(p.body).toMatchObject({ pullRequestNumber: 42 });
  });

  it("still requires a reason even with a correct confirmation", () => {
    expect(
      planQueueCommand([
        "bypass",
        ...REPO,
        "--pr",
        "42",
        "--confirm",
        "recallnet/thwip#42",
      ]),
    ).toMatchObject({ ok: false });
  });
});

describe("rebaseline", () => {
  it("requires the base sha the queue should adopt", () => {
    const result = planQueueCommand(["rebaseline", ...REPO, "--reason", "external push by an admin"], { nonce: "test-nonce" });
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.message).toMatch(/--base-sha/);
  });

  it("rejects a malformed object id", () => {
    for (const sha of ["abc", "A".repeat(40), "a".repeat(39), "a".repeat(41)]) {
      expect(
        planQueueCommand(["rebaseline", ...REPO, "--reason", "external push happened", "--base-sha", sha]),
        sha,
      ).toMatchObject({ ok: false });
    }
  });
});

describe("authority", () => {
  it("marks administrative commands as requiring admin", () => {
    expect(plan(["pause", ...REPO, "--reason", "incident under way"]).requiresAdmin).toBe(true);
    expect(plan(["resume", ...REPO]).requiresAdmin).toBe(true);
    expect(plan(["eject", ...REPO, "--pr", "1", "--reason", "abandoned by its author"]).requiresAdmin).toBe(true);
  });

  it("does not require admin for a developer's own queue actions", () => {
    expect(plan(["status", ...REPO]).requiresAdmin).toBe(false);
    expect(plan(["join", ...REPO, "--pr", "1"]).requiresAdmin).toBe(false);
    expect(plan(["leave", ...REPO, "--pr", "1"]).requiresAdmin).toBe(false);
  });

  it("lets a member run the diagnostic, because the people who need it are members", () => {
    // Doctor sent the developer's session to an operator-only endpoint, so it
    // failed for exactly the people most likely to be asking what is wrong.
    const doctor = plan(["doctor", ...REPO]);
    expect(doctor.requiresAdmin).toBe(false);
    expect(doctor.path).not.toContain("/admin/");
  });
});

describe("idempotency", () => {
  it("gives every mutation a key, so a retry is one effect", () => {
    const mutations = [
      ["join", ...REPO, "--pr", "1"],
      ["leave", ...REPO, "--pr", "1"],
      ["pause", ...REPO, "--reason", "incident under way"],
      ["resume", ...REPO],
      ["rebaseline", ...REPO, "--reason", "external push happened", "--base-sha", "a".repeat(40)],
      ["eject", ...REPO, "--pr", "1", "--reason", "abandoned by its author"],
      ["bypass", ...REPO, "--pr", "1", "--reason", "verifier outage today", "--confirm", "recallnet/thwip#1"],
    ];
    for (const argv of mutations) {
      expect(plan(argv).idempotencyKey, argv[0]).toBeDefined();
    }
  });

  it("gives reads no key, because they change nothing", () => {
    expect(plan(["status", ...REPO]).idempotencyKey).toBeUndefined();
    expect(plan(["doctor", ...REPO]).idempotencyKey).toBeUndefined();
  });

  /**
   * The one that left a lane paused. `key(["resume", repo, ref])` never changed,
   * so the second resume of a lane was indistinguishable from a retry of the
   * first: the control plane answered `duplicate` and the queue stayed stopped.
   * Two runs of a command are two intents, and the operator meant the second one
   * as much as the first.
   */
  it("gives two runs of the same command different keys", () => {
    const argv = ["resume", ...REPO];
    expect(planWith(argv, "second").idempotencyKey).not.toBe(planWith(argv, "first").idempotencyKey);
  });

  it("still produces one key per invocation, so a resent request applies once", () => {
    const argv = ["pause", ...REPO, "--reason", "incident under way"];
    expect(planWith(argv, "n1").idempotencyKey).toBe(planWith(argv, "n1").idempotencyKey);
  });

  /**
   * A command that names the state it wants keeps a key derived from that state.
   * Asking twice for the same base, or for the same merge to be reconciled, is
   * the same request both times, and repeating it must not produce a second
   * record of the same decision.
   */
  it("keeps a key that names a target state stable across invocations", () => {
    const rebaseline = ["rebaseline", ...REPO, "--reason", "external push happened", "--base-sha", "a".repeat(40)];
    expect(planWith(rebaseline, "second").idempotencyKey).toBe(planWith(rebaseline, "first").idempotencyKey);
  });

  it("produces different keys for different branches", () => {
    const a = planWith(["pause", ...REPO, "--branch", "main", "--reason", "incident under way"], "n1");
    const b = planWith(["pause", ...REPO, "--branch", "release", "--reason", "incident under way"], "n1");
    expect(b.idempotencyKey).not.toBe(a.idempotencyKey);
  });
});

describe("explain", () => {
  it("is a read, needs no admin, and defaults its event count", () => {
    const p = plan(["explain", ...REPO]);
    expect(p.method).toBe("GET");
    expect(p.requiresAdmin).toBe(false);
    expect(p.idempotencyKey).toBeUndefined();
    expect(p.path).toContain("events=25");
  });

  it("rejects a silly event count", () => {
    expect(planQueueCommand(["explain", ...REPO, "--events", "abc"], { nonce: "test-nonce" })).toMatchObject({ ok: false });
    expect(planQueueCommand(["explain", ...REPO, "--events", "99999"], { nonce: "test-nonce" })).toMatchObject({ ok: false });
  });
});

describe("reconcile", () => {
  const base = ["reconcile", ...REPO, "--reason", "the merge was refused with 405"];

  it("requires a recognised observation", () => {
    expect(planQueueCommand([...base, "--observed", "probably"], { nonce: "test-nonce" })).toMatchObject({ ok: false });
  });

  it("requires a merge sha for anything but not-merged", () => {
    expect(planQueueCommand([...base, "--observed", "merged"], { nonce: "test-nonce" })).toMatchObject({ ok: false });
    expect(
      planQueueCommand([...base, "--observed", "merged", "--merge-sha", "a".repeat(40)]),
    ).toMatchObject({ ok: true });
    expect(planQueueCommand([...base, "--observed", "not-merged"], { nonce: "test-nonce" })).toMatchObject({ ok: true });
  });

  it("requires a reason and admin standing", () => {
    expect(planQueueCommand(["reconcile", ...REPO, "--observed", "not-merged"], { nonce: "test-nonce" })).toMatchObject({ ok: false });
    expect(plan([...base, "--observed", "not-merged"]).requiresAdmin).toBe(true);
  });
});

describe("work", () => {
  it("requires --watch, because there is nothing else for it to do yet", () => {
    const result = planQueueCommand(["work", ...REPO], { nonce: "test-nonce" });
    expect(result).toMatchObject({ ok: false, exitCode: EXIT.usage });
    if (!result.ok) expect(result.message).toMatch(/--watch/);
  });

  it("requires a well-formed repository", () => {
    expect(planQueueCommand(["work", "--watch"], { nonce: "test-nonce" })).toMatchObject({ ok: false });
  });

  it("rejects an unknown flag rather than ignoring it", () => {
    expect(planQueueCommand(["work", ...REPO, "--watch", "--forse", "yes"], { nonce: "test-nonce" })).toMatchObject({ ok: false });
  });

  it("names the heartbeat endpoint once --watch is present", () => {
    const result = plan(["work", ...REPO, "--watch"]);
    expect(result.method).toBe("POST");
    expect(result.path).toContain("/runners/heartbeat");
    expect(result.requiresAdmin).toBe(false);
  });
});

describe("methods", () => {
  it("uses the method that matches the effect", () => {
    expect(plan(["status", ...REPO]).method).toBe("GET");
    expect(plan(["join", ...REPO, "--pr", "1"]).method).toBe("POST");
    expect(plan(["leave", ...REPO, "--pr", "1"]).method).toBe("DELETE");
    expect(plan(["eject", ...REPO, "--pr", "1", "--reason", "abandoned by its author"]).method).toBe("DELETE");
  });
});
