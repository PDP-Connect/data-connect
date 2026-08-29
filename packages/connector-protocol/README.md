# @pdpp/connector-protocol

The connector authoring contract for [PDPP](https://github.com/PDP-Connect/pdpp) (the Personal Data Portability Protocol): the JSONL wire-protocol message types, the `LocalCollectorDefinition` type contract, the bootstrap/emit/scope-filter primitives connector authors import directly, and small text/auth/retry utilities connectors depend on.

Bottom of the dependency graph — this package depends on nothing in `@pdpp/collector-runtime` or `@pdpp/polyfill-connectors`, so connector authors never pull in the runtime package or its release cadence just to get the files they author against.

## Entry points

- `.` — the top-level connector-authoring types and primitives
- `./auth` — authentication helpers connectors use against upstream providers
- `./collector-definition` — the `LocalCollectorDefinition` contract
- `./connector-runtime-protocol` — the JSONL wire-protocol message types shared with `@pdpp/collector-runtime`
- `./http-retry` — retry-after/backoff helpers for HTTP-based connectors
- `./pdpp-safe-text` — text-safety helpers for connector-authored content
- `./safe-text-preview` — bounded text previews for connector-authored content

## Status

Published from [PDP-Connect/data-connect](https://github.com/PDP-Connect/data-connect), under `packages/connector-protocol`.

## Protocol rollout

The `0.0.2` package adds the `STREAM_EVIDENCE` wire message. It is a breaking
wire addition for fail-closed runtimes that do not recognize that message, so
the runtime must be upgraded before a connector that emits it is distributed.

| Connector | Runtime | Result |
| --- | --- | --- |
| old connector | new runtime | compatible; no new message is emitted |
| new connector emitting `STREAM_EVIDENCE` | old fail-closed runtime | incompatible; pre-spawn gate rejects it |
| new connector | new runtime advertising `STREAM_EVIDENCE` | compatible |

Connectors declare required protocol capabilities with
`protocol_capabilities`. The runtime advertises `protocolVersion` and
`protocolCapabilities`, and rejects missing capabilities before spawning a
connector. `SKIP_RESULT.boundary_claim` is optional and does not require a
protocol capability.

The committed `artifact.json` binds the package version and source-input digest
to a reproducible npm tarball digest. Run `npm run artifact:verify` after any
protocol or package build change. Run `npm run artifact:generate` when the
expected artifact metadata must be regenerated.
