// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Moving a legacy-projected source identity to a published declaration.
 *
 * A connector registered before source declarations existed retains the reference implementation's
 * legacy projection, whose `source.id` is the connector's `manifest_uri`. When the installer verifies a
 * package that names itself with that same `manifest_uri` and declares a different source, the retained
 * identity moves to the declared one, and the grants, grant package members and pairwise handles that
 * name the old id move with it in the same transaction. Every other identity change stays refused.
 *
 * Runs on SQLite, and on PostgreSQL 18 when PDPP_TEST_POSTGRES_URL is set.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getConnectorManifest, registerConnector } from "../server/auth.ts";
import {
  type ConnectorCatalogEntry,
  createConnectorInstallService,
  createFileConnectorInstallStore,
} from "../server/connector-install/index.ts";
import { installedConnectorManifestRegistration } from "../server/connector-install/manifest-registration.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import { snapshotContentAddressedSourceDeclarationFromLegacyConnectorManifest } from "../server/source-declaration-legacy-collection.ts";
import { readCollectionProfileFixture } from "./helpers/installed-collection-profiles.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";

const KEY = "chatgpt";
const LEGACY_SOURCE = `https://registry.pdpp.dev/connectors/${KEY}`;
const DECLARED_SOURCE = `https://registry.pdpp.dev/sources/${KEY}`;
const OTHER_SOURCE = "https://sources.example/other/identity-move";
const UNRELATED_SOURCE = "https://registry.pdpp.dev/connectors/github";
const LEGACY_PUBLISHER = "https://pdpp.dev/reference-implementation";
const CONFIG_DIGEST = `sha256:${"e".repeat(64)}`;
const ALREADY_BOUND = /already bound to source/;
const SHARED = /also retains/;
const HANDLE_TAKEN = /pairwise handle is already issued/;

type Backend = "sqlite" | "postgres";

function profileFor(version: string, manifestUri = LEGACY_SOURCE): Record<string, unknown> {
  return {
    ...readCollectionProfileFixture("github"),
    connector_id: KEY,
    connector_key: KEY,
    manifest_uri: manifestUri,
    version,
  };
}

function declarationFor(profile: Record<string, unknown>, sourceId: string) {
  return snapshotContentAddressedSourceDeclarationFromLegacyConnectorManifest(profile, {
    connectorImplementationId: `https://implementations.example/connectors/${KEY}`,
    publisherId: "https://publishers.example/identity-move",
    sourceId,
  });
}

interface Version {
  readonly entry: ConnectorCatalogEntry;
  readonly profileBytes: string;
  readonly sidecar: string;
}

function versionWith(version: string, sourceId: string, manifestUri?: string): Version {
  const profile = profileFor(version, manifestUri);
  const profileBytes = JSON.stringify(profile, null, 2);
  return {
    entry: {
      config_digest: CONFIG_DIGEST,
      connector_id: KEY,
      connector_key: KEY,
      digest: `sha256:${createHash("sha256").update(profileBytes).digest("hex")}`,
      tier: "supported",
      version,
    },
    profileBytes,
    sidecar: JSON.stringify(declarationFor(profile, sourceId), null, 2),
  };
}

function serviceFor(dataDir: string, versions: readonly Version[]) {
  const store = createFileConnectorInstallStore(dataDir);
  const service = createConnectorInstallService({
    catalogLoader: async () => versions.map((version) => version.entry),
    dataDir,
    installArtifact: (root, entry) => {
      const version = versions.find((candidate) => candidate.entry.digest === entry.digest);
      if (!version) {
        throw new Error("no fixture version for the requested digest");
      }
      mkdirSync(join(root, "profile"), { recursive: true });
      mkdirSync(join(root, "dist"), { recursive: true });
      writeFileSync(join(root, "profile", "collection-profile.json"), version.profileBytes);
      writeFileSync(join(root, "dist", "collection-profile.mjs"), "export {};\n");
      writeFileSync(join(root, "provenance.json"), "{}\n");
      writeFileSync(join(root, "source-declaration.json"), version.sidecar);
    },
    registerManifest: (manifest, provenance) =>
      installedConnectorManifestRegistration.registerManifest(manifest, provenance),
    repairManifestDerivedState: installedConnectorManifestRegistration.repairManifestDerivedState,
    store,
  });
  return { service, store };
}

async function retained(): Promise<{ id: string | undefined; publisher: string | undefined }> {
  const stored = (await getConnectorManifest(KEY)) as {
    source_declaration?: { publisher?: { id?: string }; source?: { id?: string } };
  } | null;
  return { id: stored?.source_declaration?.source?.id, publisher: stored?.source_declaration?.publisher?.id };
}

