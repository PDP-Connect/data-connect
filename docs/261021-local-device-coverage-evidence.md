# Local device terminal coverage contract

Status: decision for linked data-connectors and data-connect PRs. PR #553 cannot restore positive coverage until new signed connector releases are pinned.

## Regression

The five pinned local releases (Claude Code 0.3.24, Codex 0.3.15, Google Takeout 0.1.22, iMessage 0.1.21, Apple Photos 0.1.22) no longer emit coverage_diagnostics. Their PROGRESS lines and stderr run diagnostics are not terminal coverage evidence. In data-connect, retired diagnostic records from old devices are accepted for compatibility but grant no coverage credit. These releases provide no typed DONE verdict, so the server's local coverage axis remains unknown. Earlier evidence in PR #553 proposed RUN_COVERAGE; the DONE decision here supersedes that message choice.

The five pins live in `packages/local-collector/src/generated/collection-profile-pins.generated.ts`. Their signed profile artifacts were inspected alongside version-matched emitters in data-connectors at `5f501848d`. Each entrypoint emits `PROGRESS`, `SKIP_RESULT`, and `DONE`, but no typed exhaustive per-store verdict. Other connectors may still declare `coverage_diagnostics`; those records retain their manifest identity and ingestion behavior without granting terminal coverage credit.

| Pin | End-of-run evidence |
| --- | --- |
| Claude Code 0.3.24 | `STATE`, human `PROGRESS`, and failure-specific `SKIP_RESULT`; `runConnector` supplies `DONE`. |
| Codex 0.3.15 | Human `PROGRESS` for outstanding work and `DONE` with status and record count; failures use `SKIP_RESULT`. |
| Google Takeout 0.1.22 | `PROGRESS` and a separate bounded stderr coverage diagnostic; missing inputs can emit `SKIP_RESULT`. |
| iMessage 0.1.21 | `PROGRESS`, per-stream `STATE`, and `SKIP_RESULT` for missing tables or unusable dates. |
| Apple Photos 0.1.22 | `PROGRESS`, a separate bounded stderr coverage diagnostic, and `SKIP_RESULT` for missing exports. |

Stderr diagnostics may be omitted or truncated. A successful `DONE`, `STATE` checkpoint, record count, progress line, or absence of skips does not prove every requested stream and scope was covered.

## Step 1: message decision

Extend the existing DONE message with optional typed coverage. DONE is already the required final message. The collector retains one DONE in `packages/collector-runtime/src/collector-runner.ts`, rejects output after it, and decides whether to send a durable terminal commit. This binds the verdict to successful termination without an extra message or duplicate-event state machine. Existing DONE messages without coverage remain valid and yield unknown coverage.

| Candidate | Type and validation | Persistence and terminal fit |
| --- | --- | --- |
| DONE | packages/connector-protocol/src/connector-runtime-protocol.ts:879-891 types status, count and error. collector-runner.ts:1829 parses JSONL with a cast, so the new field needs explicit runtime validation. | The collector retains it; the authenticated terminal commit endpoint validates and persists terminal facts in reference-implementation/operations/local-device-terminal-collection.ts:42-141. Its final-message semantics fit. |
| PROGRESS | connector-runtime-protocol.ts:793-804 types owner-facing text and optional counts. connector-diagnostic.ts:4-77 writes best-effort bounded stderr, outside the protocol. | Neither is retained as terminal proof. A mid-run line can precede failure or truncation. |
| STATE | connector-runtime-protocol.ts:791 types a stream cursor; collector-runner.ts:1650-1662 buffers only in-scope checkpoint state. | A cursor is a resume position, not enumeration status. Some streams have none. |
| SKIP_RESULT | connector-runtime-protocol.ts:808-846 types a specific skip with reason, message, optional diagnostics and continuation. | One omission does not enumerate every store; absence of skips does not prove completeness. The collector does not retain it as terminal facts. |
| STREAM_EVIDENCE | connector-runtime-protocol.ts:842-885 types measured state-stream detail counts. | It is reference-only, can arrive before completion, and does not enumerate local stores or assert a terminal scope. |
| RUN_COVERAGE | No current protocol message. The earlier proposal adds a pre-DONE event and ordering rules. | The optional DONE field has the needed terminal semantics, so a new message is unnecessary. |

