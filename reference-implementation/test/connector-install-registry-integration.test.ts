// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Install service to registry journey: the verified source declaration is published to the real registry
 * (SQLite, and PostgreSQL 18 when PDPP_TEST_POSTGRES_URL is set) through the production registration
 * wiring, and survives reuse and a restart with a new store and service instance.
 *
 * The OCI artifact seam is a trusted verified-layout fixture (`installArtifact`); signatures are not exercised.
 * The install record's sidecar digest is the durable binding this journey checks.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getConnectorManifest } from "../server/auth.ts";
import {
  type ConnectorCatalogEntry,
  createConnectorInstallService,
  createFileConnectorInstallStore,
  inspectActiveConnector,
} from "../server/connector-install/index.ts";
import { installedConnectorManifestRegistration } from "../server/connector-install/manifest-registration.ts";
import { closeDb, initDb } from "../server/db.ts";
import { closePostgresStorage, initPostgresStorage } from "../server/postgres-storage.ts";
import { snapshotContentAddressedSourceDeclarationFromLegacyConnectorManifest } from "../server/source-declaration-legacy-collection.ts";
import { withFixtureSourceDeclaration } from "./helpers/fixture-source-declaration.ts";
import { readCollectionProfileFixture } from "./helpers/installed-collection-profiles.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";

const SLUG = "fixture-registry-journey";
const CONFIG_DIGEST = `sha256:${"d".repeat(64)}`;
const OTHER_SOURCE = "https://sources.example/other/registry-journey";
const ALREADY_BOUND = /already bound to source/;

function profileFor(version: string): Record<string, unknown> {
  return {
    ...readCollectionProfileFixture("github"),
    connector_id: SLUG,
    connector_key: SLUG,
    manifest_uri: `https://registry.pdpp.dev/connectors/${SLUG}`,
    version,
  };
}

function digestOf(bytes: string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

interface Version {
  readonly entry: ConnectorCatalogEntry;
  readonly profileBytes: string;
  readonly sidecar: string;
}

/** A version whose sidecar names `sourceId` as its Core source; the profile itself embeds nothing. */
function versionWith(version: string, sourceId?: string): Version {
  const profile = profileFor(version);
  const declaration =
    sourceId === undefined
      ? withFixtureSourceDeclaration(profile).source_declaration
      : snapshotContentAddressedSourceDeclarationFromLegacyConnectorManifest(profile, {
          connectorImplementationId: `https://implementations.example/connectors/${SLUG}`,
          publisherId: "https://publishers.example/registry-journey",
          sourceId,
        });
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
    sidecar: JSON.stringify(declaration, null, 2),
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

function retainedSourceId(stored: Record<string, unknown> | null): string | undefined {
  const declaration = stored?.source_declaration as { source?: { id?: unknown } } | undefined;
  return typeof declaration?.source?.id === "string" ? declaration.source.id : undefined;
}

/** The production registration wiring, optionally failing once on a chosen call to exercise rollback. */
function productionService(dataDir: string, versions: readonly Version[], failOnCall?: number) {
  const store = createFileConnectorInstallStore(dataDir);
  let calls = 0;
  const service = createConnectorInstallService({
    catalogLoader: async () => versions.map((version) => version.entry),
    dataDir,
    installArtifact: (root, entry) => {
      const version = versions.find((candidate) => candidate.entry.digest === entry.digest);
      if (!version) {
        throw new Error("no fixture version for the requested digest");
      }
      writeLayout(root, version);
    },
    registerManifest: async (manifest) => {
      calls += 1;
      if (failOnCall === calls) {
        throw new Error("registration refused (test)");
      }
      return await installedConnectorManifestRegistration.registerManifest(manifest);
    },
    repairManifestDerivedState: installedConnectorManifestRegistration.repairManifestDerivedState,
    store,
  });
  return { service, store };
}

async function journey(): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-install-registry-"));
  try {
    const v1 = versionWith("1.0.0");
    const v2 = versionWith("1.1.0");
    const first = productionService(dataDir, [v1, v2]);
    const installed = await first.service.install(SLUG, v1.entry.digest);
    const sourceAfterInstall = retainedSourceId((await getConnectorManifest(SLUG)) as Record<string, unknown> | null);
    assert.ok(sourceAfterInstall, "the registry retains a source for the installed connector");
    assert.equal(
      installed.manifest.source_declaration !== undefined,
      true,
      "the install record carries the verified declaration"
    );

    // Same-digest reuse: the registry keeps the source and the record keeps its sidecar digest.
    const reused = await first.service.install(SLUG, v1.entry.digest);
    assert.equal(reused.sourceDeclarationSha256, installed.sourceDeclarationSha256);
    assert.equal(
      retainedSourceId((await getConnectorManifest(SLUG)) as Record<string, unknown> | null),
      sourceAfterInstall
    );

    // Restart: a new store and a new service read the same record and republish the same source.
    const restarted = productionService(dataDir, [v1, v2]);
    const inspected = await inspectActiveConnector(restarted.store, SLUG);
    assert.equal(inspected.status, "active");
    await restarted.service.install(SLUG, v1.entry.digest);
    assert.equal(
      retainedSourceId((await getConnectorManifest(SLUG)) as Record<string, unknown> | null),
      sourceAfterInstall
    );

    // A new version whose declaration rebinds the retained source is refused by the registry, and the
    // previous install stays active with its own source.
    const rebinding = versionWith("1.2.0", OTHER_SOURCE);
    const third = productionService(dataDir, [v1, rebinding]);
    await assert.rejects(() => third.service.install(SLUG, rebinding.entry.digest), ALREADY_BOUND);
    const active = await third.store.getActive(SLUG);
    assert.equal(active?.digest, v1.entry.digest, "the previous install stays active");
    assert.equal(
      retainedSourceId((await getConnectorManifest(SLUG)) as Record<string, unknown> | null),
      sourceAfterInstall
    );

    // Tampered bytes while stopped: refused on read, and the registry keeps the verified source.
    writeFileSync(join(installed.root, "source-declaration.json"), '{"source":"tampered"}\n');
    const tampered = await inspectActiveConnector(createFileConnectorInstallStore(dataDir), SLUG);
    assert.equal(tampered.status, "invalid");
    assert.equal(
      retainedSourceId((await getConnectorManifest(SLUG)) as Record<string, unknown> | null),
      sourceAfterInstall
    );
  } finally {
    rmSync(dataDir, { force: true, recursive: true });
  }
}

test("SQLite: the verified declaration reaches the registry and survives reuse, restart and tamper", async () => {
  initDb(":memory:");
  try {
    await journey();
  } finally {
    closeDb();
  }
});

test("PostgreSQL: the verified declaration reaches the registry and survives reuse, restart and tamper (skipped: PDPP_TEST_POSTGRES_URL unset)", {
  skip: !process.env.PDPP_TEST_POSTGRES_URL,
}, async () => {
  const url = process.env.PDPP_TEST_POSTGRES_URL;
  assert.ok(url);
  await withTemporaryPostgresDatabase(
    {
      closeConnections: closePostgresStorage,
      connectionString: url,
      databaseName: `pdpp_test_install_registry_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 10)}_1`,
      templateName: null,
    },
    async (databaseUrl) => {
      initDb(":memory:");
      try {
        await initPostgresStorage({ backend: "postgres", databaseUrl });
        await journey();
      } finally {
        await closePostgresStorage();
        closeDb();
      }
    }
  );
});