const GRANT_LEGACY = "grt_identity_move_legacy";
const GRANT_UNRELATED = "grt_identity_move_unrelated";
const PACKAGE = "pkg_identity_move";
const ISSUED_AT = "2026-01-01T00:00:00.000Z";

function grantJson(grantId: string, sourceId: string): string {
  return JSON.stringify({
    access_mode: "read",
    client: { client_id: "client-move" },
    grant_id: grantId,
    issued_at: ISSUED_AT,
    source: { id: sourceId, kind: "connector" },
    streams: [{ name: "items" }],
    subject: { id: "owner" },
    version: "0.1.0",
  });
}

function memberJson(sourceId: string): string {
  return JSON.stringify({ connection_id: "cin_move", display_name: "ChatGPT", id: sourceId, kind: "connector" });
}

/** Rows that name the legacy source id, plus one grant that names another source and must not move. */
async function seedReferences(backend: Backend): Promise<void> {
  const grants: [string, string][] = [
    [GRANT_LEGACY, LEGACY_SOURCE],
    [GRANT_UNRELATED, UNRELATED_SOURCE],
  ];
  if (backend === "postgres") {
    for (const [grantId, sourceId] of grants) {
      await postgresQuery(
        `INSERT INTO grants(grant_id, subject_id, client_id, grant_json, access_mode, status, issued_at)
         VALUES($1, 'owner', 'client-move', $2::jsonb, 'read', 'active', $3)`,
        [grantId, grantJson(grantId, sourceId), ISSUED_AT]
      );
    }
    await postgresQuery(
      `INSERT INTO grant_packages(package_id, subject_id, client_id, status, package_json, created_at, approved_at)
       VALUES($1, 'owner', 'client-move', 'active', '{}'::jsonb, $2, $2)`,
      [PACKAGE, ISSUED_AT]
    );
    await postgresQuery(
      `INSERT INTO grant_package_members(package_id, grant_id, token_id, source_json, status, added_at)
       VALUES($1, $2, 'tok_move', $3::jsonb, 'active', $4)`,
      [PACKAGE, GRANT_LEGACY, memberJson(LEGACY_SOURCE), ISSUED_AT]
    );
    await postgresQuery(
      `INSERT INTO pairwise_identity_handles(issuer, subject_id, client_id, kind, source_id, internal_id, handle)
       VALUES('issuer-move', 'owner', 'client-move', 'grantor', $1, 'internal-move', 'handle-move')`,
      [LEGACY_SOURCE]
    );
    return;
  }
  const db = getDb();
  const insertGrant = db.prepare(
    `INSERT INTO grants(grant_id, subject_id, client_id, grant_json, access_mode, status, issued_at)
     VALUES(?, 'owner', 'client-move', ?, 'read', 'active', ?)`
  );
  for (const [grantId, sourceId] of grants) {
    insertGrant.run(grantId, grantJson(grantId, sourceId), ISSUED_AT);
  }
  db.prepare(
    `INSERT INTO grant_packages(package_id, subject_id, client_id, status, package_json, created_at, approved_at)
     VALUES(?, 'owner', 'client-move', 'active', '{}', ?, ?)`
  ).run(PACKAGE, ISSUED_AT, ISSUED_AT);
  db.prepare(
    `INSERT INTO grant_package_members(package_id, grant_id, token_id, source_json, status, added_at)
     VALUES(?, ?, 'tok_move', ?, 'active', ?)`
  ).run(PACKAGE, GRANT_LEGACY, memberJson(LEGACY_SOURCE), ISSUED_AT);
  db.prepare(
    `INSERT INTO pairwise_identity_handles(issuer, subject_id, client_id, kind, source_id, internal_id, handle)
     VALUES('issuer-move', 'owner', 'client-move', 'grantor', ?, 'internal-move', 'handle-move')`
  ).run(LEGACY_SOURCE);
}

interface References {
  readonly grant: string;
  readonly unrelatedGrant: string;
  readonly member: string;
  readonly handle: string;
}

