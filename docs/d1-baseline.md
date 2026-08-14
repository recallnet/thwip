# D1 migration tracks

Thwip supports two database starting points.

- Existing hosted databases keep the complete `0001`–`0034` migration history and their real Wrangler ledger.
- A new self-hosted database starts from `migrations-baseline/1000_current_schema.sql`.

Do not apply the baseline to an existing database. Do not add old migration names to a new database's ledger. Wrangler records the migration it actually applies.

## Fresh database

The operational repository keeps the baseline in `migrations-baseline` so the hosted database can never see it as pending. The clean public release exposes `1000_current_schema.sql` through its configured D1 migration directory. Apply it once to an empty D1 database before deploying the Worker.

The baseline creates the current schema and only this generic bootstrap state:

- one queue clock;
- one private-feedback retention clock;
- one active R2 capability generation;
- one lifecycle readiness row.

It contains no organization, repository, project, user, token, queue item, proof, signed chain, installation, or production identifier.

## Later migrations

All later migrations start at `1001`. A later migration must have the same filename, SQL, and release phase on both tracks:

- after `0034` in the existing hosted migration set; and
- after `1000` in the public self-hosted migration set.

The parity tests build both tracks, compare their complete SQLite schema and required seed meaning, then apply the same synthetic future migration to both.

## Backup and recovery

Restore a database with the migration track recorded in its own backup:

- restore an existing hosted database with its historic ledger; or
- restore a self-hosted database with its baseline ledger.

Never replace one track's ledger with the other. After the restore, apply only later shared migrations that are not already recorded. Run the foreign-key check in D1. Run the SQLite integrity check against an exported local copy before returning the Worker to service; Wrangler's local D1 shell may refuse that pragma.

The full Cloudflare and GitHub self-hosting setup is tracked in issue #442.
