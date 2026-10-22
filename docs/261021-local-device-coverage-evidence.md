# Local device terminal coverage contract

Status: decision for linked data-connectors and data-connect PRs. PR #553 cannot restore positive coverage until new signed connector releases are pinned.

## Regression

The five pinned local releases no longer emit coverage_diagnostics. Their PROGRESS lines and stderr run diagnostics are not terminal coverage evidence. In data-connect, collector-runner.ts collects legacy coverage_diagnostics RECORDs but has no typed proof from these releases, so terminalFacts is null and the server's local coverage axis remains unknown. The prior proposal in data-connect-repin-553/docs/261021-local-device-coverage-evidence.md suggested RUN_COVERAGE; this decision supersedes that message choice.

## Step 1: message decision

Extend the existing DONE message with optional typed coverage. DONE is already the required final message. The collector retains one DONE in packages/collector-runtime/src/collector-runner.ts:1676, rejects output after it, and decides whether to send a durable terminal commit at :1035-1058. This allows the verdict to be bound to successful termination without an extra message or duplicate-event state machine. Existing DONE messages without coverage remain valid and yield unknown coverage.

| Candidate | Type and validation | Persistence and terminal fit |
| --- | --- | --- |
| DONE | packages/connector-protocol/src/connector-runtime-protocol.ts:879-891 types status, count and error. collector-runner.ts:1829 parses JSONL with a cast, so the new field needs explicit runtime validation. | The collector retains it; the authenticated terminal commit endpoint validates and persists terminal facts in reference-implementation/operations/local-device-terminal-collection.ts:42-141. Its final-message semantics fit. |
| PROGRESS | connector-runtime-protocol.ts:793-804 types owner-facing text and optional counts. connector-diagnostic.ts:4-77 writes best-effort bounded stderr, outside the protocol. | Neither is retained as terminal proof. A mid-run line can precede failure or truncation. |
| STATE | connector-runtime-protocol.ts:791 types a stream cursor; collector-runner.ts:1650-1662 buffers only in-scope checkpoint state. | A cursor is a resume position, not enumeration status. Some streams have none. |
| SKIP_RESULT | connector-runtime-protocol.ts:808-846 types a specific skip with reason, message, optional diagnostics and continuation. | One omission does not enumerate every store; absence of skips does not prove completeness. The collector does not retain it as terminal facts. |
| STREAM_EVIDENCE | connector-runtime-protocol.ts:842-885 types measured state-stream detail counts. | It is reference-only, can arrive before completion, and does not enumerate local stores or assert a terminal scope. |
| RUN_COVERAGE | No current protocol message. The earlier proposal adds a pre-DONE event and ordering rules. | The optional DONE field has the needed terminal semantics, so a new message is unnecessary. |

The existing local-device run-coverage summaries and packages/polyfill-connectors/src/connector-diagnostic.ts stderr helper may supply inputs to a verdict, but they do not carry a typed protocol verdict and are not persisted as one. `buildTerminalCollectionFacts` in collector-runner.ts reduces the old record-backed store map to status lists and loses store IDs; the v2 path must retain them. Although DONE has no such field today, its required final-message semantics permit an optional field without another event or ordering rule.

## Typed field

DONE.coverage has version 1, collection_scope, and streams. Each stream has stream, scoped, and stores. Each store has store and status. The closed status enum is collected, partial, unavailable, failed.

- collected: the requested region was fully enumerated and all supported records were handled; an honestly verified empty region counts.
- partial: a supported item was skipped, deferred, unsupported, or remains pending.
- unavailable: the source store was absent or inaccessible before enumeration.
- failed: enumeration or classification began but did not complete.

Only collected can support a positive coverage verdict. START.collection_scope carries the collector's canonical collectorScopeFingerprint; unscoped is an explicit value. DONE.coverage.collection_scope must echo it. The verdict lists exactly every requested stream and every store in each stream's signed manifest coverage inventory, with no duplicates or extras. The server admits a selected-stream subset when each reported stream matches its signed inventory; the read model requires the complete manifest inventory before showing whole-connection coverage. Store IDs are opaque to the app. A stream without inventory cannot prove coverage. scoped is true only if the connector enforced the requested boundary during enumeration.

The collector validates the typed field before accepting it. It carries store IDs and statuses in a version 2 terminal commit only after successful DONE, complete scan, drained outbox, and durable checkpoint. The server validates the commit against authenticated device/source/connector identity, boundary, manifest inventory, status enum and commit ID. Existing version 1 commits remain accepted; an old device or missing field continues to work but does not gain coverage. Malformed, partial, unavailable, failed, missing, duplicate, stale or mixed-boundary evidence stays unknown or a worse gap state. The validated proof must feed both the Collection Report and connection coverage axis. A drained outbox alone is no evidence of coverage.

The collector stores the latest acknowledged receipt in the local outbox (schema v6), outside prunable outbox rows, with the run's order as the server acknowledged it. An acknowledged run without coverage evidence clears the evidence; see "Device receipts" below. Offline status can describe the receipt's measured boundary; doctor compares it with the active owner boundary. The server read model must make the same boundary comparison before showing positive connection coverage.

The device verdict (`pdpp-local-collector status`, `terminal_coverage.verdict`) is `covered` only when the receipt names the selected release, every store is `collected`, and the run's runtime accounting is clean: durable admission, complete detail, consistent stream evidence, checkpoint eligibility, and zero outstanding debt. Clean accounting is the same test the server applies before it withholds `collected`. Missing or malformed accounting reads `no_evidence`; a measured gap reads `incomplete`. Open outbox work for the lane (queued, leased or dead-lettered) reads `unadmitted`, because the latest run has not reached a durable terminal commit and the receipt no longer stands for it.

