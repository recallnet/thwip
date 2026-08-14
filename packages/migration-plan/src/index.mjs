/**
 * The one release-order model used by migration, deployment, and the Worker.
 *
 * An after-worker entry is a barrier. A Worker may deploy while that barrier is
 * the first pending phase, but a later before-worker entry is not thereby ready:
 * it stays visible as blocked behind the barrier until the barrier is applied.
 * Keeping this as executable, dependency-free data lets both Cloudflare's
 * Worker bundle and the local Node safety commands evaluate the same rules.
 */

export const MIGRATION_PLAN_VERSION = 2;

/** The immutable release history used by existing hosted databases. */
export const LEGACY_MIGRATION_RELEASES = Object.freeze([
  { name: "0001_init.sql", phase: "before-worker" },
  { name: "0002_better_auth.sql", phase: "before-worker" },
  { name: "0003_github_projection.sql", phase: "before-worker" },
  { name: "0004_key_cache_source.sql", phase: "before-worker" },
  { name: "0005_queue_projection.sql", phase: "before-worker" },
  { name: "0006_queue_projection_marks.sql", phase: "before-worker" },
  { name: "0007_queue_transition_observed_at_nullable.sql", phase: "before-worker" },
  { name: "0008_policy_activation_source.sql", phase: "before-worker" },
  { name: "0008_queue_projection_serves_reads.sql", phase: "before-worker" },
  { name: "0009_candidate_verdicts_in_d1.sql", phase: "before-worker" },
  { name: "0010_projection_head_sha.sql", phase: "before-worker" },
  { name: "0011_queue_state_in_d1.sql", phase: "before-worker" },
  { name: "0012_projection_after_the_authority_moved.sql", phase: "before-worker" },
  { name: "0013_app_native_proof_checks.sql", phase: "before-worker" },
  { name: "0014_signed_queue_attestations.sql", phase: "before-worker" },
  { name: "0015_service_key_history.sql", phase: "before-worker" },
  { name: "0016_attestation_epoch_for_thwip.sql", phase: "before-worker" },
  { name: "0017_chain_publication.sql", phase: "before-worker" },
  { name: "0018_one_record_per_merge.sql", phase: "after-worker", barrier: "one-record-per-merge" },
  { name: "0019_backfill_watermark.sql", phase: "before-worker" },
  { name: "0020_queue_runners.sql", phase: "before-worker" },
  { name: "0021_local_run_assignments.sql", phase: "before-worker" },
  { name: "0022_merge_written_by_the_app.sql", phase: "before-worker" },
  { name: "0023_remove_queue_runtime_selectors.sql", phase: "after-worker", barrier: "queue-runtime-selectors" },
  { name: "0023_status_comment_per_pull_request.sql", phase: "before-worker" },
  { name: "0024_queue_clock.sql", phase: "before-worker" },
  { name: "0025_projection_generation.sql", phase: "before-worker" },
  { name: "0026_queue_clock_last_failure.sql", phase: "before-worker" },
  { name: "0027_reused_ci_metrics.sql", phase: "before-worker" },
  { name: "0028_project_removal.sql", phase: "before-worker" },
  { name: "0029_terminal_comment_priority.sql", phase: "before-worker" },
  { name: "0030_github_repository_lifecycle.sql", phase: "before-worker" },
  {
    name: "0031_finish_github_repository_lifecycle.sql",
    phase: "after-worker",
    barrier: "project-lifecycle-in-place",
  },
  { name: "0032_private_agent_feedback_foundation.sql", phase: "before-worker" },
  { name: "0033_verifier_protocol_v3.sql", phase: "before-worker" },
  {
    name: "0034_reopen_after_project_lifecycle.sql",
    phase: "after-worker",
    barrier: "project-lifecycle-reopen",
  },
]);

/** A fresh self-hosted database starts here instead of replaying private history. */
export const BASELINE_MIGRATION_RELEASE = Object.freeze({
  name: "1000_current_schema.sql",
  phase: "before-worker",
});

/**
 * Add every migration after the public baseline here, starting at 1001.
 * The exact same files and release declarations follow both starting tracks.
 */
export const FUTURE_MIGRATION_RELEASES = Object.freeze([]);

/** The active model for databases that retain the historic production ledger. */
export const MIGRATION_RELEASES = Object.freeze([
  ...LEGACY_MIGRATION_RELEASES,
  ...FUTURE_MIGRATION_RELEASES,
]);

/** The active model for databases created from the public baseline. */
export const BASELINE_MIGRATION_RELEASES = Object.freeze([
  BASELINE_MIGRATION_RELEASE,
  ...FUTURE_MIGRATION_RELEASES,
]);

/** Every filename the repository can legitimately carry. */
export const ALL_MIGRATION_RELEASES = Object.freeze([
  ...LEGACY_MIGRATION_RELEASES,
  BASELINE_MIGRATION_RELEASE,
  ...FUTURE_MIGRATION_RELEASES,
]);

