export type MigrationPhase = "before-worker" | "after-worker";

export interface MigrationRelease {
  readonly name: string;
  readonly phase: MigrationPhase;
  readonly barrier?: string;
}

export interface MigrationReleaseState {
  readonly version: number;
  readonly kind: MigrationPhase | "current";
  readonly selected: readonly string[];
  readonly before: readonly string[];
  readonly after: readonly string[];
  readonly deferred: readonly string[];
  readonly deployBlockers: readonly string[];
  readonly blockedBehindBarrier: readonly string[];
  /** Known migrations recorded after the first missing known migration. */
  readonly outOfOrderApplied: readonly string[];
  readonly barrier: { readonly name: string; readonly id: string } | null;
}

export interface SchemaCapabilities {
  readonly projectLifecycle: boolean;
  readonly lifecycleFinished: boolean;
  readonly privateAgentFeedback: boolean;
  readonly verifierProtocolV3: boolean;
  readonly lifecycleReopened: boolean;
}

export interface PublicMigrationState {
  readonly version: number;
  readonly phase: MigrationReleaseState["kind"];
  readonly selected: readonly string[];
  readonly deployBlockers: readonly string[];
  readonly blockedBehindBarrier: readonly string[];
  readonly outOfOrderApplied: readonly string[];
  readonly barrier: MigrationReleaseState["barrier"];
  readonly capabilities: SchemaCapabilities;
}

export const MIGRATION_PLAN_VERSION: number;
export const MIGRATION_RELEASES: readonly MigrationRelease[];
export const SCHEMA_CAPABILITY_MIGRATIONS: Readonly<Record<keyof SchemaCapabilities, string>>;
export function evaluateMigrationReleases(
  model: readonly MigrationRelease[],
  applied: readonly string[],
): MigrationReleaseState;
export function migrationReleaseState(applied: readonly string[]): MigrationReleaseState;
export function schemaCapabilities(applied: readonly string[]): SchemaCapabilities;
export function publicMigrationState(applied: readonly string[]): PublicMigrationState;
