import { describe, expect, it } from "vitest";
import { EXIT } from "./queue-exit.js";
import { isNonFastForward, planPush, type DivergedTips } from "./push-plan.js";

/**
 * Ship amends HEAD to attach the proof, so on a branch that is already on the
 * remote the very next push is rejected as non-fast-forward. Ship caused that
 * divergence, so it is the one thing here it may resolve on its own.
 */

const REJECTED = [
  "To github.com:acme/widgets.git",
  " ! [rejected]        HEAD -> topic (non-fast-forward)",
  "error: failed to push some refs to 'github.com:acme/widgets.git'",
  "hint: Updates were rejected because a pushed branch tip is behind its remote counterpart.",
].join("\n");

const DENIED = [
  "ERROR: Permission to acme/widgets.git denied to nobody.",
  "fatal: Could not read from remote repository.",
].join("\n");

function tips(over: Partial<DivergedTips> = {}): DivergedTips {
  return {
    branch: "topic",
    localSha: "a".repeat(40),
    localParents: ["p".repeat(40)],
    remoteSha: "b".repeat(40),
    remoteParents: ["p".repeat(40)],
    ...over,
  };
}

describe("reading what git said", () => {
  it("tells a non-fast-forward rejection from any other refusal", () => {
    expect(isNonFastForward(REJECTED)).toBe(true);
    expect(isNonFastForward(DENIED)).toBe(false);
    expect(isNonFastForward("")).toBe(false);
  });
});

describe("what to do about a rejected push", () => {
  it("does nothing more when the push went through", () => {
    expect(planPush({ ok: true, stderr: "" }, tips())).toEqual({ kind: "done" });
  });

  it("forces with a lease when the remote tip is the commit the proof rewrote", () => {
    // Same parents, different commit: that is what `git commit --amend` leaves
    // behind and nothing else does. The remote tip is this branch's own previous
    // tip, so replacing it destroys no work that was not already replaced.
    const plan = planPush({ ok: false, stderr: REJECTED }, tips());
    expect(plan).toMatchObject({ kind: "force-with-lease", branch: "topic", expect: "b".repeat(40) });
  });

  it("names the exact commit the lease must find, so a push that raced this one wins", () => {
    const plan = planPush({ ok: false, stderr: REJECTED }, tips({ remoteSha: "c".repeat(40) }));
    expect(plan).toMatchObject({ kind: "force-with-lease", expect: "c".repeat(40) });
  });

  it("stops rather than overwrite a commit this machine never had", () => {
    // Different parents means the remote tip is built on something else, so
    // somebody pushed. Forcing here throws away their work.
    const plan = planPush({ ok: false, stderr: REJECTED }, tips({ remoteParents: ["q".repeat(40)] }));
    expect(plan).toMatchObject({ kind: "stop", reasonCode: "PUSH_REJECTED", exitCode: EXIT.sourceChanged });
    expect(plan.kind === "stop" && plan.why.length).toBeGreaterThan(0);
  });

  it("stops when it cannot read the remote tip, because a lease needs one to name", () => {
    const plan = planPush({ ok: false, stderr: REJECTED }, tips({ remoteSha: null, remoteParents: [] }));
    expect(plan).toMatchObject({ kind: "stop", reasonCode: "PUSH_REJECTED" });
  });

  it("classifies a refusal that is not about fast-forwarding, and quotes what git printed", () => {
    const plan = planPush({ ok: false, stderr: DENIED }, tips());
    expect(plan).toMatchObject({ kind: "stop", reasonCode: "LOCAL_FAILURE", exitCode: EXIT.invariant });
    expect(plan.kind === "stop" && plan.detail).toContain("Permission to acme/widgets.git denied");
  });

  it("never forces over a root commit, where having no parents proves nothing", () => {
    const plan = planPush({ ok: false, stderr: REJECTED }, tips({ localParents: [], remoteParents: [] }));
    expect(plan).toMatchObject({ kind: "stop", reasonCode: "PUSH_REJECTED" });
  });

  it("never forces when the two tips are the same commit", () => {
    const plan = planPush({ ok: false, stderr: REJECTED }, tips({ remoteSha: "a".repeat(40) }));
    expect(plan.kind).toBe("stop");
  });
});
