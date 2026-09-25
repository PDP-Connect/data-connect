// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { getDb } from "./db.ts";
import {
  isPostgresStorageBackend,
  type PostgresTransactionClient,
  postgresQuery,
  withPostgresBulkTransaction,
  withPostgresTransaction,
} from "./postgres-storage.ts";

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      return candidate;
    }
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(candidate).sort()) {
      sorted[key] = candidate[key];
    }
    return sorted;
  });
}

export function storedConnectorManifestRevision(manifest: Record<string, unknown>): string {
  return `sha256:${createHash("sha256").update(canonicalJson(manifest)).digest("hex")}`;
}

export function storedConnectorManifestStreamRevision(manifest: Record<string, unknown>): string {
  return storedConnectorManifestRevision({ connector_id: manifest.connector_id, streams: manifest.streams });
}

function connectorManifestStreamNames(manifest: Record<string, unknown>): string[] {
  if (!Array.isArray(manifest.streams)) {
    throw new TypeError("Connector manifest streams must be an array");
  }
  const names = manifest.streams.map((stream) => {
    if (!stream || typeof stream !== "object" || Array.isArray(stream)) {
      throw new TypeError("Connector manifest stream must be an object");
    }
    const name = (stream as Record<string, unknown>).name;
    if (typeof name !== "string" || name.length === 0) {
      throw new TypeError("Connector manifest stream name must be a non-empty string");
    }
    return name;
  });
  if (new Set(names).size !== names.length) {
    throw new TypeError("Connector manifest stream names must be unique");
  }
  return names;
}

function selectedManifestStreams(manifest: Record<string, unknown>, names: readonly string[]): unknown[] | null {
  if (!Array.isArray(manifest.streams)) {
    return null;
  }
  const wantedNames = new Set(names);
  const byName = new Map<string, unknown>();
  for (const stream of manifest.streams) {
    if (!stream || typeof stream !== "object" || Array.isArray(stream)) {
      continue;
    }
    const name = (stream as Record<string, unknown>).name;
    if (typeof name !== "string" || !wantedNames.has(name)) {
      continue;
    }
    if (byName.has(name)) {
      return null;
    }
    byName.set(name, stream);
  }
  const selected = names.map((name) => byName.get(name));
  return selected.every((stream) => stream !== undefined) ? selected : null;
}

function assertCurrentManifestStreamSubset(
  connectorId: string,
  expectedManifest: Record<string, unknown>,
  storedManifest: unknown,
  hasActivation: boolean
): void {
  if (!storedManifest) {
    if (hasActivation) {
      throw new Error(`Connector ${connectorId} manifest revision changed during derived repair`);
    }
    return; // Native manifests may have no registry row or OCI activation.
  }
  const manifest = typeof storedManifest === "string" ? JSON.parse(storedManifest) : storedManifest;
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error(`Connector ${connectorId} manifest revision changed during derived repair`);
  }
  const names = connectorManifestStreamNames(expectedManifest);
  const expectedStreams = selectedManifestStreams(expectedManifest, names);
  const storedStreams = selectedManifestStreams(manifest as Record<string, unknown>, names);
  if (!expectedStreams || !storedStreams) {
    throw new Error(`Connector ${connectorId} manifest revision changed during derived repair`);
  }
  const expectedRevision = storedConnectorManifestStreamRevision({ connector_id: connectorId, streams: expectedStreams });
  const currentRevision = storedConnectorManifestStreamRevision({ connector_id: connectorId, streams: storedStreams });
  if (currentRevision !== expectedRevision) {
    throw new Error(`Connector ${connectorId} manifest revision changed during derived repair`);
  }
}

/**
 * Confirm only the declared streams being repaired still match storage.
 * Reconciliation passes intentionally narrow a manifest to one dirty stream,
 * so comparing the full manifest would reject valid work and block repairs.
 */
export async function assertConnectorManifestStreamSubsetWithClient(
  client: PostgresTransactionClient,
  connectorId: string,
  expectedManifest: Record<string, unknown>
): Promise<void> {
  await lockConnectorManifestPublication(client, connectorId);
  const row = await client.query<{ manifest: unknown }>(
    "SELECT manifest FROM connectors WHERE connector_id=$1 FOR SHARE",
    [connectorId]
  );
  const activation = row.rows[0]
    ? null
    : await client.query("SELECT 1 FROM connector_activations WHERE connector_id=$1", [connectorId]);
  assertCurrentManifestStreamSubset(
    connectorId,
    expectedManifest,
    row.rows[0]?.manifest,
    Boolean(activation?.rowCount)
  );
}