async function readReferences(backend: Backend): Promise<References> {
  // SQLite returns JSON columns as text; PostgreSQL returns JSONB as parsed objects.
  const parsed = (json: unknown) => (typeof json === "string" ? JSON.parse(json) : json);
  const sourceOf = (json: unknown) => (parsed(json) as { source: { id: string } }).source.id;
  const memberIdOf = (json: unknown) => (parsed(json) as { id: string }).id;
  if (backend === "postgres") {
    const grants = await postgresQuery<{ grant_id: string; grant_json: unknown }>(
      "SELECT grant_id, grant_json FROM grants WHERE grant_id IN ($1, $2)",
      [GRANT_LEGACY, GRANT_UNRELATED]
    );
    const members = await postgresQuery<{ source_json: unknown }>(
      "SELECT source_json FROM grant_package_members WHERE package_id = $1",
      [PACKAGE]
    );
    const handles = await postgresQuery<{ source_id: string }>(
      "SELECT source_id FROM pairwise_identity_handles WHERE handle = 'handle-move'"
    );
    const byId = new Map(grants.rows.map((row) => [row.grant_id, sourceOf(row.grant_json)]));
    return {
      grant: byId.get(GRANT_LEGACY) ?? "",
      handle: handles.rows[0]?.source_id ?? "",
      member: memberIdOf(members.rows[0]?.source_json),
      unrelatedGrant: byId.get(GRANT_UNRELATED) ?? "",
    };
  }
  const db = getDb();
  const grantSource = (grantId: string) => {
    const row = db.prepare("SELECT grant_json FROM grants WHERE grant_id = ?").get(grantId) as { grant_json: string };
    return sourceOf(row.grant_json);
  };
  const member = db.prepare("SELECT source_json FROM grant_package_members WHERE package_id = ?").get(PACKAGE) as {
    source_json: string;
  };
  const handle = db.prepare("SELECT source_id FROM pairwise_identity_handles WHERE handle = 'handle-move'").get() as {
    source_id: string;
  };
  return {
    grant: grantSource(GRANT_LEGACY),
    handle: handle.source_id,
    member: memberIdOf(member.source_json),
    unrelatedGrant: grantSource(GRANT_UNRELATED),
  };
}

const UNMOVED: References = {
  grant: LEGACY_SOURCE,
  handle: LEGACY_SOURCE,
  member: LEGACY_SOURCE,
  unrelatedGrant: UNRELATED_SOURCE,
};

/** The connector as an instance registered it before declarations: the legacy projection of its manifest. */
async function seedLegacyConnector(backend: Backend): Promise<void> {
  await registerConnector({ ...profileFor("0.9.0"), legacy_source_ids: [LEGACY_SOURCE] });
  assert.deepEqual(await retained(), { id: LEGACY_SOURCE, publisher: LEGACY_PUBLISHER });
  await seedReferences(backend);
}

async function execute(backend: Backend, postgresSql: string, sqliteSql: string, params: string[]): Promise<void> {
  if (backend === "postgres") {
    await postgresQuery(postgresSql, params);
    return;
  }
  getDb().prepare(sqliteSql).run(...params);
}

async function withDataDir(run: (dataDir: string) => Promise<void>): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-identity-move-"));
  try {
    await run(dataDir);
  } finally {
    rmSync(dataDir, { force: true, recursive: true });
  }
}

