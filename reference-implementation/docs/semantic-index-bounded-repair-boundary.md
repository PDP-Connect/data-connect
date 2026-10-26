# Semantic bounded-repair blockers: implementation boundary

Base examined: `224ffb13d12fa7787403df44bfa01e3665216da1` on
`fix/semantic-bounded-repair`. This is a phase-1 design record only.

## Invariants retained

- Repair remains bounded and keyed by physical scope
  `(connector_instance_id, stream)`.
- `records.version`, `version_counter`, `record_changes`, and cursor behavior
  remain historical-record semantics. A repair never manufactures a new
  historical version.
- `search_index_dirty.revision` remains the latest-write CAS token. A direct
  repair mutation marks it in the same transaction as the mutation.
- The existing lease token `(lease_owner, lease_generation)` fences every
  derived-state mutation, including semantic metadata.

## 1. Direct writers and same-version bodies

### Provenance / invalidation proof

There is no existing record `text_hash` or body-provenance column that proves
which body an embedding came from. `record_changes.record_json` is historical
body storage, not a current-vector provenance token. The existing
`semantic_search_blob.source_version` (and SQLite sidecars) therefore cannot
distinguish a restored body at the same version.

Use a narrow, explicit semantic invalidation generation rather than a payload
hash:

- `records.semantic_generation BIGINT/INTEGER NOT NULL DEFAULT 1`;
- `semantic_search_blob.source_generation BIGINT/INTEGER NULL`;
- SQLite `semantic_search_rowid.source_generation INTEGER NULL` for the
  sqlite-vec sidecar.

`semantic_generation` is internal derived-data provenance, not history. Each
durable mutation that changes a record's semantic truth increments it in the
same row mutation. Existing regular ingest returns the allocated generation
with its changed-record work item; semantic publish must match *both*
`records.version` and `records.semantic_generation` under its existing
`records FOR UPDATE` / SQLite write transaction. The bounded repair stores and
compares both values; its Postgres page write holds the existing record share
lock and joins on both values. NULL source generation is legacy-unknown and is
never current.

This is the required fence for the old-publisher race: a publisher computed
before a same-version projection restore carries the old generation and cannot
write after the restore. It is more efficient than fetching/hash-normalizing
every record body on every key-only bounded verification pass. The additions
are narrow, nullable for derived rows and constant-default for records; no
history-table backfill or `version` rewrite is needed.

### Writer transaction boundary

`gmail-delta-blanked-envelope-restore.ts` keeps one `BEGIN`/`COMMIT` for its
apply loop. Make its guarded `UPDATE records` increment
`semantic_generation` with `version`, return the updated scope, then call the
same `INSERT ... ON CONFLICT ... revision = revision + 1` shape as
`markSearchIndexDirtyPostgres` through that *same* `pg.PoolClient`, before
commit. A zero-row guarded update writes neither queue entry nor generation.

`record-current-projection-repair.ts` makes the equivalent dirty mark before
its existing transaction commits, not in the post-commit retained-size
best-effort block. Its current-row restore and tombstone paths increment
`semantic_generation` even when they retain the historical `version`; an
inserted current projection starts at generation 1. The dirty scope is marked
once per affected `(connector_instance_id, stream)` transaction (not once per
row) with the normal revision increment. Retained-size behavior stays as it
is, including its post-commit best-effort policy.

## 2. Manifest-current identity reset

Replace the split `deleteStreamRows()` then `resetPass()` transition with one
narrow existing-store transition, `resetIdentityPass(...)`; this is not a new
service/facade. In Postgres its one transaction must, in this order:

1. take `lockConnectorManifestPublication(connectorId)` (the same advisory
   transaction lock used by profile publication);
2. read/validate the declared manifest with
   `assertConnectorManifestStreamSubsetWithClient` while that lock is held;
3. prove the lease fence with the progress row `FOR UPDATE`;
4. delete the stream's semantic rows, then reset identity/cursor/pass kind and
   captured dirty revision; commit.

Thus profile publication and destructive reset serialize on the same lock, and
the proof and deletion are in one commit boundary. SQLite performs the
equivalent manifest read, lease proof, delete and reset in one `immediate()`
write transaction, which serializes with its manifest publication transaction.
If either proof fails, no delete/reset occurs. Normal page-level manifest
assertions remain unchanged.

## 3. Metadata completion

Extend the existing `RepairStore.complete` operation with optional semantic
metadata for an identity-changing pass. In one Postgres transaction it takes
the progress row `FOR UPDATE` with owner/generation/unexpired predicate,
upserts `semantic_search_meta`, runs the unchanged latest-dirty-revision CAS,
then either deletes progress (`complete`) or resets/release it (`reset`).
SQLite does the same inside its current `writeTransaction`. `repairSemanticScope`
no longer writes metadata before calling completion. A lost/expired fence writes
neither metadata nor completion state.

## Files to change

- `reference-implementation/scripts/repair/gmail-delta-blanked-envelope-restore.ts`
- `reference-implementation/scripts/repair/record-current-projection-repair.ts`
- `reference-implementation/server/records.ts` and
  `server/postgres-records.ts` (carry the committed semantic generation into
  deferred publisher work and gate the publisher on it)
- `reference-implementation/server/search-semantic.ts`,
  `server/semantic-index-repair.ts`, and `server/postgres-search.ts`
  (provenance persistence/detection, atomic reset and completion)
- `reference-implementation/server/db.ts`, `server/postgres-storage.ts`, and
  registered semantic SQLite queries as required by the new columns.
- focused semantic-repair and repair-utility tests.

## Explicit non-changes

Do not alter `version`, `version_counter`, `record_changes`, cursor values,
archives, compactor, backfill budget/fairness, or `computeIndexState`'s public
meaning. Do not return to whole-stream rebuilds for ordinary record drift. No
new general repair facade is introduced.

## Test plan

Run all new race tests against SQLite and a fresh isolated real Postgres
database; Postgres must use the specified local-image disposable container and
never a shared endpoint.

1. Execute the real Gmail restore and projection-repair applies on Postgres;
   assert the same transaction leaves a dirty row, then reconcile to current
   vectors. Mirror their durable generation/dirty contract in SQLite's repair
   store test fixture, since both utilities intentionally require
   `pg.PoolClient`.
2. Same-version current-projection restore and tombstone: assert historical
   version/cursor unchanged, generation advances, dirty revision advances, and
   repair re-embeds or removes rows on both backends.
3. Hold an old computation/publisher across a same-version repair; release it
   after the repair and prove its old generation cannot write. Then converge.
4. Pause an old identity-reset caller after public entry, publish a new profile,
   then release the old reset. Assert the shared publication lock makes it fail
   without deleting the newly current stream.
5. Expire generation A, let B acquire and complete a newer identity, then let
   A attempt metadata completion. Assert A changes neither meta, dirty row nor
   progress; B's identity remains.
6. Keep all existing semantic-repair tests green and add the real-Postgres
   counterparts rather than accepting a skip. Leave the known byte-identical
   `backup-table-inventory-postgres` baseline failure untouched.
