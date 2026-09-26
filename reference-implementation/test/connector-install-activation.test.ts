// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ControllerError, createController, resolveActiveInstallFirstConnectorPath } from "../runtime/controller.ts";
import {
  __setRegisterConnectorPhaseHookForTest,
  getConnectorManifest,
  normalizeConnectorManifestForStorage,
  registerConnector,
} from "../server/auth.ts";
import {
  __setConnectorActivationPhaseHookForTest,
  canonicalActivationManifestRevision,
  getConnectorActivation,
} from "../server/connector-install/activation-authority.ts";
import {
  type ConnectorCatalogEntry,
  createConnectorInstallService,
  createConnectorInstallStore,
  repairPendingConnectorActivations,
  resolveActiveConnectorPath,
} from "../server/connector-install/index.ts";
import { createFileLocalConnectorSourceStore } from "../server/connector-install/local-source.ts";
import { closeDb, initDb } from "../server/db.ts";
import { closePostgresStorage, initPostgresStorage } from "../server/postgres-storage.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";

const firstDigest = `sha256:${"a".repeat(64)}`;
const secondDigest = `sha256:${"b".repeat(64)}`;
const configDigest = `sha256:${"c".repeat(64)}`;
const connectorId = "f1-activation";
const POST_PERSISTENCE_FAULT = /F1 fault after manifest persistence/;
const STAGED_REPAIR_FAULT = /F1 staged repair failure/;
const REVISION_CHANGED = /revision changed/i;
const ACTIVATION_FAULT = /F1 fault during activation/;
const PRIMARY_REGISTRATION_FAULT = /F1 primary registration failure/;
const first: ConnectorCatalogEntry = {
  config_digest: configDigest,
  connector_id: connectorId,
  connector_key: connectorId,
  digest: firstDigest,
  version: "1.0.0",
};
const second: ConnectorCatalogEntry = { ...first, digest: secondDigest, latest: true, version: "2.0.0" };

function writeFixture(root: string, version: string): void {
  mkdirSync(join(root, "profile"), { recursive: true });
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(
    join(root, "profile", "collection-profile.json"),
    JSON.stringify({
      capabilities: { human_interaction: [] },
      connector_id: connectorId,
      display_name: "F1 activation fixture",
      manifest_uri: `https://sources.example/${connectorId}`,
      protocol_version: "0.1.0",
      streams: [
        {
          name: "items",
          primary_key: ["id"],
          schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
          selection: { fields: true, resources: true },
          semantics: "append_only",
        },
      ],
      version,
    })
  );
  writeFileSync(join(root, "dist", "collection-profile.mjs"), `export const version = ${JSON.stringify(version)};\n`);
  writeFileSync(join(root, "provenance.json"), "{}\n");
}

async function assertPostPersistenceFailure(): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-f1-activation-"));
  const previousDataDir = process.env.PDPP_DATA_DIR;
  process.env.PDPP_DATA_DIR = dataDir;
  const store = createConnectorInstallStore();
  let current = first;
  try {
    const service = createConnectorInstallService({
      catalogLoader: async () => [current],
      dataDir,
      installArtifact: (root, selected) => writeFixture(root, selected.version ?? ""),
      registerManifest: (manifest, options) => registerConnector(manifest, options),
      store,
    });
    const original = await service.install(connectorId, firstDigest);
    current = second;
    __setRegisterConnectorPhaseHookForTest((point, context) => {
      if (point === "after-manifest-persisted" && (context.manifest as { version?: string }).version === "2.0.0") {
        return Promise.reject(new Error("F1 fault after manifest persistence"));
      }
      return Promise.resolve();
    });
    await assert.rejects(service.update(connectorId), POST_PERSISTENCE_FAULT);
    const registered = await getConnectorManifest(connectorId);
    const pending = await getConnectorActivation(connectorId);
    assert.equal(registered?.version, "2.0.0");
    assert.equal(pending?.state, "repair_required");
    assert.equal(pending?.record.digest, secondDigest);
    assert.equal(pending?.manifestRevision, canonicalActivationManifestRevision(registered ?? {}));
    assert.deepEqual(registered, normalizeConnectorManifestForStorage(pending?.record.manifest ?? {}).storedManifest);
    assert.equal(await store.getActive(connectorId), null);
    assert.equal(await resolveActiveConnectorPath(store, connectorId), null);
    __setRegisterConnectorPhaseHookForTest(null);
    assert.deepEqual(
      await repairPendingConnectorActivations((manifest, options) => registerConnector(manifest, options), dataDir),
      []
    );
    assert.equal((await getConnectorActivation(connectorId))?.state, "active");
    assert.equal((await store.getActive(connectorId))?.digest, secondDigest);
    assert.equal(
      await resolveActiveConnectorPath(store, connectorId),
      join(dataDir, "connectors", connectorId, secondDigest, "dist", "collection-profile.mjs")
    );
    assert.notEqual((await store.getActive(connectorId))?.root, original.root);
  } finally {
    __setRegisterConnectorPhaseHookForTest(null);
    if (previousDataDir === undefined) {
      delete process.env.PDPP_DATA_DIR;
    } else {
      process.env.PDPP_DATA_DIR = previousDataDir;
    }
    rmSync(dataDir, { force: true, recursive: true });
  }
}

