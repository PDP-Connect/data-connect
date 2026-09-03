# Codex rollout archival contract

This document is the contract between the `codex` connector
(`packages/polyfill-connectors/connectors/codex/`) and an external process —
referred to below as "the archiver" — that relocates old Codex CLI rollout
files on disk. The archiver is **not part of this repository**. Nothing here
implements, wraps, or modifies the archiver; this file exists so both sides
have one place that states the invariants the connector's rollout scan relies
on.

## Roots

- **Primary root** — `CODEX_SESSIONS_DIR` (default `$CODEX_HOME/sessions`).
  Codex CLI itself reads and writes here. This is the only root Codex knows
  about.
- **Archive root** — `CODEX_SESSIONS_ARCHIVE_DIR` (default
  `$CODEX_HOME/sessions-archive`). The archiver's relocation target. Codex CLI
  never reads or writes here.

Both roots use the identical `yyyy/mm/dd/rollout-<timestamp>-<uuid>.jsonl`
layout. A file's relative path under the archive root (e.g.
`2026/04/15/rollout-2026-04-15T12-26-06-<uuid>.jsonl`) is expected to be
identical to its relative path was under the primary root before the move —
only the root changes.

## Invariants the archiver MUST uphold

1. **One-way relocation only.** A rollout file moves from the primary root to
   the archive root. It never moves the other direction, and it never exists
   in the archive root before it has existed in the primary root.
2. **Append-only, immutable once archived.** Once a rollout file lands under
   the archive root, its bytes never change — no further appends, edits,
   truncation, or rewriting. (Codex itself may still be appending to the file
   while it is under the primary root, before the archiver picks it up; this
   invariant is about the file's life AFTER relocation.)
3. **No deletion.** The archiver does not delete rollout files. Its result is
   a relocation, not a copy that leaves a duplicate behind, and not a prune.
   A rollout file that disappears from the primary root must, given enough
   time for the archiver to run, reappear under the archive root at the same
   relative path — never simply vanish.
4. **Filename (and therefore the embedded session UUID) is preserved
   verbatim across the move.** The connector identifies a rollout file by the
   UUID suffix in its filename (see `extractRolloutUuidFromFilename` in
   `parsers.ts`), which is confirmed to be byte-identical to the
   `session_id`/`id` field inside the file's own `session_meta` JSON line.
   Renaming the file, or writing it under the archive root with a different
   name, breaks this identity and would look like a brand-new session to the
   connector.
5. **The move should be as close to atomic as the filesystem allows** (e.g.
   `rename(2)` within the same filesystem, not `cp` followed by a separate
   `rm`). The connector tolerates a non-atomic move (see "Mid-move race"
   below) but a true rename removes the failure window entirely.

## What the connector guarantees, given the invariants above

- **Both roots are scanned and merged.** `CODEX_SESSIONS_DIR` and
  `CODEX_SESSIONS_ARCHIVE_DIR` are walked independently and their rollout
  files are treated as one logical set (see `scanRollouts` in `index.ts`).
- **Identity is UUID-based, never path-based.** The per-file parse cursor
  (`RolloutFileCursor`, persisted in STATE as `file_cursors`) is keyed by the
  session UUID extracted from the filename, not by the file's path. A file
  relocated from the primary root to the archive root is recognized as the
  SAME file: the next scan does not reparse it from scratch and does not
  re-emit its already-emitted `messages`/`function_calls` records. See
  `archive-scan.test.ts` — "safety case 2" tests, e.g. "a rollout file moved
  from sessions/ to sessions-archive/ and rescanned emits ZERO new records".
- **Relocation is never confused with deletion.** The connector's
  `isTombstone` mechanism (see `src/connector-runtime.ts`) only fires on an
  explicit deletion marker inside a record's own payload — it is never
  inferred from a record's absence between runs, and the Codex connector does
  not wire it at all. A rollout file's disappearance from the primary root
  while present in the archive root is not treated as a deletion signal in
  either direction.
- **The mid-move race is handled.** Because the two roots are walked
  independently (not atomically together), a scan can land while the
  archiver's move is in flight — a `cp`-then-`rm` style relocation can
  briefly leave the same UUID visible under both roots, or a listing race can
  surface stale entries. The scan de-duplicates by UUID within a single pass
  (`seenCursorKeysThisScan` in `index.ts`): the first sighting of a UUID in a
  scan wins, a second sighting in the same scan is treated as the same file
  and skipped — never double-parsed, never double-emitted, and never
  reported as evidence of anything having been deleted.
- **Archive-root absence is reported honestly, not silently.** A host with
  nothing archived yet (a fresh install, or one where the archiver hasn't run)
  reports the `sessions_archive` coverage store as `missing` via
  `coverage_diagnostics` rather than failing readiness — see the
  `sessions_archive` entry in `CODEX_KNOWN_LOCAL_STORES` (`index.ts`) and its
  matching descriptor in `LOCAL_COVERAGE_STORE_DESCRIPTORS_BY_CONNECTOR.codex`
  (`src/local-source-inventory.ts`).

## Naming note

The Codex `state_5.sqlite#threads.archived` field (see `schemas.ts`,
`parsers.ts`, `types.ts`) is an existing, UNRELATED concept: it is Codex's own
in-app "user archived this thread" boolean, set inside the Codex CLI itself
and stored in its state database. It has nothing to do with this document's
filesystem-relocation archive. Code and comments for the concept described in
this document intentionally avoid the bare words `archived`/`isArchived` to
prevent the two from being conflated; see `sessions_archive` /
`archiveBaseDir` / `CODEX_SESSIONS_ARCHIVE_DIR` for the names actually used.
