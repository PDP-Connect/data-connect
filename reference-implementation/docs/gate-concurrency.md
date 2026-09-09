# Gate concurrency: policy, evidence, and use

## Policy

`scripts/run-tests.ts` chooses its default file-concurrency cap from the storage
profile — **8** for memory-default, **2** for PostgreSQL — clamped to the
available CPU parallelism and the number of selected test files:

```ts
const DEFAULT_FILE_CONCURRENCY_CAP = selectedProfile === "postgres" ? 2 : 8;
const defaultConcurrency = Math.max(
  1,
  Math.min(DEFAULT_FILE_CONCURRENCY_CAP, availableParallelism?.() ?? 1, testFiles.length || 1)
);
```

The caps differ because the profiles differ. Memory-default gives every test
file its own in-memory storage, so independent files can run together and the
cap only has to bound host contention. PostgreSQL stays at 2 for the
restore-database reason described in the next section, and the cap-8
measurements archived below cover memory-default only.

`PDPP_TEST_CONCURRENCY`, when it parses to a positive integer, replaces either
default. A positive override is **not** clamped to the CPU count or the selected
file count.

## What the cap does and does not protect

Each test file runs in its own child process, so files do not share a runner
process. Process isolation alone does not bound resource use: files still open
SQLite databases and temporary directories on the same host, and several tests
assert real serialization ordering that heavy parallelism can break.

The PostgreSQL path has a stronger reason to stay low. Its backup/restore oracle
shares the restore database named by `PDPP_TEST_POSTGRES_RESTORE_URL`, so
otherwise-independent file workers can contend for the same restore resource.
Raising concurrency for PostgreSQL needs its own restore-aware measurement on a
PostgreSQL host; a memory-profile result is not authority for it.

## Archived memory-default measurements

Two memory-default runs of the same tree and selection, one at cap 2 and one at
cap 8, are archived with this document:

- `receipts/gate-concurrency-20260903.tar.gz` — the raw receipts and
  transcripts, four members, byte-for-byte as recorded
- `receipts/gate-concurrency-20260903.summary.json` — a readable pairing of the
  two runs

Read a member without unpacking the archive:

```sh
tar -xzOf docs/receipts/gate-concurrency-20260903.tar.gz \
  gate-concurrency-memory-cap-8.receipt.json
```

Replay the archived pair, which re-derives each receipt's counts, failure names
and selection digests from its own archived raw output:

```sh
node --test --experimental-strip-types scripts/evidence/gate-concurrency-receipts.test.ts
```

## What the receipts establish

Three different things are worth keeping separate:

- **Recorded provenance.** Git head, Node version, profile and source-tree
  digest are values the measuring process wrote down. Nothing here authenticates
  the host or the toolchain; matching digests and paired metadata do not make
  recorded provenance independently verified.
- **Digest binding.** Each receipt's digests bind its transcript, selected-file
  list and selection manifest. This shows the bytes were not edited after
  recording.
- **Re-derived outcomes.** The counts and failure identities are recomputed from
  the raw structured output the transcript carries, so a forged count or a
  renamed failure is rejected even when every digest still matches.

`counts.completed_files` is a legacy field derived from the exit code, not an
observed completion count. It is 0 on both archived runs because both exited
non-zero. A real per-file completion claim needs raw file-outcome events, which
this schema does not carry.

## What the pair observed

On the archived Node 22.23.1 runs, both caps selected 1,033 files and produced
6,961 assertions: 6,335 passed, 396 failed and 230 skipped, with the same 396
failure identities and exit code 1 in both runs. The cap-2 receipt records
352.198 seconds; the cap-8 receipt records 141.066 seconds.

This is **failure-set equality for this pair**, on one host, with both runs
failing. Two runs that fail identically say nothing about whether either cap is
safe, and none of it is a green-suite result. The failures are retained as
evidence rather than hidden.

On the recorded Node 22.23.1 run, both caps selected 1,033 files and produced
6,961 assertions: 6,335 passed, 396 failed, and 230 skipped, with the same 396
failure identities and exit code 1. The cap-2 receipt records 352.198 seconds;
the cap-8 receipt records 141.066 seconds. These failures are retained as
evidence, not hidden as a successful result.

## Operational use

Use the default unless a measurement for the same profile and host justifies an
override. `8` below is an override, not the effective default on any host:

```sh
# Memory profile, cap 8 as an explicit override of the default.
PDPP_TEST_CONCURRENCY=8 pnpm --dir reference-implementation test

# PostgreSQL stays low unless its own restore-aware measurement says otherwise.
PDPP_TEST_PROFILE=postgres PDPP_TEST_CONCURRENCY=2 pnpm --dir reference-implementation test
```