async function assertRepairRequiredNeverRunsSeed(): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-f1-seed-fallback-"));
  const previousDataDir = process.env.PDPP_DATA_DIR;
  process.env.PDPP_DATA_DIR = dataDir;
  const seedManifest = JSON.parse(
    readFileSync(join(import.meta.dirname, "..", "fixtures", "seed-manifests", "github.json"), "utf8")
  );
  const initial = { ...first, connector_id: "github", connector_key: "github" };
  const replacement = { ...initial, digest: secondDigest, latest: true, version: seedManifest.version };
  let current = initial;
  const store = createConnectorInstallStore();
  try {
    const service = createConnectorInstallService({
      catalogLoader: async () => [current],
      dataDir,
      installArtifact(root, selected) {
        mkdirSync(join(root, "profile"), { recursive: true });
        mkdirSync(join(root, "dist"), { recursive: true });
        writeFileSync(
          join(root, "profile", "collection-profile.json"),
          JSON.stringify({ ...seedManifest, version: selected.version })
        );
        writeFileSync(join(root, "dist", "collection-profile.mjs"), "export {};\n");
        writeFileSync(join(root, "provenance.json"), "{}\n");
      },
      registerManifest: (manifest, options) => registerConnector(manifest, options),
      store,
    });
    await service.install("github", firstDigest);
    current = replacement;
    __setRegisterConnectorPhaseHookForTest(async (point) => {
      if (point === "after-manifest-persisted") {
        throw new Error("review negative: repair failed");
      }
    });
    await assert.rejects(service.update("github"), /review negative: repair failed/);
    __setRegisterConnectorPhaseHookForTest(null);
    assert.equal((await getConnectorActivation("github"))?.state, "repair_required");
    assert.equal(await resolveActiveConnectorPath(store, "github"), null);
    const manifest = await getConnectorManifest("github");
    assert.ok(manifest);
    await assert.rejects(
      resolveActiveInstallFirstConnectorPath(
        "github", manifest, undefined, createFileLocalConnectorSourceStore(dataDir), store
      ),
      /repair_required/
    );
    const controller = createController({
      admitRunConnection: async ({ connectorId, ownerSubjectId }) => ({
        connectorId,
        connectorInstanceId: "cin_seed_fallback",
        ownerSubjectId: ownerSubjectId ?? "owner_local",
      }),
      connectorPathResolver: () => join(import.meta.dirname, "..", "connectors", "seed", "index.ts"),
    });
    await assert.rejects(
      controller.runNow("github", { manifest }),
      (error: unknown) =>
        error instanceof ControllerError &&
        error.code === "connector_install_invalid" &&
        /repair_required.*operator must repair/.test(error.message)
    );
  } finally {
    __setRegisterConnectorPhaseHookForTest(null);
    if (previousDataDir === undefined) {
      delete process.env.PDPP_DATA_DIR;
    } else {
      process.env.PDPP_DATA_DIR = previousDataDir;
    }
    rmSync(dataDir, { force: true, recursive: true });
  }
}

