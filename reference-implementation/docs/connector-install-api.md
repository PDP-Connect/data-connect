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