export const SCHEMA_CAPABILITY_MIGRATIONS = Object.freeze({
  projectLifecycle: "0030_github_repository_lifecycle.sql",
  lifecycleFinished: "0031_finish_github_repository_lifecycle.sql",
  privateAgentFeedback: "0032_private_agent_feedback_foundation.sql",
  verifierProtocolV3: "0033_verifier_protocol_v3.sql",
  lifecycleReopened: "0034_reopen_after_project_lifecycle.sql",
});

function names(entries) {
  return entries.map((entry) => entry.name);
}

/** Evaluate any ordered model. Tests use this to prove phase transitions. */
export function evaluateMigrationReleases(model, applied) {
  const appliedSet = new Set(applied);
  const firstPendingIndex = model.findIndex((migration) => !appliedSet.has(migration.name));
  const outOfOrderApplied = firstPendingIndex === -1
    ? []
    : names(model.slice(firstPendingIndex + 1).filter((migration) => appliedSet.has(migration.name)));
  const pending = model.filter((migration) => !appliedSet.has(migration.name));
  if (pending.length === 0) {
    return {
      version: MIGRATION_PLAN_VERSION,
      kind: "current",
      selected: [],
      before: [],
      after: [],
      deferred: [],
      deployBlockers: [],
      blockedBehindBarrier: [],
      outOfOrderApplied: [],
      barrier: null,
    };
  }

  const kind = pending[0].phase;
  const selectedBarrier = kind === "after-worker"
    ? (pending[0].barrier ?? pending[0].name)
    : null;
  let selectedLength = pending.findIndex((migration) =>
    migration.phase !== kind
      || (kind === "after-worker" && (migration.barrier ?? migration.name) !== selectedBarrier));
  if (selectedLength === -1) selectedLength = pending.length;
  const selectedEntries = pending.slice(0, selectedLength);
  const selected = names(selectedEntries);
  const firstBarrierIndex = pending.findIndex((migration) => migration.phase === "after-worker");
  const firstBarrier = firstBarrierIndex === -1 ? null : pending[firstBarrierIndex];
  const blockedBehindBarrier = firstBarrierIndex === -1
    ? []
    : names(pending.slice(firstBarrierIndex + 1).filter((migration) => migration.phase === "before-worker"));

  return {
    version: MIGRATION_PLAN_VERSION,
    kind,
    selected,
    before: kind === "before-worker" ? selected : [],
    after: kind === "after-worker" ? selected : [],
    deferred: names(pending.slice(selectedLength)),
    deployBlockers: kind === "before-worker" ? selected : [],
    blockedBehindBarrier,
    outOfOrderApplied,
    barrier: firstBarrier === null
      ? null
      : { name: firstBarrier.name, id: firstBarrier.barrier ?? firstBarrier.name },
  };
}

/** Evaluate the repository's canonical release model. */
export function migrationReleaseState(applied) {
  const track = migrationTrack(applied);
  const model = track === "legacy" ? MIGRATION_RELEASES : BASELINE_MIGRATION_RELEASES;
  const release = evaluateMigrationReleases(model, applied);
  if (track !== "mixed") return release;

  // A baseline ledger must never also claim the private history. Make the
  // existing out-of-order safety signal fail closed for that impossible mix.
  const historic = new Set(LEGACY_MIGRATION_RELEASES.map((migration) => migration.name));
  return {
    ...release,
    outOfOrderApplied: [...new Set([
      ...release.outOfOrderApplied,
      ...applied.filter((name) => historic.has(name)),
    ])],
  };
}

/** Which supported starting track the durable ledger describes. */
export function migrationTrack(applied) {
  const have = new Set(applied);
  const baseline = have.has(BASELINE_MIGRATION_RELEASE.name);
  const legacy = LEGACY_MIGRATION_RELEASES.some((migration) => have.has(migration.name));
  if (baseline && legacy) return "mixed";
  return baseline ? "baseline" : "legacy";
}

/** Capabilities are derived from the same ordered migration record as release state. */
export function schemaCapabilities(applied) {
  const have = new Set(applied);
  if (have.has(BASELINE_MIGRATION_RELEASE.name)) {
    return Object.fromEntries(
      Object.keys(SCHEMA_CAPABILITY_MIGRATIONS).map((capability) => [capability, true]),
    );
  }
  return Object.fromEntries(
    Object.entries(SCHEMA_CAPABILITY_MIGRATIONS).map(([capability, migration]) => [capability, have.has(migration)]),
  );
}

/** Public state returned by both /health and /v1/schema. */
export function publicMigrationState(applied) {
  const release = migrationReleaseState(applied);
  return {
    version: release.version,
    track: migrationTrack(applied),
    phase: release.kind,
    selected: release.selected,
    deployBlockers: release.deployBlockers,
    blockedBehindBarrier: release.blockedBehindBarrier,
    outOfOrderApplied: release.outOfOrderApplied,
    barrier: release.barrier,
    capabilities: schemaCapabilities(applied),
  };
}
