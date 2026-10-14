// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared fixture and scenarios for the legacy-upgrade preservation tests.
 *
 * `fixtures/legacy-upgrade/*.json` are copies of the c82718d4
 * `package/manifests/*.json` bundle entries. An upgraded database holds them
 * the way c82718d4's registerConnector stored them: the row id is the
 * manifest's `connector_key`, and the JSON went through
 * `normalizeConnectorManifestForStorage`. Only the OCI fetch is replaced in
 * the scenarios; the install service, owner routes, registration, state,
 * ingest and read paths are the production ones.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeConnectorManifestForStorage, registerConnector } from "../../server/auth.ts";
import {
  type ConnectorCatalogEntry,
  createConnectorInstallService,
  createFileConnectorInstallStore,
} from "../../server/connector-install/index.ts";
import { getDb } from "../../server/db.ts";
import { startServer } from "../../server/index.ts";
import { postgresQuery } from "../../server/postgres-storage.ts";
import {
  createPostgresConnectorInstanceStore,
  createSqliteConnectorInstanceStore,
} from "../../server/stores/connector-instance-store.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const NOW = "2026-05-18T12:00:00.000Z";
const CONFIG_DIGEST = `sha256:${"c".repeat(64)}`;

export type Row = Record<string, unknown>;

export type TestServer = Awaited<ReturnType<typeof startServer>> & {
  asServer: { close: (cb: (err?: Error) => void) => void; closeAllConnections: () => void };
  rsServer: { close: (cb: (err?: Error) => void) => void; closeAllConnections: () => void };
};

export type InstallService = ReturnType<typeof createConnectorInstallService>;

export function legacyManifest(key: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(HERE, "..", "fixtures", "legacy-upgrade", `${key}.json`), "utf8"));
}

/** The manifest JSON c82718d4 left in `connectors.manifest`. */
export function legacyStoredManifest(key: string): Record<string, unknown> {
  return normalizeConnectorManifestForStorage(legacyManifest(key)).storedManifest;
}

type InstanceStore = ReturnType<typeof createSqliteConnectorInstanceStore> | ReturnType<typeof createPostgresConnectorInstanceStore>;

/** Storage access that differs by backend. SQL uses `?` placeholders and runs on both. */
export interface LegacyBackend {
  readonly name: "sqlite" | "postgres";
  insertConnector(connectorId: string, manifestJson: string): Promise<void>;
  insertGrant(grantId: string, grantJson: string): Promise<void>;
  instanceStore(): InstanceStore;
  query(sql: string, params?: unknown[]): Promise<Row[]>;
}

export const sqliteBackend: LegacyBackend = {
  async insertConnector(connectorId, manifestJson) {
    getDb()
      .prepare("INSERT INTO connectors(connector_id, manifest, created_at) VALUES(?, ?, ?)")
      .run(connectorId, manifestJson, NOW);
  },
  async insertGrant(grantId, grantJson) {
    getDb()
      .prepare(
        `INSERT INTO grants(grant_id, subject_id, client_id, grant_json, access_mode, status, issued_at, expires_at)
         VALUES(?, 'owner_local', 'legacy-client', ?, 'continuous', 'active', ?, NULL)`
      )
      .run(grantId, grantJson, NOW);
  },
  instanceStore: () => createSqliteConnectorInstanceStore(),
  name: "sqlite",
  async query(sql, params = []) {
    return getDb()
      .prepare(sql)
      .all(...params) as Row[];
  },
};

export const postgresBackend: LegacyBackend = {
  async insertConnector(connectorId, manifestJson) {
    await postgresQuery("INSERT INTO connectors(connector_id, manifest) VALUES($1, $2::jsonb)", [
      connectorId,
      manifestJson,
    ]);
  },
  async insertGrant(grantId, grantJson) {
    await postgresQuery(
      `INSERT INTO grants(grant_id, subject_id, client_id, grant_json, access_mode, status, issued_at, expires_at)
       VALUES($1, 'owner_local', 'legacy-client', $2, 'continuous', 'active', $3, NULL)`,
      [grantId, grantJson, NOW]
    );
  },
  instanceStore: () => createPostgresConnectorInstanceStore(),
  name: "postgres",
  async query(sql, params = []) {
    let index = 0;
    return (await postgresQuery(sql.replace(/\?/g, () => `$${++index}`), params)).rows as Row[];
  },
};

export async function closeServer(server: TestServer): Promise<void> {
  server.schedulerManager?.stop?.();
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  await Promise.allSettled([
    new Promise<void>((resolve) => server.asServer.close(() => resolve())),
    new Promise<void>((resolve) => server.rsServer.close(() => resolve())),
  ]);
}

