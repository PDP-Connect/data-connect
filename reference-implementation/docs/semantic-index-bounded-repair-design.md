# Bounded, version-aware semantic index repair (design)

Base: `origin/integration/unified-stack` = 36380c838426a13acacfc3f4696aa9bbf93a2481.
Branch created in the shared worktree: `fix/semantic-bounded-repair` (no commits, no code change yet).
Status: DESIGN ONLY, revision 2 (root ruling applied: version rule, write fencing, lease generation, index_state unchanged, fairness). Implementation waits for the root's acceptance.
Files below are under `reference-implementation/` unless noted. Line numbers are for the base above.

Confidence tags: [V] verified by reading base source in this session. [I] my inference. [?] not provable from source.

## 0. Stop-condition assessment

| Condition | Result |
|---|---|
| (a) broader behavior or spec scope than the direction | No. Four small edges are called out in section 9 so the root can veto them. |
| (b) `source_version` backfill needs a large one-time rewrite | No migration backfill exists. The column is added with no default (metadata-only, section 2). Legacy rows converge lazily through the paced repair (section 7 gives the cost). Per the root: this is in scope, not a stop. |
| (c) a contract or spec conflicts | No conflict found. One contract needs care: `index_state` (section 6). No `openspec/` or `docs/reference/testing-policy.md` exists in this repo; the only prose contracts are `README.md` (index_state paragraph) and `docs/migrate-storage.md`. |

## 1. Verified facts on this base [V]

- `semanticBackfillIndexIsInSync` (`server/search-semantic.ts:2784-2823`) compares `SUM(COUNT(*) per declared scope)` with `postgresCountIndexableSemanticValues` only.
- `inspectSemanticBackfillInstance` (`:2874-2940`): on a count mismatch it sets `canResume = false` (`:2929`). `prepareSemanticBackfillKeys` (`:2942-2975`) then runs `postgresSemanticIndexDeleteByConnectorStream` / `vectorIndex.deleteByConnectorStream`, i.e. the whole-stream DELETE, and `rebuildSemanticIndexForStream` (`:2537-2657`, `PAGE = 500` at `:2565`) re-embeds the whole stream. The page keyset (`lastId`) lives in a JS closure only.
- `postgresSemanticIndexInsertManyGuarded` (`server/postgres-search.ts:781-826` region): `ON CONFLICT ... DO UPDATE SET embedding = EXCLUDED.embedding`, no elision, no version stored.
- Live write: `maintainRecordIndexesWithinPermit` (`server/records.ts:~2778`). It embeds first (`computeSemanticEntries`), then one transaction that `SELECT ... FOR UPDATE`s the `records` row, checks `version == expectedVersion`, then calls `applySemanticEntriesWithClient` -> `postgresSemanticIndexPublishWithClient` (DELETE other scopes of the record, then `insertSemanticRows` with elision on `embedding`). No version is written.
- Delete with no backend: `applySemanticDeleteWithClient` returns early when `backend` is null (`search-semantic.ts:2231`). Update with no backend: `computeSemanticEntries` returns null (`:2154`). Both leave stale or orphan rows. Embed failure skips the whole publish and keeps the old embedding.
- Record versions come from a per-`(connector_instance_id, stream)` counter (`version_counter.max_version`, `server/postgres-records.ts:1566+`), so `records.version` is monotonic per stream in normal operation. Tombstones bump it. Rev 2: the design does NOT rely on this (stream reset, regeneration and SQLite reset paths can restart versions).
- `computeIndexState` (`search-semantic.ts:~3390`) returns `"building"` while any backfill is active in-process and `"stale"` while ANY `semantic_search_backfill_progress` row exists. It is advertised as `capabilities.semantic_retrieval.index_state` (`server/metadata.ts:874-921`, enum `built|building|stale` in `openapi/reference-public.openapi.json`).
- The PG progress table already declares an unused `cursor_key TEXT` (`server/postgres-storage.ts:3161`). SQLite has no such column (`server/db.ts:2137`).
- `semanticIndexBackfillForManifest` does NOT honor `storage_binding.connector_instance_id` (lexical does, `search.ts:1175`). `resolveSemanticBackfillConnectorInstanceIds` (`:2711`) walks every instance of the connector, although `search-index-reconcile.ts:12,137` documents and sets a pin. [V] This matters for section 5.
- Callers of `semanticIndexBackfillForManifest`: boot (`retrieval-startup-backfill.ts:94`, `index.ts:1306`), connector registration (`auth.ts:5452`), dirty reconcile (`search-index-reconcile.ts:169`). The 60 s sweep and the request-time self-heal both reach it through `runSearchIndexDirtyReconcileRound`.
- SQLite has two semantic stores: `sqlite-vec` (`semantic_search_vec` vec0 table plus the regular `semantic_search_rowid` sidecar) and a `blob-flat` fallback (`semantic_search_blob`, `db.ts:2170`). `makeSqliteVecIndex` / `makeBlobFlatIndex` implement one `SemanticIndex` interface (`search-semantic.ts:1307, 1585`). Postgres bypasses that interface and calls `postgres-search.ts` directly.
- The compactor (`scripts/compact-record-history.ts`) imports only `server/polyfill-connectors-runtime.ts`. This design touches none of the compactor sources, so its source-SHA or revision guard is unaffected. [V]

## 2. Schema change (forward-only, idempotent boot DDL)