async function assertFreshPolicyRevisionSurvivesStaleRepair(): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-f1-policy-"));
  const previousDataDir = process.env.PDPP_DATA_DIR;
  process.env.PDPP_DATA_DIR = dataDir;
  const store = createConnectorInstallStore();
  let current = first;
  try {
    const service = createConnectorInstallService({
      catalogLoader: async () => [current],
      dataDir,
      installArtifact: (root, selected) => writeFixture(root, selected.version ?? ""),
      registerManifest: (manifest, options) => registerConnector(manifest, options),
      store,
    });
    await service.install(connectorId, firstDigest);
    current = second;
    __setRegisterConnectorPhaseHookForTest((point) => {
      if (point === "after-manifest-persisted") {
        throw new Error("F1 staged repair failure");
      }
      return Promise.resolve();
    });
    await assert.rejects(service.update(connectorId), STAGED_REPAIR_FAULT);
    __setRegisterConnectorPhaseHookForTest(null);
    const pending = await getConnectorActivation(connectorId);
    assert.ok(pending);
    await registerConnector({ ...pending.record.manifest, version: "3.0.0" });
    const failures = await repairPendingConnectorActivations(
      (manifest, options) => registerConnector(manifest, options),
      dataDir
    );
    assert.equal(failures.length, 1);
    assert.match(String(failures[0]?.error), REVISION_CHANGED);
    assert.equal((await getConnectorManifest(connectorId))?.version, "3.0.0");
    assert.equal((await getConnectorActivation(connectorId))?.state, "repair_required");
    assert.equal(await store.getActive(connectorId), null);
  } finally {
    __setRegisterConnectorPhaseHookForTest(null);
    if (previousDataDir === undefined) {
      delete process.env.PDPP_DATA_DIR;
    } else {
      process.env.PDPP_DATA_DIR = previousDataDir;
    }
    rmSync(dataDir, { force: true, recursive: true });
  }
}

async function assertPublicationFailure(): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-f1-publication-"));
  const previousDataDir = process.env.PDPP_DATA_DIR;
  process.env.PDPP_DATA_DIR = dataDir;
  const store = createConnectorInstallStore();
  let current = first;
  try {
    const service = createConnectorInstallService({
      catalogLoader: async () => [current],
      dataDir,
      installArtifact: (root, selected) => writeFixture(root, selected.version ?? ""),
      registerManifest: (manifest, options) => registerConnector(manifest, options),
      store,
    });
    const original = await service.install(connectorId, firstDigest);
    current = second;
    __setConnectorActivationPhaseHookForTest((point) => {
      if (point === "before-publication-commit") {
        throw new Error("F1 fault during activation");
      }
    });
    await assert.rejects(service.update(connectorId), ACTIVATION_FAULT);
    assert.equal((await getConnectorManifest(connectorId))?.version, "1.0.0");
    assert.equal((await getConnectorActivation(connectorId))?.state, "active");
    assert.equal((await store.getActive(connectorId))?.digest, firstDigest);
    assert.equal(
      await resolveActiveConnectorPath(store, connectorId),
      join(original.root, "dist", "collection-profile.mjs")
    );
  } finally {
    __setConnectorActivationPhaseHookForTest(null);
    if (previousDataDir === undefined) {
      delete process.env.PDPP_DATA_DIR;
    } else {
      process.env.PDPP_DATA_DIR = previousDataDir;
    }
    rmSync(dataDir, { force: true, recursive: true });
  }
}

async function assertCompensationFailure(): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-f1-compensation-"));
  const previousDataDir = process.env.PDPP_DATA_DIR;
  process.env.PDPP_DATA_DIR = dataDir;
  const store = createConnectorInstallStore();
  let current = first;
  const previousConsoleError = console.error;
  const recorded: unknown[] = [];
  console.error = (...args: unknown[]) => recorded.push(args);
  try {
    const service = createConnectorInstallService({
      catalogLoader: async () => [current],
      dataDir,
      installArtifact: (root, selected) => writeFixture(root, selected.version ?? ""),
      registerManifest: (manifest, options) => registerConnector(manifest, options),
      store,
    });
    await service.install(connectorId, firstDigest);
    current = second;
    __setRegisterConnectorPhaseHookForTest((point) => {
      if (point === "after-manifest-persisted") {
        throw new Error("F1 primary registration failure");
      }
      return Promise.resolve();
    });
    __setConnectorActivationPhaseHookForTest((point) => {
      if (point === "before-repair-error-write") {
        throw new Error("F1 compensation failure");
      }
    });
    await assert.rejects(service.update(connectorId), PRIMARY_REGISTRATION_FAULT);
    assert.equal((await getConnectorActivation(connectorId))?.state, "repair_required");
    assert.equal(await store.getActive(connectorId), null);
    assert.equal(await resolveActiveConnectorPath(store, connectorId), null);
    assert.equal(
      (recorded[0] as [string, { compensationError: Error }])[1].compensationError.message,
      "F1 compensation failure"
    );
  } finally {
    __setRegisterConnectorPhaseHookForTest(null);
    __setConnectorActivationPhaseHookForTest(null);
    console.error = previousConsoleError;
    if (previousDataDir === undefined) {
      delete process.env.PDPP_DATA_DIR;
    } else {
      process.env.PDPP_DATA_DIR = previousDataDir;
    }
    rmSync(dataDir, { force: true, recursive: true });
  }
}

