# Gate concurrency: policy, evidence, and use

## Policy

`scripts/file-concurrency.ts` decides how many test files the gate runs at
once. Each storage profile has a cap: **8** for `memory-default` and **8**
for `postgres`. The cap is clamped by the available CPU parallelism and by the
number of selected test files, and never falls below 1.

`PDPP_TEST_CONCURRENCY`, when it parses to a positive integer, replaces that
default request. Positive overrides remain clamped by the profile cap, CPU
count and selected file count. The runner reads it with `Number.parseInt`, which
truncates, so `1.5` becomes 1; a non-positive or unparseable value falls back
to the profile default, which is then clamped as above.

Because of the clamps the cap is a ceiling rather than a target. A 4-CPU
hosted runner resolves to 4 and never reaches 8.

## What the cap does and does not protect

Each test file runs in its own child process, so files do not share a runner
process. Process isolation alone does not bound resource use: files still open
SQLite databases and temporary directories on the same host, and several tests
assert real serialization ordering that heavy parallelism can break.

The PostgreSQL cap was 2 for two reasons that no longer hold. Files shared the
one restore database the backup oracle resets, and
`test/run-tests-postgres-template-selection.test.ts` cleaned up by dropping every
`pdpp_test_%` database on the cluster, killing other files' live databases at
any concurrency above 2. The runner now allocates a cold restore database per
file and owns every database it creates, and that test drops only the databases
its nested runner reports. `npm run test:postgres` also gives each run its own
disposable cluster, so concurrent runs do not share a server. Direct test
invocations outside the runner still require caller-owned targets.

Measured on 2026-10-18, 80 randomly sampled PostgreSQL-using test files
(`--files-from`, seed 2), private PostgreSQL 18 per run, `test-ab -n 3`
interleaved under `CPUQuota=800% MemoryMax=24G`, host load 56 to 90:

| | cap 2 | cap 8 |
| --- | --- | --- |
| wall (median, range) | 256.3 s (249.0 to 268.2) | 95.2 s (89.1 to 107.0) |
| CPU-seconds | 369.2 (358.4 to 372.3) | 380.5 (377.3 to 397.7) |
| peak memory | 1,936 MB (1,854 to 1,972) | 3,386 MB (3,267 to 3,465) |
| result, every run | 80 files, 862 passed, 0 failed | 80 files, 862 passed, 0 failed |

Cap 8 cuts wall time by 63 percent for 3 percent more CPU and 1.4 GB more peak
memory; all three differences are outside the run-to-run ranges. A single run
at 4 took 126 s, so the gain continues past 4. A 4-CPU hosted runner still
resolves to 4.

## Load-sensitive failures are defects, not artifacts

An earlier revision of this document listed four tests that failed only at high
concurrency, called them contention artifacts rather than code defects, and
concluded that the cap should stay low to avoid them. That reading was wrong.
Each has since been traced to a real defect and repaired at its root:

- Three SQLite writer-path tests closed the database while deferred index
  maintenance they had started was still running, so the lane failed with
  "no database is open" from a promise nobody awaited. They now drain the lane
  before teardown.
- The same three tests also raced a wall clock. Each holds a write gate on
  purpose while a queued writer waits on the production admission budget of
  two seconds, and a slow four-CPU runner spends that margin on real I/O. The
  test file now sets `PDPP_INGEST_LOCK_WAIT_MS` far above any deliberate hold,
  because the property under test is serialization order, not the timeout;
  the cases that test the timeout set their own short budget.
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

Reading any run's counts, then or now: older `run-tests.ts` runs wrote
`completed_files` as `failed ? 0 : results.length`, so it is 0 for any such run
that exited non-zero, NOT because no file finished. `run-tests.ts` now counts
the files whose child exited, pass or fail, and adds `failed_files` for the
ones that exited non-zero, were killed by the per-file watchdog, recorded a
failure although the child exited 0, or could not be accounted (a rejected
`todo`, an unexplained skip, a malformed event). An accounting error does not
stop the run: the file counts as failed with an empty summary, the accounting
result is still written, and the run then fails with
`accounting error in <file>: <kind>`, where the kind is `todo-rejected`,
`unexplained-skip` or `malformed-events`. The full error names a test, which
test code controls, so it goes only to a private 0600 file next to the
killed-file tails (named in the line), and on CI nowhere. A runner that a test
starts writes its diagnostics inside the outer run's directory
(`PDPP_TEST_DIAGNOSTICS_ROOT`); the runner accepts that override only under the
outer run's own directory, and prunes only run directories it marked. A killed file
is a failed file; it no longer aborts the files after it. Its result holds only
structured fields (`TIMED OUT (idle|hard)` or `KILLED`, the signal and the
elapsed time), never its raw output and never the name of the last test that
began running: under `--test-isolation=none` test code shares the child's stdout
with the reporter and can write that line itself, so the name is untrusted.
Locally the file's first line names that test and the newest 64 KB of the raw
output follows, in a mode 0600 file under
`${XDG_STATE_HOME:-~/.local/state}/pdpp-ri-test-diagnostics/` (one 0700
directory per run; the newest 20 runs are kept, none older than 7 days), whose
path the result names. It does not go to the run's `TMPDIR`, which the sandbox
removes when the run ends. On CI (`CI` set) it is not kept. The reporter never
prints a test's own output, but it emits a content-free `test:progress` event
(at most one a second) when output arrives, so a test that logs is not killed as
idle. `gate-concurrency-receipt.ts` still derives its
own `completed_files` from the exit code, so that receipt remains 0 on a failed
run.

## Operational use

The defaults above apply with no configuration. Override only where the host is
known and a measurement for the same profile justifies it:

```sh
# Memory profile, overriding the default cap of 8.
PDPP_TEST_PROFILE=memory-default PDPP_TEST_CONCURRENCY=4 npm --prefix reference-implementation test

# PostgreSQL on a private, disposable cluster (cap 8, clamped by CPUs).
npm --prefix reference-implementation run test:postgres
```

Whether 8 suits hardware larger than the measured host is not settled here;
re-measure rather than porting the number.
