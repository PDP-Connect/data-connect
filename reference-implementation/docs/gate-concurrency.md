# Gate concurrency: policy, evidence, and use

## Policy

`scripts/file-concurrency.ts` decides how many test files the gate runs at
once. Each storage profile has a cap: **8** for `memory-default`, **2** for
`postgres`. The cap is clamped by the available CPU parallelism and by the
number of selected test files, and never falls below 1.

`PDPP_TEST_CONCURRENCY`, when it parses to a positive integer, replaces that
default. A positive override is **not** clamped to the CPU count or the
selected file count. The runner reads it with `Number.parseInt`, which
truncates, so `1.5` becomes 1; a non-positive or unparseable value falls back
to the profile default, which is then clamped as above.

Because of the clamps the cap is a ceiling rather than a target. A 4-CPU
hosted runner resolves to 4 and never reaches 8.

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

## Load-sensitive failures are defects, not artifacts

An earlier revision of this document listed four tests that failed only at high
concurrency, called them contention artifacts rather than code defects, and
concluded that the cap should stay low to avoid them. That reading was wrong.
Each has since been traced to a real defect and repaired at its root:

- Three SQLite writer-path tests closed the database while deferred index
  maintenance they had started was still running, so the lane failed with
  "no database is open" from a promise nobody awaited. They now drain the lane
  before teardown.
- A large-upload test let a detached validation task outlive the test that
  started it and write into the next test's database.

A test that only passes because the gate is slow is hiding a defect. Raising
the cap surfaced these; keeping it low would have preserved them.

## The one-off measurement behind the cap

The memory-default cap was set after a single pair of runs on 2026-09-03: the
same tree and the same selection, once at cap 2 and once at cap 8, on one
24-core host at Node 22.23.1.

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
What supports the cap is the clamps that bound it and the repairs above, not
this wall-clock pair on its own.

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

The defaults above apply with no configuration. Override only where the host is
known and a measurement for the same profile justifies it:

```sh
# Memory profile, overriding the default cap of 8.
PDPP_TEST_CONCURRENCY=4 pnpm --dir reference-implementation test

# PostgreSQL stays at 2 unless its own restore-aware measurement says otherwise.
PDPP_TEST_PROFILE=postgres pnpm --dir reference-implementation test
```

Whether 8 suits hardware larger than the measured host is not settled here;
re-measure rather than porting the number.