The existing local-device run-coverage summaries and packages/polyfill-connectors/src/connector-diagnostic.ts stderr helper may supply inputs to a verdict, but they do not carry a typed protocol verdict and are not persisted as one. Old record-backed diagnostic status lists lack store IDs; the v2 path retains them in `DONE.coverage` without another event or ordering rule.

## Typed field

DONE.coverage has version 1, collection_scope, and streams. Each stream has stream, scoped, and stores. Each store has store and status. The closed status enum is collected, partial, unavailable, failed.

- collected: the requested region was fully enumerated and all supported records were handled; an honestly verified empty region counts.
- partial: a supported item was skipped, deferred, unsupported, or remains pending.
- unavailable: the source store was absent or inaccessible before enumeration.
- failed: enumeration or classification began but did not complete.

Only collected can support a positive coverage verdict. START.collection_scope carries the collector's canonical collectorScopeFingerprint; unscoped is an explicit value. DONE.coverage.collection_scope must echo it. The verdict lists exactly every requested stream and every store in each stream's signed manifest coverage inventory, with no duplicates or extras. The server admits a selected-stream subset when each reported stream matches its signed inventory; the read model requires the complete manifest inventory before showing whole-connection coverage. Store IDs are opaque to the app. A stream without inventory cannot prove coverage. scoped is true only if the connector enforced the requested boundary during enumeration.

The collector validates the typed field before accepting it. It carries store IDs and statuses in a version 2 terminal commit only after successful DONE, complete scan, drained outbox, and durable checkpoint. The server validates the commit against authenticated device/source/connector identity, boundary, manifest inventory, status enum and commit ID. Existing version 1 commits remain accepted; an old device or missing field continues to work but does not gain coverage. Malformed, partial, unavailable, failed, missing, duplicate, stale or mixed-boundary evidence stays unknown or a worse gap state. The validated proof must feed both the Collection Report and connection coverage axis. A drained outbox alone is no evidence of coverage.

The collector stores the latest acknowledged v2 receipt in local outbox schema v5, outside prunable outbox rows. If a later successful DONE omits coverage while that receipt exists, the collector sends the no-evidence version 2 commit described under "Terminal record for every successful run". Its acknowledgement removes the receipt and makes the server's latest run unknown. Offline status can describe the receipt's measured boundary; doctor compares it with the active owner boundary. The server read model must make the same boundary comparison before showing positive connection coverage.

The device verdict (`pdpp-local-collector status`, `terminal_coverage.verdict`) is `covered` only when the receipt names the selected release, every store is `collected`, and the run's runtime accounting is clean: durable admission, complete detail, consistent stream evidence, checkpoint eligibility, and zero outstanding debt. Clean accounting is the same test the server applies before it withholds `collected`. Missing or malformed accounting reads `no_evidence`; a measured gap reads `incomplete`. Open outbox work for the lane (queued, leased or dead-lettered) reads `unadmitted`, because the latest run has not reached a durable terminal commit and the receipt no longer stands for it.

The server's owner coverage is a fact about one admitted run, shown with its as-of. Any later attempt the server observes (a state commit, a terminal run record, an admitted or refused batch, a delivered failure report) retires it to unknown; see "Revision fencing" below. Only an attempt the server never hears about leaves the last admitted coverage in place. Every failed run, including one that fails before its scan, leaves an open `connector_child_failure` gap on the device, so the device shows that run as `unadmitted` until a later run that negotiated coverage commits its typed terminal verdict and recovers the gap. A run without negotiated coverage, even a successful one, recovers no gap.

## Collection Profile amendment

