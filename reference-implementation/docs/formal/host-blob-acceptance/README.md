# Host BLOB acceptance model

A TLA+ model of how the reference runtime accepts a BLOB and the RECORD that
references it. It mirrors `runtime/host-blob-acceptance.ts` (the ordering
rules) and the wiring in `runtime/index.ts` (verify the spool bytes, upload
before the record is buffered, flush later). `runtime/host-blob-acceptance.test.ts`
replays every message order the model explores against the real module.

## What it models

The connector is adversarial. At each step it may emit a BLOB (good or bad
spool bytes), a RECORD that references a host blob, a plain RECORD, PROGRESS or
any other message. The run may be cancelled or fail at any step. An upload or a
flush may fail.

| State | Meaning |
|---|---|
| `held` | the key of the BLOB held in memory, or none |
| `store` | keys with a durable blob row and binding |
| `buffered` | keys whose RECORD is buffered for ingest |
| `durable` | keys whose RECORD is durable |

Rules under test, one switch each:

| Switch | Rule | Mutant that turns it off |
|---|---|---|
| `CheckBytes` | verify size, sha256 and JSON before holding a BLOB | `M-NoCheckBytes` |
| `RequirePending` | a RECORD that references a host blob needs the held BLOB | `M-NoRequirePending` |
| `UploadFirst` | store the blob before the record is buffered | `M-LateUpload` |
| `FailOnDoneHeld` | DONE or any non-PROGRESS message fails the run while a BLOB is held | `M-NoFailOnDoneHeld` |

## Invariants

| Name | Statement |
|---|---|
| `NoDanglingReference` | a durable record never references a blob the store lacks |
| `OnlyVerifiedBytesStored` | only bytes that passed verification are stored |
| `NoHeldBlobAfterRun` | nothing is held after the run ends |
| `DoneLeavesNoOrphan` | a run that ends done has no blob without its record |
| `BufferedRecordHasBlob` | a buffered record's blob is already stored |

## Result

TLC 2026.11.15 (rev bc1b506), one worker, bound of five connector messages, two keys.
Reproduce with `tlc -workers 1 -deadlock -config base.cfg HostBlobAcceptance.tla`
(and each `M-*.cfg` and `W-*.cfg`).

| Config | Result | Distinct states | Violated invariant |
|---|---|---|---|
| `base.cfg` | no error | 156 | none |
| `M-NoCheckBytes.cfg` | counterexample | 12 | `OnlyVerifiedBytesStored` |
| `M-NoRequirePending.cfg` | counterexample | 5 | `BufferedRecordHasBlob` |
| `M-LateUpload.cfg` | counterexample | 21 | `NoDanglingReference` |
| `M-NoFailOnDoneHeld.cfg` | counterexample | 12 | `NoHeldBlobAfterRun` |
| `W-PlainMessageFailsWithBufferedRecord.cfg` | counterexample (expected) | 39 | action property `NoPlainMessageFailureWithBufferedRecord` |

Each switched-off rule breaks an invariant, so each rule in the base model does
work and the base result is not vacuous.

`W-PlainMessageFailsWithBufferedRecord.cfg` is a witness, not a mutant. It
asserts that a message other than a BLOB or a RECORD with a blob can never fail
the run while a RECORD is buffered. The counterexample is the trace that
production allows: BLOB(k1), RECORD(k1), BLOB(k2), then STATE. Every failure
discards the buffered batch (`Fail` sets `buffered' = {}`), so a failing
`OtherMessage` or `RecordPlain` must not also say `UNCHANGED buffered`. Before
this witness, both did, and the failure was disabled whenever a RECORD was
buffered. The failure step reaches the same state as a second BLOB after a
RECORD, so the reachable states and the invariant results did not change; the
witness guards the transition relation. If the witness stops producing a
counterexample, those two actions have regained the conflicting `UNCHANGED`.

## What the model does not show

- A blob can be stored and its record never made durable: the upload succeeds,
  then a later flush fails or the process dies. The blob is an orphan. It is
  unreachable on read, because a read needs a visible record that references
  the blob. A later run that sends the same bytes finds the content-addressed
  row and its binding insert is idempotent. No reclaim runs for such an
  orphan; the server reclaims blobs only when a connection or stream is
  deleted. `DoneLeavesNoOrphan` holds only for a run that ends done.
- The model does not cover the bytes themselves, only whether they passed
  verification.
