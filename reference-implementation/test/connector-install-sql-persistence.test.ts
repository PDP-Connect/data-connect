// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The digest-bearing install record through the production SQL store.
 *
 * `createConnectorInstallStore()` (no preload directory) persists `connector_installs.record_json`. This journey
 * installs a pinned fixture through the production registration wiring, reads the record back through fresh store
 * instances, and reads the activation through the lazy path (`getConnectorActivation`, which imports the legacy
 * install row into `connector_activations`). It runs on SQLite always and on PostgreSQL 18 when
 * PDPP_TEST_POSTGRES_URL is set. The OCI artifact is a trusted fixture that reports a verified source declaration
 * digest; signatures are not exercised. Compare connector-install-registry-integration.test.ts, which uses the
 * file install store.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getConnectorManifest } from "../server/auth.ts";
import { getConnectorActivation } from "../server/connector-install/activation-authority.ts";
import {
  type ConnectorCatalogEntry,
  type ConnectorInstallRecord,
  createConnectorInstallService,
  createConnectorInstallStore,
  inspectActiveConnector,
} from "../server/connector-install/index.ts";
import { installedConnectorManifestRegistration } from "../server/connector-install/manifest-registration.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import {
  closePostgresStorage,
  initPostgresStorage,
  isPostgresStorageBackend,
  postgresQuery,
} from "../server/postgres-storage.ts";
import { snapshotContentAddressedSourceDeclarationFromLegacyConnectorManifest } from "../server/source-declaration-legacy-collection.ts";
import { withFixtureSourceDeclaration } from "./helpers/fixture-source-declaration.ts";
import { readCollectionProfileFixture } from "./helpers/installed-collection-profiles.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";

const SLUG = "fixture-sql-persistence";
const CONFIG_DIGEST = `sha256:${"e".repeat(64)}`;
const OTHER_SOURCE = "https://sources.example/other/sql-persistence";
const INTEGRITY_REFUSAL = /source declaration bytes failed integrity verification/;
const CONFLICT_REFUSAL = /conflicts with the verified source declaration/;

