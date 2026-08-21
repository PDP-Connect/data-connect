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
