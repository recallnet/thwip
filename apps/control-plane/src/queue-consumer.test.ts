import { describe, expect, it } from "vitest";
import { processQueueMessage } from "./queue-consumer.js";

/**
 * The production loop lives in `index.ts` because it owns ack and retry per
 * message. Driving `processQueueMessage` directly keeps this suite on the same
 * function production calls, rather than a second loop that could drift.
 */
async function runMessages(messages: Parameters<typeof processQueueMessage>[0][], deps: Parameters<typeof processQueueMessage>[2] = {}): Promise<void> {
  const synced = new Set<string>();
  for (const body of messages) await processQueueMessage(body, synced, deps);
}
import type { AppProofRequest } from "./app-proof-verification.js";

const REQUEST: AppProofRequest = {
  repositoryId: "repo-1",
  repository: "acme/widgets",
  ownerId: "owner-1",
  installationId: "42",
  subjectSha: "a".repeat(40),
  baseRef: "main",
  pullRequestNumber: 53,
};

describe("queue consumer", () => {
  it("does not re-read the installation for a proof task that changed nothing about it", async () => {
    const synced: string[] = [];
    await runMessages(
      [{ event: "check_run", installationId: "42", appProofTask: { kind: "verify", request: REQUEST }, syncInstallation: false }],
      { syncInstallation: async (id: string) => { synced.push(id); } },
    );
    expect(synced).toEqual([]);
  });

  it("re-reads the installation when the installation itself changed", async () => {
    const synced: string[] = [];
    await runMessages(
      [{ event: "installation_repositories", installationId: "42", syncInstallation: true }],
      { syncInstallation: async (id: string) => { synced.push(id); } },
    );
    expect(synced).toEqual(["42"]);
  });

  it("does not sync twice for two messages carrying the same installation and flag", async () => {
    const synced: string[] = [];
    await runMessages(
      [
        { event: "installation_repositories", installationId: "42", syncInstallation: true },
        { event: "installation_repositories", installationId: "42", syncInstallation: true },
      ],
      { syncInstallation: async (id: string) => { synced.push(id); } },
    );
    expect(synced).toEqual(["42"]);
  });

  it("reconciles proof checks after a membership event that also syncs the installation", async () => {
    const reconciled: string[] = [];
    await runMessages(
      [{ event: "member", installationId: "42", syncInstallation: true }],
      {
        syncInstallation: async () => {},
        reconcileInstallationProofChecks: async (id: string) => { reconciled.push(id); },
      },
    );
    expect(reconciled).toEqual(["42"]);
  });

  it("reconciles policies and proof checks for a dashboard full-sync follow-up", async () => {
    const work: string[] = [];
    await runMessages(
      [{ event: "policy_reconcile", installationId: "42" }],
      {
        reconcileInstallationPolicies: async (id: string) => {
          work.push(`policies:${id}`);
        },
        reconcileInstallationProofChecks: async (id: string) => {
          work.push(`proofs:${id}`);
        },
      },
    );
    expect(work).toEqual(["policies:42", "proofs:42"]);
  });
});
