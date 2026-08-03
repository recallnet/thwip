import { MEMBERSHIP_EVENTS } from "./webhook-work.js";
import type { AppProofRequest, AppProofTask } from "./app-proof-verification.js";
import type { PolicyPush } from "./policy-activation.js";

/**
 * The shape of a `SYNC_QUEUE` message body, independent of the `Env` the real
 * consumer reads it against. Everything the consumer decides comes from these
 * fields, so a test can build one directly instead of going through a live
 * `Env` and a real `MessageBatch`.
 */
export interface QueueConsumerMessage {
  readonly event?: string;
  readonly installationId?: string | null;
  readonly policyPush?: PolicyPush | null;
  readonly appProofTask?: AppProofTask | null;
  readonly reconcileProofRepositoryId?: string | null;
  readonly syncInstallation?: boolean;
}

/** The consumer's side effects, each already bound to the `Env` it needs. */
export interface QueueConsumerDeps {
  syncInstallation?: (installationId: string) => Promise<unknown>;
  reconcileInstallationProofChecks?: (installationId: string) => Promise<unknown>;
  activatePolicyFromDefaultBranchPush?: (policyPush: PolicyPush) => Promise<unknown>;
  reconcileInstallationPolicies?: (installationId: string) => Promise<unknown>;
  reconcileProjectProofChecks?: (repositoryId: string) => Promise<unknown>;
  processAppProof?: (request: AppProofRequest) => Promise<unknown>;
  requestForRerequest?: (verificationId: string) => Promise<AppProofRequest | null>;
}

const noop = async (): Promise<void> => {};

function resolveDeps(deps: QueueConsumerDeps): Required<QueueConsumerDeps> {
  return {
    syncInstallation: deps.syncInstallation ?? noop,
    reconcileInstallationProofChecks: deps.reconcileInstallationProofChecks ?? noop,
    activatePolicyFromDefaultBranchPush: deps.activatePolicyFromDefaultBranchPush ?? noop,
    reconcileInstallationPolicies: deps.reconcileInstallationPolicies ?? noop,
    reconcileProjectProofChecks: deps.reconcileProjectProofChecks ?? noop,
    processAppProof: deps.processAppProof ?? noop,
    requestForRerequest: deps.requestForRerequest ?? (async () => null),
  };
}

/**
 * Applies one message's work. `synced` is shared across a batch: a delivery
 * that says the installation changed still costs one read per installation
 * per batch, not one per message.
 */
export async function processQueueMessage(
  body: QueueConsumerMessage,
  synced: Set<string>,
  deps: QueueConsumerDeps = {},
): Promise<void> {
  const resolved = resolveDeps(deps);
  const inst = body.installationId;

  // Syncing on every message asked GitHub to confirm what it had just told
  // us, once per delivery. The producer now says when a delivery changed
  // what the installation covers, and the daily reconciliation still catches
  // anything that drifted in between.
  if (inst && body.syncInstallation === true && !synced.has(inst)) {
    await resolved.syncInstallation(inst);
    synced.add(inst);
    if (MEMBERSHIP_EVENTS.includes(body.event as (typeof MEMBERSHIP_EVENTS)[number])) {
      await resolved.reconcileInstallationProofChecks(inst);
    }
  }
  if (body.policyPush != null) {
    await resolved.activatePolicyFromDefaultBranchPush(body.policyPush);
  }
  if (body.event === "policy_reconcile" && inst) {
    await resolved.reconcileInstallationPolicies(inst);
    await resolved.reconcileInstallationProofChecks(inst);
  }
  if (body.reconcileProofRepositoryId) {
    await resolved.reconcileProjectProofChecks(body.reconcileProofRepositoryId);
  }
  if (body.appProofTask?.kind === "verify") {
    await resolved.processAppProof(body.appProofTask.request);
  } else if (body.appProofTask?.kind === "rerequest") {
    const request = await resolved.requestForRerequest(body.appProofTask.verificationId);
    if (request !== null) await resolved.processAppProof(request);
  }
}