const SCENARIOS: Array<{ name: string; run: (backend: Backend) => Promise<void> }> = [
  {
    name: "a matching declared legacy id moves retained data to the explicit current source",
    run: async (backend) => {
      await seedLegacyConnector(backend);
      await registerConnector({ ...profileFor("1.0.0"), source: { id: DECLARED_SOURCE }, legacy_source_ids: [LEGACY_SOURCE] });
      assert.equal((await retained()).id, DECLARED_SOURCE);
      assert.deepEqual(await readReferences(backend), { grant: DECLARED_SOURCE, handle: DECLARED_SOURCE, member: DECLARED_SOURCE, unrelatedGrant: UNRELATED_SOURCE });
      await assert.rejects(() => registerConnector({ ...profileFor("1.1.0"), source: { id: OTHER_SOURCE }, legacy_source_ids: [DECLARED_SOURCE] }), ALREADY_BOUND);
    },
  },
  {
    name: "a verified package moves the legacy projection and every reference to the declared source",
    run: (backend) =>
      withDataDir(async (dataDir) => {
        await seedLegacyConnector(backend);
        const declared = versionWith("1.0.0", DECLARED_SOURCE);
        const { service } = serviceFor(dataDir, [declared]);
        await service.install(KEY, declared.entry.digest);
        assert.equal((await retained()).id, DECLARED_SOURCE);
        assert.notEqual((await retained()).publisher, LEGACY_PUBLISHER);
        assert.deepEqual(await readReferences(backend), {
          grant: DECLARED_SOURCE,
          handle: DECLARED_SOURCE,
          member: DECLARED_SOURCE,
          unrelatedGrant: UNRELATED_SOURCE,
        });

        // Reinstalling the same package is not a second move.
        await service.install(KEY, declared.entry.digest);
        assert.equal((await retained()).id, DECLARED_SOURCE);

        // The moved identity is now a published declaration, so a later rebinding is refused.
        const rebinding = versionWith("1.1.0", OTHER_SOURCE);
        const later = serviceFor(dataDir, [declared, rebinding]);
        await assert.rejects(() => later.service.install(KEY, rebinding.entry.digest), ALREADY_BOUND);
        assert.equal((await retained()).id, DECLARED_SOURCE);
        assert.equal((await readReferences(backend)).grant, DECLARED_SOURCE);
      }),
  },
  {
    name: "a verified package that names a different implementation does not move the identity",
    run: (backend) =>
      withDataDir(async (dataDir) => {
        await seedLegacyConnector(backend);
        const foreign = versionWith("1.0.0", DECLARED_SOURCE, "https://implementations.example/connectors/elsewhere");
        const { service } = serviceFor(dataDir, [foreign]);
        await assert.rejects(() => service.install(KEY, foreign.entry.digest), ALREADY_BOUND);
        assert.deepEqual(await retained(), { id: LEGACY_SOURCE, publisher: LEGACY_PUBLISHER });
        assert.deepEqual(await readReferences(backend), UNMOVED);
      }),
  },
  {
    name: "a declaration that the installer did not verify does not move the identity",
    run: async (backend) => {
      await seedLegacyConnector(backend);
      const profile = profileFor("1.0.0");
      await assert.rejects(
        () => registerConnector({ ...profile, source_declaration: declarationFor(profile, DECLARED_SOURCE) }),
        ALREADY_BOUND
      );
      assert.deepEqual(await retained(), { id: LEGACY_SOURCE, publisher: LEGACY_PUBLISHER });
      assert.deepEqual(await readReferences(backend), UNMOVED);
    },
  },
  {
    name: "a legacy id that another connector also retains does not move",
    run: (backend) =>
      withDataDir(async (dataDir) => {
        await seedLegacyConnector(backend);
        await execute(
          backend,
          "INSERT INTO connectors(connector_id, manifest) SELECT 'chatgpt-copy', manifest FROM connectors WHERE connector_id = $1",
          "INSERT INTO connectors(connector_id, manifest) SELECT 'chatgpt-copy', manifest FROM connectors WHERE connector_id = ?",
          [KEY]
        );
        const declared = versionWith("1.0.0", DECLARED_SOURCE);
        const { service } = serviceFor(dataDir, [declared]);
        await assert.rejects(() => service.install(KEY, declared.entry.digest), SHARED);
        assert.deepEqual(await retained(), { id: LEGACY_SOURCE, publisher: LEGACY_PUBLISHER });
        assert.deepEqual(await readReferences(backend), UNMOVED);
      }),
  },
  {
    name: "a handle already issued under the declared id for the same instance stops the move",
    run: (backend) =>
      withDataDir(async (dataDir) => {
        await seedLegacyConnector(backend);
        await execute(
          backend,
          `INSERT INTO pairwise_identity_handles(issuer, subject_id, client_id, kind, source_id, internal_id, handle)
           VALUES('issuer-move', 'owner', 'client-move', 'grantor', $1, 'internal-move', 'handle-move-declared')`,
          `INSERT INTO pairwise_identity_handles(issuer, subject_id, client_id, kind, source_id, internal_id, handle)
           VALUES('issuer-move', 'owner', 'client-move', 'grantor', ?, 'internal-move', 'handle-move-declared')`,
          [DECLARED_SOURCE]
        );
        const declared = versionWith("1.0.0", DECLARED_SOURCE);
        const { service } = serviceFor(dataDir, [declared]);
        await assert.rejects(() => service.install(KEY, declared.entry.digest), HANDLE_TAKEN);
        assert.deepEqual(await retained(), { id: LEGACY_SOURCE, publisher: LEGACY_PUBLISHER });
        assert.deepEqual(await readReferences(backend), UNMOVED);
      }),
  },
];

for (const { name, run } of SCENARIOS) {
  test(`SQLite: ${name}`, async () => {
    initDb(":memory:");
    try {
      await run("sqlite");
    } finally {
      closeDb();
    }
  });

  test(`PostgreSQL: ${name} (skipped: PDPP_TEST_POSTGRES_URL unset)`, {
    skip: !process.env.PDPP_TEST_POSTGRES_URL,
  }, async () => {
    const url = process.env.PDPP_TEST_POSTGRES_URL;
    assert.ok(url);
    await withTemporaryPostgresDatabase(
      {
        closeConnections: closePostgresStorage,
        connectionString: url,
        databaseName: `pdpp_test_identity_move_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 10)}`,
        templateName: null,
      },
      async (databaseUrl) => {
        initDb(":memory:");
        try {
          await initPostgresStorage({ backend: "postgres", databaseUrl });
          await run("postgres");
        } finally {
          await closePostgresStorage();
          closeDb();
        }
      }
    );
  });
}
