# PostgreSQL bloat maintenance

Date: 2026-09-03

## Question

How should the reference implementation prevent high-churn PostgreSQL tables from accumulating physical bloat, and how can it reclaim derived-index space without stopping writers?

## Findings

- PostgreSQL supports table-specific autovacuum parameters with `ALTER TABLE ... SET (...)`; the same reloptions can address the table's TOAST relation with the `toast.` prefix. The relevant vacuum trigger is a threshold plus a scale-factor term, so low scale factors alone do not protect a table that has only a few very large JSONB or BYTEA rows.
- `VACUUM (ANALYZE)` cannot run inside a transaction block. `REINDEX ... CONCURRENTLY` also cannot run inside a transaction block, so the maintenance runner must borrow a direct session rather than use the transaction helper.
- A concurrent reindex allows normal writes but has stricter operational constraints. The runner therefore rebuilds only an explicit, static allowlist of derived indexes after observed dead-tuple pressure crosses a conservative threshold.

## Decision

The source-level fix is write elision: repeated structural-equality record payloads do not mutate `records` or append `record_changes`; content-addressed `blobs` already does the same for binary payloads. The implementation also avoids no-op metadata updates on that record path. These properties are separately proven with physical PostgreSQL relation statistics. Per-table heap and TOAST autovacuum reloptions for `records`, `record_changes`, `blobs`, and `spine_events`, plus the default 01:00-05:00 UTC maintenance job, are recovery safety nets only; they do not make a rewriting source path correct. The job vacuums known heavy tables and considers concurrent rebuild only for a static search-index allowlist. A durable database receipt claims each UTC window so a restart or another replica does not repeat an expensive partial pass. Set `PDPP_POSTGRES_DERIVED_INDEX_MAINTENANCE_WINDOW=disabled` to opt out or set another UTC window. A health receipt shows the last completed local job outcome.

## Sources

- PostgreSQL: [Routine Vacuuming](https://www.postgresql.org/docs/current/routine-vacuuming.html)
- PostgreSQL: [Automatic Vacuuming](https://www.postgresql.org/docs/current/runtime-config-vacuum.html)
- PostgreSQL: [REINDEX](https://www.postgresql.org/docs/current/sql-reindex.html)
- PostgreSQL: [CREATE TABLE storage parameters](https://www.postgresql.org/docs/current/sql-createtable.html)
