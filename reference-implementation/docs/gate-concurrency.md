# Gate concurrency: policy, evidence, and use

## Policy

`scripts/run-tests.ts` caps file concurrency at **2** by default, clamped to the
available CPU parallelism and the number of selected test files:

```ts
const defaultConcurrency = Math.max(1, Math.min(2, availableParallelism?.() ?? 1, testFiles.length || 1));
```

`PDPP_TEST_CONCURRENCY`, when it parses to a positive integer, replaces that
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

## The one-off measurement behind the cap

The cap was set after a single pair of memory-default runs on 2026-09-03: the
same tree and the same selection, once at cap 2 and once at cap 8, on one host
at Node 22.23.1, git head `eb6a890d`.

| | cap 2 | cap 8 |
| --- | --- | --- |
| Elapsed | 352.198 s | 141.066 s |
| Selected files | 1,033 | 1,033 |
| Assertions | 6,961 | 6,961 |
| Passed / failed / skipped | 6,335 / 396 / 230 | 6,335 / 396 / 230 |
| Failure identities | 396 | 396 (same set) |
| Exit code | 1 | 1 |

Both runs failed, and they failed on the identical set of 396 assertions. That
is **failure-set equality for one pair on one host** — it says the cap did not
change which assertions failed, and nothing more. It is not a green-suite
result, and two equally failing runs are not evidence that either cap is safe.

The raw receipts and transcripts for that pair are not retained. They were a
snapshot of one day's tree, they went stale the moment the tree moved, and
re-verifying a frozen archive proves only that the archive is unchanged. Going
forward, **the evidence is the ongoing CI runs at the current cap**: every
`reference-implementation` CI run exercises the default cap against the tree as
it actually is, which is the claim worth holding.

Reading any run's counts, then or now: `completed_files` is derived from the
exit code (`run-tests.ts` writes `failed ? 0 : results.length`), not from an
observed per-file completion count, so it is 0 for any run that exits non-zero.
A real per-file completion claim needs raw file-outcome events, which the
receipt schema does not carry.

## Operational use

Use the default unless a measurement for the same profile and host justifies an
override. `8` below is an override, not the effective default on any host:

```sh
# Memory profile, cap 8 as an explicit override of the default.
PDPP_TEST_CONCURRENCY=8 pnpm --dir reference-implementation test

# PostgreSQL stays low unless its own restore-aware measurement says otherwise.
PDPP_TEST_PROFILE=postgres PDPP_TEST_CONCURRENCY=2 pnpm --dir reference-implementation test
```
