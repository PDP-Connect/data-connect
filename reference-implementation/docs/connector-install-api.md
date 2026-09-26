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
`{ "connector_id": "github" }` and activates the signed catalog row marked
`latest`.

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

## Recover a legacy policy mismatch

An imported legacy install whose registry manifest differs from its installed
manifest has a `repair_required` activation in the database. It is absent from
the owner status list, and install and update refuse it.
The following offline runbook restores the **installed artifact's** manifest;
it therefore rolls back any newer registry-only policy. Use it only after an
operator has compared those two manifests and approved that rollback. If the
newer policy must remain, publish a signed artifact with that policy and plan
its replacement separately. Do not delete the activation row to unblock a run.

1. Stop every server process using the database and `PDPP_DATA_DIR`. Back up
   the database and the full data directory. For SQLite, copy the configured
   `PDPP_DB_PATH` after shutdown. For PostgreSQL, use `pg_dump --format=custom`
   against the configured database URL. Keep the backup until status is active.
2. Inspect `connector_activations.record_json` and `connectors.manifest` for
   the affected `connector_id`. Confirm the activation has state
   `repair_required` and reason `Legacy registry and installed artifact
   disagree`. Review the policy difference and approve restoring the manifest
   embedded in `record_json`.
3. From the repository root, set `CONNECTOR_ID`, `PDPP_DATA_DIR`, and either
   `PDPP_DB_PATH` (SQLite) or `RECOVERY_DATABASE_URL` (PostgreSQL). Run this
   maintenance command while the server remains stopped:

```bash
node --import tsx --input-type=module <<'JS'
import { getConnectorActivation } from './reference-implementation/server/connector-install/activation-authority.ts';
import { repairPendingConnectorActivations } from './reference-implementation/server/connector-install/index.ts';
import { registerConnector } from './reference-implementation/server/auth.ts';
import { closeDb, getDb, initDb } from './reference-implementation/server/db.ts';
import { closePostgresStorage, initPostgresStorage, postgresQuery } from './reference-implementation/server/postgres-storage.ts';

const id = process.env.CONNECTOR_ID;
const dataDir = process.env.PDPP_DATA_DIR;
const postgresUrl = process.env.RECOVERY_DATABASE_URL;
if (!id || !dataDir || (!postgresUrl && !process.env.PDPP_DB_PATH)) {
  throw new Error('Set CONNECTOR_ID, PDPP_DATA_DIR, and RECOVERY_DATABASE_URL or PDPP_DB_PATH');
}
initDb(postgresUrl ? ':memory:' : process.env.PDPP_DB_PATH);
try {
  if (postgresUrl) await initPostgresStorage({ backend: 'postgres', databaseUrl: postgresUrl });
  const activation = await getConnectorActivation(id);
  if (activation?.state !== 'repair_required' ||
      activation.repairReason !== 'Legacy registry and installed artifact disagree') {
    throw new Error('Expected the imported legacy mismatch; no change made');
  }
  await registerConnector(activation.record.manifest);
  if (postgresUrl) {
    await postgresQuery(
      "UPDATE connector_activations SET repair_reason=$1 WHERE connector_id=$2 AND attempt_id=$3 AND state='repair_required'",
      ['Operator approved legacy manifest restoration', id, activation.attemptId]
    );
  } else {
    getDb().prepare(
      "UPDATE connector_activations SET repair_reason=? WHERE connector_id=? AND attempt_id=? AND state='repair_required'"
    ).run('Operator approved legacy manifest restoration', id, activation.attemptId);
  }
  const failures = await repairPendingConnectorActivations(
    (manifest, options) => registerConnector(manifest, options), dataDir
  );
  if (failures.length || (await getConnectorActivation(id))?.state !== 'active') {
    throw new Error(`Activation remains blocked: ${JSON.stringify(failures)}`);
  }
  console.log(`Activation active: ${id}`);
} finally {
  if (postgresUrl) await closePostgresStorage();
  closeDb();
}
JS
```

4. Restart the server and check `GET /v1/owner/connector-install/status` for
   `activation_state: active` and the expected digest. If the command failed,
   leave the connector blocked and investigate the error before retrying.
