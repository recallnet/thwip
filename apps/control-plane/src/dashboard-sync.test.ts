import { describe, expect, it, vi } from "vitest";
import { runDashboardSync } from "./dashboard-sync.js";

describe("dashboard full sync", () => {
  it("projects the installation, then queues policy and proof reconciliation", async () => {
    const order: string[] = [];
    const enqueueReconciliation = vi.fn(async () => {
      order.push("reconcile");
    });

    await expect(
      runDashboardSync("149708815", {
        syncInstallation: async () => {
          order.push("sync");
          return { members: 9, teams: 2, repos: 5, grants: 40 };
        },
        enqueueReconciliation,
      }),
    ).resolves.toEqual({
      synced: { members: 9, teams: 2, repos: 5, grants: 40 },
      reconciliation: "queued",
    });
    expect(order).toEqual(["sync", "reconcile"]);
    expect(enqueueReconciliation).toHaveBeenCalledWith({
      event: "policy_reconcile",
      installationId: "149708815",
    });
  });

  it("does not queue follow-up work when the installation projection fails", async () => {
    const enqueueReconciliation = vi.fn(async () => undefined);
    await expect(
      runDashboardSync("149708815", {
        syncInstallation: async () => {
          throw new Error("GitHub unavailable");
        },
        enqueueReconciliation,
      }),
    ).rejects.toThrow("GitHub unavailable");
    expect(enqueueReconciliation).not.toHaveBeenCalled();
  });

  it("does not claim success unless the durable follow-up was accepted", async () => {
    await expect(
      runDashboardSync("149708815", {
        syncInstallation: async () => ({ repos: 5 }),
        enqueueReconciliation: async () => {
          throw new Error("queue unavailable");
        },
      }),
    ).rejects.toThrow("queue unavailable");
  });
});
