# @pdpp/read-core

`@pdpp/read-core` contains pure, adapter-agnostic primitives for shaping PDPP
read results into bounded previews, continuation descriptors, handle metadata,
and deliberate escalation paths.

It is the shared core consumed by independently-installed read adapters
(`@pdpp/mcp-server`, `@pdpp/cli`, and future REST/SDK adapters). Given records,
record-sets, or field reads, it returns structured, bounded descriptors that
any adapter can render — the adapter decides how to present them.

## Boundary (what belongs here, and what does not)

**In scope** — pure read shaping only:

- Bounded previews of records and record-sets.
- Content ladders and field-window evidence (progressive disclosure).
- Continuation descriptors and opaque content handles (encode/decode).
- Binary/blob field metadata.
- Deterministic truncation and stable inline JSON.
- Stable record identity for evidence.

Record descriptors use the canonical record key as `id`, with `instance_id` and
`stream` alongside it. Field and JSON continuation read arguments and resource
URI payloads carry the same tuple.

Instance identity is read from the record envelope (`instance_id`,
`instanceId`, `connection_id`, `connectionId`, `connector_instance_id`) and
from fallback metadata (the same five names). `connection_id` and the other
aliases are accepted during the compatibility release and are normalized to
`instance_id` in evidence and handles. All recognized aliases are compared;
different values fail with `RecordIdentityConflictError`
(`code: "conflicting_instance_id"`). Record and fallback `stream` /
`stream_name` values that differ fail with `code: "conflicting_stream"`.

Optional identity inputs that are `undefined` are absent. A present `null`,
empty string, or non-string value fails with `code: "malformed_instance_id"`,
`"malformed_record_id"`, or `"malformed_stream"`. Match on the error's `code`
or `name`; the error class is not part of the public export manifest.

The canonical record key comes from these sources, in this order of meaning:

- A canonical record envelope (`object: "record"`) uses its `id`. A
  SearchResult-only `record_key` on such an envelope is ignored.
- Any other row uses `record_key`, `record_id`, or `recordId`, and fallback
  metadata uses `recordId` or `record_id`. Different values fail with
  `code: "conflicting_record_id"`.
- When a canonical key is known, a row `id` or `result_id` is a legacy
  self-contained handle. It is never split. It must equal the key, or exactly
  `<stream>:<key>` or `<instance_id>/<stream>:<key>` built from the known parts;
  otherwise the record fails with `code: "conflicting_record_id"`. If the
  stream or instance is unknown, the handle is not checked against that part,
  and the row has no ladder. Keys and instance handles may contain `/` and `:`.
- With no canonical key and a known stream, a row `id` is the literal key. A
  fallback `id` is an adapter's self-contained handle: an exact
  `<instance_id>/<stream>:` or `<stream>:` prefix is removed, and any other value
  is the literal key.
- With no canonical key and no stream, a row `id` (or fallback `id`) is parsed
  as a legacy `instance/stream:key` or `stream:key` handle. URL-shaped IDs are
  not parsed. A parsed instance that differs from an explicit instance alias is
  not used, and the record has no ladder.

Identity is never read from fields inside application `data` (or `record`):
`data.id`, `data.record_id`, `data.connection_id` and similar fields remain
application data.

A content ladder requires a resolved key, stream, and instance. If identity is
incomplete, `buildRecordContentLadder` returns `null`. `buildRecordSetContentLadder`
omits such rows and returns `null` when no rows remain. A row with conflicting or
malformed identity is not omitted: the whole record-set call fails closed with
the typed error. The core never emits read arguments or resource URIs with an
absent or null `instance_id`. Direct handle encoding without an instance throws
`RecordIdentityConflictError` with code `missing_instance_id`.

`summarizeRecordEvidence` and `sanitizeRecordForEvidence` normalize instance
aliases, so malformed or conflicting instance aliases fail with the same typed
error. They render record `id` and `stream` values verbatim, including
non-string values, and never invent or convert record identity.

Flat envelope operational fields, including `instanceId`, `connectionId`, and
`result_id`, are excluded from content windows. Nested application fields with
those names remain readable. Tombstones (`deleted: true`) retain their identity
but expose no field, JSON, or binary read capabilities.

**Out of scope** — keep these in the adapter or server layers:

- No authorization, grants, or token semantics.
- No HTTP, transport, or networking.
- No filesystem or export I/O.
- No CLI parsing or flag handling.
- No UI rendering beyond minimal stable descriptors.
- No connector-specific or source-specific business semantics.
- No single-client quirks baked in as core semantics (client workarounds
  belong in the adapter that needs them).

The package keeps a deliberately small, stable public API so adapters can build
against it safely.

## TypeScript declarations

This package does not currently publish declaration files. Its public contract
is the emitted JavaScript root export; declarations will be added only with an
explicit typed API contract.
