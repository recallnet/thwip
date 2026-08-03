import { describe, expect, it } from "vitest";

import { INSTALLATION_STATE_EVENTS, webhookWork } from "./webhook-work.js";

const base = { delivery: "d1", installationId: "42" };

describe("webhookWork", () => {
  /**
   * The event that drained ten thousand operations in a day. The App publishes
   * six checks per commit, GitHub fires a check_run webhook for each one, and
   * every webhook used to cost a queue write and an installation sync while
   * carrying nothing the consumer would act on.
   */
  it("skips a completed check_run for a check the App does not verify", () => {
    expect(
      webhookWork("check_run", { action: "completed", check_run: { name: "some-other-ci" } }, base),
    ).toBeNull();
  });

  it("keeps a rerequested thwip check, because the consumer reruns the proof", () => {
    const work = webhookWork(
      "check_run",
      { action: "rerequested", check_run: { name: "thwip", external_id: "proof-verification:abcd1234" } },
      base,
    );
    // Asserted through a non-optional read. `work?.appProofTask` would also
    // satisfy `not.toBeNull()` when `work` is null, which is the one shape this
    // test exists to rule out.
    expect(work).not.toBeNull();
    expect(work!.appProofTask).toEqual({ kind: "rerequest", verificationId: "abcd1234" });
  });

  it("keeps a pull_request event, because a proof check hangs on it", () => {
    const work = webhookWork(
      "pull_request",
      { action: "opened", repository: { id: 1315419165 }, pull_request: { number: 1 } },
      base,
    );
    expect(work).not.toBeNull();
  });

  it("keeps a default-branch push, because policy activates from it", () => {
    const work = webhookWork(
      "push",
      { ref: "refs/heads/main", repository: { id: 1315419165, default_branch: "main" } },
      base,
    );
    expect(work?.reconcileProofRepositoryId).toBe("1315419165");
  });

  it("keeps a membership change, because the consumer reconciles proof checks for it", () => {
    expect(webhookWork("membership", { action: "added" }, base)).not.toBeNull();
  });

  it("keeps an installation change, because it is what actually changes installation state", () => {
    for (const event of INSTALLATION_STATE_EVENTS) {
      expect(webhookWork(event, { action: "created" }, base)).not.toBeNull();
    }
  });

  it("skips an event the consumer has no branch for", () => {
    expect(webhookWork("star", { action: "created" }, base)).toBeNull();
  });

  /**
   * A message with no installation id cannot be acted on: every branch in the
   * consumer that does work either needs the installation or a repository the
   * payload names.
   */
  it("skips a check_run rerequest with no installation", () => {
    expect(
      webhookWork(
        "check_run",
        { action: "rerequested", check_run: { name: "thwip", external_id: "proof-verification:abcd1234" } },
        { delivery: "d1", installationId: null },
      ),
    ).toBeNull();
  });
});
