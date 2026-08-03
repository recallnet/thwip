import { describe, expect, it } from "vitest";
import {
  queueInstructions,
  queuePointer,
  queueSetupPrompt,
  withQueuePointer,
  type QueueInstructionFacts,
} from "./queue.js";

function facts(over: Partial<QueueInstructionFacts> = {}): QueueInstructionFacts {
  return {
    repositoryName: "recallnet/thwip",
    baseRef: "refs/heads/main",
    backend: "managed",
    activationState: "enforced",
    hasDaggerModule: true,
    ...over,
  };
}

describe("queueInstructions", () => {
  it("names the branch it governs, without the ref prefix", () => {
    const text = queueInstructions(facts());
    expect(text).toContain("merging of\n`main`");
    expect(text).not.toContain("refs/heads/main");
  });

  it("states every prohibition an agent could otherwise violate", () => {
    const text = queueInstructions(facts());
    for (const rule of [
      "Do not call `gh pr merge`",
      "Do not merge through the GitHub UI",
      "Do not push directly to `main`",
      "Do not manually rebase",
      "Do not amend or force-push a queued head",
    ]) {
      expect(text, `missing rule: ${rule}`).toContain(rule);
    }
  });

  it("says why force-pushing a queued head matters, not just that it is banned", () => {
    // A rule an agent understands is one it will not rationalize around.
    expect(queueInstructions(facts())).toMatch(/candidate someone is testing is the head you replaced/);
  });

  it("tells an agent that Ctrl-C is safe, so it does not avoid interrupting", () => {
    expect(queueInstructions(facts())).toMatch(/does not erase the queue request or lose your place/);
  });

  it("defines completion precisely", () => {
    expect(queueInstructions(facts())).toMatch(/complete only after `queue\.merge_confirmed`/);
  });

  it("forbids retrying around a signature or permission failure", () => {
    expect(queueInstructions(facts())).toMatch(/not conditions to retry around/);
  });

  it("explains that a pull request cannot approve its own policy change", () => {
    expect(queueInstructions(facts())).toMatch(/cannot approve its\n *own policy change/);
  });

  it("says the queue is only observing when it is, and still asks for the rules", () => {
    for (const activationState of ["observe", "configured"] as const) {
      const text = queueInstructions(facts({ activationState }));
      expect(text).toContain(`currently in \`${activationState}\``);
      expect(text).toMatch(/Follow these rules anyway/);
    }
  });

  it("says nothing about observing when the queue is enforcing", () => {
    for (const activationState of ["canary", "enforced"] as const) {
      expect(queueInstructions(facts({ activationState }))).not.toMatch(/would do without blocking/);
    }
  });

  it("adapts to a repository with no Dagger module", () => {
    const withModule = queueInstructions(facts({ hasDaggerModule: true }));
    const without = queueInstructions(facts({ hasDaggerModule: false }));
    expect(withModule).toContain("approved Dagger pipeline");
    expect(without).toContain("approved required suites");
    expect(without).not.toContain("Dagger material");
  });

  it("refuses to promise a permanent queue position", () => {
    expect(queueInstructions(facts())).toMatch(/no permanent\nposition/);
  });
});

describe("queuePointer", () => {
  it("is delimited so a later version can find and replace it", () => {
    const pointer = queuePointer();
    expect(pointer.startsWith("<!-- thwip:start -->")).toBe(true);
    expect(pointer.trimEnd().endsWith("<!-- thwip:end -->")).toBe(true);
  });

  it("stays small: it points at THWIP.md rather than restating it", () => {
    expect(queuePointer().split("\n")).toHaveLength(5);
  });
});