// biome-ignore lint/suspicious/noExplicitAny: response bodies are asserted field by field in the tests.
export async function fetchJson(url: string, init: RequestInit = {}): Promise<{ body: any; status: number }> {
  const response = await fetch(url, init);
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { body, status: response.status };
}

async function issueOwnerToken(asUrl: string): Promise<string> {
  const form = { "Content-Type": "application/x-www-form-urlencoded" };
  const device = await fetchJson(`${asUrl}/oauth/device_authorization`, {
    body: new URLSearchParams({ client_id: "pdpp_cli" }).toString(),
    headers: form,
    method: "POST",
  });
  await fetch(`${asUrl}/device/approve`, {
    body: new URLSearchParams({ subject_id: "owner_local", user_code: device.body.user_code }).toString(),
    headers: form,
    method: "POST",
  });
  const token = await fetchJson(`${asUrl}/oauth/token`, {
    body: new URLSearchParams({
      client_id: "pdpp_cli",
      device_code: device.body.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }).toString(),
    headers: form,
    method: "POST",
  });
  assert.ok(token.body?.access_token, "device exchange should issue an owner token");
  return token.body.access_token;
}

export interface LegacyUrls {
  readonly asUrl: string;
  readonly ownerToken: string;
  readonly rsUrl: string;
}

export async function withLegacyServer(
  options: {
    backend: LegacyBackend;
    databaseUrl?: string | undefined;
    /** Extra startServer options, for tests that run a connector (connectorPathResolver, run env). */
    serverOptions?: Record<string, unknown> | undefined;
    service?: InstallService | undefined;
  },
  body: (urls: LegacyUrls) => Promise<void>
): Promise<void> {
  const server = (await startServer({
    asPort: 0,
    ...(options.service ? { connectorInstallService: options.service } : {}),
    ...(options.serverOptions ?? {}),
    dbPath: ":memory:",
    quiet: true,
    reconcilePolyfillManifests: false,
    rsPort: 0,
    ...(options.backend.name === "postgres" && options.databaseUrl
      ? { databaseUrl: options.databaseUrl, ownerAuthPassword: "", storageBackend: "postgres" as const }
      : {}),
  })) as TestServer;
  try {
    const asUrl = `http://localhost:${server.asPort}`;
    await body({ asUrl, ownerToken: await issueOwnerToken(asUrl), rsUrl: `http://localhost:${server.rsPort}` });
  } finally {
    await closeServer(server);
  }
}

export interface LegacyInstance {
  readonly id: string;
  readonly status: "active" | "paused";
}

function legacyRecordData(key: string, stream: string, instanceId: string): Row {
  const manifest = legacyManifest(key) as { streams: { name: string; primary_key?: string[] }[] };
  const declared = manifest.streams.find((candidate) => candidate.name === stream);
  assert.ok(declared, `legacy manifest ${key} declares ${stream}`);
  const data: Row = {};
  for (const field of declared.primary_key ?? []) {
    data[field] = `rec-${instanceId}`;
  }
  return { ...data, name: `legacy ${instanceId}` };
}

/**
 * Writes the legacy registration, instances, per-instance state (over the
 * owner state API), records (over the owner ingest API) and a grant row (inserted directly; no client-token read goes through it).
 * Paused instances are paused only after their data exists, because writes
 * need an active instance.
 */
export async function seedLegacyRegistration(
  backend: LegacyBackend,
  urls: LegacyUrls,
  key: string,
  instances: readonly LegacyInstance[],
  stream: string
): Promise<void> {
  // POST /connectors of the shipped apple_contacts JSON is rejected today
  // ("connector_id must match connector_key"), so the stored row is written
  // directly, as it exists in an upgraded database.
  await backend.insertConnector(key, JSON.stringify(legacyStoredManifest(key)));
  const store = backend.instanceStore();
  const auth = { Authorization: `Bearer ${urls.ownerToken}` };
  for (const instance of instances) {
    await store.upsert({
      connectorId: key,
      connectorInstanceId: instance.id,
      createdAt: NOW,
      displayName: `Legacy ${instance.id}`,
      ownerSubjectId: "owner_local",
      sourceBinding: { account_hint: instance.id },
      sourceBindingKey: instance.id,
      sourceKind: "account",
      updatedAt: NOW,
    });
    const state = await fetchJson(
      `${urls.rsUrl}/v1/state/${encodeURIComponent(key)}?connector_instance_id=${instance.id}`,
      {
        body: JSON.stringify({ state: { [stream]: { cursor: `cursor-${instance.id}` } } }),
        headers: { ...auth, "Content-Type": "application/json" },
        method: "PUT",
      }
    );
    assert.equal(state.status, 200, JSON.stringify(state.body));
    const ingest = await fetchJson(
      `${urls.rsUrl}/v1/ingest/${stream}?connector_id=${encodeURIComponent(key)}&connector_instance_id=${instance.id}`,
      {
        body: `${JSON.stringify({ data: legacyRecordData(key, stream, instance.id), key: `rec-${instance.id}` })}\n`,
        headers: { ...auth, "Content-Type": "application/x-ndjson" },
        method: "POST",
      }
    );
    assert.equal(ingest.status, 200, JSON.stringify(ingest.body));
    assert.equal(ingest.body.records_accepted, 1, JSON.stringify(ingest.body));
    if (instance.status !== "active") {
      await store.updateStatus(instance.id, { status: instance.status, updatedAt: NOW });
    }
  }
  await backend.insertGrant(
    `grt_legacy_${key}`,
    JSON.stringify({
      access_mode: "continuous",
      grant_id: `grt_legacy_${key}`,
      source: { id: key, kind: "connector" },
      streams: [{ name: stream }],
    })
  );
}