The server's owner coverage is a fact about one admitted run, shown with its as-of. Any attempt the server observes from the same or a later run (a state commit, a terminal run record, a durable batch record, an admitted or refused batch, a delivered failure report, a legacy split terminal report) retires it to unknown; an observation that names no run counts as the newest started run. See "Run order and commit order" and "Revision fencing" below. Only an attempt the server never hears about leaves the last admitted coverage in place. Every failed run, including one that fails before its scan, leaves an open `connector_child_failure` gap on the device, so the device shows that run as `unadmitted` until a later complete run is admitted and recovers the gap.

## Collection Profile amendment

The canonical Collection Profile is `data-connectors/docs/spec/collection-profile.md`. [Data-connectors PR #541](https://github.com/PDP-Connect/data-connectors/pull/541), stacked on #516, specifies the optional START capability, stream store declarations, terminal store collection evidence, and its relationship to detail accounting and checkpoint eligibility. Data-connectors #539 and this PR implement the amendment. The owner approves it at merge.

## Acceptance and release

Failing-first tests must show absent coverage unknown, a valid fully drained proof covered, partial/unavailable/failed not covered, malformed rejected or unknown, and old devices still working. Verify connector emitters, collector checkpointing, server validation, and both read models. Bump the five connector manifest patch versions and regenerate connector-implementation-index.json. PR #553 then repins the five signed releases and their verified hashes.

## Run order and commit order

The spec gate amended the ordering decision. Two orders exist, and each controls a different thing. This section supersedes "retire by revision comparison only" where the two differ.

| Order | Assigned by | Controls |
| --- | --- | --- |
| Run sequence | the server, at run start, per connection | whether a positive proof is eligible |
| Commit revision | the server, at commit, per connection | the order of server observations and projections, and the as-of |

No wall clock takes part in either.

Sequence issuance. The runtime already contacts the server before it scans: a "starting" heartbeat, the pre-scan drain, and the state read, which names the connection. None of these can carry the issuance. The heartbeat is a best-effort liveness signal that names no run, and the state read is a GET, which must stay free of side effects. The runtime therefore makes one new idempotent call at the same point, after the state read and before the scan: `POST .../source-instances/{source}/run-starts` with the run id. The server resolves the authenticated device, source and connection the same way as the terminal route. In one transaction that holds the connection row lock, it increments `connector_instances.run_sequence_issued` and stores `(connector_instance_id, run_id) -> (run_sequence, storage_epoch, device_id, source_instance_id)` in `collection_run_sequences`. An exact replay of the same run id from the same device and source returns the stored sequence (200). The same run id from another device or source is `409 run_start_conflict`. The runtime keeps the run id it registered and uses it for the run's terminal record. A server without the route (404), or a failed call, leaves the run without a sequence. The run still collects and commits its terminal record, but that record can never be an eligible positive proof.

Multiple collectors. The sequence is connection-scoped and fenced by construction: the connection row lock serializes issuance, so two devices or runtimes that collect one connection get distinct sequences in start order. Several collectors per connection are therefore allowed. The proof of the most recently started run that the server has heard from is the only one that can be current.

Observed maximum. Every observation that takes a commit revision (see the table below) also updates a run-order marker on `connector_instances`, in the same transaction, after the revision `UPDATE` has locked the row: `run_order_sequence`, `run_order_event`, `run_order_run_id`, `run_order_revision`. An observation that names a run with a sequence in the current storage epoch has that sequence. An observation that names no such run is attributed to the newest issued sequence (`run_sequence_issued`) with no run id. Record batches, refused batches and state commits name no run, so they are always attributed this way; a failure report or terminal record of an unknown run is too. Attribution can retire a proof but never establish one. If the observation's sequence is greater than or equal to `run_order_sequence`, the marker moves to it: sequence, event, attributed run id (or NULL) and revision. A lower sequence leaves the marker unchanged. The observation still takes its commit revision and is stored as history.

Eligibility. A positive proof is a v2 terminal run record. It is current only when all of these hold:

- the marker event is `terminal_run` and the marker run id is the proof run;
- the proof's commit revision equals `run_order_revision`;
- the proof's run sequence equals `run_order_sequence`;
- the proof's storage epoch equals the connection's current `storage_epoch`;
- the existing checks pass: one release digest, the boundary and manifest snapshot, and no newer settled device run without a revision.

So an old run's proof that reaches the server after a newer run's terminal record (an outbox delay or retry) takes the next commit revision and is stored, but its sequence is below the marker, so it stays a historical fact with its as-of and never becomes current. A run without a server-issued sequence never matches the marker.

Replay. An exact replay of a run's terminal record returns the stored receipt and moves neither the sequence nor the revision. A conflicting duplicate fails with `409` and writes nothing. The HTTP route resolves the receipt before it validates the request against the current manifest inventory, so an authorized exact replay still gets its receipt after an inventory change. It keeps the full device, source and connection binding: the route authorizes the device and resolves the source and connection before the lookup, and the stored receipt must match every binding field.

Crash after ingest. A durable record is an observation attributed to the newest issued sequence. The run that ingested it registered its sequence before its scan, so the record moves the marker to that sequence and retires an earlier positive, even if the run dies before its terminal record. Repeated authorized refused batches can keep coverage unknown. That is accepted: a false positive is never kept to resist it.

Restore incarnation. The repository has no automatic restore detection. Its restore concept is the storage epoch: `connector_instance_config_current.storage_epoch` is documented as "bumped on backup restore / re-import", but no code bumps it, and only connections with a config pointer have one. The coverage order binds to that concept rather than a parallel one. `connector_instances.storage_epoch` (default 1) is the connection's storage epoch, and one restore step, `beginStorageEpochAfterRestore` (`reference-implementation/scripts/mark-storage-restored.ts`), increments it and `connector_instance_config_current.storage_epoch` for every row in one transaction. Issuance rows and terminal records carry the epoch they were committed in. After the step, every positive proof from before it fails the epoch check and reads unknown until a run issued in the new epoch commits an eligible terminal record. A sequence issued before the restore resolves to no run in the new epoch, so its observations are attributed to the newest issued sequence and cannot establish a proof. The declared restore path is: restore the database, run the step, then start the server. A restore without the step, such as a reverted virtual-machine snapshot, is not detected. A restored older proof can then read as current again. The server cannot detect that path, and this note discloses it as a deployment limitation, as Core restore safety requires.

Device receipts. The device stores, with each acknowledged terminal receipt, the run id, the run sequence and storage epoch the server acknowledged, and the commit revision. It replaces the stored receipt only with an acknowledgement for a later run: a higher (storage epoch, run sequence), or any acknowledgement when the stored receipt has no sequence. An older run's late acknowledgement leaves a newer receipt in place. An acknowledgement without a sequence clears the evidence but keeps the stored order. `pdpp-local-collector status` shows the receipt's as-of, and its verdict is `covered` only for a receipt with a sequence and a revision. Outbox schema v6 adds the columns; a v5 receipt has none of them and reads `no_evidence` until the next acknowledged run.

Tests. `A` is `reference-implementation/test/local-device-coverage-revision-atomicity.test.ts` (SQLite and PostgreSQL), `J` is `local-device-coverage-journey.test.ts`, `O` is `packages/collector-runtime/src/local-device-outbox.test.ts`, `L` is `packages/local-collector/test/runner.test.ts`.

| Rule | Tests |
| --- | --- |
| Delayed older proof stays history | A "run order: an older run's proof that arrives after a newer run's terminal record stays history"; J "J5" |
| No issued sequence, no eligible proof | A "run order: a run with no issued sequence never produces an eligible proof" |
| Second collector | A "run order: a second collector on one connection is ordered by run start, not by commit"; A "run start: the route issues a connection-scoped sequence and an exact replay returns it" |
| Replay and conflicting duplicate | A "replay: an exact terminal replay after an inventory change gets its receipt; a conflicting duplicate fails atomically" |
| Restore incarnation | A "restore: the restore step makes a restored proof unknown until a new eligible terminal" |
| Ingest before a crash | A "crash after ingest: a later run's durable records retire an earlier positive without its terminal"; J "J6" (kills the runner process) |
| Device receipt order and as-of | O "an older run's late ACK does not replace a newer run's receipt", "an ACK without a run sequence clears the evidence and keeps the stored order", "a v5 outbox upgrades to v6 and keeps its receipt readable without an as-of"; L "a receipt without a run sequence is no evidence, and an older run's late ACK does not replace a newer receipt" |
| Contract | A "contract: owner diagnostics and connector detail validate against @pdpp/reference-contract" |

## Revision fencing (replaces the wall-clock stale-proof rule)

The spec gate replaced the server's wall-clock rule (MAX `connector_state.updated_at` compared with the proof instant) with a monotonic per-connection revision. Equal timestamps do not identify a transaction, and a skewed clock can order a later commit before an earlier one. The revision follows the Core restore-safety fencing principle. Since the amended decision, the revision orders observations and projections, and run order decides eligibility (see "Run order and commit order").

Events that get a revision. The server assigns the next revision inside the transaction that persists each event it can observe for an authorized connection. The event and its revision commit together or not at all:

| Event | Kind | Transaction it shares |
| --- | --- | --- |
| Owner-scoped state write that touches a non-`$` stream | `state_commit` | the state write (connector-state store, PUT state route) |
| Terminal run commit (v1 or v2), with its own state delta | `terminal_run` | the terminal event, its state rows and run record (terminal-run-commit store) |
| Device batch record made durable | `batch_record` | that record's write and its durable-prefix advance (device ingest, `advance*DeviceIngestPrefix`) |
| Device batch accepted | `batch_accepted` | the `processing` to `accepted` transition, which is the replay decision (`completeProcessingBatch`) |
| Device batch refused after authorization (4xx, or a 503 after a received attempt) | `batch_rejected` | its own transaction; the revision is the refusal's only durable effect |
| Failure report (`connector_child_failure` or `policy_budget` gap) | `failure_report` | the gap upsert (`upsertPendingGap` with `collectionRevision`) |
| Legacy split `terminal-collection` report | `legacy_terminal` | its run event and run record (`commitLegacyTerminalCollection`) |

Server-owned `$` scope rows, heartbeats, gap recoveries, grant-scoped state, and replays of an accepted batch or a stored terminal response get no revision. They neither establish nor retire proof.

Atomicity. No event commits without its revision, and no revision is allocated in a separate transaction before or after its event:

- SQLite. Each event runs in one `BEGIN IMMEDIATE` transaction (the record write, `completeProcessingBatch`, the gap upsert, the terminal commits). The revision `UPDATE ... RETURNING` runs inside it. The write lock serializes events per database, so revisions follow commit order.
- Postgres. Each event runs in one `withPostgresTransaction` and locks the `connector_instances` row before the batch outcome or gap row. `completeProcessingBatch` and the gap upsert take the lock with the revision `UPDATE` as their first statement. A device record transaction already holds it from its admission check (`FOR UPDATE`). Terminal commits take the connector-instance advisory lock, then the row. Concurrent events for a connection therefore serialize on the row, and revisions follow commit order.
- Failure. If the revision cannot be recorded (no connection row, an unreadable stored revision, or a storage error), the store throws and the event rolls back. A device record or acceptance is not stored, a failure report stores no gap, a terminal commit (v2, v1 or legacy split) stores no run, event or state, and a state commit stores no state. A refusal whose revision cannot be recorded is answered `503 device_ingest_retryable`, not with the refusal, so the device retries rather than trusting an answer the server cannot order. No catch turns an unrecorded revision into success. The one write without a revision is a state commit for a connector-keyed legacy caller whose connection row does not exist yet; it has no projection to retire.
- Stored value. The schema does not keep the revision readable: both backends accept a negative value, and SQLite's INTEGER affinity also keeps text and reals. The advance `UPDATE` therefore matches only a stored non-negative integer whose successor is still a safe integer (SQLite also checks `typeof(...) = 'integer'`). Any other stored value matches no row and the event throws, so the server never increments a value it cannot order by.
- Replay. A legacy split report's event id is its run's. The commit reads the stored event under the same lock before it allocates. An identical retry (same connection and facts) is answered `200 {ok: true}` with no revision, so it retires nothing; a different report for the same run is `409 terminal_collection_conflict` and writes nothing. A replayed v2 terminal response also allocates no revision.

Each durable batch record takes its own revision, so a crash after any record commits, before the acceptance, leaves the earlier proof retired. A terminal commit that lands between two records of a batch is retired by the next record.

Storage. `connector_instances` holds the high-water mark: `collection_revision` (0 before any event), `collection_revision_event`, `collection_revision_run_id`, and `collection_revision_at` (wall-clock, display only). `connector_state.collection_revision` records the revision of the commit that last wrote each row; the projection no longer reads it. The terminal run event, and so `run_history.facts_json`, carries `collection_revision`, for v2, v1 and legacy split reports. SQLite adds the columns with `addColumnIfMissing`; Postgres uses `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`. Rows that predate the migration read 0 or NULL and fail closed until the next event.

Proof binding. A proof is a v2 terminal run record at revision R, with the run sequence and storage epoch of its run; its own state rows carry R. The projection reads the run-order marker, the run it names, the connection's storage epoch, the declared scope, the manifest generation and (for a terminal-run high-water mark) the connector manifest in one statement (the manifest only when the marker is a terminal run), so the proof payload, its fence and the boundary it is judged against come from one snapshot. The rest of the projection reads the scope, the generation and the manifest separately. A positive needs all three to equal the snapshot's; a scope or manifest change that lands between the reads makes the coverage unknown rather than a positive composed from two moments. A legacy `coverage_diagnostics` state row is never a proof: it names no run and no release digest, so it cannot back "complete as of" anything, and the projection shows unknown for it (PR #553 retires the legacy path).

Retirement. A proof is current only when it is the run-order marker: the marker event is `terminal_run`, its run id is the proof run, the proof's revision equals `run_order_revision`, its run sequence equals `run_order_sequence`, and its storage epoch is the connection's current one. The server reads the proof run by that run id, not by the newest `completed_at`. An observation of the same or a later run moves the marker and retires the proof to unknown. An observation of an older run takes the next revision but leaves the marker, so a delayed older proof or report stays history. A legacy split report names its run: an older run's report is history, and a report of an unregistered run counts as the newest started run and retires the proof. No wall clock takes part.

Fail closed. Coverage is unknown when the run-order marker, the proof revision, its run sequence or its storage epoch is missing, NULL, not a safe integer, or unequal; when the marker event or run id differs from the proof; when the run had no issued sequence; when the proof does not name exactly one release digest; or when the revision read fails. A proof is also unknown when the newest settled device run is a different run that carries no revision (a pre-migration row), because its order against the proof is ambiguous.

Terminal record for every successful run. A runtime that implements this profile version commits a terminal run record for every run whose DONE succeeded, even when coverage was not negotiated and no STATE changed. Without coverage evidence it sends a version 2 commit with empty `terminal_facts`, carrying the run's STATE delta. The server stores unknown inventory for it, and the device clears its receipt (`no_evidence`). A server that names no connection on its state read cannot bind a terminal record, so against such a server the runtime keeps the plain state checkpoint.

As-of. Every owner projection that can show positive local coverage carries `coverage_as_of`: run id, release digest, run sequence, collection revision, and commit time. That is the connector summary (list), the connector detail, the owner connection diagnostics (`health.axes` and `rendered_verdict`), and the connection health embedded in each (`connection_health.coverage_as_of`, `health.coverage_as_of`), which equals the top-level value. All of them read the same summary projection. Owner UI copy reads "complete as of <time>".

Contract. `@pdpp/reference-contract` is vendored as `reference-implementation/vendor/pdpp-reference-contract-0.1.0.tgz`, compiled from `packages/reference-contract` in PDP-Connect/pdpp at commit `0d3deca1` (see `reference-implementation/vendor/README.md`). Its diagnostics schemas set `additionalProperties: false` and do not list `coverage_as_of`, at the top level or in `health`. Its terminal-run response schema does not list `collection_revision`, `run_sequence` or `storage_epoch`, and the new run-start route has no contract entry, like the other local-collector routes (`terminal-collection`, `local-collector-gaps`). The source schema must add these members in PDP-Connect/pdpp; this repository then re-vendors the tarball by the documented process. `test/local-device-coverage-revision-atomicity.test.ts` validates the diagnostics and connector detail responses against the vendored contract and lists the members still pending; it fails when the vendored contract gains one, so the list cannot go stale.

Device diagnostics. `local_collector_coverage` in the device-exporter diagnostics takes `fully_accounted` and `coverage_as_of` from the same summary projection: true only while the fenced proof is current and the coverage axis is `complete`. Its `by_store`, `counts_by_status`, `store_count` and `unaccounted_stores` are historical inventory from raw `coverage_diagnostics` records, with no run, release or revision behind them, and never claim current completeness.

Limits. The server cannot order an attempt it never hears about. Examples are a run refused before authorization, a device that goes offline before it delivers its failure barrier, and a runner that predates this version and sends neither state nor records. A run start is not an observation either: a run that dies after it registers, before it sends anything the server records, leaves the proof in place. That includes a run whose record batches are all exact replays of batches the server already admitted, because an idempotent replay takes no revision. A restore without the restore step is not detected (see "Restore incarnation"). In those cases the projection keeps the last admitted proof, labelled with its as-of. The device keeps its stricter local verdict. There is no heartbeat or lease machinery.

## Collection Profile trim: moved text, dropped text, rule-to-failure-to-test

Non-normative. This section supports data-connectors PR #541, which trims
`docs/spec/collection-profile.md` (Sections 3.2, 3.4, 5.1, 5.8.2 to 5.8.4,
6.2 item 14, and 8). It records what left the profile and why. The table gives
the failure behind each MUST that remains, and the test that proves it.

Test labels used below:

- ATOM: `reference-implementation/test/local-device-coverage-revision-atomicity.test.ts`
- JOUR: `reference-implementation/test/local-device-coverage-journey.test.ts`
- STALE: `reference-implementation/test/local-device-coverage-stale-proof.test.ts`
- PROJ: `reference-implementation/test/local-device-terminal-coverage-projection.test.ts`
- OP: `reference-implementation/test/local-device-terminal-run-commit-operation.test.ts`
- RESTART: `reference-implementation/test/terminal-run-commit-collector-restart.test.ts`
- GREEN: `reference-implementation/test/ref-connectors-local-coverage-green.test.ts`
- STATE-PG: `reference-implementation/test/local-device-coverage-state-commit-postgres.test.ts`
- RUNNER: `packages/collector-runtime/src/collector-runner.test.ts`
- OUTBOX: `packages/collector-runtime/src/local-device-outbox.test.ts`
- LC: `packages/local-collector/test/runner.test.ts`
- CONSOLE: `apps/console/src/app/(console)/lib/connection-evidence.test.ts`
- DC: data-connectors `schemas/connector-manifest.schema.test.mjs`. These are
  text pins. They show that the profile says the rule, not that an
  implementation obeys it.

### Moved from the profile

Each item below was in #541's text and is now in the section named. Two items
were not in this note before, and they are added here.

- Revision events and their transactions: "Events that get a revision".
- Sequence issuance, the run-order marker, and the observed maximum:
  "Sequence issuance" and "Observed maximum".
- Commit order does not decide eligibility: "Run order and commit order".
- Runs from several devices ordered by start: "Multiple collectors".
- Exact replay resolves the stored receipt before it validates mutable state:
  "Replay".
- Restore incarnation and the storage epoch: "Restore incarnation".
- Attempts the server never observes, runs that die after registering, and
  the absence of a heartbeat or lease: "Limits".
- A runtime from before this version sends no terminal record, so an earlier
  proof stays current: "Terminal record for every successful run" and "Limits".
- Added here. The server resolves the release pair only after it authorizes
  the source instance, and it binds the claim to that instance's current
  binding generation. A connector-id-only manifest lookup, with no artifact
  pin, an unregistered digest, or a digest paired with another manifest
  fingerprint, never establishes positive coverage. If the release pair or its
  instance binding is missing or does not match, the result is unknown.
- Added here. The runtime retains the validated assertion separately from the
  derived verdict and from the evidence behind that verdict.

### Dropped from the profile

- "This section defines no client-visible PDPP Core response member." It is a
  scope statement with no failure behind it.
- "A runtime MAY request a separate run containing only instrumented streams."
  It is a permission. The rule that matters, that a connection-wide verdict
  does not cover uninstrumented streams, is kept.
- "A manifest MAY advertise support ... with `run_coverage: { "version": 1 }`."
  No failure depends on it, because START negotiation is what matters.
- "Checkpoint eligibility MUST remain governed by Sections 5.6 and 5.8." It
  restates the downgrade rule.
- "Connector package patch versions alone MUST NOT establish wire
  compatibility" and "Deployment MUST be runtime-first." Base Section 8 already
  says that profile versions are independent of connector versions and that
  rollout is runtime-first.
- "Adding this optional feature to an already published profile requires a
  minor profile version." Section 1 places this feature in 0.3.0, which covers
  it.
- "It also defines optional version 1 terminal store collection evidence ...
  the linked schemas do not yet establish support." Section 1 already says the
  linked schemas do not establish support for the version.
- Folded into the rules that carry the same failure: "Emission is provisional
  until durable admission" (into the durable-admission and rejected-effect
  MUSTs), "Dispositions MAY include ..." (into the `collected` status),
  "Runtime evidence that contradicts `collected` MUST take precedence" (into
  the connector-assertion MUST), "Failure of a complete-data claim MUST NOT ...
  gap debt" (into the checkpoint-downgrade MUST), and "Positive coverage
  applies only to the validated targets, source account, boundary, and release"
  (into the retained-bindings MUST in 5.8.4).

### Rule, failure, test

| § | MUST (trimmed profile) | Failure it prevents | Test |
| --- | --- | --- | --- |
| 3.2 | An identifier MUST NOT contain a credential or device-specific path. | A credential or device path is published in a signed manifest. | none (gap) |
| 3.2 | The manifest MUST state each store's obligation, content or metadata only. | Metadata-only inventory reads as completeness of content. | OP: "proven empty content is complete while metadata inventory stays inventory only" |
| 3.2 | A runtime MUST NOT derive store coverage for a stream with no `coverage_stores`. | An undeclared store reads as covered. | OP: "the terminal endpoint rejects a store outside the registered inventory" |
| 3.2 | A change to a store's obligation MUST change the manifest revision. | A proof for the old obligation survives the change. | PROJ: "catalog obligation changes invalidate proof when the binding generation advances" |
| 3.4 | A connector that cannot run without the evidence MUST declare `RUN_COVERAGE_V1`. | The runtime runs the connector and silently drops evidence it needs. | none (gap) |
| 3.4 | A runtime that does not support the capability MUST refuse the connector before spawn. | Same as above, without the declaration. | none (gap) |
| 3.4 | When START omits `run_coverage_version`, a connector MUST omit `DONE.coverage`. | Coverage that was not requested is trusted. | JOUR: "A: without START coverage negotiation, a successful run supplies no positive coverage"; RUNNER: "a connector that does not request coverage cannot submit a positive DONE verdict" |
| 3.4 | If version 1 was requested and a successful DONE omits `coverage` (including from producers that predate the field), the runtime MUST treat the stores as unknown and MUST NOT keep an earlier positive. | An omission is read as "not supported", and the older proof stays current. | RUNNER: "successful DONE without coverage retires earlier proof with STATE" and "... without STATE"; PROJ: "legacy terminal commit without v2 proof stays unknown" |
| 3.4 | Negotiating this evidence MUST NOT disable or weaken detail accounting, diagnosis, or checkpoint rules. | Opting into coverage skips the accounting that protects data. | RUNNER: "runCollectorConnector lets SKIP_RESULT defeat a collected DONE assertion"; OP: "checkpoint eligibility ${eligible} governs state advancement with accounted debt" |
| 8 | A runtime MUST NOT request evidence that its persistence and validation path cannot accept. | Evidence is requested, then silently dropped. | none (gap) |
| 5.1 | A runtime that requests version 1 MUST supply a non-empty `collection_scope`. | A proof with no scope binds to nothing. | none (gap; the mismatch case is below) |
| 5.1 | The connector MUST echo `collection_scope` without modification. | Coverage is claimed for a different scope. | RUNNER: "runCollectorConnector rejects a DONE coverage scope echo that differs from actual START scope" |
| 5.1 | The runtime MUST bind the string to the run's normalized targets, collection mode, boundary, and source-root restrictions. | A proof for one boundary is replayed for another. | PROJ: "v2 terminal proof for an old collection scope cannot cover the current scope" |
| 5.1 | The echoed string MUST NOT confer authorization. | A connector string widens access. | none (gap) |
| 5.1 | `unscoped` MUST NOT remove a restriction in `START.scope` or the authority bindings. | A run escapes its scope and still claims coverage. | none (gap) |
| 5.8.2 | A failed DONE MUST NOT contain `coverage`. | A failed run's claims are trusted. | PROJ: "a newer failed run cannot retain an earlier v2 covered verdict" (projection side only; the DONE side is untested) |
| 5.8.2 | The coverage object's shape: `version`, `collection_scope`, `streams`, the stream and store fields, and the status enum. | Malformed coverage reaches the projection. | RUNNER: "runCollectorConnector rejects malformed DONE coverage: ${label}" and "runCollectorConnector rejects ${versionLabel} DONE coverage versions"; RUNNER: "runCollectorConnector flags an unrecognized coverage status as unaccounted" |
| 5.8.2 | Stream entries MUST equal the requested set, and each stream's stores MUST equal its manifest inventory, with no duplicates or extras. | Missing or extra streams or stores read as covered. | RUNNER: "runCollectorConnector rejects missing and extra DONE coverage streams"; OP: "v2 claims with an extra store outside the registered inventory are rejected"; OP: "v2 normalization rejects duplicate streams and duplicate stores" |
| 5.8.2 | A connector MUST omit the whole object when a requested stream has no declared inventory. | A stream with no inventory claims coverage. | none direct (gap) |
| 5.8.2 | A connector MUST report `collected` only after enumeration closes and every in-scope candidate has a disposition. | A complete claim with candidates still open. | RUNNER: "runCollectorConnector withholds collected coverage after an HTTP receipt rejects a record" |
| 5.8.2 | A connector MUST report `partial` when an in-scope candidate, field, item, or payload is skipped, deferred, unsupported, or pending. | Skipped items read as complete. | RUNNER: "runCollectorConnector lets SKIP_RESULT defeat a collected DONE assertion" |
| 5.8.2 | A connector MUST report `unavailable` when it could not access the store before enumeration began. | An inaccessible store reads as partial or complete. | PROJ: "an unavailable store verdict never projects complete on list or detail" |
| 5.8.2 | A connector MUST report `failed` when enumeration or classification began and did not finish. | An unfinished enumeration reads as complete. | PROJ: "local-device v2 ${status} verdict never projects covered" |
| 5.8.2 | Absence of records or a file-read failure MUST NOT by itself establish proven emptiness. | A missing store reads as empty and complete. | none (gap) |
| 5.8.2 | `scoped: true` MUST NOT assert binding enforcement under Section 3.3.9. | Enumeration honesty is read as enforcement. | none (gap) |
| 5.8.2 | The runtime MUST derive accepted coverage from the assertions and its observable accounting. | Connector claims are accepted as proof. | OP: "connector collected assertions cannot override runtime accounting or absent admission" |
| 5.8.2 | The runtime MUST reconcile DETAIL_COVERAGE, STREAM_EVIDENCE, durable admission, and outstanding debt for the same obligations. | A store is complete while its detail or debt says otherwise. | PROJ: "runtime ${field} contradiction prevents both owner projections claiming complete" |
| 5.8.2 | The runtime MUST downgrade a `collected` assertion when it observes a skip, an inconsistency, a rejected effect, unresolved debt, or a withheld checkpoint. | A complete claim survives runtime evidence. | RUNNER: "runCollectorConnector lets SKIP_RESULT defeat a collected DONE assertion"; RUNNER: "runCollectorConnector withholds collected coverage after an HTTP receipt rejects a record" |
| 5.8.2 | The connector's assertion MUST NOT override runtime evidence. | Same as above. | OP: "connector collected assertions cannot override runtime accounting or absent admission" |
| 5.8.2 | The downgrade MUST NOT by itself make an otherwise eligible checkpoint ineligible. | A coverage downgrade stalls checkpoint progress. | OP: "checkpoint eligibility ${eligible} governs state advancement with accounted debt" |
| 5.8.2 | `DONE.coverage` MUST NOT authorize STATE advancement, a materialization receipt, debt settlement, or a substitute for accounting. | STATE advances, or debt settles, on a coverage claim. | partial: OP "connector collected assertions cannot override runtime accounting or absent admission" (no direct test that a collected DONE alone leaves STATE unchanged) |
| 5.8.2 | Before it records positive coverage, the runtime MUST validate the version, boundary echo, stream set, inventories, statuses, and bindings. | Unvalidated coverage is recorded as positive. | PROJ: "malformed persisted v2 store inventory never projects covered"; OP: "version 2 terminal coverage validates named stores against the manifest" |
| 5.8.2 | Missing, unsupported, or malformed coverage MUST NOT establish positive coverage. The runtime MAY fail the exchange; otherwise it MUST record unknown or a worse result. | A malformed claim keeps a proof positive. | PROJ: "legacy terminal commit without v2 proof stays unknown" |
| 5.8.2 | A runtime MUST NOT treat a transport acknowledgment as durable admission. | Records lost after a transport ack count as admitted. | JOUR: "B2: a server-rejected record stays unadmitted, moves no cursor, and leaves the lane not covered" (partial: the record was rejected, not only acknowledged) |
| 5.8.2 | A rejected in-scope effect, unresolved debt, missing accounting, or withheld checkpoint MUST prevent positive coverage for that obligation. | Positive coverage over a rejected record. | RUNNER: "runCollectorConnector withholds collected coverage after an HTTP receipt rejects a record"; JOUR: "J3: a run that fails before its scan leaves the lane not covered; the server keeps run A's coverage until a later run recovers" |
| 5.8.2 | A positive's artifact digest and manifest fingerprint MUST match a release pair that the runtime or server has verified. | An unverified or mismatched release certifies code. | OP: "a v2 claim cannot pair a registered digest with another manifest fingerprint"; OP: "terminal coverage requires the release registered for the authorized connector instance" |
| 5.8.2 | An unregistered digest, or a digest with a different fingerprint, MUST NOT establish positive coverage. | Same as above. | OP: "the terminal endpoint keeps an unregistered digest unknown"; OP: "unregistered well-formed artifact digests remain unknown" |
| 5.8.2 | A different release MUST invalidate a positive unless a compatibility rule preserves its obligations. | A proof certifies a later release. | PROJ: "unchanged manifest with a different artifact digest projects unknown on list and detail" |
| 5.8.2 | After a negotiated success, an omitted `DONE.coverage` is a new terminal result: the runtime MUST retire earlier positives for the connection and release, and MUST record the stores as unknown, with or without STATE. | A silent omission keeps the old proof current. | PROJ: "successful empty v2 terminal replacement retires earlier proof with state" and "... without state"; STALE: "journey: a later unnegotiated run with no STATE commits a terminal record that retires the proof"; JOUR: "U: after a covered run, an unnegotiated success with STATE retires the proof on server and device" and "... without STATE ..." |
| 5.8.2 | A negative store result MUST NOT be erased by a later positive without independently valid recovery evidence. | A partial store flips to complete on an unsupported claim. | none (gap) |
| 5.8.2 | A connection-wide verdict MUST NOT imply coverage for omitted or uninstrumented streams. | A connection-level "complete" hides an uninstrumented stream. | OP: "selected instrumented stream is accepted beside an uninstrumented stream"; PROJ: "selected-stream v2 proof cannot cover omitted manifest streams" |
| 5.8.3 | The runtime MUST commit an orderable terminal run record for every successful run, negotiated or not, with or without STATE, and the record MUST name its run and run sequence. | A run without a record leaves an earlier proof current. | RUNNER: "successful DONE without coverage retires earlier proof without STATE"; STALE: "journey: a later unnegotiated run with no STATE commits a terminal record that retires the proof"; ATOM: "run start: the route issues a connection-scoped sequence and an exact replay returns it" |
| 5.8.3 | A positive MUST be published only after a successful DONE, exit 0, durable admission of the run's relevant effects, and completion of its checkpoint commits. | A positive is published for data that is not yet durable. | RUNNER: "runCollectorConnector rejects a valid concrete ${effectType} before terminal coverage" (admission side; the checkpoint side is covered only by the OP checkpoint test above) |
| 5.8.3 | The component MUST assign each run a sequence when the run starts, and the runtime MUST obtain it before it admits any effect. | Effects are admitted with no sequence, so no order exists. | ATOM: "run order: a second collector on one connection is ordered by run start, not by commit"; ATOM: "run start: the route issues a connection-scoped sequence and an exact replay returns it" |
| 5.8.3 | A run without an assigned sequence MUST NOT produce positive coverage. | An unordered run becomes eligible. | ATOM: "run order: a run with no issued sequence never produces an eligible proof" |
| 5.8.3 | An observed event of the same or a later run MUST retire the positive to unknown. | An attempt does not retire the proof. | JOUR: "J2: a batch the server receives and rejects after a covered run retires the proof on server and device"; JOUR: "J4: a failure report the server receives after a covered run retires the proof"; JOUR: "J6: a runner killed after its records are admitted, before its terminal record, leaves the earlier positive unknown"; ATOM: "crash after ingest: a later run's durable records retire an earlier positive without its terminal" |
| 5.8.3 | A terminal record of an earlier run that arrives later MUST NOT become current. | A late, older proof becomes current. | ATOM: "run order: an older run's proof that arrives after a newer run's terminal record stays history"; JOUR: "J5: an older run's proof delivered after a newer run's terminal record stays history" |
| 5.8.3 | If a sequence or revision cannot be read, is missing, or is ambiguous, the result MUST be unknown. | An ambiguous order picks a proof. | STALE: "revision: an unreadable or mismatched revision, run sequence or storage epoch fails closed"; ATOM: "upgrade: rows from before the collection revision fail closed, and the next proof is current" |
| 5.8.3 | The runtime MUST NOT compare wall-clock timestamps to decide currency. | A skewed clock reorders evidence. | STALE: "revision: a later state commit retires the proof when the server clock has gone back"; STALE: "revision: a newer proof committed with the clock set back is the current proof"; GREEN: "coverage proof eligibility ignores wall-clock ordering when generations match" |
| 5.8.3 | An exact replay MUST return the stored receipt and change neither the run sequence nor the coverage. | A replay takes a revision and retires a proof, or fails after an inventory change. | ATOM: "replay: an exact terminal replay after an inventory change gets its receipt; a conflicting duplicate fails atomically"; OP: "SQLite route operation composes authorization with 201, exact response-loss replay, and non-disclosing 409"; RESTART: "cursor-aware response-loss restart exact-replays once on ${backend}" |
| 5.8.3 | A different record for the same run MUST fail and write nothing. | A second record overwrites the receipt. | OP: "divergent receipt conflict returns a typed non-disclosing 409" |
| 5.8.3 | The component MUST assign a monotonic per-connection revision to every observed event that can establish or retire positive coverage. | Events are unordered, so the current proof is ambiguous. | STALE: "revision: a distinct state commit at the proof's own instant retires it"; STATE-PG: "real PostgreSQL: the collection revision orders commits and observed events, and both coverage readers return the same fence" (skipped unless `PDPP_TEST_POSTGRES_URL` is set) |
| 5.8.3 | The admitted effect observes the run's sequence and retires earlier positive coverage. | An admitted effect before the terminal record leaves the proof current. | ATOM: "crash after ingest: a later run's durable records retire an earlier positive without its terminal"; JOUR: "J6: a runner killed after its records are admitted, before its terminal record, leaves the earlier positive unknown" |
| 5.8.3 | The component MUST NOT keep positive coverage to avoid retiring it. | A false positive is kept to avoid an unknown result. | JOUR: "J2: a batch the server receives and rejects after a covered run retires the proof on server and device" |
| 5.8.3 | Server-owned scope state, heartbeats, gap recoveries, and grant-scoped state MUST NOT take a revision or retire positive coverage. | Liveness writes churn the proof to unknown. | STALE: "revision: a later server-owned scope write is not an event and does not retire the proof" (heartbeats specifically: no direct test) |
| 5.8.3 | A restore that can regress sequences or terminal records MUST reset positives to unknown until a run assigned after the restore commits a current record. | A restored older proof is current again. | ATOM: "restore: the restore step makes a restored proof unknown until a new eligible terminal" |
| 5.8.3 | The component MUST disclose the restore paths it does not detect. | An owner trusts coverage after an undetected restore. | none (documentation duty; see "Restore incarnation" and "Limits") |
| 5.8.3 | A device runtime MUST NOT report a lane as covered while a failure barrier or unadmitted work of a later attempt remains open. | The device shows covered over unadmitted work. | LC: "a later run whose record batch stays ready makes an earlier covered receipt unadmitted"; LC: "a pass that fails before its scan leaves an earlier covered receipt unadmitted"; LC: "a run aborted before start leaves an earlier covered receipt unadmitted" |
| 5.8.4 | Every projection that shows coverage MUST carry the run identifier and run sequence, the release digest, and the revision and commit time. | Coverage is shown without the run or release it describes. | STALE: "as-of: a shown proof carries its run id, release digest, revision and commit time" |
| 5.8.4 | A proof with no recorded release MUST show the digest as absent. | A digest is shown for a release that is unknown. | none (gap; the closest case is PROJ: "a local source without a server pin projects unknown with an explicit reason") |
| 5.8.4 | Owner-facing text MUST present coverage as of its time, not as a present-tense claim. | A stale proof reads as current. | CONSOLE: "coverage chip reads 'complete as of <time>' when the reference names the run it describes"; CONSOLE: "per-stream coverage reads 'complete as of <time>' with the connection's as-of" |
| 5.8.4 | A runtime MUST retain the run's bindings and MUST revalidate them before it reuses a positive. | A positive is reused across accounts or boundaries. | PROJ: "persisted terminal coverage cannot cross a source binding generation"; OP: "a run bound to its registered release remains valid after the connector catalog advances" |
| 5.8.4 | Metadata-only inventory coverage MUST NOT be displayed as completeness of the underlying content. | Inventory reads as complete content. | OP: "proven empty content is complete while metadata inventory stays inventory only" |
| 5.8.4 | A DETAIL_COVERAGE or STREAM_EVIDENCE projection SHOULD carry the same facts. | (SHOULD, so not a conformance requirement.) | none, by design |
| 6.2 (14) | Runtime conformance: the rows above, as one checklist. | (Aggregate.) | the rows above |
| 8 | `coverage.version` versions this payload only; it does not replace `protocol_version`. | A runtime reads it as the profile version. | none (gap) |
| 8 | Implementations MUST NOT assume that an older runtime, or a runtime with a closed manifest validator, ignores unknown manifest or wire fields. | A new field breaks the exchange or the manifest. | none (gap) |

### Gaps

The MUST rows marked "none" have a failure behind them but no conformance test
in #577 or data-connectors. The data-connectors tests in DC check only the
profile's wording. Adding a test for each gap is the next step, or the
sentence should be cut with the failure it covers stated explicitly.
