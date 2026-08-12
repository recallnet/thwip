export interface DashboardSyncDependencies {
  readonly syncInstallation: (installationId: string) => Promise<Record<string, number>>;
  readonly enqueueReconciliation: (message: {
    readonly event: "policy_reconcile";
    readonly installationId: string;
  }) => Promise<void>;
}

/**
 * Refresh the installation now, then reconcile policies and proof checks in a
 * fresh queue invocation. Keeping both GitHub walks in one request can exceed
 * Cloudflare's subrequest limit after the installation projection succeeds.
 */
export async function runDashboardSync(
  installationId: string,
  dependencies: DashboardSyncDependencies,
): Promise<{ synced: Record<string, number>; reconciliation: "queued" }> {
  const synced = await dependencies.syncInstallation(installationId);
  await dependencies.enqueueReconciliation({ event: "policy_reconcile", installationId });
  return { synced, reconciliation: "queued" };
}