async function assertProcessRestart(postgresUrl?: string): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-f1-restart-"));
  const previousDataDir = process.env.PDPP_DATA_DIR;
  process.env.PDPP_DATA_DIR = dataDir;
  try {
    const child = spawnSync(
      process.execPath,
      ["--import", "tsx", join(import.meta.dirname, "fixtures", "connector-install-activation-child.ts")],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PDPP_F1_DATA_DIR: dataDir,
          ...(postgresUrl ? { PDPP_F1_PG_URL: postgresUrl } : {}),
        },
        timeout: 30_000,
      }
    );
    assert.equal(child.status, 77, child.stderr);
    if (!postgresUrl) {
      initDb(join(dataDir, "activation.sqlite"));
    }
    const store = createConnectorInstallStore();
    assert.equal((await getConnectorActivation(connectorId))?.state, "repair_required");
    assert.equal((await getConnectorManifest(connectorId))?.version, "2.0.0");
    assert.equal(await resolveActiveConnectorPath(store, connectorId), null);
    assert.deepEqual(
      await repairPendingConnectorActivations((manifest, options) => registerConnector(manifest, options), dataDir),
      []
    );
    assert.equal((await getConnectorActivation(connectorId))?.state, "active");
    assert.equal((await store.getActive(connectorId))?.digest, secondDigest);
    assert.equal(
      await resolveActiveConnectorPath(store, connectorId),
      join(dataDir, "connectors", connectorId, secondDigest, "dist", "collection-profile.mjs")
    );
  } finally {
    if (!postgresUrl) {
      closeDb();
    }
    if (previousDataDir === undefined) {
      delete process.env.PDPP_DATA_DIR;
    } else {
      process.env.PDPP_DATA_DIR = previousDataDir;
    }
    rmSync(dataDir, { force: true, recursive: true });
  }
}

async function assertUnpublishedRootRedownloads(): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-f1-unpublished-"));
  const previousDataDir = process.env.PDPP_DATA_DIR;
  process.env.PDPP_DATA_DIR = dataDir;
  const root = join(dataDir, "connectors", connectorId, firstDigest);
  writeFixture(root, "1.0.0");
  let downloaded = false;
  try {
    const service = createConnectorInstallService({
      catalogLoader: async () => [first],
      dataDir,
      installArtifact: (staged) => {
        downloaded = true;
        assert.equal(existsSync(root), false);
        writeFixture(staged, "1.0.0");
      },
      registerManifest: (manifest, options) => registerConnector(manifest, options),
      store: createConnectorInstallStore(),
    });
    await service.install(connectorId, firstDigest);
    assert.equal(downloaded, true);
    assert.equal((await getConnectorActivation(connectorId))?.state, "active");
  } finally {
    if (previousDataDir === undefined) {
      delete process.env.PDPP_DATA_DIR;
    } else {
      process.env.PDPP_DATA_DIR = previousDataDir;
    }
    rmSync(dataDir, { force: true, recursive: true });
  }
}

test("SQLite: post-persistence failure leaves one coherent activation", async () => {
  initDb(":memory:");
  try {
    await assertPostPersistenceFailure();
  } finally {
    closeDb();
  }
});

test("SQLite: repair-required activation cannot admit seed bytes", async () => {
  initDb(":memory:");
  try {
    await assertRepairRequiredNeverRunsSeed();
  } finally {
    closeDb();
  }
});

test("SQLite: activation transaction failure retains the old tuple", async () => {
  initDb(":memory:");
  try {
    await assertPublicationFailure();
  } finally {
    closeDb();
  }
});

test("SQLite: compensation failure preserves the primary error and repair state", async () => {
  initDb(":memory:");
  try {
    await assertCompensationFailure();
  } finally {
    closeDb();
  }
});

test("SQLite: process restart resumes a committed repair state", () => assertProcessRestart());

test("SQLite: unpublished root is redownloaded after a crash", async () => {
  initDb(":memory:");
  try {
    await assertUnpublishedRootRedownloads();
  } finally {
    closeDb();
  }
});

test("SQLite: stale repair cannot overwrite a newer policy revision", async () => {
  initDb(":memory:");
  try {
    await assertFreshPolicyRevisionSurvivesStaleRepair();
  } finally {
    closeDb();
  }
});

