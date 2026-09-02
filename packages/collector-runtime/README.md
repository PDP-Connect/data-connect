# @pdpp/collector-runtime

Generic connector-execution runtime for [PDPP](https://github.com/PDP-Connect/pdpp) (the Personal Data Portability Protocol) local (device-side) collection: the collector loop, the device-exporter ingest client, the durable outbox, and the runtime-capabilities placement gate.

Depends on `@pdpp/connector-protocol` for the connector authoring contract (wire-protocol types, JSONL primitives). Connector-agnostic — carries no connector definitions or content.

## Entry points

- `.` — the collector runtime's top-level exports
- `./collector-build-info` — build/version metadata for a running collector
- `./collector-runner` — the connector-execution loop
- `./local-device-client` — the HTTP client a device-side collector uses to talk to a reference server, including terminal-run-commit hashing
- `./local-device-envelope` — canonical-JSON and record-envelope helpers shared by the client, the outbox, and the runner

## Status

Published from [PDP-Connect/data-connect](https://github.com/PDP-Connect/data-connect), under `packages/collector-runtime`.

## Release artifact verification

The committed `artifact.json` binds this package's source inputs, declaration
output, and reproducible `npm pack` tarball digests. Run `npm run
artifact:verify` after a committed package change. The npm release workflow is
the authority for publication and provenance; local verification does not claim
that a tarball has been published.
