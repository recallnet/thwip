/**
 * The narrow SQL surface the branch queue needs.
 *
 * Cloudflare's SQLite-backed Durable Object storage satisfies this, and so does
 * better-sqlite3 through the adapter in the tests. Keeping the store behind this
 * interface is what lets the chaos tests evict the object between every command
 * and prove that state rehydrates to exactly the same place.
 */
export interface SqlLike {
  exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): { toArray(): T[] };
}

/**
 * Authoritative hot tables.
 *
 * The event log is the truth; every other table is a derived snapshot that
 * exists so a cold object can answer a read without replaying everything, and
 * so the alarm can find the earliest deadline without loading state.
 */
const SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS queue_meta (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     queue_key TEXT NOT NULL,
     repository_id TEXT NOT NULL,
     base_ref TEXT NOT NULL,
     generation INTEGER NOT NULL DEFAULT 0,
     active_attempt_revision INTEGER NOT NULL DEFAULT 0,
     queue_epoch INTEGER NOT NULL DEFAULT 0,
     last_sequence INTEGER NOT NULL DEFAULT 0,
     turn_sequence TEXT NOT NULL DEFAULT '0',
     ordinal_sequence TEXT NOT NULL DEFAULT '0',
     paused INTEGER NOT NULL DEFAULT 0,
     pause_reason TEXT,
     rebaseline_required INTEGER NOT NULL DEFAULT 0,
     base_sha TEXT,
     active_attempt_id TEXT,
     chain_head_digest TEXT,
     chain_head_sequence INTEGER NOT NULL DEFAULT 0,
     activation_state TEXT NOT NULL DEFAULT 'configured',
     active_config_digest TEXT
   )`,

  `CREATE TABLE IF NOT EXISTS principals (
     principal_id TEXT PRIMARY KEY,
     github_user_id TEXT NOT NULL,
     last_served_turn TEXT NOT NULL DEFAULT '0',
     fairness_debt TEXT
   )`,

  `CREATE TABLE IF NOT EXISTS entries (
     entry_id TEXT PRIMARY KEY,
     pull_request_number INTEGER NOT NULL,
     sponsor_principal_id TEXT NOT NULL,
     sponsor_github_user_id TEXT NOT NULL,
     fairness_ordinal TEXT NOT NULL,
     state TEXT NOT NULL,
     primary_reason TEXT,
     secondary_reasons TEXT NOT NULL DEFAULT '[]',
     scheduler_eligible INTEGER NOT NULL DEFAULT 0,
     cooldown_until TEXT,
     head_sha TEXT NOT NULL,
     current_attempt_id TEXT,
     last_attempt_id TEXT
   )`,

  `CREATE TABLE IF NOT EXISTS attempts (
     attempt_id TEXT PRIMARY KEY,
     entry_id TEXT NOT NULL,
     parent_attempt_id TEXT,
     phase TEXT NOT NULL,
     outcome TEXT,
     body TEXT NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS attempt_edges (
     parent_attempt_id TEXT NOT NULL,
     child_attempt_id TEXT NOT NULL,
     edge_kind TEXT NOT NULL,
     PRIMARY KEY (parent_attempt_id, child_attempt_id)
   )`,

  `CREATE TABLE IF NOT EXISTS offers (
     attempt_id TEXT PRIMARY KEY,
     entry_id TEXT NOT NULL,
     sponsor_principal_id TEXT NOT NULL,
     claim_token TEXT NOT NULL,
     expires_at TEXT NOT NULL,
     result TEXT
   )`,

  `CREATE TABLE IF NOT EXISTS deadlines (
     kind TEXT NOT NULL,
     attempt_id TEXT NOT NULL,
     due_at TEXT NOT NULL,
     PRIMARY KEY (kind, attempt_id)
   )`,

  `CREATE TABLE IF NOT EXISTS inbox_dedupe (
     idempotency_key TEXT PRIMARY KEY,
     sequence INTEGER NOT NULL,
     result TEXT NOT NULL,
     recorded_at TEXT NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS events (
     sequence INTEGER PRIMARY KEY,
     idempotency_key TEXT NOT NULL,
     at TEXT NOT NULL,
     type TEXT NOT NULL,
     body TEXT NOT NULL,
     generation INTEGER NOT NULL,
     compacted INTEGER NOT NULL DEFAULT 0
   )`,

  `CREATE TABLE IF NOT EXISTS transitions (
     transition_sequence INTEGER PRIMARY KEY,
     kind TEXT NOT NULL,
     prior_digest TEXT,
     digest TEXT NOT NULL,
     base_sha TEXT NOT NULL,
     attempt_id TEXT,
     witnesses TEXT NOT NULL,
     recorded_at TEXT
   )`,

  `CREATE TABLE IF NOT EXISTS outbox (
     outbox_id INTEGER PRIMARY KEY AUTOINCREMENT,
     kind TEXT NOT NULL,
     attempt_id TEXT,
     operation_id TEXT,
     attempt_revision INTEGER NOT NULL,
     payload TEXT NOT NULL,
     created_at TEXT NOT NULL,
     acknowledged INTEGER NOT NULL DEFAULT 0,
     attempts INTEGER NOT NULL DEFAULT 0
   )`,

  `CREATE TABLE IF NOT EXISTS merge_operations (
     operation_id TEXT PRIMARY KEY,
     attempt_id TEXT NOT NULL,
     attempt_revision INTEGER NOT NULL,
     expected_base_sha TEXT NOT NULL,
     expected_head_sha TEXT NOT NULL,
     expected_tree_oid TEXT NOT NULL,
     pull_request_number INTEGER,
     write_started_at TEXT NOT NULL,
     outcome TEXT,
     resolved_at TEXT,
     refusal_reason TEXT,
     refusal_count INTEGER NOT NULL DEFAULT 0,
     refused_at TEXT,
     retry_after TEXT
   )`,

  `CREATE TABLE IF NOT EXISTS sockets (
     socket_id TEXT PRIMARY KEY,
     principal_id TEXT NOT NULL,
     attached_at TEXT NOT NULL
   )`,

  /**
   * What a pinned verifier observed when it ran the required suites against one
   * integrated candidate tree.
   *
   * Keyed by tree rather than by attempt on purpose. The claim being recorded is
   * about a tree — "these suites, named by this policy, passed against exactly
   * this integration" — and it stays true if the attempt is superseded and the
   * same tree comes back. A verdict for a different tree is a verdict about
   * different code and must never be reused, which the primary key enforces.
   *
   * This is evidence, not queue state: the reducer consumes it as an input at
   * merge-preparation time, the way it consumes the head proof, and never stores
   * it. That is why it lives beside the log rather than in it.
   */
  `CREATE TABLE IF NOT EXISTS candidate_verdicts (
     candidate_tree_oid TEXT PRIMARY KEY,
     candidate_sha TEXT NOT NULL,
     base_sha TEXT NOT NULL,
     pull_request_number INTEGER NOT NULL,
     accepted INTEGER NOT NULL,
     result_digest TEXT NOT NULL,
     policy_digest TEXT NOT NULL,
     suites TEXT NOT NULL,
     reason_codes TEXT NOT NULL,
     workflow_ref TEXT NOT NULL,
     workflow_sha TEXT NOT NULL,
     run_id TEXT NOT NULL,
     observed_at TEXT NOT NULL
   )`,

  /**
   * When a verifier was last asked to run against a candidate tree.
   *
   * The merge gate asks whether a verdict exists on a poll, and without this it
   * dispatched a fresh verifier every time the answer was no. One candidate once
   * cost four full CI runs, three of them wasted.
   */
  `CREATE TABLE IF NOT EXISTS candidate_dispatches (
     candidate_tree_oid TEXT PRIMARY KEY,
     dispatched_at TEXT NOT NULL
   )`,

  `CREATE INDEX IF NOT EXISTS deadlines_due ON deadlines (due_at)`,
  `CREATE INDEX IF NOT EXISTS outbox_pending ON outbox (acknowledged, outbox_id)`,
  `CREATE INDEX IF NOT EXISTS entries_state ON entries (state, scheduler_eligible)`,
];

/**
 * Columns added after objects were already live.
 *
 * `CREATE TABLE IF NOT EXISTS` does nothing to a table that already exists, so a
 * column added to SCHEMA reaches new queues only. Each patch is applied and its
 * "duplicate column name" refusal ignored, which is the whole check: SQLite
 * already knows whether the column is there.
 */
const SCHEMA_PATCHES: readonly string[] = [
  `ALTER TABLE transitions ADD COLUMN recorded_at TEXT`,
  // A sweep settling an orphaned write needs the pull request to read GitHub
  // about, and the surviving attempt it used to borrow that number from does
  // not survive the failure the sweep exists for.
  `ALTER TABLE merge_operations ADD COLUMN pull_request_number INTEGER`,
  // What the sweep concluded last time it looked at this row, how many times it
  // has concluded the same thing, and when it will look again. A row it cannot
  // settle used to cost its full GitHub read budget every five minutes forever,
  // and on 4 August that spent the invocation's subrequests before the sweep
  // reached anything new.
  `ALTER TABLE merge_operations ADD COLUMN refusal_reason TEXT`,
  `ALTER TABLE merge_operations ADD COLUMN refusal_count INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE merge_operations ADD COLUMN refused_at TEXT`,
  `ALTER TABLE merge_operations ADD COLUMN retry_after TEXT`,
];

export function initSchema(sql: SqlLike): void {
  for (const statement of SCHEMA) sql.exec(statement);
  for (const patch of SCHEMA_PATCHES) {
    try {
      sql.exec(patch);
    } catch {
      /* the column is already present */
    }
  }
}
