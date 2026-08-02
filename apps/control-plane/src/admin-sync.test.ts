import { isReasonCode } from "@thwip/vocabulary";
import { describe, expect, it, vi } from "vitest";

import { reasonForGithubFailure, syncInstallations } from "./admin-sync.js";
import { GithubApiError } from "./github-error.js";

/**
 * `/admin/sync` returned 500 after it had already succeeded.
 *
 * It reconciles the policy, then reads open pull requests to publish the proof
 * check. That read needs a permission the installation may not hold, GitHub
 * answers 403, and the whole call reported failure. An operator reads that as
 * "the policy did not activate" and retries something that was already done.
 *
 * Two things were wrong. A later best-effort step decided the fate of a
 * completed reconcile, and a permission GitHub refused came back as an internal
 * error rather than `APP_PERMISSION_DRIFT`, the code that exists for it.
 */

const installations = [
  { id: 1, account: { login: "recallnet" } },
  { id: 2, account: { login: "other" } },
];

function steps(overrides: Partial<Parameters<typeof syncInstallations>[1]> = {}) {
  return {
    syncInstallation: vi.fn(async () => ({ repos: 3 })),
    reconcilePolicies: vi.fn(async () => ({ activated: 1 })),
    reconcileProofChecks: vi.fn(async () => 7),
    ...overrides,
  };
}

describe("reconciling every installation", () => {
  it("reports the reconcile it completed when the proof-check pass is refused", async () => {
    const dependencies = steps({
      reconcileProofChecks: vi.fn(async () => {
        throw new GithubApiError("recallnet/thwip/pulls", 403, "Resource not accessible by integration");
      }),
    });

    const result = await syncInstallations(installations, dependencies);

    const recallnet = result.installations["recallnet"]!;
    expect(recallnet.projection).toEqual({ repos: 3 });
    expect(recallnet.policies).toEqual({ activated: 1 });
    expect(recallnet.reconciled).toBe(true);
    expect(recallnet.proofChecks).toBeNull();
    expect(recallnet.proofChecksFailure?.reason).toBe("APP_PERMISSION_DRIFT");
  });

  it("keeps going to the next installation", async () => {
    const dependencies = steps({
      reconcileProofChecks: vi.fn(async (installationId: string) => {
        if (installationId === "1") throw new GithubApiError("recallnet/thwip/pulls", 403, "nope");
        return 7;
      }),
    });

    const result = await syncInstallations(installations, dependencies);

    expect(result.installations["other"]!.proofChecks).toBe(7);
    expect(result.installations["other"]!.proofChecksFailure).toBeUndefined();
  });

  /**
   * The whole point. A caller that throws here is the 500 an operator read as
   * "nothing was reconciled".
   */
  it("does not throw when a best-effort step fails", async () => {
    const dependencies = steps({
      reconcileProofChecks: vi.fn(async () => {
        throw new Error("something else entirely");
      }),
    });

    await expect(syncInstallations(installations, dependencies)).resolves.toBeDefined();
  });

  it("says a reconcile that genuinely failed did not happen", async () => {
    const dependencies = steps({
      reconcilePolicies: vi.fn(async () => {
        throw new GithubApiError("recallnet/thwip/contents/thwip.yaml", 403, "nope");
      }),
    });

    const result = await syncInstallations(installations, dependencies);

    expect(result.installations["recallnet"]!.reconciled).toBe(false);
    expect(result.installations["recallnet"]!.failure?.reason).toBe("APP_PERMISSION_DRIFT");
    expect(result.degraded).toBe(true);
  });

  it("is not degraded when every step ran", async () => {
    const result = await syncInstallations(installations, steps());
    expect(result.degraded).toBe(false);
    expect(result.installations["recallnet"]!.proofChecks).toBe(7);
  });
});

describe("what a GitHub refusal is called", () => {
  it("names a 403 as the permission drift it is", () => {
    expect(reasonForGithubFailure(new GithubApiError("/repos/a/b/pulls/1", 403, "nope"))).toBe(
      "APP_PERMISSION_DRIFT",
    );
  });

  /**
   * Not every failure has a status object attached yet, and the message is the
   * only thing several call sites carry. A 403 that reads as an internal error
   * because of where it was raised is the same defect in a different place.
   */
  it("reads the status out of the message when that is all there is", () => {
    expect(reasonForGithubFailure(new Error("GitHub /repos/a/b/pulls/1 -> 403: nope"))).toBe(
      "APP_PERMISSION_DRIFT",
    );
  });

  it("leaves anything else unnamed rather than guessing", () => {
    expect(reasonForGithubFailure(new Error("GitHub /repos/a/b -> 502: bad gateway"))).toBeNull();
    expect(reasonForGithubFailure(new Error("kaboom"))).toBeNull();
  });

  it("only ever answers with a code the rest of the system knows", () => {
    const reason = reasonForGithubFailure(new GithubApiError("/x", 403, ""));
    expect(reason).not.toBeNull();
    expect(isReasonCode(reason!)).toBe(true);
  });
});