test("PostgreSQL: post-persistence failure leaves one coherent activation", {
  skip: !process.env.PDPP_TEST_POSTGRES_URL,
}, async () => {
  const url = process.env.PDPP_TEST_POSTGRES_URL;
  assert.ok(url);
  await withTemporaryPostgresDatabase(
    {
      closeConnections: closePostgresStorage,
      connectionString: url,
      databaseName: `pdpp_test_f1_activation_${Date.now().toString(36)}`,
      templateName: null,
    },
    async (databaseUrl) => {
      initDb(":memory:");
      try {
        await initPostgresStorage({ backend: "postgres", databaseUrl });
        await assertPostPersistenceFailure();
      } finally {
        await closePostgresStorage();
        closeDb();
      }
    }
  );
});

test("PostgreSQL: repair-required activation cannot admit seed bytes", {
  skip: !process.env.PDPP_TEST_POSTGRES_URL,
}, async () => {
  const url = process.env.PDPP_TEST_POSTGRES_URL;
  assert.ok(url);
  await withTemporaryPostgresDatabase(
    {
      closeConnections: closePostgresStorage,
      connectionString: url,
      databaseName: `pdpp_test_f1_seed_${Date.now().toString(36)}`,
      templateName: null,
    },
    async (databaseUrl) => {
      initDb(":memory:");
      try {
        await initPostgresStorage({ backend: "postgres", databaseUrl });
        await assertRepairRequiredNeverRunsSeed();
      } finally {
        await closePostgresStorage();
        closeDb();
      }
    }
  );
});

for (const [name, assertion] of [
  ["activation transaction failure retains the old tuple", assertPublicationFailure],
  ["compensation failure preserves the primary error and repair state", assertCompensationFailure],
] as const) {
  test(`PostgreSQL: ${name}`, { skip: !process.env.PDPP_TEST_POSTGRES_URL }, async () => {
    const url = process.env.PDPP_TEST_POSTGRES_URL;
    assert.ok(url);
    await withTemporaryPostgresDatabase(
      {
        closeConnections: closePostgresStorage,
        connectionString: url,
        databaseName: `pdpp_test_f1_fault_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 8)}`,
        templateName: null,
      },
      async (databaseUrl) => {
        initDb(":memory:");
        try {
          await initPostgresStorage({ backend: "postgres", databaseUrl });
          await assertion();
        } finally {
          await closePostgresStorage();
          closeDb();
        }
      }
    );
  });
}

test("PostgreSQL: process restart resumes a committed repair state", {
  skip: !process.env.PDPP_TEST_POSTGRES_URL,
}, async () => {
  const url = process.env.PDPP_TEST_POSTGRES_URL;
  assert.ok(url);
  await withTemporaryPostgresDatabase(
    {
      closeConnections: closePostgresStorage,
      connectionString: url,
      databaseName: `pdpp_test_f1_restart_${Date.now().toString(36)}`,
      templateName: null,
    },
    async (databaseUrl) => {
      initDb(":memory:");
      try {
        await initPostgresStorage({ backend: "postgres", databaseUrl });
        await assertProcessRestart(databaseUrl);
      } finally {
        await closePostgresStorage();
        closeDb();
      }
    }
  );
});

test("PostgreSQL: unpublished root is redownloaded after a crash", {
  skip: !process.env.PDPP_TEST_POSTGRES_URL,
}, async () => {
  const url = process.env.PDPP_TEST_POSTGRES_URL;
  assert.ok(url);
  await withTemporaryPostgresDatabase(
    {
      closeConnections: closePostgresStorage,
      connectionString: url,
      databaseName: `pdpp_test_f1_unpublished_${Date.now().toString(36)}`,
      templateName: null,
    },
    async (databaseUrl) => {
      initDb(":memory:");
      try {
        await initPostgresStorage({ backend: "postgres", databaseUrl });
        await assertUnpublishedRootRedownloads();
      } finally {
        await closePostgresStorage();
        closeDb();
      }
    }
  );
});

test("PostgreSQL: stale repair cannot overwrite a newer policy revision", {
  skip: !process.env.PDPP_TEST_POSTGRES_URL,
}, async () => {
  const url = process.env.PDPP_TEST_POSTGRES_URL;
  assert.ok(url);
  await withTemporaryPostgresDatabase(
    {
      closeConnections: closePostgresStorage,
      connectionString: url,
      databaseName: `pdpp_test_f1_policy_${Date.now().toString(36)}`,
      templateName: null,
    },
    async (databaseUrl) => {
      initDb(":memory:");
      try {
        await initPostgresStorage({ backend: "postgres", databaseUrl });
        await assertFreshPolicyRevisionSurvivesStaleRepair();
      } finally {
        await closePostgresStorage();
        closeDb();
      }
    }
  );
});