function digestOf(bytes: string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function profileFor(version: string): Record<string, unknown> {
  return {
    ...readCollectionProfileFixture("github"),
    connector_id: SLUG,
    connector_key: SLUG,
    manifest_uri: `https://registry.pdpp.dev/connectors/${SLUG}`,
    version,
  };
}

function declarationOf(profile: Record<string, unknown>): Record<string, unknown> {
  return withFixtureSourceDeclaration(profile).source_declaration as Record<string, unknown>;
}

interface Version {
  readonly entry: ConnectorCatalogEntry;
  readonly profileBytes: string;
  /** The verified sidecar bytes the pinned installer core reports, and the install writes. */
  readonly sidecar: string;
}

/**
 * A version. `embedded` is written into the profile itself; it is absent unless a test needs a profile that
 * carries a declaration (equal, or conflicting with the sidecar).
 */
function versionOf(version: string, embedded?: unknown): Version {
  const base = profileFor(version);
  const profile = embedded === undefined ? base : { ...base, source_declaration: embedded };
  const profileBytes = JSON.stringify(profile, null, 2);
  return {
    entry: {
      config_digest: CONFIG_DIGEST,
      connector_id: SLUG,
      connector_key: SLUG,
      digest: digestOf(profileBytes),
      tier: "supported",
      version,
    },
    profileBytes,
    sidecar: JSON.stringify(declarationOf(base), null, 2),
  };
}

function writeLayout(root: string, version: Version): void {
  mkdirSync(join(root, "profile"), { recursive: true });
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(join(root, "profile", "collection-profile.json"), version.profileBytes);
  writeFileSync(join(root, "dist", "collection-profile.mjs"), "export {};\n");
  writeFileSync(join(root, "provenance.json"), "{}\n");
  writeFileSync(join(root, "source-declaration.json"), version.sidecar);
}

/** The production store and registration wiring over the owned data directory. */
function serviceOver(dataDir: string, versions: readonly Version[]) {
  const registered: Record<string, unknown>[] = [];
  const service = createConnectorInstallService({
    catalogLoader: async () => versions.map((version) => version.entry),
    dataDir,
    installArtifact: (root, entry) => {
      const version = versions.find((candidate) => candidate.entry.digest === entry.digest);
      if (!version) {
        throw new Error("no fixture version for the requested digest");
      }
      writeLayout(root, version);
      return {
        configDigest: CONFIG_DIGEST,
        sourceDeclarationSha256: digestOf(version.sidecar),
      };
    },
    registerManifest: async (manifest) => {
      registered.push(manifest);
      return await installedConnectorManifestRegistration.registerManifest(manifest);
    },
    repairManifestDerivedState: installedConnectorManifestRegistration.repairManifestDerivedState,
    store: createConnectorInstallStore(),
  });
  return { registered, service };
}

async function storedRecord(): Promise<ConnectorInstallRecord | null> {
  const json = isPostgresStorageBackend()
    ? (
        await postgresQuery<{ record_json: string }>(
          "SELECT record_json FROM connector_installs WHERE connector_id=$1",
          [SLUG]
        )
      ).rows[0]?.record_json
    : getDb()
        .prepare("SELECT record_json FROM connector_installs WHERE connector_id=?")
        .get<{ record_json: string }>(SLUG)?.record_json;
  return json === undefined ? null : (JSON.parse(json) as ConnectorInstallRecord);
}

async function retainedSourceId(): Promise<unknown> {
  const declaration = (
    (await getConnectorManifest(SLUG)) as {
      source_declaration?: { source?: { id?: unknown } };
    } | null
  )?.source_declaration;
  return declaration?.source?.id;
}

/** Runs `run` with PDPP_DATA_DIR owned by the test and no preload directory, restoring both afterwards. */
async function withOwnedDataDir(run: (dataDir: string) => Promise<void>): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-install-sql-"));
  const previousDataDir = process.env.PDPP_DATA_DIR;
  const previousPreload = process.env.PDPP_CONNECTOR_PRELOAD_DIR;
  process.env.PDPP_DATA_DIR = dataDir;
  delete process.env.PDPP_CONNECTOR_PRELOAD_DIR;
  try {
    await run(dataDir);
  } finally {
    if (previousDataDir === undefined) {
      delete process.env.PDPP_DATA_DIR;
    } else {
      process.env.PDPP_DATA_DIR = previousDataDir;
    }
    if (previousPreload === undefined) {
      delete process.env.PDPP_CONNECTOR_PRELOAD_DIR;
    } else {
      process.env.PDPP_CONNECTOR_PRELOAD_DIR = previousPreload;
    }
    rmSync(dataDir, { force: true, recursive: true });
  }
}

