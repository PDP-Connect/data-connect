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

The collector stores the latest acknowledged v2 receipt in local outbox schema v5, outside prunable outbox rows. A later acknowledged v1 commit removes that receipt. Offline status can describe the receipt's measured boundary; doctor compares it with the active owner boundary. The server read model must make the same boundary comparison before showing positive connection coverage.

The device verdict (`pdpp-local-collector status`, `terminal_coverage.verdict`) is `covered` only when the receipt names the selected release, every store is `collected`, and the run's runtime accounting is clean: durable admission, complete detail, consistent stream evidence, checkpoint eligibility, and zero outstanding debt. Clean accounting is the same test the server applies before it withholds `collected`. Missing or malformed accounting reads `no_evidence`; a measured gap reads `incomplete`. Open outbox work for the lane (queued, leased or dead-lettered) reads `unadmitted`, because the latest run has not reached a durable terminal commit and the receipt no longer stands for it.

## Collection Profile amendment

The canonical Collection Profile is `data-connectors/docs/spec/collection-profile.md`. [Data-connectors PR #541](https://github.com/PDP-Connect/data-connectors/pull/541), stacked on #516, specifies the optional START capability, stream store declarations, terminal store collection evidence, and its relationship to detail accounting and checkpoint eligibility. Data-connectors #539 and this PR implement the amendment. The owner approves it at merge.

## Acceptance and release

Failing-first tests must show absent coverage unknown, a valid fully drained proof covered, partial/unavailable/failed not covered, malformed rejected or unknown, and old devices still working. Verify connector emitters, collector checkpointing, server validation, and both read models. Bump the five connector manifest patch versions and regenerate connector-implementation-index.json. PR #553 then repins the five signed releases and their verified hashes.