export interface OwnerRows {
  readonly connectors: Row[];
  readonly grants: Row[];
  readonly instances: Row[];
  readonly records: Row[];
  readonly state: Row[];
}

/** Everything the owner would notice, read straight from storage. */
export async function snapshotOwnerRows(backend: LegacyBackend): Promise<OwnerRows> {
  return {
    connectors: await backend.query("SELECT connector_id FROM connectors ORDER BY connector_id"),
    grants: await backend.query("SELECT * FROM grants ORDER BY grant_id"),
    instances: await backend.query(
      `SELECT connector_instance_id, owner_subject_id, connector_id, display_name, status, source_kind,
              source_binding_key, source_binding_json, created_at, revoked_at,
              CAST(manifest_generation AS TEXT) AS manifest_generation
         FROM connector_instances ORDER BY connector_instance_id`
    ),
    records: await backend.query(
      `SELECT connector_id, connector_instance_id, stream, record_key, record_json, version, deleted
         FROM records ORDER BY connector_instance_id, stream, record_key`
    ),
    state: await backend.query(
      `SELECT connector_id, connector_instance_id, stream, state_json
         FROM connector_state ORDER BY connector_instance_id, stream`
    ),
  };
}

export function withoutGeneration(instances: Row[]): Row[] {
  return instances.map(({ manifest_generation: _generation, ...rest }) => rest);
}

/** A catalog entry plus install-artifact writer for one profile; only the OCI fetch is faked. */
export function fakeCatalogFor(profile: Row): {
  readonly entry: ConnectorCatalogEntry;
  readonly installArtifact: (root: string) => void;
} {
  const bytes = JSON.stringify(profile, null, 2);
  const key = profile.connector_key as string;
  return {
    entry: {
      config_digest: CONFIG_DIGEST,
      connector_id: key,
      connector_key: key,
      digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      latest: true,
      tier: "supported",
      version: profile.version as string,
    },
    installArtifact: (root) => {
      mkdirSync(join(root, "profile"), { recursive: true });
      mkdirSync(join(root, "dist"), { recursive: true });
      writeFileSync(join(root, "profile", "collection-profile.json"), bytes);
      writeFileSync(join(root, "dist", "collection-profile.mjs"), "export {};\n");
      writeFileSync(join(root, "provenance.json"), "{}\n");
    },
  };
}

/** The checked-in 0.5.1 github profile: the same 7 streams as the c82718d4 0.5.0 manifest. */
export function catalogGithubProfile(): Row {
  return JSON.parse(readFileSync(join(HERE, "..", "fixtures", "collection-profiles", "github.json"), "utf8"));
}

export function installServiceFor(
  dataDir: string,
  catalog: ReturnType<typeof fakeCatalogFor> | null,
  onRegister?: () => void
): InstallService {
  return createConnectorInstallService({
    catalogLoader: async () => (catalog ? [catalog.entry] : []),
    dataDir,
    ...(catalog ? { installArtifact: catalog.installArtifact } : {}),
    registerManifest: (manifest) => {
      onRegister?.();
      return registerConnector(manifest);
    },
    store: createFileConnectorInstallStore(dataDir),
  });
}

async function storedManifest(backend: LegacyBackend, key: string): Promise<Row> {
  const [row] = await backend.query("SELECT manifest FROM connectors WHERE connector_id = ?", [key]);
  assert.ok(row, `connector ${key} is registered`);
  return (typeof row.manifest === "string" ? JSON.parse(row.manifest) : row.manifest) as Row;
}

async function assertPausedReadRefused(urls: LegacyUrls): Promise<void> {
  const read = await fetchJson(
    `${urls.rsUrl}/v1/streams/repositories/records?connector_id=github&connector_instance_id=cin_github_paused`,
    { headers: { Authorization: `Bearer ${urls.ownerToken}` } }
  );
  assert.equal(read.status, 400, JSON.stringify(read.body));
  assert.equal(read.body.error.code, "connector_instance_inactive");
}