export function assertConnectorManifestStreamSubsetSync(
  connectorId: string,
  expectedManifest: Record<string, unknown>
): void {
  const row = getDb()
    .prepare("SELECT manifest FROM connectors WHERE connector_id=?")
    .get<{ manifest: string }>(connectorId);
  const activation = row
    ? null
    : getDb().prepare("SELECT 1 FROM connector_activations WHERE connector_id=?").get(connectorId);
  assertCurrentManifestStreamSubset(connectorId, expectedManifest, row?.manifest, Boolean(activation));
}

export function assertCurrentManifestRevision(
  connectorId: string,
  expectedRevision: string,
  storedManifest: unknown,
  hasActivation: boolean
): void {
  if (!storedManifest) {
    if (hasActivation) {
      throw new Error(`Connector ${connectorId} manifest revision changed during derived repair`);
    }
    return; // Native manifests may have no registry row or OCI activation.
  }
  const manifest = typeof storedManifest === "string" ? JSON.parse(storedManifest) : storedManifest;
  if (storedConnectorManifestRevision(manifest as Record<string, unknown>) !== expectedRevision) {
    throw new Error(`Connector ${connectorId} manifest revision changed during derived repair`);
  }
}

export async function assertConnectorManifestRevisionWithClient(
  client: PostgresTransactionClient,
  connectorId: string,
  expectedRevision: string
): Promise<void> {
  await lockConnectorManifestPublication(client, connectorId);
  const row = await client.query<{ manifest: unknown }>(
    "SELECT manifest FROM connectors WHERE connector_id=$1 FOR SHARE",
    [connectorId]
  );
  const activation = row.rows[0]
    ? null
    : await client.query("SELECT 1 FROM connector_activations WHERE connector_id=$1", [connectorId]);
  assertCurrentManifestRevision(connectorId, expectedRevision, row.rows[0]?.manifest, Boolean(activation?.rowCount));
}

export function assertConnectorManifestRevisionSync(connectorId: string, expectedRevision: string): void {
  const row = getDb()
    .prepare("SELECT manifest FROM connectors WHERE connector_id=?")
    .get<{ manifest: string }>(connectorId);
  const activation = row
    ? null
    : getDb().prepare("SELECT 1 FROM connector_activations WHERE connector_id=?").get(connectorId);
  assertCurrentManifestRevision(connectorId, expectedRevision, row?.manifest, Boolean(activation));
}

function assertCurrentManifestStreamRevision(
  connectorId: string,
  expectedRevision: string | null,
  storedManifest: unknown,
  hasActivation = false
): void {
  if (!storedManifest) {
    if (expectedRevision === null && !hasActivation) {
      return;
    }
    throw new Error(`Connector ${connectorId} manifest revision changed during derived repair`);
  }
  if (expectedRevision === null) {
    throw new Error(`Connector ${connectorId} manifest revision changed during derived repair`);
  }
  const manifest = typeof storedManifest === "string" ? JSON.parse(storedManifest) : storedManifest;
  if (storedConnectorManifestStreamRevision(manifest as Record<string, unknown>) !== expectedRevision) {
    throw new Error(`Connector ${connectorId} manifest revision changed during derived repair`);
  }
}

export async function assertConnectorManifestStreamRevisionWithClient(
  client: PostgresTransactionClient,
  connectorId: string,
  expectedRevision: string
): Promise<void> {
  await lockConnectorManifestPublication(client, connectorId);
  const row = await client.query<{ manifest: unknown }>(
    "SELECT manifest FROM connectors WHERE connector_id=$1 FOR SHARE",
    [connectorId]
  );
  assertCurrentManifestStreamRevision(connectorId, expectedRevision, row.rows[0]?.manifest);
}

export function assertConnectorManifestStreamRevisionSync(connectorId: string, expectedRevision: string): void {
  const row = getDb()
    .prepare("SELECT manifest FROM connectors WHERE connector_id=?")
    .get<{ manifest: string }>(connectorId);
  assertCurrentManifestStreamRevision(connectorId, expectedRevision, row?.manifest);
}

