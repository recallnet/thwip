import type { ReasonCode } from "@thwip/vocabulary";

import { githubStatusOf } from "./github-error.js";

/**
 * Reconciling every installation, and saying honestly what got done.
 *
 * `/admin/sync` answered 500 after it had already succeeded. It reconciles the
 * projection and the policy, then reads open pull requests to republish the
 * proof check. That read needs a permission the installation may not hold,
 * GitHub answers 403, and the throw took the whole call with it. An operator
 * reads a 500 as "the policy did not activate" and retries work that was
 * already done, or worse, believes enforcement is off when it is on.
 *
 * So the proof-check pass is what it always was, a best-effort pass over
 * whatever is open, and it now reports as one. A failure there is recorded
 * beside the reconcile that completed instead of erasing it, and a refusal from
 * GitHub is named `APP_PERMISSION_DRIFT` rather than surfacing as an internal
 * error. That is the same shape as a check still running being written down as
 * a failed proof: an unknown reported as a verdict.
 */

export interface InstallationSyncSteps {
  syncInstallation(installationId: string): Promise<unknown>;
  reconcilePolicies(installationId: string): Promise<unknown>;
  reconcileProofChecks(installationId: string): Promise<number>;
}

export interface StepFailure {
  /** Null when nothing in the vocabulary describes it. Never a guess. */
  readonly reason: ReasonCode | null;
  readonly detail: string;
}

export interface InstallationSyncResult {
  readonly installationId: string;
  readonly projection: unknown;
  readonly policies: unknown;
  /** True when the projection and the policy both landed. */
  readonly reconciled: boolean;
  readonly failure?: StepFailure;
  /** Null when the best-effort pass did not run to completion. */
  readonly proofChecks: number | null;
  readonly proofChecksFailure?: StepFailure;
}

export interface InstallationSyncReport {
  readonly installations: Record<string, InstallationSyncResult>;
  /** True when any step anywhere did not complete. The status stays 200. */
  readonly degraded: boolean;
}

/**
 * What a GitHub refusal is called in the vocabulary the rest of the system
 * speaks. Only 403: it is the one status that means exactly "the App is not
 * allowed to do this", and anything broader would put a setup instruction in
 * front of an operator whose problem is a bad gateway.
 */
export function reasonForGithubFailure(error: unknown): ReasonCode | null {
  return githubStatusOf(error) === 403 ? "APP_PERMISSION_DRIFT" : null;
}

function failure(error: unknown): StepFailure {
  return {
    reason: reasonForGithubFailure(error),
    detail: (error instanceof Error ? error.message : String(error)).slice(0, 500),
  };
}

export async function syncInstallations(
  installations: ReadonlyArray<{ id: number | string; account: { login: string } }>,
  steps: InstallationSyncSteps,
): Promise<InstallationSyncReport> {
  const results: Record<string, InstallationSyncResult> = {};
  let degraded = false;

  for (const installation of installations) {
    const installationId = String(installation.id);
    let projection: unknown = null;
    let policies: unknown = null;
    let reconciled = true;
    let reconcileFailure: StepFailure | undefined;

    try {
      projection = await steps.syncInstallation(installationId);
      policies = await steps.reconcilePolicies(installationId);
    } catch (error) {
      reconciled = false;
      reconcileFailure = failure(error);
      degraded = true;
    }

    // Republishing the proof check on every open pull request is a catch-up
    // pass, not part of the reconcile. It runs after, it fails on its own, and
    // one installation refusing it must not stop the next one being synced.
    let proofChecks: number | null = null;
    let proofChecksFailure: StepFailure | undefined;
    if (reconciled) {
      try {
        proofChecks = await steps.reconcileProofChecks(installationId);
      } catch (error) {
        proofChecksFailure = failure(error);
        degraded = true;
      }
    }

    results[installation.account.login] = {
      installationId,
      projection,
      policies,
      reconciled,
      ...(reconcileFailure !== undefined ? { failure: reconcileFailure } : {}),
      proofChecks,
      ...(proofChecksFailure !== undefined ? { proofChecksFailure } : {}),
    };
  }

  return { installations: results, degraded };
}