### Postgres (`server/postgres-storage.ts`, in the same bootstrap function that already holds `ALTER TABLE semantic_search_backfill_progress ADD COLUMN IF NOT EXISTS fields_fingerprint TEXT`, ~`:5341`)

```sql
ALTER TABLE semantic_search_blob ADD COLUMN IF NOT EXISTS source_version BIGINT;            -- NULL = legacy-unknown
ALTER TABLE semantic_search_backfill_progress ADD COLUMN IF NOT EXISTS pass_kind TEXT NOT NULL DEFAULT 'rebuild';
ALTER TABLE semantic_search_backfill_progress ADD COLUMN IF NOT EXISTS pass_dirty_revision BIGINT;
ALTER TABLE semantic_search_backfill_progress ADD COLUMN IF NOT EXISTS lease_owner TEXT;
ALTER TABLE semantic_search_backfill_progress ADD COLUMN IF NOT EXISTS lease_expires_at BIGINT;   -- epoch ms
ALTER TABLE semantic_search_backfill_progress ADD COLUMN IF NOT EXISTS lease_generation BIGINT NOT NULL DEFAULT 0;   -- fencing token
-- cursor_key TEXT already exists in the CREATE TABLE; reused as the persisted keyset cursor.
```

- `source_version BIGINT` is nullable with NO default. In PG11+ (this repo targets PG16) an `ADD COLUMN` with no default, or with a constant default, is a catalog-only change: no table rewrite, no scan. It takes a brief `ACCESS EXCLUSIVE` lock on `semantic_search_blob` (queued behind live readers; the boot DDL path already tolerates this lock for other ALTERs). Existing rows read back as NULL. [V for PG semantics, general knowledge]
- `pass_kind ... NOT NULL DEFAULT 'rebuild'` is a constant default, so it is also metadata-only on the tiny progress table. Pre-existing progress rows keep their old meaning ("interrupted rebuild").
- No backfill statement, no `UPDATE ... SET source_version = records.version` shortcut (the root forbids it). A NULL row becomes non-NULL only when the repair re-embeds it from the current record text and writes the version.
- No new index. Justification (plan-only, section 6 of the brief): every new read is served by an existing index.
  - Version probe: `WHERE connector_instance_id = $1 AND scope_key = ANY($2) AND record_key = ANY($3)` is the existing PK `(connector_instance_id, scope_key, record_key)` shape already measured at 0.069 ms (`postgres-search.ts` comment at `postgresListExistingSemanticKeysForRecords`). It now also returns `source_version` from the heap tuple: one more heap fetch per hit, no index change.
  - Orphan keyset: `WHERE connector_instance_id = $1 AND scope_key = $2 AND record_key > $3 ORDER BY record_key LIMIT n` is an ordered PK range scan. No sort node.
  - Live-key probe: `records WHERE connector_instance_id = $1 AND stream = $2 AND record_key = ANY($3)` uses the unique `(connector_instance_id, stream, record_key)` key.
  - Record page: `SELECT id, record_key, version ... WHERE connector_instance_id AND stream AND NOT deleted AND id > $cursor ORDER BY id LIMIT n` uses `idx_pg_records_instance_stream_id` as today, minus `record_json` (no detoast).
  - The plan evidence is argument-only. I will confirm with plan-only `EXPLAIN` (no ANALYZE) on the disposable container during implementation. Tradeoff: if a plan shows a Sort or Seq Scan I will add nothing without a second review.
- No `work_mem`, planner hint, or `SET LOCAL` is added.

### SQLite (`server/db.ts`, static DDL plus the existing `hasTableColumn` migration style)

```sql
ALTER TABLE semantic_search_rowid ADD COLUMN source_version INTEGER;   -- vec0 path sidecar
ALTER TABLE semantic_search_blob  ADD COLUMN source_version INTEGER;   -- blob-flat path
ALTER TABLE semantic_search_backfill_progress ADD COLUMN pass_kind TEXT NOT NULL DEFAULT 'rebuild';
ALTER TABLE semantic_search_backfill_progress ADD COLUMN cursor_key TEXT;
ALTER TABLE semantic_search_backfill_progress ADD COLUMN pass_dirty_revision INTEGER;
ALTER TABLE semantic_search_backfill_progress ADD COLUMN lease_owner TEXT;
ALTER TABLE semantic_search_backfill_progress ADD COLUMN lease_expires_at INTEGER;
ALTER TABLE semantic_search_backfill_progress ADD COLUMN lease_generation INTEGER NOT NULL DEFAULT 0;
```

Guarded by `hasTableColumn` so reruns are no-ops. The `CREATE TABLE IF NOT EXISTS` bodies in `db.ts` also gain the columns for fresh databases. A vec0 virtual table cannot take a new column, so the version lives in the regular `semantic_search_rowid` sidecar, which is already the logical-identity map. The `semantic_search_vec` DROP/CREATE path (dimension change) already wipes the sidecar and progress.

### Why a column and not a sidecar table
A per-key sidecar would avoid rewriting the 2.8 KB heap tuple when only the version changes, but it can desync: a delete path that forgets the sidecar plus a later insert that omits it would make a new row look current. The column is atomic with the row and cannot desync. See the cost tradeoff in section 7.

## 3. Repair algorithm

### 3.1 States and who decides
Per `(connector_instance_id, stream)` there is at most one progress row. It means "a bounded pass is open for this scope".

- `pass_kind = 'rebuild'`: identity (fields fingerprint, model, dimensions, metric) changed. The old rows are invalid. Advertised `index_state` is `stale` (unchanged behavior).
- `pass_kind = 'repair'`: identity unchanged. Any progress row still advertises `stale` (section 6, existing semantics).

