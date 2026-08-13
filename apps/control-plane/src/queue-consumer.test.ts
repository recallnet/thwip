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
  projectId: "project-1",
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

  it("acknowledges delayed membership work after an authoritative uninstall", async () => {
    const work: string[] = [];
    await runMessages(
      [
        { event: "member", installationId: "42", syncInstallation: true },
        { event: "installation_repositories", installationId: "42", syncInstallation: true },
      ],
      {
        syncInstallation: async (id) => {
          work.push(`delete:${id}`);
          return "deleted";
        },
        reconcileInstallationProofChecks: async (id) => {
          work.push(`proofs:${id}`);
        },
      },
    );
    expect(work).toEqual(["delete:42"]);
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

  it("runs daily policy and proof repair only after its multi-step installation sync finishes", async () => {
    const work: string[] = [];
    const purposes: Array<{ reconcilePolicies: boolean; reconcileProofChecks: boolean }> = [];
    await processQueueMessage(
      { event: "policy_reconcile", installationId: "42", syncInstallation: true },
      new Set(),
      {
        syncInstallation: async (_id, purpose) => {
          purposes.push(purpose);
          return { continued: 1 };
        },
        reconcileInstallationPolicies: async (id) => { work.push(`policies:${id}`); },
        reconcileInstallationProofChecks: async (id) => { work.push(`proofs:${id}`); },
      },
    );
    expect(work).toEqual([]);
    expect(purposes).toEqual([{ reconcilePolicies: true, reconcileProofChecks: true }]);

    await processQueueMessage(
      {
        event: "installation_sync_continue",
        installationId: "42",
        syncInstallation: true,
        postSyncPolicyReconcile: true,
        postSyncProofReconcile: true,
      },
      new Set(),
      {
        syncInstallation: async (_id, purpose) => {
          purposes.push(purpose);
          return { continued: 0 };
        },
        reconcileInstallationPolicies: async (id) => { work.push(`policies:${id}`); },
        reconcileInstallationProofChecks: async (id) => { work.push(`proofs:${id}`); },
      },
    );
    expect(work).toEqual(["policies:42", "proofs:42"]);
    expect(purposes).toEqual([
      { reconcilePolicies: true, reconcileProofChecks: true },
      { reconcilePolicies: true, reconcileProofChecks: true },
    ]);
  });

  it("preserves membership proof repair without inventing policy work across continuation", async () => {
    const work: string[] = [];
    await processQueueMessage(
      { event: "member", installationId: "42", syncInstallation: true },
      new Set(),
      {
        syncInstallation: async (_id, purpose) => {
          expect(purpose).toEqual({ reconcilePolicies: false, reconcileProofChecks: true });
          return { continued: 1 };
        },
        reconcileInstallationPolicies: async (id) => { work.push(`policies:${id}`); },
        reconcileInstallationProofChecks: async (id) => { work.push(`proofs:${id}`); },
      },
    );
    expect(work).toEqual([]);

    await processQueueMessage(
      {
        event: "installation_sync_continue",
        installationId: "42",
        syncInstallation: true,
        postSyncPolicyReconcile: false,
        postSyncProofReconcile: true,
      },
      new Set(),
      {
        syncInstallation: async (_id, purpose) => {
          expect(purpose).toEqual({ reconcilePolicies: false, reconcileProofChecks: true });
          return { continued: 0 };
        },
        reconcileInstallationPolicies: async (id) => { work.push(`policies:${id}`); },
        reconcileInstallationProofChecks: async (id) => { work.push(`proofs:${id}`); },
      },
    );
    expect(work).toEqual(["proofs:42"]);
  });

  it("confirms an uninstall against current GitHub authority", async () => {
    const work: string[] = [];
    await runMessages(
      [{ event: "installation", installationId: "42", installationAction: "deleted", syncInstallation: false }],
      {
        syncInstallation: async (id) => { work.push(`sync:${id}`); },
      },
    );
    expect(work).toEqual(["sync:42"]);
  });

  it("does not run an untagged proof reconcile against a later project incarnation", async () => {
    const work: string[] = [];
    await runMessages(
      [{ event: "push", installationId: "42", reconcileProofRepositoryId: "repo-1", reconcileProofProjectId: null }],
      { reconcileProjectProofChecks: async (repositoryId, projectId) => { work.push(`${repositoryId}:${projectId}`); } },
    );
    expect(work).toEqual([]);
  });

  it("does not reconsider a fresh project for an unbound old proof delivery", async () => {
    const reconsidered: string[] = [];
    await runMessages(
      [
        {
          event: "check_run",
          installationId: "42",
          appProofTask: { kind: "verify", request: { ...REQUEST, projectId: undefined } },
          syncInstallation: false,
        },
      ],
      {
        processAppProof: async () => undefined,
        reconsiderHead: async (repositoryId) => {
          reconsidered.push(repositoryId);
        },
      },
    );
    expect(reconsidered).toEqual([]);
  });
});