The canonical Collection Profile is `data-connectors/docs/spec/collection-profile.md`. [Data-connectors PR #541](https://github.com/PDP-Connect/data-connectors/pull/541), stacked on #516, specifies the optional START capability, stream store declarations, terminal store collection evidence, and its relationship to detail accounting and checkpoint eligibility. Data-connectors #539 and this PR implement the amendment. The owner approves it at merge.

## Acceptance and release

Tests must show absent coverage unknown, a valid fully drained proof covered, partial/unavailable/failed not covered, malformed rejected or unknown, and old devices still working. Verify connector emitters, collector checkpointing, server validation, and both read models. After data-connectors #539 releases its signed profiles, repin Claude Code 0.3.25, Codex 0.3.16, Google Takeout 0.1.23, iMessage 0.1.22, and Apple Photos 0.1.23. PR #553 keeps the current pins until that release.

## Revision fencing (replaces the wall-clock stale-proof rule)

The spec gate replaced the server's wall-clock rule (MAX `connector_state.updated_at` compared with the proof instant) with a monotonic per-connection revision. Equal timestamps do not identify a transaction, and a skewed clock can order a later commit before an earlier one. The revision follows the Core restore-safety fencing principle: retire by revision comparison only.

Events that get a revision. The server assigns the next revision inside the transaction of each event it can observe for an authorized connection:

| Event | Kind | Where |
| --- | --- | --- |
| Owner-scoped state write that touches a non-`$` stream | `state_commit` | connector-state store, PUT state route |
| Terminal run commit (v1 or v2), with its own state delta | `terminal_run` | terminal-run-commit store |
| New ingest batch admitted (not a replay of an admitted batch) | `batch_accepted` | device ingest route |
| Ingest batch received and refused (4xx after device authorization) | `batch_rejected` | device ingest route |
| Failure report received (`connector_child_failure` or `policy_budget` gap) | `failure_report` | local-collector-gaps route |

Server-owned `$` scope rows, heartbeats, gap recoveries, grant-scoped state, and the legacy split `terminal-collection` report get no revision. They neither establish nor retire proof. The legacy split report follows its own state commit, which already has a revision; its run record is labelled with the current revision so that the projection can order it.

Storage. `connector_instances` holds the high-water mark: `collection_revision` (0 before any event), `collection_revision_event`, `collection_revision_run_id`, and `collection_revision_at` (wall-clock, display only). `connector_state.collection_revision` records the revision of the commit that last wrote each row. The terminal run event, and so `run_history.facts_json`, carries `collection_revision`. SQLite adds the columns with `addColumnIfMissing`; Postgres uses `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`. Rows that predate the migration read NULL and fail closed.

Proof binding. A v2 proof is the terminal run record at revision R; its own state rows carry R. A retired `coverage_diagnostics` snapshot from an older device is accepted but grants no coverage credit, at any revision, so no fence is bound to it.

Retirement. A proof is current only when its revision equals the connection's high-water revision. For a v2 proof, the high-water event must also be `terminal_run` with the same run id. The server reads the proof run by that run id, not by the newest `completed_at`. Any later observable event raises the high-water revision and retires the proof to unknown. No wall clock takes part.

Fail closed. Coverage is unknown when the high-water row or the proof revision is missing, NULL, not a safe integer, or unequal; when the high-water run id differs from the proof run; or when the revision read fails. A v2 proof is also unknown when the newest settled device run is a different run that carries no revision (a pre-migration row or a writer that assigns none), because its order against the proof is ambiguous.

Terminal record for every successful run. A runtime that implements this profile version commits a terminal run record for every run whose DONE succeeded, even when coverage was not negotiated and no STATE changed. Without coverage evidence it sends a version 2 commit with empty `terminal_facts`, carrying the run's STATE delta. The server stores unknown inventory for it, and the device clears its receipt (`no_evidence`). A server that names no connection on its state read cannot bind a terminal record, so against such a server the runtime keeps the plain state checkpoint.

As-of. Every owner projection that shows local coverage carries `coverage_as_of`: run id, release digest, collection revision, and commit time. Owner UI copy reads "complete as of <time>". Only a v2 terminal proof that the fence admits has an as-of; coverage without one is not shown as complete.

Limits. The server cannot order an attempt it never hears about. Examples are a run refused before authorization, a device that goes offline before it delivers its failure barrier, and a runner that predates this version and sends neither state nor records. In those cases the projection keeps the last admitted proof, labelled with its as-of. The device keeps its stricter local verdict. There is no heartbeat or lease machinery.