Decision (replaces the count test):
```
identityChanged = !meta || meta.fp != newFp || meta.model != m || meta.dims != d || meta.metric != metric
if identityChanged:
    if !(row exists && row.pass_kind == 'rebuild' && row identity == current):
        DELETE whole stream rows   # the ONLY whole-stream delete; same statement as today
        row := {kind 'rebuild', identity current, cursor NULL}
    # else: resume the open rebuild, no delete
else:
    if row.kind == 'rebuild' (leftover, meta already current): row := {kind 'repair', cursor NULL}
    else keep row (resume) or create {kind 'repair', cursor NULL}
```
Count drift is not an input. `semanticBackfillIndexIsInSync` and its count helpers are removed from the backfill path (`postgresCountIndexableSemanticValues` stays exported because `test/postgres-runtime-storage.test.ts:1741` tests it; it becomes unused in production, noted for review).

### 3.2 One pass, three detectors, one cursor
The cursor is a small JSON string in `cursor_key`:
`{"p":"records","id":<last records.id>}` then `{"p":"orphans","s":<scope ordinal>,"k":"<last record_key>"}`. NULL means start.

Phase A, records (missing and stale). Per page (`PAGE = 500`, existing constant):
1. `SELECT id, record_key, version FROM records WHERE instance AND stream AND NOT deleted AND id > cursor ORDER BY id LIMIT 500`. No `record_json`.
2. One probe: `SELECT scope_key, record_key, source_version FROM semantic_search_blob WHERE connector_instance_id=$1 AND scope_key = ANY($2) AND record_key = ANY($3)` (exact scope keys, never LIKE).
3. VERSION RULE (rev 2): a semantic row is current if and only if `source_version = records.version` of the live record. Absent row = missing. NULL, lower and higher are all stale and all require validation (re-embed from the current text). The design assumes nothing about version monotonicity across delete, reset, archive or regeneration paths (e.g. SQLite `deleteAllRecords` with no backend leaves rows; a regenerated stream restarts at low versions). A record is a CANDIDATE if any declared scope is missing or not current.
4. Fetch `record_json` only for candidates: `SELECT record_key, version, record_json FROM records WHERE ... record_key = ANY($) AND NOT deleted`. Use the version from THIS read, not from step 1 (it may have moved on). Embedding input and stamped version come from the same row read, so the stamp can never claim a version the text was not read at.
5. Per candidate row and declared field:
   - text empty and a semantic row exists: add to `emptied`. (The field was removed or cleared in a newer version; the old vector is stale.)
   - text non-empty and row current or ahead: skip. Otherwise embed (`embedDocumentWithAdmission`) and add `{scopeKey, recordKey, vector, version}`.
   - A record with no candidate scopes and no text is simply re-fetched each pass if its row is absent; steady-state cost is small and bounded by page size.