describe("withQueuePointer", () => {
  it("appends to an existing file without disturbing it", () => {
    const existing = "# Agents\n\nRun the tests before you finish.\n";
    const updated = withQueuePointer(existing);
    expect(updated.startsWith(existing)).toBe(true);
    expect(updated).toContain(queuePointer());
  });

  it("is idempotent, so re-running setup produces no diff", () => {
    const once = withQueuePointer("# Agents\n\nSomething.\n");
    expect(withQueuePointer(once)).toBe(once);
    expect(withQueuePointer(withQueuePointer(once))).toBe(once);
  });

  it("replaces an outdated pointer in place, keeping surrounding text", () => {
    const stale = [
      "# Agents",
      "",
      "Before you start, read the README.",
      "",
      "<!-- thwip:start -->",
      "Something we used to say.",
      "<!-- thwip:end -->",
      "",
      "Afterwards, update the changelog.",
      "",
    ].join("\n");
    const updated = withQueuePointer(stale);
    expect(updated).toContain("Before you start, read the README.");
    expect(updated).toContain("Afterwards, update the changelog.");
    expect(updated).not.toContain("Something we used to say.");
    expect(updated).toContain("read `THWIP.md`");
  });

  it("leaves a malformed remnant alone rather than guessing", () => {
    // One delimiter without the other could mean anything; editing it could
    // destroy authored text.
    const malformed = "# Agents\n\n<!-- thwip:start -->\nhalf a pointer\n";
    const updated = withQueuePointer(malformed);
    expect(updated).toContain("half a pointer");
    expect(updated.match(/<!-- thwip:start -->/g)).toHaveLength(2);
  });

  it("does not double a blank line when appending", () => {
    expect(withQueuePointer("# Agents\n\n")).toBe("# Agents\n\n" + queuePointer() + "\n");
    expect(withQueuePointer("# Agents\n")).toBe("# Agents\n\n" + queuePointer() + "\n");
  });

  it("handles a file with no trailing newline", () => {
    const updated = withQueuePointer("# Agents");
    expect(updated.startsWith("# Agents\n\n")).toBe(true);
    expect(updated).toContain(queuePointer());
  });
});

describe("queueSetupPrompt", () => {
  it("tells the agent to find a conflicting auto-merge system first", () => {
    expect(queueSetupPrompt("recallnet/thwip")).toMatch(/second auto-merge system\n *racing the queue/);
  });

  it("insists the proposed configuration cannot judge itself", () => {
    expect(queueSetupPrompt("recallnet/thwip")).toMatch(/must not judge itself/);
  });

  it("is explicit about what only the owner can do", () => {
    const prompt = queueSetupPrompt("recallnet/thwip");
    expect(prompt).toMatch(/merge the setup pull request/);
    expect(prompt).toMatch(/THWIP_ENQUEUE_TOKEN repository secret/);
    expect(prompt).toMatch(/grant the thwip App "checks: write"/);
  });

  /**
   * The bootstrap route builds the ruleset now. A prompt that still told an
   * agent to hand-build it would produce a ruleset enrolment then refuses to
   * replace, which is the branch nobody can merge on.
   */
  it("sends ruleset work to enrolment rather than to the agent", () => {
    const prompt = queueSetupPrompt("recallnet/thwip");
    expect(prompt).toMatch(/It builds the branch ruleset itself/);
    expect(prompt).toMatch(/Do\n *not edit that ruleset by hand/);
    // GitHub can only pin a context to its source after that source has
    // published the check, and the prompt says who handles that ordering.
    expect(prompt).toMatch(/pins each to the source that publishes it/);
  });

  it("names the request that enrols the repository", () => {
    const prompt = queueSetupPrompt("recallnet/thwip");
    expect(prompt).toContain("/v1/queue/<repository id>/bootstrap");
    expect(prompt).toMatch(/"Set up" tab/);
  });

  /**
   * The prompt may only name checks that something publishes. It used to name
   * "Thwip / Merge", from a path that was never built, so an agent following it
   * would have required a check nothing could ever satisfy.
   */
  it("names the checks that exist and no others", () => {
    const prompt = queueSetupPrompt("recallnet/thwip");
    expect(prompt).toContain("thwip / turn");
    expect(prompt).not.toContain("Thwip / Merge");
  });

  it("only tells the agent to run commands the CLI has", () => {
    const prompt = queueSetupPrompt("recallnet/thwip");
    for (const missing of ["thwip queue repair", "--watch"]) {
      expect(prompt, missing).not.toContain(missing);
    }
    expect(prompt).toContain("thwip queue doctor");
    expect(prompt).toContain("thwip queue setup --write");
  });

  it("asks for proof before the checks are made required", () => {
    expect(queueSetupPrompt("recallnet/thwip")).toMatch(
      /required check that\n *nothing publishes blocks every merge/,
    );
  });

  it("tells the agent to preserve what someone else authored", () => {
    const prompt = queueSetupPrompt("recallnet/thwip");
    expect(prompt).toMatch(/drop a rule or a required check somebody else added/);
    expect(prompt).toMatch(/Do not rewrite instructions\n *someone else authored/);
  });
});