/** `/update` over HTTP on legacy github with an active and a paused instance. */
export async function assertUpdatePreservesOwnerRows(backend: LegacyBackend, dataDir: string, databaseUrl?: string) {
  const catalog = fakeCatalogFor(catalogGithubProfile());
  const service = installServiceFor(dataDir, catalog);
  await withLegacyServer({ backend, databaseUrl, service }, async (urls) => {
    await seedLegacyRegistration(
      backend,
      urls,
      "github",
      [
        { id: "cin_github_active", status: "active" },
        { id: "cin_github_paused", status: "paused" },
      ],
      "repositories"
    );
    const before = await snapshotOwnerRows(backend);
    await assertPausedReadRefused(urls);
    const manifestBefore = await storedManifest(backend, "github");
    assert.equal(manifestBefore.version, "0.5.0");
    assert.equal((manifestBefore.streams as unknown[]).length, 7);
    assert.deepEqual(
      before.instances.map((row) => [row.connector_instance_id, row.status, row.manifest_generation]),
      [
        ["cin_github_active", "active", "0"],
        ["cin_github_paused", "paused", "0"],
      ]
    );
    assert.equal(before.records.length, 2);
    assert.equal(before.state.length, 2);
    assert.equal(before.grants.length, 1);

    const updated = await fetchJson(`${urls.rsUrl}/v1/owner/connector-install/update`, {
      body: JSON.stringify({ connector_id: "github" }),
      headers: { Authorization: `Bearer ${urls.ownerToken}`, "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));

    const after = await snapshotOwnerRows(backend);
    // Same connector rows (no parallel registration), grants, records and state.
    assert.deepEqual(after.connectors, before.connectors);
    assert.deepEqual(after.grants, before.grants);
    assert.deepEqual(after.records, before.records);
    assert.deepEqual(after.state, before.state);
    // Same instance ids and identity columns; paused stays paused.
    assert.deepEqual(withoutGeneration(after.instances), withoutGeneration(before.instances));
    assert.deepEqual(
      after.instances.map((row) => [row.connector_instance_id, row.status]),
      [
        ["cin_github_active", "active"],
        ["cin_github_paused", "paused"],
      ]
    );
    // Only the manifest and the generation moved.
    assert.deepEqual(
      after.instances.map((row) => row.manifest_generation),
      ["1", "1"]
    );
    assert.equal((await storedManifest(backend, "github")).version, "0.5.1");

    // The active instance's records stay readable over HTTP. The paused instance's rows
    // are covered by the storage snapshot above; its owner reads are refused the same way
    // as before the update (stores/connector-instance-store.ts, same at c82718d4).
    await assertPausedReadRefused(urls);
    const read = await fetchJson(
      `${urls.rsUrl}/v1/streams/repositories/records?connector_id=github&connector_instance_id=cin_github_active`,
      { headers: { Authorization: `Bearer ${urls.ownerToken}` } }
    );
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.equal(read.body.data.length, 1);
  });
}

/** `/update` for a key with no catalog entry (the catalog only has the hyphenated key). */
export async function assertUpdateWithoutCatalogEntryCreatesNothing(
  backend: LegacyBackend,
  dataDir: string,
  databaseUrl?: string
) {
  const hyphenProfile = {
    ...legacyManifest("apple_contacts"),
    connector_id: "https://registry.pdpp.dev/connectors/apple-contacts",
    connector_key: "apple-contacts",
  };
  let registrations = 0;
  const service = installServiceFor(dataDir, fakeCatalogFor(hyphenProfile), () => {
    registrations += 1;
  });
  await withLegacyServer({ backend, databaseUrl, service }, async (urls) => {
    await seedLegacyRegistration(
      backend,
      urls,
      "apple_contacts",
      [{ id: "cin_apple_contacts_legacy", status: "active" }],
      "contacts"
    );
    const before = await snapshotOwnerRows(backend);
    const updated = await fetchJson(`${urls.rsUrl}/v1/owner/connector-install/update`, {
      body: JSON.stringify({ connector_id: "apple_contacts" }),
      headers: { Authorization: `Bearer ${urls.ownerToken}`, "Content-Type": "application/json" },
      method: "POST",
    });
    // Pinned as observed: the service throws a plain Error, which handleError maps to 500 api_error.
    // A 4xx would be the better contract; this pin makes a change in either direction visible.
    assert.equal(updated.status, 500, JSON.stringify(updated.body));
    assert.equal(updated.body.error.code, "api_error");
    assert.equal(updated.body.error.message, "Connector has no verified update target.");
    assert.equal(registrations, 0, "a failed update must not register a manifest");
    assert.deepEqual(await snapshotOwnerRows(backend), before);
    assert.deepEqual(await service.status(), [], "nothing was installed");
  });
}
