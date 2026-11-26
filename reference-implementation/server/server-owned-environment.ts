// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Environment names the reference server reads for its own configuration.
 *
 * A connector key is chosen by the connector's author, so a manifest keyed
 * `database` would own `PDPP_DATABASE_*`, which includes the server's storage
 * URL. A connector must never be able to declare or receive a name the server
 * uses, whatever its key. The tuning-namespace rule consults this list first.
 *
 * An entry ending in `_` is a server namespace (every name under it); any other
 * entry is one exact name. Add an entry when the server starts reading a
 * variable outside these namespaces.
 */
const SERVER_OWNED_ENVIRONMENT: readonly string[] = [
  "PDPP_AS_",
  "PDPP_BROWSER_",
  "PDPP_CLIENT_",
  "PDPP_CONNECTOR_",
  "PDPP_CREDENTIAL_",
  "PDPP_DATABASE_",
  "PDPP_DB_",
  "PDPP_DCR_",
  "PDPP_INGEST_",
  "PDPP_NEKO_",
  "PDPP_OWNER_",
  "PDPP_PG_",
  "PDPP_POSTGRES_",
  "PDPP_REFERENCE_",
  "PDPP_RS_",
  "PDPP_RUN_",
  "PDPP_RUNTIME_",
  "PDPP_SEMANTIC_",
  "PDPP_SQLITE_",
  "PDPP_STORAGE_",
  "PDPP_TEST_",
  "PDPP_TRUSTED_",
  "PDPP_WEB_",
  "PDPP_BIND_HOST",
  "PDPP_BLOB_SPOOL_DIR",
  "PDPP_DATA_DIR",
  "PDPP_DIR",
  "PDPP_INITIAL_ACCESS_TOKEN",
  "PDPP_INSTANCE_NAME",
  "PDPP_SOURCE_WEBHOOK_SECRETS",
  "PDPP_STREAMING_REGISTRATION_TOKEN",
  "PDPP_SUBJECT_ID",
  "PDPP_TRACE",
  "PDPP_TRACE_DIR",
];

export function isServerOwnedEnvironmentKey(key: string): boolean {
  const upper = key.toUpperCase();
  return SERVER_OWNED_ENVIRONMENT.some((entry) => (entry.endsWith("_") ? upper.startsWith(entry) : upper === entry));
}