/** Read the stream-shape revision used by a non-device ingest before it computes manifest-derived values. */
export async function currentConnectorManifestStreamRevision(connectorId: string): Promise<string | null> {
  if (isPostgresStorageBackend()) {
    const result = await postgresQuery<{ manifest: unknown }>("SELECT manifest FROM connectors WHERE connector_id=$1", [
      connectorId,
    ]);
    if (!result.rows[0]) {
      const activation = await postgresQuery("SELECT 1 FROM connector_activations WHERE connector_id=$1", [
        connectorId,
      ]);
      if (activation.rowCount) {
        throw new Error(`Connector ${connectorId} manifest revision changed during derived repair`);
      }
      return null;
    }
    return storedConnectorManifestStreamRevision(
      (typeof result.rows[0].manifest === "string"
        ? JSON.parse(result.rows[0].manifest)
        : result.rows[0].manifest) as Record<string, unknown>
    );
  }
  const row = getDb()
    .prepare("SELECT manifest FROM connectors WHERE connector_id=?")
    .get<{ manifest: string }>(connectorId);
  if (!row) {
    const activation = getDb().prepare("SELECT 1 FROM connector_activations WHERE connector_id=?").get(connectorId);
    if (activation) {
      throw new Error(`Connector ${connectorId} manifest revision changed during derived repair`);
    }
    return null;
  }
  return storedConnectorManifestStreamRevision(JSON.parse(row.manifest) as Record<string, unknown>);
}

export async function assertConnectorManifestStreamRevisionOrAbsentWithClient(
  client: PostgresTransactionClient,
  connectorId: string,
  expectedRevision: string | null
): Promise<void> {
  await lockConnectorManifestPublication(client, connectorId);
  const row = await client.query<{ manifest: unknown }>(
    "SELECT manifest FROM connectors WHERE connector_id=$1 FOR SHARE",
    [connectorId]
  );
  const activation = row.rows[0]
    ? null
    : await client.query("SELECT 1 FROM connector_activations WHERE connector_id=$1", [connectorId]);
  assertCurrentManifestStreamRevision(
    connectorId,
    expectedRevision,
    row.rows[0]?.manifest,
    Boolean(activation?.rowCount)
  );
}

export function assertConnectorManifestStreamRevisionOrAbsentSync(
  connectorId: string,
  expectedRevision: string | null
): void {
  const row = getDb()
    .prepare("SELECT manifest FROM connectors WHERE connector_id=?")
    .get<{ manifest: string }>(connectorId);
  const activation = row
    ? null
    : getDb().prepare("SELECT 1 FROM connector_activations WHERE connector_id=?").get(connectorId);
  assertCurrentManifestStreamRevision(connectorId, expectedRevision, row?.manifest, Boolean(activation));
}

/** Use the same advisory key as OCI activation publication. */
export async function lockConnectorManifestPublication(
  client: PostgresTransactionClient,
  connectorId: string
): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext('connector_activation'), hashtext($1))", [connectorId]);
}

/**
 * A bounded derived write owns one transaction. Compute/embedding happens before
 * this call; the revision read and every mutation in the callback share it.
 */
export async function withConnectorManifestDerivedWrite<T>(
  connectorId: string,
  expectedRevision: string,
  write: {
    postgres: (client: PostgresTransactionClient) => Promise<T>;
    sqlite: () => T;
  },
  options: { bulk?: boolean } = {}
): Promise<T> {
  if (isPostgresStorageBackend()) {
    const transact = options.bulk ? withPostgresBulkTransaction : withPostgresTransaction;
    return transact(async (client) => {
      await assertConnectorManifestRevisionWithClient(client, connectorId, expectedRevision);
      return write.postgres(client);
    });
  }
  return await getDb()
    .transaction(() => {
      const row = getDb()
        .prepare("SELECT manifest FROM connectors WHERE connector_id=?")
        .get<{ manifest: string }>(connectorId);
      const activation = row
        ? null
        : getDb().prepare("SELECT 1 FROM connector_activations WHERE connector_id=?").get(connectorId);
      assertCurrentManifestRevision(connectorId, expectedRevision, row?.manifest, Boolean(activation));
      return write.sqlite();
    })
    .immediate();
}
