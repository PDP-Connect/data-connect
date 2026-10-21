# Owner connector updates (phase 1)

All routes require the existing owner token/session guards. Updates are manual.
No policy API, unattended activation, MCP, or desktop updater changes are included.
A package update affects every instance of its connector.

`POST /v1/owner/connector-updates/plans` accepts an empty body and returns HTTP 202:

```json
{"data":{"plan_id":"<uuid>","status_url":"/v1/owner/connector-updates/plans/<uuid>"},"object":"connector_update_plan"}
```

Poll that URL. Its `data` contains:

- `plan_id`, `state` (`checking`, `ready`, `failed`), `created_at`, `expires_at`.
- `catalog_revision`: hash of the verified catalog entries and saved generation.
- `manual_count`, `review_count`, `items`, and optional failure `error`.

Each item contains `connector_id`, exact `installed` and `target` tuples
`{version,digest}`, `manual_eligible`, `auto_eligible` (always false),
`review_required`, `reasons`, `affected_instance_count`, and
`manifest_diff: {changed_fields,compatibility:"unknown"}`. Versions can be null.
Private staging paths and install records are omitted from the response.
Plans expire 15 minutes after creation. A ready plan is immutable.

Planning uses the complete installed package set, excludes selected local sources,
fetches each target by its exact verified catalog digest, and verifies the artifact
with the existing pinned installer. Download concurrency is one per plan; the
existing installer fence bounds concurrent staging across processes. Preflight
retains the verified bytes in a digest root without activating them. Existing roots
are compared with freshly verified artifact hashes before reuse.

A stable, increasing version in the same major is a manual candidate only if no
non-descriptive manifest declaration changed. Majors, downgrades, same-version
republishes, prereleases, and incomparable versions require review. Manifest
comparison is conservative: a declaration change can require review even if it
reduces access. Missing compatibility metadata is disclosed and disables automatic
eligibility; it does not by itself block a manual candidate. Verification failures
cannot be overridden. Review consent is outside this phase, so review items cannot
be submitted to a batch.

`POST /v1/owner/connector-updates/batches` accepts:

```json
{"plan_id":"<uuid>","idempotency_key":"<stable caller request key>","selected_connector_ids":["github"]}
```

Omit `selected_connector_ids` to apply every manual candidate. An empty selection
creates an empty completed batch. `idempotency_key` must contain 1–200 characters.
Unknown fields, including automatic triggers or consents, are rejected. HTTP 202:

```json
{"data":{"batch_id":"<uuid>","status_url":"/v1/owner/connector-updates/batches/<uuid>"},"object":"connector_update_batch"}
```

The server rechecks the complete catalog, installed records, local-source selection,
and expiry before accepting a new request. HTTP 409 `plan_changed` requires a new
plan; the server never substitutes a new latest digest. HTTP 409 `review_required`
rejects a selected review, missing, or unverified item. Reusing a key for the same
plan and selection returns the original batch, including after completion or plan
expiry. Reusing it for another request returns `idempotency_conflict`. Concurrent
requests wait briefly for validation; `request_busy` can be retried with the same
key.

Poll the batch URL. Its `data` contains `batch_id`, `plan_id`, `idempotency_key`,
`state` (`queued`, `running`, `completed`, `completed_with_issues`), `created_at`,
optional `completed_at`, and `items`. Each item has `connector_id`, exact `installed`
and `target` tuples, `state`, `retry_eligible`, and optional `error:{code,message}`.
Item states are `queued`, `verified`, `waiting_for_run_boundary`, `activating`,
`succeeded`, `deferred`, `failed`, and `recovery_required`. Counts can be derived
from the durable items. Unrelated items continue after an item fails.

Activation reuses the existing connector lifecycle lock. The existing installer
fence also serializes publication with direct installs and uninstalls, including
file-backed preload stores. A competing installer produces a retryable `deferred`
item with `connector_install_busy`; the batch never waits for that fence while
holding the lifecycle lock. It rechecks the installed
tuple and local selection inside that lock, checks durable active-run liveness,
and activates the prepared record without another catalog lookup. An active run
keeps its old package and is never cancelled. The batch waits up to 30 seconds
without holding the lifecycle lock, then records `deferred`. A new plan/batch can
retry after that run finishes. Old roots remain available. Scheduled dispatch now
uses controller `runNow`, which resolves current bytes under the lifecycle lock.

Publication writes a durable recovery fence before changing the active pointer or
registering the manifest. The fence clears only after publication and lifecycle
transaction completion. If activation or registration fails, pointer restoration
is attempted, but registration metadata may already have changed. Such an item is
`recovery_required`, never successful or rolled back. Both active-install reads
and dispatch refuse it. An operator must reconcile the active record, registered
manifest, generations, accepted declarations, and derived repair state before
removing that fence. There is no automatic rollback or recovery endpoint in this
phase. Successful registration queues the existing derived repair; asynchronous
repair failures retain the existing maintenance retry behavior.

The existing `POST /v1/owner/connector-install/update` uses the same plan/batch
service for one connector. It retains its successful installed-record response;
review or deferred/recovery outcomes return an error. A connector without a
verified install record (a registration carried over from the pre-OCI bundle)
has no installed tuple for a plan item, so the route publishes the catalog's
latest verified target for it through the direct install path. New clients
should use the asynchronous endpoints so work remains observable after an HTTP
disconnect.

Plans, batch items, results, and idempotency receipts are private atomic JSON
records under `PDPP_DATA_DIR/connector-updates`, guarded by the existing OS-backed
directory-lock primitive. Startup and status polling resume pre-publication work.
Interrupted `activating` items enter recovery and fence dispatch rather than
replaying uncertain writes. Several server processes must share the same data
and artifact directory, including when the registry uses PostgreSQL. Independent
filesystem roots with a shared PostgreSQL database are not supported for batch
ownership. Power-loss durability and multi-host fencing have not been verified.

This phase retains roots and journals without a garbage collector or retention
budget. Cancellation, review consent, migration/re-auth workflows, automated
recovery, publisher compatibility metadata, release notes, channels, rollout,
revocation metadata, and run-state rollback remain future work.
