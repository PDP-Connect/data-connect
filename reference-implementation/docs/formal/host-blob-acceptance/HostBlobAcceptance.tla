\* Copyright The PDP-Connect Contributors
\* SPDX-License-Identifier: Apache-2.0
------------------------- MODULE HostBlobAcceptance -------------------------
(***************************************************************************)
(* BLOB -> RECORD acceptance in the reference runtime.                     *)
(*                                                                         *)
(* Mirrors runtime/host-blob-acceptance.ts (the ordering rules) and the    *)
(* wiring in runtime/index.ts (verify the spool bytes, upload before the   *)
(* record is buffered, flush later). The connector is adversarial: at any  *)
(* step it may emit any message, with good or bad spool bytes. The run     *)
(* may be cancelled or fail at any step, and any upload or flush may fail. *)
(*                                                                         *)
(* The four switches below turn one rule off at a time. Each switched-off  *)
(* variant must violate an invariant; see RESULT.md.                       *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
  Keys,             \* record keys the connector may use
  MaxMsgs,          \* bound on connector messages in one run
  CheckBytes,       \* TRUE: verify size, sha256 and JSON before holding a BLOB
  RequirePending,   \* TRUE: a RECORD that references a host blob needs the held BLOB
  UploadFirst,      \* TRUE: store the blob before the record is buffered
  FailOnDoneHeld    \* TRUE: DONE while a BLOB is held fails the run

NoKey == "none"

VARIABLES
  run,          \* "running" | "done" | "failed" | "cancelled"
  held,         \* NoKey, or the key of the BLOB held in memory
  heldBad,      \* the held BLOB's bytes failed verification (only reachable if ~CheckBytes)
  store,        \* keys with a durable blob row and binding
  storeBad,     \* keys whose stored bytes failed verification
  buffered,     \* keys whose RECORD, with a blob reference, is buffered for ingest
  durable,      \* keys whose RECORD, with a blob reference, is durable
  lateUpload,   \* keys whose upload is still owed (only when ~UploadFirst)
  msgs

vars == <<run, held, heldBad, store, storeBad, buffered, durable, lateUpload, msgs>>

Init ==
  /\ run = "running"
  /\ held = NoKey
  /\ heldBad = FALSE
  /\ store = {}
  /\ storeBad = {}
  /\ buffered = {}
  /\ durable = {}
  /\ lateUpload = {}
  /\ msgs = 0

Fail == /\ run' = "failed" /\ held' = NoKey /\ heldBad' = FALSE /\ buffered' = {} /\ lateUpload' = {}

\* BLOB(k): the descriptor is valid; the spool bytes are good or bad.
Blob(k, good) ==
  /\ run = "running" /\ msgs < MaxMsgs
  /\ msgs' = msgs + 1
  /\ UNCHANGED <<store, storeBad, durable>>
  /\ IF held /= NoKey
       THEN Fail                                   \* a second BLOB before the RECORD
       ELSE IF CheckBytes /\ ~good
              THEN Fail                            \* bytes do not match the descriptor
              ELSE /\ held' = k /\ heldBad' = ~good
                   /\ UNCHANGED <<run, buffered, lateUpload>>

\* RECORD(k) that references a host blob.
RecordWithBlob(k) ==
  /\ run = "running" /\ msgs < MaxMsgs
  /\ msgs' = msgs + 1
  /\ IF held = k
       THEN \/ \* upload succeeds
               /\ held' = NoKey /\ heldBad' = FALSE
               /\ run' = "running"
               /\ IF UploadFirst
                    THEN /\ store' = store \cup {k}
                         /\ storeBad' = IF heldBad THEN storeBad \cup {k} ELSE storeBad
                         /\ buffered' = buffered \cup {k}
                         /\ UNCHANGED <<durable, lateUpload>>
                    ELSE /\ buffered' = buffered \cup {k}
                         /\ lateUpload' = lateUpload \cup {k}
                         /\ UNCHANGED <<store, storeBad, durable>>
            \/ \* upload fails: the run fails, the record is never buffered
               /\ Fail /\ UNCHANGED <<store, storeBad, durable>>
       ELSE IF RequirePending
              THEN Fail /\ UNCHANGED <<store, storeBad, durable>>   \* no BLOB, or a different one
              ELSE /\ buffered' = buffered \cup {k}                 \* mutant: accept a dangling reference
                   /\ UNCHANGED <<run, held, heldBad, store, storeBad, durable, lateUpload>>

\* RECORD(k) with no host blob reference.
RecordPlain(k) ==
  /\ run = "running" /\ msgs < MaxMsgs
  /\ msgs' = msgs + 1
  /\ UNCHANGED <<store, storeBad, buffered, durable>>
  /\ IF held /= NoKey THEN Fail ELSE UNCHANGED <<run, held, heldBad, lateUpload>>

\* PROGRESS passes while a BLOB is held. Any other message while held fails the run.
Progress ==
  /\ run = "running" /\ msgs < MaxMsgs
  /\ msgs' = msgs + 1
  /\ UNCHANGED <<run, held, heldBad, store, storeBad, buffered, durable, lateUpload>>

OtherMessage ==
  /\ run = "running" /\ msgs < MaxMsgs
  /\ msgs' = msgs + 1
  /\ UNCHANGED <<store, storeBad, buffered, durable>>
  /\ IF held /= NoKey THEN Fail ELSE UNCHANGED <<run, held, heldBad, lateUpload>>

\* The runtime flushes one buffered record. Ingest may fail, which fails the run.
Flush(k) ==
  /\ run = "running" /\ k \in buffered
  /\ UNCHANGED <<store, storeBad, msgs>>
  /\ \/ /\ durable' = durable \cup {k} /\ buffered' = buffered \ {k}
        /\ UNCHANGED <<run, held, heldBad, lateUpload>>
     \/ \* ingest failure fails the run; run cleanup drops the held blob
        /\ Fail /\ UNCHANGED durable

\* A deferred upload completes (only the mutant that buffers the record first).
LateUpload(k) ==
  /\ run = "running" /\ k \in lateUpload
  /\ store' = store \cup {k} /\ lateUpload' = lateUpload \ {k}
  /\ UNCHANGED <<run, held, heldBad, storeBad, buffered, durable, msgs>>

\* DONE: flushes everything, then the run is done. With a BLOB held it fails.
Done ==
  /\ run = "running"
  /\ UNCHANGED <<store, storeBad, msgs>>
  /\ IF held /= NoKey /\ FailOnDoneHeld
       THEN Fail /\ UNCHANGED durable
       ELSE /\ durable' = durable \cup buffered
            /\ buffered' = {}
            /\ lateUpload' = {}
            /\ run' = "done"
            /\ UNCHANGED <<held, heldBad>>

\* The run is cancelled or the connector exits at any time. Memory is lost; the
\* spool directory is removed. Nothing durable changes.
Cancel ==
  /\ run = "running"
  /\ run' \in {"failed", "cancelled"}
  /\ held' = NoKey /\ heldBad' = FALSE /\ buffered' = {} /\ lateUpload' = {}
  /\ UNCHANGED <<store, storeBad, durable, msgs>>

Stutter == run /= "running" /\ UNCHANGED vars

Next ==
  \/ \E k \in Keys, g \in BOOLEAN : Blob(k, g)
  \/ \E k \in Keys : RecordWithBlob(k)
  \/ \E k \in Keys : RecordPlain(k)
  \/ Progress \/ OtherMessage
  \/ \E k \in Keys : Flush(k)
  \/ \E k \in Keys : LateUpload(k)
  \/ Done \/ Cancel \/ Stutter

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ run \in {"running", "done", "failed", "cancelled"}
  /\ held \in Keys \cup {NoKey}
  /\ store \subseteq Keys /\ storeBad \subseteq Keys
  /\ buffered \subseteq Keys /\ durable \subseteq Keys /\ lateUpload \subseteq Keys

\* I1. A durable record never references a blob the store lacks.
NoDanglingReference == durable \subseteq store

\* I2. Only bytes that passed verification are stored.
OnlyVerifiedBytesStored == storeBad = {}

\* I3. Nothing is held after the run ends, so nothing stays pending forever.
NoHeldBlobAfterRun == run /= "running" => held = NoKey

\* I4. A run that finishes done has no blob without its record.
DoneLeavesNoOrphan == run = "done" => store \subseteq durable

\* I5. A buffered record's blob is already stored when the record is buffered.
BufferedRecordHasBlob == (UploadFirst /\ buffered \subseteq store) \/ ~UploadFirst

=============================================================================
