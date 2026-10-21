# Local device terminal coverage contract

Status: required follow-up in data-connectors. PR #553 does not restore positive coverage.

## Evidence at the pinned releases

The five pins are in `packages/local-collector/src/generated/collection-profile-pins.generated.ts`. Their exact OCI artifacts were installed through `ensureCollectionProfileInstalled` (`packages/local-collector/src/managed/collection-profiles.ts:125-205`), which verifies the signature and pinned profile/entrypoint hashes. Each pinned `dist/collection-profile.mjs` contains `PROGRESS`, `SKIP_RESULT`, and `DONE`, but contains no `RUN_COVERAGE`, `coverage_statuses`, or `coverage_diagnostics` literal. The matching versioned source manifests and emitters were inspected in the data-connectors checkout at `5f501848d` (the five connector files have no branch changes from that checkout's `origin/main`). The source paths below explain the behavior found in the pinned entrypoints.

`coverage_diagnostics` is retired for these five pins. Other connectors can still declare that stream; a declared stream keeps its own manifest identity and indexing rules.

| Pin | End-of-run evidence in version-matched source |
| --- | --- |
| Claude Code 0.3.24 | `connectors/claude_code/index.ts` emits stream `STATE`, human `PROGRESS`, and `SKIP_RESULT` for specific failures; `runConnector` supplies `DONE`. There is no terminal per-stream coverage object. |
| Codex 0.3.15 | `connectors/codex/index.ts:3230-3269` emits human `PROGRESS` for outstanding work, then `DONE {status:"succeeded",records_emitted}`. Other failures use `SKIP_RESULT`; no terminal per-stream coverage object is emitted. |
| Google Takeout 0.1.22 | `connectors/google_takeout/index.ts:76-112` emits `PROGRESS {stream,message}` and writes a separate stderr `coverage` diagnostic with `stream,status,reason,items,unsupported_files`. Missing inputs also emit `SKIP_RESULT` (for example `index.ts:510-525`). `runConnector` supplies `DONE`. |
| iMessage 0.1.21 | `connectors/imessage/index.ts:374-403,770-871` emits `PROGRESS {stream,message}`, per-stream `STATE`, and `SKIP_RESULT` for missing tables or unusable dates. `runConnector` supplies `DONE`; no coverage verdict is emitted. |
| Apple Photos 0.1.22 | `connectors/apple_photos/index.ts:127-145,190-215` emits `PROGRESS {stream,message}` and writes a separate stderr `coverage` diagnostic with `stream,status,reason,files_scanned`. Missing exports also emit `SKIP_RESULT`. `runConnector` supplies `DONE`. |

`packages/connector-protocol/src/connector-runtime-protocol.ts:772-900` types `PROGRESS` as owner-facing text with optional counts, `SKIP_RESULT` as a failure/skip event, and `DONE` as run status and record count. `packages/polyfill-connectors/src/connector-runtime.ts:1773-1796` emits successful `DONE` after optional shape-check text. The data-connectors diagnostic helper (`packages/polyfill-connectors/src/connector-diagnostic.ts:4-77`) writes best-effort, bounded stderr lines; it explicitly does not provide a protocol event. A diagnostic may be omitted or truncated. Neither a successful `DONE`, a `STATE` checkpoint, a record count, a human `PROGRESS` line, nor the absence of `SKIP_RESULT` proves every requested stream and scope was covered.

Data-connect's `packages/collector-runtime/src/collector-runner.ts:1409-1442` observes the typed child stream, retains `DONE`, and ignores `PROGRESS` and `SKIP_RESULT` for terminal coverage. At `:972` it passes `terminalFacts: null` into the durable commit path. Its stderr buffer is for failure reporting, not coverage. `deriveLocalCollectorLifecycleState` (`:3016-3067`) calls any drained outbox `healthy_idle`; this says nothing about source coverage. The reference server suppresses local-device scheduler run facts at `reference-implementation/server/ref-control.ts:4143-4162,5447-5455`. It must continue to show coverage `unknown` without a committed typed proof.

## Required v1 event

Add one `RUN_COVERAGE` JSONL message to the connector protocol, before terminal `DONE`:

```json
{
  "type": "RUN_COVERAGE",
  "version": 1,
  "collection_scope": "unscoped",
  "streams": [
    {
      "stream": "messages",
      "scoped": true,
      "stores": [{ "store": "messages", "status": "collected" }]
    }
  ]
}
```

Extend `START` with the collector's canonical `collection_scope` fingerprint and require the connector to echo it here; today `buildCollectorStartMessage` (`packages/collector-runtime/src/collector-runner.ts:1981-2024`) sends only per-stream ranges and roots. `unscoped` is a real value. The fingerprint algorithm is `collectorScopeFingerprint` (`:1908-1939`). `streams` contains exactly one entry for **every requested stream**, including a verified-empty stream, and no unrequested stream. Each entry contains exactly one status for every store in that stream's signed manifest coverage inventory. Store IDs are opaque to the app; the server compares sets against the signed manifest, without connector-specific branches. A stream with no declared inventory cannot gain positive coverage.

`status` is the closed v1 vocabulary `collected | verified_empty | missing | unaccounted`. `collected` means the store's requested region was enumerated and its supported records were handled. `verified_empty` means that region was enumerated and contained no supported records. `missing` means its source was absent or inaccessible. `unaccounted` means the scan or classification did not complete. An unsupported file, a skipped required item, a pending capture/upload, or a truncated scan cannot be `collected` or `verified_empty`. `scoped: true` asserts that the connector enforced the requested boundary on this stream; `false` prevents a positive claim for a bounded scope. The assertion must describe enumeration, not merely post-filtering emitted records.

The runtime accepts exactly one v1 event, validates its shape and requested-stream set, and rejects duplicates, unknown status/version, duplicate or missing stores, an absent/mismatched scope, and any message after `DONE`. It retains the event only until a successful `DONE`. It must drop the proof if the scan was budget-truncated, the outbox has a pending/dead-letter record or gap, or the terminal commit cannot durably checkpoint. On success it stamps the current boundary and connector instance and calls `maybeCommitCheckpoint` with the validated facts instead of `null`. An empty or absent event never produces a terminal commit.

The terminal commit envelope needs version 2 so each `terminal_facts` entry preserves its store IDs and statuses; the current `TerminalCollectionFact` (`packages/collector-runtime/src/local-device-client.ts:164-174`) holds only a status list and cannot support the server's inventory check. Keep version 1 parsing and prior evidence behavior for old devices. The server validates version 2, source/device/connector identity, boundary, signed manifest inventory, statuses, and commit id before persisting it. Only a current, fully committed proof whose required streams are all `collected` or `verified_empty`, with `scoped: true` when bounded, can yield `complete`. Missing, partial, malformed, stale, or mixed-boundary proof yields `unknown` or the existing worse gap state; it never yields a false green. The generic terminal evidence must feed both the per-stream Collection Report and connection coverage axis. Scheduler run facts remain excluded for local-device sources unless they are tied to this validated terminal proof. The device must retain the last acknowledged proof outside the prunable outbox for status/doctor, invalidating it on a changed scope, failed run, or open gap.

## Consumers and acceptance tests

1. Extend `START`, define and parse `RUN_COVERAGE` in `packages/connector-protocol/src/connector-runtime-protocol.ts`, and add each stream's coverage inventory to the signed manifest. Emit the event from new signed data-connectors releases. Keep `PROGRESS` as text and stderr diagnostics as diagnostics.
2. Capture and validate it in `packages/collector-runtime/src/collector-runner.ts` at `handleMessage` and `streamConnectorIntoOutbox`; pass facts to `maybeCommitCheckpoint`, preserve the store identities in a v2 `TerminalRunCommitRequest` in `packages/collector-runtime/src/local-device-client.ts`, and retain the acknowledged local proof for status/doctor.
3. Validate and fold the terminal commit generically in `reference-implementation/server/routes/ref-device-exporters.ts` and the terminal evidence store. Use that proof in `reference-implementation/server/ref-control.ts` for local-device coverage; expose the same result in local collector status/doctor without equating `healthy_idle` with coverage.
4. Test before and after the change: successful `DONE` with no `RUN_COVERAGE` stays `unknown`; a complete, drained, correctly scoped proof becomes covered on device and server; missing/duplicate/malformed facts, mismatched scope, undeclared stores, missing required streams, incomplete drain, and replay remain unknown or worse. The positive test must fail against PR #553's current collector path.

Until the protocol and signed releases exist, PR #553's coverage blocker remains open.
