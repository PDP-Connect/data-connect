# Connector-install owner API

All endpoints require the existing owner bearer-token middleware. The
`connector_id` field is the safe operational connector key, for example
`github`; it is not the URI-shaped manifest `connector_id`.

`GET /v1/owner/connector-install/catalog` returns:

```json
{
  "object": "connector_install_catalog",
  "data": [{
    "catalog_connector_id": "https://registry.pdpp.dev/connectors/github",
    "connector_id": "github",
    "connector_key": "github",
    "digest": "sha256:<64 lowercase hex characters>",
    "version": "1.0.0",
    "latest": true,
    "tier": "supported",
    "bindings": {},
    "setup_modality": "provider_authorization",
    "display_name": "GitHub"
  }]
}
```

Catalog data is the signed discovery result projected to one row per published
version. `catalog_connector_id`, `display_name`, `published_at`, `tier`,
and `setup_modality` are omitted when unavailable. Install accepts only a
digest that is present in this result.

`GET /v1/owner/connector-install/status` returns:

```json
{
  "object": "connector_install_status",
  "data": [{
    "activation_state": "active",
    "connector_id": "github",
    "digest": "sha256:<64 lowercase hex characters>",
    "config_digest": "sha256:<64 lowercase hex characters>",
    "version": "1.0.0",
    "tier": "supported",
    "bindings": {},
    "registry": "ghcr.io",
    "repository": "pdp-connect/connector/github",
    "activated_at": "2026-09-16T00:00:00.000Z",
    "manifest_sha256": "sha256:<64 lowercase hex characters>",
    "entrypoint_sha256": "sha256:<64 lowercase hex characters>",
    "provenance_sha256": "sha256:<64 lowercase hex characters>"
  }]
}
```

`POST /v1/owner/connector-install/install` accepts
`{ "connector_id": "github", "digest": "sha256:..." }` and returns one status
record with HTTP 201. `POST /v1/owner/connector-install/update` accepts
`{ "connector_id": "github" }` and runs the shared update plan and batch for
that connector. It returns the installed record after success. A target needing
review, a changed plan, a deferred run, or failed publication returns an error.

## Manual update plans and batches

`POST /v1/owner/connector-updates/plans` accepts an empty body and returns HTTP
202 with `{ "data": { "plan_id": "<uuid>", "status_url": "/v1/owner/connector-updates/plans/<uuid>" } }`.
Poll `GET /v1/owner/connector-updates/plans/:id` for `{ "data": plan }`. The
plan has `plan_id`, `state` (`checking`, `ready`, `failed`), `created_at`,
`expires_at`, `catalog_revision`, `manual_count`, `review_count`, `items`, and
optional `error`. Each item has `connector_id`, exact `installed` and `target`
`{version,digest}` tuples, `manual_eligible`, `auto_eligible:false`,
`review_required`, `reasons`, `manifest_diff:{changed_fields,compatibility}`,
and `affected_instance_count`. A ready plan is immutable and expires after 15
minutes. Only a stable, increasing version in the same major with unchanged
known manifest declarations is manually eligible. Other changes need review.

`POST /v1/owner/connector-updates/batches` accepts
`{ "plan_id": "<uuid>", "idempotency_key": "<stable key>", "selected_connector_ids": ["github"] }`.
Omit `selected_connector_ids` to apply every manually eligible item. HTTP 202
returns `{ "data": { "batch_id": "<uuid>", "status_url": "/v1/owner/connector-updates/batches/<uuid>" } }`.
Poll `GET /v1/owner/connector-updates/batches/:id` for `{ "data": batch }`.
The batch has `batch_id`, `plan_id`, `idempotency_key`, `state` (`queued`,
`running`, `completed`, `completed_with_issues`), `created_at`, optional
`completed_at`, and durable `items`. Each result has `connector_id`, the exact
installed and target tuples, `state`, `retry_eligible`, and optional
`error:{code,message}`. Item states are `queued`, `verified`,
`waiting_for_run_boundary`, `activating`, `succeeded`, `deferred`, `failed`, and
`recovery_required`.

