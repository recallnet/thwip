import { describe, expect, it } from "vitest";
import { EXIT } from "./queue-exit.js";
import { isMutating, MUTATING_SUBCOMMANDS, planQueueCommand } from "./queue-commands.js";

/**
 * Parsing is where the damaging mistakes live. A destructive command that ran with
 * a silently defaulted argument, or an administrative one that accepted a blank
 * reason, would do real harm to a real repository — so these tests are about
 * refusals far more than about happy paths.
 */

const REPO = ["--repo", "recallnet/thwip"];

function plan(argv: string[]) {
  const result = planQueueCommand(argv);
  if (!result.ok) throw new Error(`expected a plan, got: ${result.message}`);
  return result.plan;
}

describe("shape", () => {
  it("requires a subcommand", () => {
    expect(planQueueCommand([])).toMatchObject({ ok: false, exitCode: EXIT.usage });
  });

  it("rejects an unknown subcommand rather than guessing", () => {
    const result = planQueueCommand(["destroy", ...REPO]);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.message).toMatch(/unknown subcommand/);
  });

  it("rejects an unknown flag rather than ignoring it", () => {
    // A silently dropped flag is how a command does something other than asked.
    const result = planQueueCommand(["status", ...REPO, "--forse", "yes"]);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.message).toMatch(/unknown flag --forse/);
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
      expect(planQueueCommand([...argv])).toMatchObject({ ok: false });
    });

    it(`${name} rejects a blank reason`, () => {
      expect(planQueueCommand([...argv, "--reason", "   "])).toMatchObject({ ok: false });
    });

    it(`${name} rejects a one-word reason that only looks like a justification`, () => {
      const result = planQueueCommand([...argv, "--reason", "broken"]);
      expect(result).toMatchObject({ ok: false });
      if (!result.ok) expect(result.message).toMatch(/explain why/);
    });

    it(`${name} accepts a real reason`, () => {
      expect(planQueueCommand([...argv, "--reason", "release freeze for the 2.0 cut"])).toMatchObject({
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
    expect(planQueueCommand([...base, "--confirm", "recallnet/thwip#43"])).toMatchObject({ ok: false });
  });

  it("refuses a confirmation for a different repository", () => {
    expect(planQueueCommand([...base, "--confirm", "someone/else#42"])).toMatchObject({ ok: false });
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
    const result = planQueueCommand(["rebaseline", ...REPO, "--reason", "external push by an admin"]);
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
    expect(plan(["doctor", ...REPO]).requiresAdmin).toBe(true);
  });

  it("does not require admin for a developer's own queue actions", () => {
    expect(plan(["status", ...REPO]).requiresAdmin).toBe(false);
    expect(plan(["join", ...REPO, "--pr", "1"]).requiresAdmin).toBe(false);
    expect(plan(["leave", ...REPO, "--pr", "1"]).requiresAdmin).toBe(false);
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

  it("produces the same key for the same command twice", () => {
    const argv = ["pause", ...REPO, "--reason", "incident under way"];
    expect(plan(argv).idempotencyKey).toBe(plan(argv).idempotencyKey);
  });

  it("produces different keys for different branches", () => {
    const a = plan(["pause", ...REPO, "--branch", "main", "--reason", "incident under way"]);
    const b = plan(["pause", ...REPO, "--branch", "release", "--reason", "incident under way"]);
    expect(b.idempotencyKey).not.toBe(a.idempotencyKey);
  });
});

describe("isMutating", () => {
  it("agrees with the plans that carry an idempotency key", () => {
    for (const subcommand of MUTATING_SUBCOMMANDS) expect(isMutating(subcommand)).toBe(true);
    for (const subcommand of ["status", "list", "doctor"]) expect(isMutating(subcommand)).toBe(false);
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