async function journey(dataDir: string): Promise<void> {
  const v1 = versionOf("1.0.0");
  const declaration = declarationOf(profileFor("1.0.0"));
  const first = serviceOver(dataDir, [v1]);

  // Install through the production store; the record carries the Core-verified sidecar digest.
  const installed = await first.service.install(SLUG, v1.entry.digest);
  assert.equal(installed.sourceDeclarationSha256, digestOf(v1.sidecar));

  // A fresh read from SQL: the digest, the raw profile hash and the verified declaration survive the round trip.
  const persisted = await storedRecord();
  assert.ok(persisted, "the SQL install store holds the record");
  assert.equal(persisted.sourceDeclarationSha256, digestOf(v1.sidecar), "the stored record keeps the sidecar digest");
  assert.equal(persisted.manifestSha256, digestOf(v1.profileBytes), "the raw profile hash is unchanged");
  assert.deepEqual(persisted.manifest.source_declaration, declaration);
  const inspected = await inspectActiveConnector(createConnectorInstallStore(), SLUG);
  assert.equal(inspected.status, "active");
  assert.equal(inspected.record.sourceDeclarationSha256, digestOf(v1.sidecar));

  // Lazy activation: the first read imports the install row into connector_activations.
  const activation = await getConnectorActivation(SLUG);
  assert.ok(activation, "the activation is imported on first read");
  assert.equal(activation.state, "active", "the registry and the installed artifact agree");
  assert.equal(activation.record.sourceDeclarationSha256, digestOf(v1.sidecar));
  assert.deepEqual(activation.record.manifest.source_declaration, declaration);
  assert.equal((await getConnectorActivation(SLUG))?.activationId, activation.activationId, "the import is stable");

  // Same-digest reuse keeps the record's digest and the retained registry source.
  const sourceAfterInstall = await retainedSourceId();
  assert.ok(sourceAfterInstall, "the registry retains a source");
  const reused = await first.service.install(SLUG, v1.entry.digest);
  assert.equal(reused.sourceDeclarationSha256, digestOf(v1.sidecar));
  assert.equal((await storedRecord())?.sourceDeclarationSha256, digestOf(v1.sidecar));
  assert.equal(await retainedSourceId(), sourceAfterInstall);

  // Tampered while stopped: the read is refused, and a repair registers only the verified declaration.
  const root = join(dataDir, "connectors", SLUG, v1.entry.digest);
  writeFileSync(join(root, "source-declaration.json"), '{"source":"tampered"}\n');
  const tampered = await inspectActiveConnector(createConnectorInstallStore(), SLUG);
  assert.equal(tampered.status, "invalid");
  assert.match(tampered.reason, INTEGRITY_REFUSAL);

  const repaired = serviceOver(dataDir, [v1]);
  const repairedRecord = await repaired.service.install(SLUG, v1.entry.digest);
  assert.equal(repaired.registered.length, 1, "the repair registers once");
  for (const manifest of repaired.registered) {
    assert.deepEqual(manifest.source_declaration, declaration, "only the verified declaration is registered");
  }
  assert.equal(repairedRecord.sourceDeclarationSha256, digestOf(v1.sidecar));
  assert.equal(await retainedSourceId(), sourceAfterInstall, "the registry keeps the verified source");

  // A profile whose embedded declaration conflicts with the sidecar is refused and changes nothing.
  const conflicting = versionOf(
    "1.1.0",
    snapshotContentAddressedSourceDeclarationFromLegacyConnectorManifest(profileFor("1.1.0"), {
      connectorImplementationId: `https://implementations.example/connectors/${SLUG}`,
      publisherId: "https://publishers.example/sql-persistence",
      sourceId: OTHER_SOURCE,
    })
  );
  const rejecting = serviceOver(dataDir, [v1, conflicting]);
  await assert.rejects(() => rejecting.service.install(SLUG, conflicting.entry.digest), CONFLICT_REFUSAL);
  assert.equal(rejecting.registered.length, 0, "the conflicting profile is never registered");
  assert.equal((await storedRecord())?.digest, v1.entry.digest, "the previous install stays active");

  // A profile that embeds an equal declaration is accepted and records its own sidecar digest.
  const equal = versionOf("1.2.0", declarationOf(profileFor("1.2.0")));
  const accepted = await serviceOver(dataDir, [equal]).service.install(SLUG, equal.entry.digest);
  assert.equal(accepted.sourceDeclarationSha256, digestOf(equal.sidecar));
  assert.equal((await storedRecord())?.digest, equal.entry.digest);
}

test("SQLite: a pinned install's source declaration digest survives the SQL store, lazy activation and repair", async () => {
  initDb(":memory:");
  try {
    await withOwnedDataDir(journey);
  } finally {
    closeDb();
  }
});

test("PostgreSQL: a pinned install's source declaration digest survives the SQL store, lazy activation and repair (skipped: PDPP_TEST_POSTGRES_URL unset)", {
  skip: !process.env.PDPP_TEST_POSTGRES_URL,
}, async () => {
  const url = process.env.PDPP_TEST_POSTGRES_URL;
  assert.ok(url);
  await withTemporaryPostgresDatabase(
    {
      closeConnections: closePostgresStorage,
      connectionString: url,
      databaseName: `pdpp_test_install_sql_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 10)}_1`,
      templateName: null,
    },
    async (databaseUrl) => {
      initDb(":memory:");
      try {
        await initPostgresStorage({ backend: "postgres", databaseUrl });
        await withOwnedDataDir(journey);
      } finally {
        await closePostgresStorage();
        closeDb();
      }
    }
  );
});