The server rechecks the catalog and installed snapshot when accepting the batch.
A change or expiry returns HTTP 409 `plan_changed`; it never picks a later
catalog digest. Repeating the same request with the same idempotency key returns
the original batch. Updates wait for active connector runs without disturbing
their artifact, then defer after 30 seconds. An uncertain activation or
registration failure is reported as `recovery_required` and fences dispatch.
See [owner update operation details](../server/connector-install/README.md) for
the recovery and persistence limits.

Direct install and uninstall, update preflight, and batch publication share an
installer fence per data directory, guarded by
an OS file lock on `<data dir>/.connector-install.lock.db` (an exclusive SQLite
transaction: fcntl on Linux and macOS, LockFileEx on Windows). A second request
fails with "Another connector installation is in progress." and names the
holder's pid from `.connector-install.lock.owner`. The OS releases the lock when
the holder process ends, so a crashed or restarted server never leaves a lock
behind, even when the new process has the same pid (normal in a container). An
older build locked by creating `.connector-install.lock/`. While that directory
exists, installs stay busy, unless its owner pid is not this server's pid and
does not exist in this PID namespace, or it has no owner record after 60
seconds. The server never removes
it; if no older server uses the data directory, remove it by hand. A direct
install that passes `PDPP_CONNECTOR_INSTALL_TIMEOUT_MS` (default 5 minutes)
fails with `connector_install_timeout`. If the deadline passes while the install
still waits for the connector's lifecycle lock, the wait ends and the lock is
released. If it passes before manifest registration starts, the install is
rolled back. If it passes during registration, the install completes late and
stays installed. This keeps the active artifact and the registered manifest in
agreement. Once the work has started, the lock stays held until the work stops.
On SQLite, each connector's lifecycle lock is an OS file lock of the same kind
in `<database file>.lifecycle-locks/`, so it is shared by exactly the processes
that share the database. The holder also writes a `connector_lifecycle_locks`
row. An existing row from an older build, which locks by that row alone, keeps
the lock busy while its pid is alive in this PID namespace and is not this
server's pid; it is never deleted.

Run one server per data directory, and stop the old version before you start a
new one. The locks above exclude a concurrent older build only where it can
see that build: a live owner pid in this PID namespace.

An install response or a succeeded batch item comes after the artifact is
activated and the manifest is registered. In the same transaction as the
manifest, the server queues the
derived repair for every connection of the connector:

- `record_derived_repair_pending`: one row per stream of the new manifest, to
  re-derive `cursor_value`, `primary_key_text` and `semantic_time`. On
  Postgres, `after_record_key` is the resume cursor.
- `search_index_dirty`: one scope per stream that the old or the new manifest
  indexes. A stream that lost its search fields thus has its stale index
  removed.

After the response and outside the lock, the server works through both
queues. Each statement covers a bounded chunk. Record-column and semantic
chunks shrink when a statement nears or passes the bulk `statement_timeout`
(`PDPP_POSTGRES_BULK_STATEMENT_TIMEOUT_MS`, default 15 s). Committed chunks
stay. If the server stops midway, the queues keep the rest and the maintenance
sweep resumes them; the semantic index embeds only pairs that are still
missing. A failure is recorded on its row (`last_error`, `attempts`, backoff)
and does not roll back the activation. Progress is visible in those two tables
and in `semantic_search_backfill_progress`.

Artifact identity is `digest`; version is display metadata. Package activation
is separate from connection setup and never changes
`connector_instances.source_binding_json`. Filesystem roots and internal
manifest bytes are not exposed by this API.

The server accepts only GHCR
`pdp-connect/connector/<connector_key>` artifacts and the exact
`publish-polyfill-connectors.yml@refs/heads/main` Sigstore identity. The RI
transport rejects config and profile responses above 1 MiB before activation.
The pinned core still needs a native config/profile-size option and oracle so
the bound is owned and proven at the shared installer boundary; the RI wrapper
is a temporary fail-closed guard for this lane.
