# Gate concurrency: profile-specific policy

`scripts/run-tests.ts` chooses its file-worker cap from the storage profile.
Memory-default uses eight file workers by default; PostgreSQL uses two.
`PDPP_TEST_CONCURRENCY`, when set to a positive integer, overrides either
default. The runner then clamps the default to the available CPU parallelism and
the number of selected test files.

## Why the profiles differ

Memory-default gives every test file its own in-memory storage. The cap of
eight limits host contention while allowing independent files to run together.
It is not a universal safe ceiling: the measurements below apply only to the
documented host and memory-default profile.

PostgreSQL keeps the cap of two because its backup/restore oracle shares the
restore database named by `PDPP_TEST_POSTGRES_RESTORE_URL`. Raising that cap
can make otherwise-independent file workers contend for the same restore
resource. Do not treat the memory-default result as authority to raise the
PostgreSQL cap; measure a dedicated PostgreSQL host and profile first.

## Reviewable memory-default measurements

The receipts and transcripts for the two measurements are checked in with this
document:

- `receipts/gate-concurrency-memory-cap-2.receipt.json` and
  `receipts/gate-concurrency-memory-cap-2.transcript`
- `receipts/gate-concurrency-memory-cap-8.receipt.json` and
  `receipts/gate-concurrency-memory-cap-8.transcript`

Each receipt binds its run to the Git head, manifest digest, selected files,
structured counts, final exit code, and start/end timestamps. Its companion
transcript has the digest recorded by the receipt and retains the emitted test
identities. The commands used Node 22.23.1, selected `ri-default` with the
`memory-default` profile, and set `PDPP_TEST_CONCURRENCY` to the cap named in
the file. The two receipts record whether the same selected files and outcome
counts were observed; they are evidence for this host only, not a green-suite
claim.

On the recorded Node 22.23.1 run, both caps selected 1,033 files and produced
6,961 assertions: 6,335 passed, 396 failed, and 230 skipped, with the same 396
failure identities and exit code 1. The cap-2 receipt records 352.198 seconds;
the cap-8 receipt records 141.066 seconds. These failures are retained as
evidence, not hidden as a successful result.

## Operational use

Use the profile default unless a measurement for the same profile and host
justifies an explicit override:

```sh
# The memory-default default is eight; this makes the setting explicit.
PDPP_TEST_PROFILE=memory-default PDPP_TEST_CONCURRENCY=8 pnpm --dir reference-implementation test

# PostgreSQL stays at two unless its own restore-aware measurement says otherwise.
PDPP_TEST_PROFILE=postgres PDPP_TEST_CONCURRENCY=2 pnpm --dir reference-implementation test
```