6. Embed first, outside any write. If the backend throws, the page is not written and the cursor does not advance (existing failure path: dirty scope keeps `failed` evidence and the existing 0/5/15/30/60/120/300/600 s backoff).
7. Write inside the existing per-page `withConnectorInstanceWrite` fence, as ONE atomic operation that (i) proves the lease and (ii) locks the authoritative record version. No stored-version comparison is used as the guard (a stored version higher than the record's must stay repairable).

   Postgres, one transaction (bulk lane, `withPostgresTransaction`):
   ```sql
   -- (i) fence: abort the page if this worker no longer owns the lease
   SELECT 1 FROM semantic_search_backfill_progress
    WHERE connector_instance_id=$1 AND stream=$2
      AND lease_owner=$o AND lease_generation=$g
      AND lease_expires_at > (extract(epoch FROM clock_timestamp())*1000)::bigint
    FOR SHARE;                                   -- 0 rows => lease_lost, write nothing
   -- (ii) lock records at the version we embedded, write only locked rows
   WITH locked AS MATERIALIZED (
     SELECT r.record_key, r.version FROM records r
      WHERE r.connector_instance_id=$7 AND r.stream=$8 AND r.record_key = ANY($4) AND NOT r.deleted
      ORDER BY r.record_key FOR SHARE)
   INSERT INTO semantic_search_blob (connector_id, connector_instance_id, scope_key, record_key, embedding, source_version)
   SELECT rows.connector_id, rows.connector_instance_id, rows.scope_key, rows.record_key, rows.embedding::vector, rows.version
     FROM unnest($1::text[],$2::text[],$3::text[],$4::text[],$5::text[],$6::bigint[]) AS rows(connector_id,connector_instance_id,scope_key,record_key,embedding,version)
     JOIN locked l ON l.record_key = rows.record_key AND l.version = rows.version
   ON CONFLICT (connector_instance_id, scope_key, record_key) DO UPDATE
     SET embedding = EXCLUDED.embedding, source_version = EXCLUDED.source_version
     WHERE semantic_search_blob.embedding IS DISTINCT FROM EXCLUDED.embedding
        OR semantic_search_blob.source_version IS DISTINCT FROM EXCLUDED.source_version;
   ```
   Why this is atomic: `FOR SHARE` on the `records` row conflicts with the `FOR UPDATE` the live publisher takes (`records.ts` publish) and with the ingest UPDATE that bumps the version. If a newer version committed first, the row is re-evaluated after the lock wait, `l.version = rows.version` fails and nothing is written. If we lock first, the ingest and the new publisher block until we commit, then overwrite our row with the newer version. An old worker therefore cannot land an older version over a newer record or a newer publish. `AS MATERIALIZED` is required so PG does not inline the locking CTE. Rows are locked in `record_key` order. The semantic rows are touched only after the records locks, the same order the publisher uses, so no lock cycle. The `IS DISTINCT FROM` pair is the write elision.
   - Emptied rows (field now empty): same transaction shape, `DELETE FROM semantic_search_blob b USING locked l WHERE (b.instance, b.scope, b.key) matches AND l.version = $v`.

   SQLite (single writer): the fence check, the `records` version re-read, and the row writes run inside one synchronous `transaction()` with no `await` in between: `SELECT ... FROM semantic_search_backfill_progress WHERE lease_owner=? AND lease_generation=? AND lease_expires_at > ?`, then per entry `SELECT version, deleted FROM records WHERE (instance, stream, key)` (existing `recordsIngestGetCurrentRecordState`), write only if `version = entry.version AND NOT deleted`. This replaces the bare `liveEntriesOnly` + `upsertMany` pair.

The live publish (`insertSemanticRows`) is changed to write `source_version = EXCLUDED.source_version` in its `DO UPDATE` (it already runs under the `records ... FOR UPDATE` version check, so it is authoritative; it needs no stored-version guard either) and its elision becomes `embedding IS DISTINCT FROM OR source_version IS DISTINCT FROM`. `computeSemanticEntries` gains an optional `version`; `records.ts` passes `expectedVersion`. Callers without a version (`semanticIndexUpsert`, legacy) write NULL = unknown, the safe value.

Phase B, orphans (rows with no live record). After Phase A reaches the end of `records`, for each declared scope key (ordinal `s`):
1. `SELECT record_key FROM semantic_search_blob WHERE connector_instance_id=$1 AND scope_key=$2 AND record_key > $3 ORDER BY record_key LIMIT 500`.
2. `SELECT record_key FROM records WHERE connector_instance_id=$1 AND stream=$2 AND record_key = ANY($3) AND NOT deleted`. Keys not returned are orphan candidates.
3. Delete atomically in one short transaction: `SELECT 1 FROM records WHERE ... record_key = ANY(orphans) FOR UPDATE` (locks tombstone rows; the live publish takes the same lock), re-check `deleted`, then `DELETE FROM semantic_search_blob WHERE (instance, scope, key) matches`. A row whose record was resurrected between steps 2 and 3 is skipped. If the record row does not exist at all, no publish can target it (publish needs the row), so deleting is safe.
4. Advance the cursor to `(s, last key)`; when a scope is exhausted move to `s + 1`.
Orphans from a stream reset or connection delete are already removed atomically elsewhere; Phase B covers the cases the brief names: delete with no backend, crash between tombstone and publish, and missing teardown.

Completion (cursor past the last scope): upsert `semantic_search_meta` (identity, only when kind is `rebuild` or meta is missing), delete the progress row guarded by `lease_owner`, return `complete` plus `pass_dirty_revision`.

### 3.3 Why this satisfies each required detector
- missing: Phase A step 3 (no row). stale: step 3 (`NULL` or `<`). orphan: Phase B.
- Offsetting count: the detectors never sum counts, so one orphan plus one missing row cannot hide each other.
- Race (version update vs repair page): steps 4 and 7 (text and version read together; write only while holding a lock on the record at that version).
- Never mark stale current: the repair never writes a version it did not embed from; a row is current only when `source_version == records.version`.
- Version reset: a pre-existing row with a higher (or NULL, or lower) `source_version` than the regenerated record is a candidate and is overwritten with the record's version.

## 4. Budget, embedding overshoot, fairness (rev 2)

- Budget per `semanticIndexBackfillForManifest` call: `{ maxPages = 100, deadlineAt }`. `deadlineAt = min(now + maxDurationMs (default 10_000), callerDeadline)`. The reconcile passes the round's remaining time as `callerDeadline` (round `maxDurationMs` minus elapsed), so a 250 ms self-heal round or the 2000 ms timer round is honored inside a scope, not only between scopes. Defaults are constants with `PDPP_SEMANTIC_REPAIR_MAX_PAGES` / `PDPP_SEMANTIC_REPAIR_MAX_MS` overrides; tests pass `budget`.
- Embedding overshoot is bounded to ONE embed call: the deadline is checked before every embed (`buildSemanticIndexEntries` loop), not only between pages. On expiry the worker writes the entries it already embedded (fenced, section 5), does NOT advance the page cursor, and returns `partial`. The next tick re-reads the same page, sees the written rows as current, and continues. At least one embed is attempted per call so progress is guaranteed.
- Persisted state is the cursor plus pass identity, saved after every completed page (fenced). The budget itself is not persisted.
- Fairness across dirty scopes: `listDirtySearchIndexScopes` orders by `marked_at ASC`. A `partial` scope would stay at the head and starve others. On `partial` the reconcile rotates it: `UPDATE search_index_dirty SET marked_at = $now WHERE connector_instance_id=$1 AND stream=$2 AND dirty <> 0`. This touches neither `revision` nor `dirty`. `busy` scopes are skipped (the loop continues to the next scope).
- Remaining full-scope queries (rev 2 audit):
  - REMOVED from the backfill path: `postgresCountIndexableSemanticValues` (detoasts `record_json` for the whole stream), `postgresCountSemanticIndexByScope` (count gate), and `postgresCountSemanticRecords` (`COUNT(*)` of live records, used only for the `recordsTotal` diagnostic; that field becomes `null`).
  - Kept and bounded: `countDirtySearchIndexScopes` (`search_index_dirty` is one row per scope, small); `computeIndexState` probes (`LIMIT 1` on progress, meta list of one row per stream).
  - Each pass is O(stream) over many ticks by design (key-only pages, section 3), never one statement over the whole scope.

## 5. Lease, fencing token, dirty CAS (rev 2)

### Namespace
The lease and progress key is the PHYSICAL scope `(connector_instance_id, stream)` = the progress table primary key. Instance resolution mirrors lexical exactly (`search.ts:1175`): `pinned = manifest.storage_binding?.connector_instance_id || manifest.connector_instance_id`; if pinned, only `resolveLexicalConnectorInstanceId(connectorId, pinned)` is processed; if not pinned, today's semantic behavior is unchanged (every instance found in records, meta or progress). No other authorization or binding semantics change.

### Lease columns and fencing token
Progress row gains `lease_generation BIGINT NOT NULL DEFAULT 0` (SQLite INTEGER) beside `lease_owner`, `lease_expires_at` (epoch ms; PG uses `clock_timestamp()` as the single clock, SQLite the process clock).
- Acquire (one transaction, `SELECT ... FOR UPDATE` on the row or insert):
  `lease_generation = lease_generation + 1, lease_owner = $uuid, lease_expires_at = now + 120_000` when the row has no owner, or `lease_expires_at <= now`. Otherwise return `busy` with no work and no write.
  When the acquire creates the row it also runs `INSERT INTO search_index_dirty(... dirty=1, revision=1) ON CONFLICT DO UPDATE SET dirty = 1` (no revision bump) in the same transaction. Invariant: a progress row implies `dirty = 1`, so every unfinished scope has a resumer (the 60 s sweep and the self-heal both list dirty scopes). `pass_dirty_revision` is governed by the PASS-START RULE below, not by acquisition.
- The holder's token is `(lease_owner, lease_generation)`.
- Every write carries the fence: the page write (section 3 step 7, first statement, `FOR SHARE` on the progress row), the cursor save, the renewal, and the completion. Cursor save and renewal are one statement:
  ```sql
  UPDATE semantic_search_backfill_progress
     SET cursor_key=$c, lease_expires_at=$now+120000, updated_at=$t
   WHERE connector_instance_id=$1 AND stream=$2 AND lease_owner=$o AND lease_generation=$g AND lease_expires_at > $now
  ```
  0 rows => `lease_lost`: the worker stops, returns `busy`, writes nothing more. The expiry check is in the statement, so a worker that stalled past 120 s cannot commit. A takeover must `UPDATE` the row, which waits on the page transaction's `FOR SHARE`; either the old write commits entirely before takeover, or the fence fails.
- Renewal happens before every page write and every cursor save (same statement). TTL (120 s) is far above the one-embed overshoot bound (section 4), but correctness does not rely on that: an expired lease just discards the page.
- Completion: one transaction: fence check, upsert meta (if rebuild or missing), `DELETE FROM semantic_search_backfill_progress WHERE ... AND lease_owner=$o AND lease_generation=$g`. Returns `complete` with the row's `pass_dirty_revision`.
- Release on partial: `UPDATE ... SET lease_owner=NULL, lease_expires_at=NULL WHERE ... lease_owner=$o AND lease_generation=$g`.

### Pass-start rule for `pass_dirty_revision` (rev 3 gate)
- Written exactly once per pass: when a NEW pass is created (no progress row, or the row is reset), in the same transaction that sets `cursor_key = NULL`: `pass_dirty_revision = (SELECT revision FROM search_index_dirty WHERE <scope>)`, or NULL if no dirty row exists (the ensure-dirty insert in that transaction then creates revision 1 only after the read, so NULL never clears).
- Never re-read. Lease acquire on an existing row (renewal, partial/busy returns, expiry, takeover by a new owner) leaves `pass_dirty_revision` and `cursor_key` untouched; the acquire statement does not list those columns. A resumed or new owner reads the stored value.
- Reset (new value, cursor NULL, in one transaction) happens only: (a) a profile invalidation (fingerprint, model, dimensions or metric changed) together with the whole-stream delete and `pass_kind='rebuild'`; (b) completion found a newer revision (below); (c) a leftover `rebuild` row whose meta is already current becomes a `repair` pass.
- The pass covers both phases (records phase, then orphan phase) under the one stored value. A key changed behind either cursor bumps `revision` above it, so the completion CAS fails and the next pass revisits it, including a new orphan behind the orphan cursor.
- Completion transaction: fence check, then
  `UPDATE search_index_dirty SET dirty=0, reconciled_at=$t, last_error=NULL, attempts=0, next_attempt_at=NULL WHERE connector_instance_id=$1 AND stream=$2 AND revision = <stored pass_dirty_revision>` (NULL: no clear).
  - Rows changed = 1: delete the progress row, return `complete`.
  - Rows changed = 0 (a newer revision survived): in the same transaction reset the progress row (cursor NULL, `pass_dirty_revision` = current revision read now, lease released, `pass_kind='repair'`), leave `dirty=1` and `revision` untouched, return `partial`. The progress row keeps the resumer guarantee (progress row implies dirty=1).
- The lexical half still gates the reconcile's own clear: the reconcile no longer issues a second clear for semantic. It clears only when lexical is in sync and semantic returned `complete` (the semantic CAS already ran); if lexical must also clear, it uses the same `revision = passDirtyRevision` equality.

### Lock order (for implementation)
progress row (lease/fence `FOR SHARE`/`UPDATE`) -> `records` rows in `record_key` order (`FOR SHARE`, repair) -> `semantic_search_blob` rows. The live publisher takes `records FOR UPDATE` -> semantic rows and never touches the progress row. Profile reset takes the progress row, then deletes semantic rows without locking `records`. No cycle; to be verified against the publisher path with a concurrent test during implementation.

### `computeIndexState` probe plan (for implementation)
The `LIMIT 1` existence probe on progress and the meta list are tiny tables (one row per scope); confirm with plan-only EXPLAIN on the test DB that they are bounded, and add a bounded predicate if not.

### Dirty CAS (exact)
`semanticIndexBackfillForManifest` returns `{ scopes: [{ connectorInstanceId, stream, status: 'complete'|'partial'|'busy', passDirtyRevision }] }`.
- `complete`: the reconcile calls the existing `clearSearchIndexDirty(key, expectedRevision = passDirtyRevision, now)`, i.e.
  `UPDATE search_index_dirty SET dirty = 0, reconciled_at=$4, last_error=NULL, attempts=0, next_attempt_at=NULL WHERE connector_instance_id=$1 AND stream=$2 AND revision = $3`.
  It is an equality compare against the revision read when the pass started. If `passDirtyRevision` is NULL (no dirty row at pass start) the reconcile does not clear. Equality (not `<=`) means any later mark, which only ever increments `revision`, makes the clear a no-op.
- `partial` / `busy`: no clear, no failure evidence, no backoff change. No statement in this design writes `revision` except the existing mark-dirty increment. `ensure-dirty` is `SET dirty = 1` only; marked_at rotation is `SET marked_at` only. Revision is never decremented and a newer revision is never cleared.
- Edge 3/5 enqueue: boot (`retrieval-startup-backfill.ts`, `index.ts:1306`) and registration (`auth.ts:5452`) rely on the acquire-time dirty guarantee above. They also call `ensureSearchIndexScopeDirty` explicitly for every `partial` scope in the result, and for scopes deferred before acquisition because the budget ran out (deferred scopes get no progress row, so the explicit call is what enqueues them).
- Single-flight covers boot, registration, timer and self-heal because the lease is inside the backfill step they all call.

## 6. `index_state` (rev 2: existing semantics kept)

No change to `computeIndexState`. Any progress row => `stale`; a backfill active in-process => `building`; otherwise identity check on meta => `built` or `stale`. Citations:
- `server/search-semantic.ts:~3388-3440` (`computeIndexState`: `if (progressRow) return "stale"`).
- `README.md:236`: "The reference reports `index_state: "stale"` or `"building"` and rebuilds from stored records."
- `server/metadata.ts:874-921, 976, 1032` (advertised as `capabilities.semantic_retrieval.index_state`, enum `built|building|stale`, `openapi/reference-public.openapi.json:542`).
- `server/deployment-diagnostics.ts:641-649` (operator warnings for `building` and `stale`).
- `server/search-semantic.ts:4099` comment: search runs regardless of `stale`; the state is an honesty advertisement, not a gate. I found no code that gates serving on it.
I found no spec text in this repo (no `openspec/`) proving `built` means "serving" rather than "fresh", so I keep it. Consequence, stated plainly: while any unfinished pass exists (repair or rebuild, including the multi-day legacy convergence in section 7) the server advertises `stale` while still serving the existing vectors. That is the existing contract and is honest. If the root wants repair advertised as `built`, that is a protocol decision I have NOT made. `pass_kind` stays (needed to decide whether the whole-stream delete already ran) but does not feed `index_state`.

## 7. Cost of converging legacy NULL rows (one time) -- CONDITIONAL AND UNMEASURED

Every figure below is an estimate that depends on inputs I did not measure: the 3.4M row count (from the brief), per-row sizes (from the DB owner's report), embed throughput `E` on this host, and whether updates are HOT. None is guaranteed performance. Measure `E` and WAL per row on the disposable container before quoting any of it.

Inputs: 3.4M `semantic_search_blob` rows [from the brief]; 9.5 GB heap + 11 GB index measured by the DB owner [trace §5A]; about 2.8 KB heap per row and about 1.5 KB of that is the 384-dim float32 vector [V: 384 x 4 B = 1536 B]; the largest stream is about 1.5M records, with about 1.5 to 1.8M rows [trace §0].

| Item | Estimate | Basis |
|---|---|---|
| Rows to validate | 3.4M | every pre-change row is NULL |
| Embed calls | up to 3.4M (one per row; no stored text hash) plus any missing rows | a NULL row can only be proven current by re-embedding its text |
| Pages | about 6,100 (3.4M / about 560 rows per 500-record page at about 1.1 declared fields per record) | `PAGE = 500` |
| Read bytes per page, record scan | under 50 KB (id, key, version only) | no `record_json` |
| Read bytes per page, candidates | 500 x average record JSON, about 1 to 5 MB for chat-style records [?] | legacy pages are all candidates |
| Write bytes per page (statement params) | about 560 rows x about 7 KB = about 4 MB | trace: 7 to 10 MB for 500 records, 2 fields |
| Heap churn if the embedding is unchanged | one new tuple per row (about 2.8 KB), the old one becomes a dead tuple; total about 9.5 GB until vacuum | non-HOT update; the version column changed |
| Index churn | up to one new entry per index per row (PK, scope btree, HNSW partials); about 11 GB of index space now, so up to about 11 GB of index WAL | non-HOT update touches every index |
| Total WAL, order of magnitude | about 20 GB, plus full-page images | sum of the two rows above |
| Compared with today's drift rebuild | about half: today deletes then re-inserts the same rows, uncapped, and re-entered every tick | trace §2 |
| Steady state after convergence | zero writes for current rows (elision) | `IS DISTINCT FROM` on both columns |

Pages per tick under the persisted budget: `min(maxPages = 100, 10 s x E / 560)` where `E` is embed docs per second on this host. `E` is not measured (the embed loop in `buildSemanticIndexEntries` is sequential per page). For `E` = 50 to 200: 0.9 to 3.6 pages per tick, i.e. about 500 to 2,000 rows and about 3 to 12 MB of WAL per tick. At one tick per 60 s: 6,100 pages need about 1,700 to 6,800 ticks, i.e. about 1.2 to 4.7 days (conditional, unmeasured). The defaults are deliberately conservative. Raising `PDPP_SEMANTIC_REPAIR_MAX_MS` scales this linearly. Request-time self-heal can add rounds under search load; the lease keeps them from overlapping.

Mitigation options for the root (not in this change): (1) accept the paced convergence; (2) an operator-run, opt-in drain that calls the same repair in a loop with a larger `maxDurationMs`; (3) a per-key sidecar table for versions to avoid heap and HNSW churn, rejected here because of the desync risk in section 2. Bulk-stamping is NOT offered, per the root.

Boot cost [I]: every boot now runs a bounded pass for each semantic stream (previously a count compare that detoasted `record_json` for the whole stream). Scopes that do not finish are marked dirty and finish in the sweep. In steady state (all rows current) the cost is about 3,000 key-only pages for the 1.5M-record stream per full verification, roughly 10 ms of DB time per page [?, not measured], and zero writes.

## 8. SQLite and Postgres parity

The semantic index exists on both, so both are implemented. Postgres is production.

- One shared engine (new module `server/semantic-index-repair.ts`) runs the pass over a small `RepairStore` interface; there are two implementations: Postgres (SQL above) and SQLite (over the existing `SemanticIndex`). The decision, cursor, budget, lease protocol, and detectors are the same code.
- `SemanticIndex` gains three methods, implemented for both `sqlite-vec` and `blob-flat`: `listVersions({instance, scopeKeys, recordKeys})`, `pageKeys({instance, scopeKey, afterRecordKey, limit})`, `deleteExactKeys({instance, scopeKey, recordKeys})`. `upsert`/`upsertMany` persist `entry.version` (vec0: sidecar column; blob-flat: table column).
- SQLite concurrency differs but needs no extra guard: the page write runs synchronously after `liveEntriesOnly` re-reads `records.version` in one tick (single writer), so an older version cannot be written over a newer one. The vec0 `UPDATE semantic_search_vec` and sidecar version write happen in one `transaction()`.
- New SQLite statements are registered `.sql` artifacts under `server/queries/search-semantic/` where static, and `iterateDynamicSqlAcknowledged` with `REVIEWED-DYNAMIC` notes where variable-arity `IN` lists are needed (existing precedent).
- Tests run on SQLite `blob-flat` and, when `sqlite-vec` loads, on `sqlite-vec` too.

## 9. Behavior edges (rev 2 status)

1. ACCEPTED with conditions: honor `storage_binding` exactly as lexical does (section 5 namespace).
2. Result object instead of `void`: callers updated.
3. ACCEPTED with conditions: `partial`/`busy` keep the dirty mark, never touch `revision`.
4. CHANGED: only `source_version == record.version` is current; no stored-version monotone guard (section 3).
5. ACCEPTED with conditions: boot and registration enqueue unfinished scopes explicitly and via the acquire-time invariant.
6. Removed: `postgresCountIndexableSemanticValues`, `postgresCountSemanticIndexByScope` and `postgresCountSemanticRecords` from the backfill path (the first stays exported for its test).
7. Needs a broader decision only if the root rejects it: advertised `stale` for the days a legacy convergence runs (section 6).

## 10. Tradeoffs

- Full verification per dirty pass costs O(stream) key-only page reads, bounded per tick. A constant ingest stream re-dirties the scope and restarts the pass after each completion. Cost is capped by the budget (about 1 to 2 percent duty at defaults). A version-watermark incremental mode (`records.version > watermark` via `idx_pg_records_stream_version`) would cut this but needs another persisted watermark and a full orphan sweep schedule; deferred.
- Legacy convergence is slow by design (section 7). The choice is between pace and burst; the incident was a burst.
- Row-level lease depends on the clock only through a 120 s TTL.
- The progress table now carries two kinds of row. The alternative (a new table) would also need entries in stream-reset, connection-delete, and orphan-stream cleanup, which today already clear the progress row. Reuse keeps one lifecycle.
- Orphan removal needs row locks on tombstones for one short transaction per 500 keys. It blocks only a concurrent publish of the same record.
- Share-locking up to 500 `records` rows per page write briefly blocks concurrent ingest UPDATEs of those rows (they wait for one short transaction).
- Lease fencing adds one `FOR SHARE` on the progress row to each page write; takeovers wait for an in-flight page.

## 11. Tests (to be written after approval)

Postgres real container (`dcsem-pg`, `pgvector/pgvector:pg16`, tmpfs, 127.0.0.1:55447) and SQLite, small fixtures, stub backend (`makeStubBackend`):
stale update repaired; (rev 3) a key behind the saved cursor changes between ticks, then the pass completes: the dirty mark survives and a new pass repairs it; the same across a lease takeover by a new owner (pass_dirty_revision unchanged); a new orphan behind the orphan cursor is removed by the next pass; a profile change mid-pass resets pass_dirty_revision and cursor; record version reset with a pre-existing HIGHER stored embedding version is repaired (PG and SQLite); SQLite `deleteAllRecords`/reset while the backend is down, then backend returns: rows repaired or removed, none falsely current; an old worker (stale version) racing a new record version and a new publisher: the newer version wins and nothing older lands (PG: held `FOR SHARE`, concurrent ingest+publish; SQLite: interleaved sync steps); lease expiry: an old worker whose lease was taken over cannot write, save a cursor or complete (fencing token); partial/busy leave `revision` unchanged and a mid-pass mark survives the CAS; an embed that exceeds the deadline writes completed entries, does not advance the cursor, and the next call resumes; fairness: two dirty scopes both advance across ticks; storage_binding pin processes only the pinned instance and an unpinned call still processes all; boot-partial scope has `dirty = 1` and is resumed by the sweep; missing+orphan offsetting to equal counts detected and repaired; legacy NULL treated as stale; backend unavailable then delete then backend returns removes the orphan and marks nothing current; two overlapping repairs: one `busy`, dirty mark survives the CAS; ingest version update racing a repair page: newer version wins; budget stops mid-stream and the next call resumes from the persisted cursor; count drift issues no whole-stream DELETE (assert on SQL text and row counts); an unchanged upsert writes nothing (`ctid`/`xmin` unchanged); `index_state` is unchanged: `stale` while an unfinished pass row exists. Update `scripts/postgres-template-eligibility.ts` (and the cold or eligible inventory test) for the new Postgres test file, and keep the existing semantic and search suites green.

## 12. Docs and files that need updating

- `reference-implementation/README.md` (near `:236`): count drift is repaired in place; only identity changes delete the index; `stale` is advertised while a pass is unfinished.
- `reference-implementation/docs/migrate-storage.md` (semantic tables at `:98-101`, `:224-227`, `:452-455`): new columns, legacy NULL meaning.
- Code comments that name the old behavior: `server/stores/search-index-dirty-store.ts:19`, `server/db.ts:2473`, `server/search-index-reconcile.ts` header, `test/semantic-startup-backfill-catches-crash-abandoned-record.test.ts` header.
- `server/backup-table-policy.ts`: no change (tables unchanged; reasons stay true). `scripts/migrate-storage/*`: copies whole tables; verify the new nullable columns round-trip (implementation check).
- `openapi/*.json`: no change (`index_state` enum unchanged).
- Schema and registry: `server/postgres-storage.ts`, `server/db.ts`, `server/queries/index.ts` + new `.sql` artifacts.

## 13. Implementation notes and deviations from rev 3 (as built)

- **Dirty enqueue is inside the backfill, not in each caller.** `repairSemanticScope` calls `ensureSearchIndexScopeDirty` for a scope deferred by an exhausted budget, and the pass-creating transaction ensures the dirty row (no revision change). Boot, registration, timer and self-heal therefore get the same guarantee with no caller edits.
- **Completion CAS lives in the pass's completion transaction** (`complete()`), not in the reconcile. The reconcile maps `complete` to `converged` and does not issue a second clear with the round's later revision.
- **Pass kind at creation.** A created progress row is always `repair`; `resetPass(..., kind: 'rebuild')` flips it only AFTER the whole-stream delete, so a crash between the two re-runs the delete instead of resuming an un-cleared rebuild.
- **SQLite reset with no backend.** `semanticIndexDeleteByConnectorStream` previously returned early when no backend was configured, leaving rows whose `source_version` could equal a regenerated record's restarted version. SQLite now removes the derived rows (vec0 rows by rowid, sidecar, blob, meta, progress) without needing a backend. Postgres already deletes atomically in `postgresDeleteAllRecords`.
- **Removed dead code** from the backfill path: `semanticBackfillIndexIsInSync`, `rebuildSemanticIndexForStream`, `postgresSemanticIndexInsertManyGuarded`, `postgresSemanticRecordsPage`, `postgresGetSemanticProgress`, `postgresUpsertSemanticProgress`, `postgresCountSemanticRecords`, `postgresCountSemanticIndexByScope`. Kept because tests import them: `postgresCountIndexableSemanticValues`, `postgresListExistingSemanticKeysForRecords`. The SQLite `listExistingKeys` index methods and their static queries are now unused (left in place to keep this change reviewable).
- **Two existing tests changed for the new contract:** `connector-manifest-revision-fence.test.ts` (a second concurrent backfill on a leased scope now reports `busy`, then converges on the next call) and `device-ingest-conformance.test.ts` (round result gains `busy` and `partial`).
- **Inventory:** the two new test files are cold-required in `scripts/postgres-template-eligibility.ts` (they exercise the bootstrap ALTERs); `PG-PROFILE-51-REPORT.md` counts updated (164 = 132 + 32).
- **Test image.** The disposable container used the local `pgvector/pgvector` image `8e5355e9ff39` (PG 16.14, untagged locally; `pgvector/pgvector:pg16` is not present).
