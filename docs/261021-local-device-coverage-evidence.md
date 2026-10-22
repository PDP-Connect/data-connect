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

The collector stores the latest acknowledged v2 receipt in local outbox schema v5, outside prunable outbox rows. A later acknowledged v1 commit removes that receipt. Offline status can describe the receipt's measured boundary; doctor compares it with the active owner boundary. The server read model must make the same boundary comparison before showing positive connection coverage.

## Published PDPP spec impact

This changes the Collection Profile wire contract. The PDPP owner tree remains read-only in this lane. Both /home/tnunamak/code/pdpp/spec-collection-profile.md and its published copy, apps/site/content/docs/spec-collection-profile.mdx, need updates: DONE (root line 514, published line 518) needs the optional field and its validation; START (root around line 198) needs collection_scope; manifest stream declarations (root lines 45-75) need coverage-store inventory. The state machine (root lines 120-155) already defines DONE as final. The restart-abandonment rule at root line 573 uses “DONE-time coverage verdict” for detail-coverage checkpoint eligibility; it does not define this per-store terminal payload. PDPP Core is unaffected. Protocol addition needs owner approval at merge.

## Acceptance and release

Tests must show absent coverage unknown, a valid fully drained proof covered, partial/unavailable/failed not covered, malformed rejected or unknown, and old devices still working. Verify connector emitters, collector checkpointing, server validation, and both read models. After data-connectors #539 releases its signed profiles, repin Claude Code 0.3.25, Codex 0.3.16, Google Takeout 0.1.23, iMessage 0.1.22, and Apple Photos 0.1.23. PR #553 keeps the current pins until that release.
