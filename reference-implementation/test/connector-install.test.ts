// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";

import {
  type ConnectorCatalogEntry,
  createConfigLimitedFetch,
  createConnectorInstallStore,
  createConnectorInstallService,
  createFileConnectorInstallStore,
  inspectActiveConnector,
  normalizeCoreInstallLayout,
  reconcileConnectorUninstalls,
  resolveActiveConnectorPath,
} from "../server/connector-install/index.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { createSqliteConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";
import { createSqliteSchedulerStore } from "../server/stores/scheduler-store.ts";
import { writeConnectorUninstallJournal } from "../server/connector-uninstall-journal.ts";
import { mountOwnerConnectorInstall } from "../server/routes/owner-connector-install.ts";

const digest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const configDigest = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const RE_INTERRUPTED = /interrupted/;
const RE_ONE_MIB = /1 MiB/;
const RE_STATE_COMMIT_FAILED = /state commit failed/;
const RE_ROLLBACK = /rollback/;
const RE_INSTALL_IN_PROGRESS = /Another connector installation is in progress/;
const RE_SYMBOLIC_LINK = /symbolic-link/;
const RE_UPDATE_FAILED = /crashed while staging update/;
const RE_UPDATE_TARGET_MISSING = /no verified update target/;
const RE_REGISTRATION_FAILED = /manifest registration failed/;
const require = createRequire(import.meta.url);
const installerCorePath = require.resolve("@opendatalabs/data-connectors-tools/installer-core");
const { assertCatalog } = await import(
  pathToFileURL(join(dirname(installerCorePath), "catalog-schema.mjs")).href
);
const entry: ConnectorCatalogEntry = {
  bindings: { browser: "optional" },
  config_digest: configDigest,
  connector_id: "github",
  connector_key: "github",
  digest,
  tier: "supported",
  version: "1.0.0",
};

test("pinned catalog schema accepts binding features and rejects unknown binding fields", () => {
  const catalog = {
    catalog_version: "1.0",
    generated_at: "2026-09-30T12:00:00Z",
    source_commit: "a".repeat(40),
    connectors: [
      {
        connector_key: "github",
        connector_id: "https://github.com/PDP-Connect/data-connectors/connectors/github",
        display_name: "GitHub",
        tier: "supported",
        runtime_requirements: {
          bindings: {
            browser: { required: true, features: ["page_navigation", "page_content_read"] },
            network: { required: true, features: ["host_http_request", "same_origin_page_fetch"] },
          },
        },
        setup: { modality: "static_secret" },
        latest: { version: "1.0.0", digest },
        versions: [{ version: "1.0.0", digest }],
      },
    ],
  };

  assert.equal(assertCatalog(catalog), catalog);
  // Deliberately untyped: the point is a property the schema does not declare.
  const invalidCatalog = structuredClone(catalog) as unknown as {
    connectors: Array<{ runtime_requirements: { bindings: { browser: Record<string, unknown> } } }>;
  };
  const firstConnector = invalidCatalog.connectors[0];
  assert.ok(firstConnector);
  firstConnector.runtime_requirements.bindings.browser.unrecognized = true;
  assert.throws(() => assertCatalog(invalidCatalog), /must NOT have additional properties/);
});

test("PDPP_CONNECTOR_PRELOAD_DIR selects the file-backed install store", () => {
  const previous = process.env.PDPP_CONNECTOR_PRELOAD_DIR;
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-connector-preload-"));
  process.env.PDPP_CONNECTOR_PRELOAD_DIR = dataDir;
  try {
    assert.equal(createConnectorInstallStore().dataDir, dataDir);
  } finally {
    if (previous === undefined) {
      delete process.env.PDPP_CONNECTOR_PRELOAD_DIR;
    } else {
      process.env.PDPP_CONNECTOR_PRELOAD_DIR = previous;
    }
    rmSync(dataDir, { force: true, recursive: true });
  }
});

function writeFixture(root: string): void {
  mkdirSync(join(root, "profile"), { recursive: true });
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(
    join(root, "profile", "collection-profile.json"),
    JSON.stringify({ connector_id: "github", version: "1.0.0" })
  );
  writeFileSync(join(root, "dist", "collection-profile.mjs"), "export {};\n");
  writeFileSync(join(root, "provenance.json"), "{}\n");
}

test("installs into an immutable digest root and resolves the active verified entrypoint", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-connector-install-"));
  try {
    const service = createConnectorInstallService({
      catalogLoader: async () => [entry],
      dataDir,
      installArtifact: (root) => {
        writeFixture(root);
      },
      registerManifest: () => Promise.resolve(),
      store: createFileConnectorInstallStore(dataDir),
    });
    const active = await service.install("github", digest);
    assert.equal(active.digest, digest);
    assert.equal(
      await resolveActiveConnectorPath(createFileConnectorInstallStore(dataDir), "github"),
      join(active.root, "dist", "collection-profile.mjs")
    );
    assert.equal((await service.status())[0]?.tier, "supported");
  } finally {
    rmSync(dataDir, { force: true, recursive: true });
  }
});

test("uninstall removes the installed artifact and active record when no source uses it", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-connector-uninstall-"));
  closeDb();
  initDb(join(dataDir, "pdpp.sqlite"));
  const store = createFileConnectorInstallStore(dataDir);
  const service = createConnectorInstallService({
    assertUninstallAllowed: async () => {},
    catalogLoader: async () => [entry],
    dataDir,
    installArtifact: (root) => writeFixture(root),
    registerManifest: () => Promise.resolve(),
    removeActivation: () => Promise.resolve(),
    store,
  });
  try {
    const active = await service.install("github", digest);
    await service.uninstall("github");
    assert.equal(existsSync(active.root), false);
    assert.equal(await store.getActive("github"), null);
  } finally {
    closeDb();
    rmSync(dataDir, { force: true, recursive: true });
  }
});

test("uninstall refuses sources including revoked connections", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-connector-uninstall-in-use-"));
  closeDb();
  initDb(join(dataDir, "pdpp.sqlite"));
  const store = createFileConnectorInstallStore(dataDir);
  const service = createConnectorInstallService({
    assertUninstallAllowed: async () => {
      const error = new Error("Cannot uninstall github: 2 sources still use this connector.") as Error & {
        code: string;
      };
      error.code = "connector_in_use";
      throw error;
    },
    catalogLoader: async () => [entry],
    dataDir,
    installArtifact: (root) => writeFixture(root),
    registerManifest: () => Promise.resolve(),
    removeActivation: () => Promise.resolve(),
    store,
  });
  try {
    const active = await service.install("github", digest);
    await assert.rejects(service.uninstall("github"), /2 sources still use this connector/);
    assert.equal((await store.getActive("github"))?.digest, digest);
    assert.equal(existsSync(active.root), true);
  } finally {
    closeDb();
    rmSync(dataDir, { force: true, recursive: true });
  }
});

test("failed uninstall activation removal restores the installed artifact and record", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-connector-uninstall-fail-"));
  closeDb();
  initDb(join(dataDir, "pdpp.sqlite"));
  const store = createFileConnectorInstallStore(dataDir);
  const service = createConnectorInstallService({
    assertUninstallAllowed: async () => {},
    catalogLoader: async () => [entry],
    dataDir,
    installArtifact: (root) => writeFixture(root),
    registerManifest: () => Promise.resolve(),
    removeActivation: async () => {
      throw new Error("activation removal failed");
    },
    store,
  });
  try {
    const active = await service.install("github", digest);
    await assert.rejects(service.uninstall("github"), /activation removal failed/);
    assert.equal((await store.getActive("github"))?.digest, digest);
    assert.equal(existsSync(join(active.root, "dist", "collection-profile.mjs")), true);
  } finally {
    closeDb();
    rmSync(dataDir, { force: true, recursive: true });
  }
});

test("a rollback error is explicit and the original entrypoint remains runnable", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-connector-uninstall-rollback-error-"));
  closeDb();
  initDb(join(dataDir, "pdpp.sqlite"));
  const backingStore = createFileConnectorInstallStore(dataDir);
  let activationWrites = 0;
  const store = {
    ...backingStore,
    activate: async (record: Parameters<typeof backingStore.activate>[0]) => {
      await backingStore.activate(record);
      activationWrites += 1;
      if (activationWrites === 2) throw new Error("restore confirmation failed");
    },
  };
  const service = createConnectorInstallService({
    assertUninstallAllowed: async () => {},
    catalogLoader: async () => [entry],
    dataDir,
    installArtifact: (root) => writeFixture(root),
    registerManifest: () => Promise.resolve(),
    removeActivation: async () => {
      throw new Error("activation removal failed");
    },
    store,
  });
  try {
    const active = await service.install("github", digest);
    await assert.rejects(service.uninstall("github"), /rollback failed/);
    assert.equal(await resolveActiveConnectorPath(backingStore, "github"), join(active.root, active.entrypointPath));
  } finally {
    closeDb();
    rmSync(dataDir, { force: true, recursive: true });
  }
});

test("an atomic uninstall failure leaves the prior active pointer and entrypoint intact", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-connector-uninstall-atomic-failure-"));
  closeDb();
  initDb(join(dataDir, "pdpp.sqlite"));
  const backingStore = createFileConnectorInstallStore(dataDir);
  const store = {
    ...backingStore,
    activate: (record: Parameters<typeof backingStore.activate>[0]) => backingStore.activate(record),
    deactivateAndRemoveActivation: async () => {
      throw new Error("activation transaction failed");
    },
  };
  const service = createConnectorInstallService({
    assertUninstallAllowed: async () => {},
    catalogLoader: async () => [entry],
    dataDir,
    installArtifact: (root) => writeFixture(root),
    registerManifest: () => Promise.resolve(),
    removeActivation: async () => assert.fail("atomic store owns pointer removal"),
    store,
  });
  try {
    const active = await service.install("github", digest);
    await assert.rejects(service.uninstall("github"), /activation transaction failed/);
    assert.equal((await backingStore.getActive("github"))?.entrypointPath, active.entrypointPath);
    assert.equal(await resolveActiveConnectorPath(backingStore, "github"), join(active.root, active.entrypointPath));
    assert.equal(existsSync(join(active.root, "dist", "collection-profile.mjs")), true);
  } finally {
    closeDb();
    rmSync(dataDir, { force: true, recursive: true });
  }
});

test("startup recovery restores the original entrypoint at each root-move crash point", async () => {
  for (const { name, moveCount } of [
    { moveCount: 0, name: "before moves" },
    { moveCount: 1, name: "during moves" },
    { moveCount: Number.POSITIVE_INFINITY, name: "after moves" },
  ]) {
    const dataDir = mkdtempSync(join(tmpdir(), `pdpp-connector-uninstall-restart-${name.replace(/ /g, "-")}-`));
    closeDb();
    initDb(join(dataDir, "pdpp.sqlite"));
    const store = createFileConnectorInstallStore(dataDir);
    const service = createConnectorInstallService({
      catalogLoader: async () => [entry],
      dataDir,
      installArtifact: (root) => writeFixture(root),
      registerManifest: () => Promise.resolve(),
      store,
    });
    try {
      const active = await service.install("github", digest);
      const connectorDir = join(dataDir, "connectors", "github");
      const moves = readdirSync(connectorDir, { withFileTypes: true }).map((item, index) => ({
        moved: join(connectorDir, `.uninstall-restart-${index}`),
        original: join(connectorDir, item.name),
      }));
      writeConnectorUninstallJournal(dataDir, { connectorId: "github", priorActiveRecord: active, rootMoves: moves });
      for (const move of moves.slice(0, moveCount)) renameSync(move.original, move.moved);

      await reconcileConnectorUninstalls(dataDir, store, async () => {});

      assert.equal(await resolveActiveConnectorPath(store, "github"), join(active.root, active.entrypointPath), name);
      assert.equal(existsSync(join(active.root, active.entrypointPath)), true, name);
    } finally {
      closeDb();
      rmSync(dataDir, { force: true, recursive: true });
    }
  }
});

test("a second store handle cannot create a source while uninstall owns the database fence", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-connector-uninstall-fence-"));
  const previousDataDir = process.env.PDPP_DATA_DIR;
  const previousPreloadDir = process.env.PDPP_CONNECTOR_PRELOAD_DIR;
  process.env.PDPP_DATA_DIR = dataDir;
  delete process.env.PDPP_CONNECTOR_PRELOAD_DIR;
  initDb(join(dataDir, "pdpp.sqlite"));
  getDb()
    .prepare("INSERT INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)")
    .run("github", JSON.stringify({ connector_id: "github" }), new Date().toISOString());
  const instanceStore = createSqliteConnectorInstanceStore();
  const competingInstanceStore = createSqliteConnectorInstanceStore();
  let releaseCheck!: () => void;
  let checkStarted!: () => void;
  const started = new Promise<void>((resolve) => (checkStarted = resolve));
  const holdCheck = new Promise<void>((resolve) => (releaseCheck = resolve));
  let setupCompleted = false;
  const service = createConnectorInstallService({
    assertUninstallAllowed: async () => {
      checkStarted();
      await holdCheck;
    },
    catalogLoader: async () => [entry],
    dataDir,
    installArtifact: (root) => writeFixture(root),
    registerManifest: () => Promise.resolve(),
    removeActivation: async () => {
      return;
    },
    store: createFileConnectorInstallStore(dataDir),
  });
  try {
    await service.install("github", digest);
    const uninstalling = service.uninstall("github");
    await started;
    const now = new Date().toISOString();
    const settingUp = competingInstanceStore
      .upsertForEnrollment({
        connectorId: "github",
        connectorInstanceId: "source-1",
        createdAt: now,
        ownerSubjectId: "owner-1",
        sourceBinding: { account_hint: "owner" },
        sourceBindingKey: "owner",
        sourceKind: "account",
        updatedAt: now,
      })
      .then((created) => {
        setupCompleted = true;
        return created;
      });
    const setupRejected = assert.rejects(settingUp, /Connector lifecycle operation is busy|Connector is not installed/);
    const schedulerStore = createSqliteSchedulerStore();
    for (const trigger of ["scheduled", "recovery"] as const) {
      assert.throws(
        () =>
          schedulerStore.upsertActiveRun({
            connector_id: "github",
            connector_instance_id: `source-${trigger}`,
            run_generation: 1,
            run_id: `run-${trigger}`,
            scenario_id: "scenario-1",
            started_at: now,
            trace_id: `trace-${trigger}`,
          }),
        /Connector lifecycle operation is busy/
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(setupCompleted, false);
    assert.equal(await instanceStore.get("source-1"), null);
    releaseCheck();
    await uninstalling;
    await setupRejected;
    assert.equal(await instanceStore.get("source-1"), null);
  } finally {
    releaseCheck();
    closeDb();
    if (previousDataDir === undefined) delete process.env.PDPP_DATA_DIR;
    else process.env.PDPP_DATA_DIR = previousDataDir;
    if (previousPreloadDir === undefined) delete process.env.PDPP_CONNECTOR_PRELOAD_DIR;
    else process.env.PDPP_CONNECTOR_PRELOAD_DIR = previousPreloadDir;
    rmSync(dataDir, { force: true, recursive: true });
  }
});

test("a corrupted active entrypoint fails closed", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-connector-install-"));
  try {
    const service = createConnectorInstallService({
      catalogLoader: async () => [entry],
      dataDir,
      installArtifact: (root) => {
        writeFixture(root);
      },
      registerManifest: () => Promise.resolve(),
      store: createFileConnectorInstallStore(dataDir),
    });
    const active = await service.install("github", digest);
    writeFileSync(join(active.root, "dist", "collection-profile.mjs"), "tampered\n");
    assert.equal(await resolveActiveConnectorPath(createFileConnectorInstallStore(dataDir), "github"), null);
  } finally {
    rmSync(dataDir, { force: true, recursive: true });
  }
});

test("status skips a stale active record with missing bytes and reinstall repairs it", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-connector-install-"));
  try {
    const service = createConnectorInstallService({
      catalogLoader: async () => [entry],
      dataDir,
      installArtifact: (root) => {
        writeFixture(root);
      },
      registerManifest: () => Promise.resolve(),
      store: createFileConnectorInstallStore(dataDir),
    });
    const active = await service.install("github", digest);
    rmSync(active.root, { force: true, recursive: true });

    assert.deepEqual(await service.status(), []);
    assert.equal(await resolveActiveConnectorPath(createFileConnectorInstallStore(dataDir), "github"), null);

    const repaired = await service.install("github", digest);
    assert.equal(repaired.digest, digest);
    assert.equal((await service.status())[0]?.digest, digest);
    assert.equal(existsSync(join(repaired.root, "dist", "collection-profile.mjs")), true);
  } finally {
    rmSync(dataDir, { force: true, recursive: true });
  }
});

test("status skips a corrupt expected root and reinstall replaces it safely", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-connector-install-"));
  try {
    const service = createConnectorInstallService({
      catalogLoader: async () => [entry],
      dataDir,
      installArtifact: (root) => {
        writeFixture(root);
      },
      registerManifest: () => Promise.resolve(),
      store: createFileConnectorInstallStore(dataDir),
    });
    const active = await service.install("github", digest);
    writeFileSync(join(active.root, "dist", "collection-profile.mjs"), "tampered\n");

    assert.deepEqual(await service.status(), []);

    const repaired = await service.install("github", digest);
    assert.equal((await service.status())[0]?.digest, digest);
    assert.equal(readFileSync(join(repaired.root, "dist", "collection-profile.mjs"), "utf8"), "export {};\n");
  } finally {
    rmSync(dataDir, { force: true, recursive: true });
  }
});

test("reinstall refuses to replace a symlinked active digest root", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-connector-install-"));
  const outsideDir = mkdtempSync(join(tmpdir(), "pdpp-connector-outside-"));
  try {
    const service = createConnectorInstallService({
      catalogLoader: async () => [entry],
      dataDir,
      installArtifact: (root) => {
        writeFixture(root);
      },
      registerManifest: () => Promise.resolve(),
      store: createFileConnectorInstallStore(dataDir),
    });
    const active = await service.install("github", digest);
    rmSync(active.root, { force: true, recursive: true });
    symlinkSync(outsideDir, active.root, "dir");

    assert.deepEqual(await service.status(), []);
    await assert.rejects(() => service.install("github", digest), /already exists without a matching active record/);
    assert.deepEqual(readdirSync(outsideDir), []);
  } finally {
    rmSync(dataDir, { force: true, recursive: true });
    rmSync(outsideDir, { force: true, recursive: true });
  }
});

test("an active root outside the configured data directory is invalid", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-connector-install-"));
  const outsideDir = mkdtempSync(join(tmpdir(), "pdpp-connector-outside-"));
  try {
    const service = createConnectorInstallService({
      catalogLoader: async () => [entry],
      dataDir,
      installArtifact: (root) => {
        writeFixture(root);
      },
      registerManifest: () => Promise.resolve(),
      store: createFileConnectorInstallStore(dataDir),
    });
    const active = await service.install("github", digest);
    const statePath = join(dataDir, "connector-install-state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, Record<string, unknown>>;
    const { github } = state;
    assert.ok(github);
    github.root = join(outsideDir, "connectors", "github", digest);
    writeFileSync(statePath, JSON.stringify(state));
    assert.equal((await inspectActiveConnector(createFileConnectorInstallStore(dataDir), "github")).status, "invalid");
    assert.equal(await resolveActiveConnectorPath(createFileConnectorInstallStore(dataDir), "github"), null);
    assert.equal(active.connectorId, "github");
  } finally {
    rmSync(dataDir, { force: true, recursive: true });
    rmSync(outsideDir, { force: true, recursive: true });
  }
});

test("a symlinked active path component fails closed", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-connector-install-"));
  const outsideDir = mkdtempSync(join(tmpdir(), "pdpp-connector-outside-"));
  try {
    const service = createConnectorInstallService({
      catalogLoader: async () => [entry],
      dataDir,
      installArtifact: (root) => {
        writeFixture(root);
      },
      registerManifest: () => Promise.resolve(),
      store: createFileConnectorInstallStore(dataDir),
    });
    const active = await service.install("github", digest);
    mkdirSync(join(outsideDir, "dist"), { recursive: true });
    writeFileSync(join(outsideDir, "dist", "collection-profile.mjs"), "export {};\n");
    rmSync(join(active.root, "dist"), { force: true, recursive: true });
    symlinkSync(join(outsideDir, "dist"), join(active.root, "dist"), "dir");
    assert.equal((await inspectActiveConnector(createFileConnectorInstallStore(dataDir), "github")).status, "invalid");
  } finally {
    rmSync(dataDir, { force: true, recursive: true });
    rmSync(outsideDir, { force: true, recursive: true });
  }
});

test("a symlinked connectors parent is refused before publication", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-connector-install-"));
  const outsideDir = mkdtempSync(join(tmpdir(), "pdpp-connector-outside-"));
  try {
    symlinkSync(outsideDir, join(dataDir, "connectors"), "dir");
    const service = createConnectorInstallService({
      catalogLoader: async () => [entry],
      dataDir,
      installArtifact: (root) => {
        writeFixture(root);
      },
      registerManifest: () => Promise.resolve(),
      store: createFileConnectorInstallStore(dataDir),
    });
    await assert.rejects(() => service.install("github", digest), RE_SYMBOLIC_LINK);
    assert.deepEqual(await service.status(), []);
    assert.deepEqual(readdirSync(outsideDir), []);
  } finally {
    rmSync(dataDir, { force: true, recursive: true });
    rmSync(outsideDir, { force: true, recursive: true });
  }
});

test("a failed stage leaves no active root or state", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-connector-install-"));
  try {
    const service = createConnectorInstallService({
      catalogLoader: async () => [entry],
      dataDir,
      installArtifact: () => {
        throw new Error("interrupted");
      },
      registerManifest: () => Promise.resolve(),
      store: createFileConnectorInstallStore(dataDir),
    });
    await assert.rejects(() => service.install("github", digest), RE_INTERRUPTED);
    assert.deepEqual(await service.status(), []);
  } finally {
    rmSync(dataDir, { force: true, recursive: true });
  }
});

test("an oversized materialized profile cannot be activated", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-connector-install-"));
  try {
    const service = createConnectorInstallService({
      catalogLoader: async () => [entry],
      dataDir,
      installArtifact: (root) => {
        writeFixture(root);
        writeFileSync(join(root, "profile", "collection-profile.json"), "x".repeat(1024 * 1024 + 1));
      },
      registerManifest: () => Promise.resolve(),
      store: createFileConnectorInstallStore(dataDir),
    });
    await assert.rejects(() => service.install("github", digest), RE_ONE_MIB);
    assert.deepEqual(await service.status(), []);
  } finally {
    rmSync(dataDir, { force: true, recursive: true });
  }
});

test("a failed active-state commit removes the newly published root", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-connector-install-"));
  const baseStore = createFileConnectorInstallStore(dataDir);
  try {
    const service = createConnectorInstallService({
      catalogLoader: async () => [entry],
      dataDir,
      installArtifact: (root) => {
        writeFixture(root);
      },
      registerManifest: () => Promise.resolve(),
      store: {
        ...baseStore,
        activate: () => {
          throw new Error("state commit failed");
        },
      },
    });
    await assert.rejects(() => service.install("github", digest), RE_STATE_COMMIT_FAILED);
    assert.equal(existsSync(join(dataDir, "connectors", "github", digest)), false);
    assert.deepEqual(await baseStore.listActive(), []);
  } finally {
    rmSync(dataDir, { force: true, recursive: true });
  }
});

test("a pre-existing digest root without active state is discarded before reinstall", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-connector-install-"));
  try {
    mkdirSync(join(dataDir, "connectors", "github", digest), { recursive: true });
    let called = false;
    const service = createConnectorInstallService({
      catalogLoader: async () => [entry],
      dataDir,
      installArtifact: (root) => {
        called = true;
        writeFixture(root);
      },
      registerManifest: () => Promise.resolve(),
      store: createFileConnectorInstallStore(dataDir),
    });
    await service.install("github", digest);
    assert.equal(called, true);
    assert.equal((await service.status())[0]?.digest, digest);
  } finally {
    rmSync(dataDir, { force: true, recursive: true });
  }
});

test("catalog high-water persists generated_at across service restarts", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-connector-install-"));
  const store = createFileConnectorInstallStore(dataDir);
  try {
    const first = createConnectorInstallService({
      catalogLoader: async () => ({ entries: [entry], generatedAt: "2026-09-16T12:00:00Z" }),
      dataDir,
      registerManifest: () => Promise.resolve(),
      store,
    });
    await first.catalog();
    assert.equal(await store.getCatalogHighWater(), "2026-09-16T12:00:00Z");
    const older = createConnectorInstallService({
      catalogLoader: async () => ({ entries: [entry], generatedAt: "2026-09-16T11:00:00Z" }),
      dataDir,
      registerManifest: () => Promise.resolve(),
      store: createFileConnectorInstallStore(dataDir),
    });
    await assert.rejects(() => older.catalog(), RE_ROLLBACK);
    const equal = createConnectorInstallService({
      catalogLoader: async () => ({ entries: [entry], generatedAt: "2026-09-16T12:00:00Z" }),
      dataDir,
      registerManifest: () => Promise.resolve(),
      store: createFileConnectorInstallStore(dataDir),
    });
    assert.equal((await equal.catalog())[0]?.digest, digest);
  } finally {
    rmSync(dataDir, { force: true, recursive: true });
  }
});

test("update refuses a catalog without an explicit latest target", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-connector-install-"));
  try {
    const service = createConnectorInstallService({
      catalogLoader: async () => [entry],
      dataDir,
      registerManifest: () => Promise.resolve(),
      store: createFileConnectorInstallStore(dataDir),
    });
    await assert.rejects(() => service.update("github"), RE_UPDATE_TARGET_MISSING);
  } finally {
    rmSync(dataDir, { force: true, recursive: true });
  }
});

test("concurrent installs are serialized by the process-safe lock", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-connector-install-"));
  let enteredResolve: (() => void) | undefined;
  let releaseStage: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => {
    enteredResolve = resolve;
  });
  const stageReleased = new Promise<void>((resolve) => {
    releaseStage = resolve;
  });
  try {
    const service = createConnectorInstallService({
      catalogLoader: async () => [entry],
      dataDir,
      installArtifact: async (root) => {
        enteredResolve?.();
        await stageReleased;
        writeFixture(root);
      },
      registerManifest: () => Promise.resolve(),
      store: createFileConnectorInstallStore(dataDir),
    });
    const first = service.install("github", digest);
    await entered;
    await assert.rejects(() => service.install("github", digest), RE_INSTALL_IN_PROGRESS);
    releaseStage?.();
    await first;
  } finally {
    rmSync(dataDir, { force: true, recursive: true });
  }
});

test("catalog remains readable while an install holds the install lock", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-connector-install-"));
  let enteredResolve: (() => void) | undefined;
  let releaseStage: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => {
    enteredResolve = resolve;
  });
  const stageReleased = new Promise<void>((resolve) => {
    releaseStage = resolve;
  });
  try {
    const service = createConnectorInstallService({
      catalogLoader: async () => ({ entries: [entry], generatedAt: "2026-09-24T00:00:00.000Z" }),
      dataDir,
      installArtifact: async (root) => {
        enteredResolve?.();
        await stageReleased;
        writeFixture(root);
      },
      registerManifest: () => Promise.resolve(),
      store: createFileConnectorInstallStore(dataDir),
    });
    const installing = service.install("github", digest);
    await entered;

    assert.equal((await service.catalog())[0]?.digest, digest);

    releaseStage?.();
    await installing;
  } finally {
    releaseStage?.();
    rmSync(dataDir, { force: true, recursive: true });
  }
});

test("concurrent catalog reads share one in-flight refresh", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-connector-install-"));
  let enteredResolve: (() => void) | undefined;
  let releaseRefresh: (() => void) | undefined;
  let loadCount = 0;
  const entered = new Promise<void>((resolve) => {
    enteredResolve = resolve;
  });
  const refreshReleased = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  try {
    const service = createConnectorInstallService({
      catalogLoader: async () => {
        loadCount += 1;
        enteredResolve?.();
        await refreshReleased;
        return [entry];
      },
      dataDir,
      registerManifest: () => Promise.resolve(),
      store: createFileConnectorInstallStore(dataDir),
    });
    const first = service.catalog();
    await entered;
    const second = service.catalog();

    releaseRefresh?.();
    const [firstEntries, secondEntries] = await Promise.all([first, second]);

    assert.equal(loadCount, 1);
    assert.deepEqual(secondEntries, firstEntries);
    assert.equal(firstEntries[0]?.digest, digest);
  } finally {
    releaseRefresh?.();
    rmSync(dataDir, { force: true, recursive: true });
  }
});

test("the RI transport bounds signed config and profile blobs", async () => {
  const profileDigest = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
  let oversized = false;
  const limited = createConfigLimitedFetch((input) => {
    const url = String(input);
    if (url.includes("/manifests/")) {
      return Response.json({
        config: { digest: configDigest },
        layers: [{ digest: profileDigest, mediaType: "application/vnd.pdpp.connector.profile.v1+json" }],
      });
    }
    oversized = true;
    return new Response("x".repeat(1024 * 1024 + 1), {
      headers: { "content-length": String(1024 * 1024 + 1) },
    });
  });
  const manifest = await limited.fetchImpl(`https://ghcr.io/v2/pdp-connect/connector/github/manifests/${digest}`);
  assert.equal(manifest.ok, true);
  assert.equal(manifest.status, 200);
  assert.equal(manifest.headers.get("content-type"), "application/json");
  await manifest.arrayBuffer();
  await assert.rejects(
    () => limited.fetchImpl(`https://ghcr.io/v2/pdp-connect/connector/github/blobs/${configDigest}`),
    RE_ONE_MIB
  );
  assert.equal(oversized, true);
});

test("normalizes the pinned core collection-profiles layout before verification", () => {
  const root = mkdtempSync(join(tmpdir(), "pdpp-connector-install-layout-"));
  const verifiedSourceDeclaration = Buffer.from('{"source":"verified"}\n');
  try {
    writeFixture(join(root, "collection-profiles", "github"));
    mkdirSync(join(root, "collection-profiles", "github", "licenses"), { recursive: true });
    mkdirSync(join(root, "collection-profiles", "github", "assets"), { recursive: true });
    writeFileSync(join(root, "collection-profiles", "github", "source-declaration.json"), verifiedSourceDeclaration);
    writeFileSync(join(root, "collection-profiles", "github", "licenses", "NOTICE"), "notice");
    writeFileSync(join(root, "collection-profiles", "github", "assets", "icon.svg"), "<svg />");
    normalizeCoreInstallLayout(root, "github", verifiedSourceDeclaration);
    assert.equal(existsSync(join(root, "profile", "collection-profile.json")), true);
    assert.equal(existsSync(join(root, "dist", "collection-profile.mjs")), true);
    assert.deepEqual(readFileSync(join(root, "source-declaration.json")), verifiedSourceDeclaration);
    assert.equal(existsSync(join(root, "licenses", "NOTICE")), true);
    assert.equal(existsSync(join(root, "assets", "icon.svg")), true);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("normalization rejects a staged tree without the verified source declaration", () => {
  const root = mkdtempSync(join(tmpdir(), "pdpp-connector-install-layout-missing-declaration-"));
  try {
    writeFixture(join(root, "collection-profiles", "github"));
    assert.throws(
      () => normalizeCoreInstallLayout(root, "github", Buffer.from('{"source":"verified"}\n')),
      /incomplete collection-profile layout/
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("normalization rejects source declaration bytes different from installer-core verification", () => {
  const root = mkdtempSync(join(tmpdir(), "pdpp-connector-install-layout-mismatched-declaration-"));
  const verifiedSourceDeclaration = Buffer.from('{"source":"verified"}\n');
  try {
    writeFixture(join(root, "collection-profiles", "github"));
    writeFileSync(join(root, "collection-profiles", "github", "source-declaration.json"), '{"source":"changed"}\n');
    assert.throws(
      () => normalizeCoreInstallLayout(root, "github", verifiedSourceDeclaration),
      /does not match installer-core verification/
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("a failed update retains the previously active digest root", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-connector-install-"));
  const next = {
    ...entry,
    config_digest: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    digest: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    latest: true,
    version: "2.0.0",
  };
  let current = entry;
  try {
    const service = createConnectorInstallService({
      catalogLoader: async () => [current],
      dataDir,
      installArtifact: (root, candidate) => {
        if (candidate.digest === next.digest) {
          throw new Error("crashed while staging update");
        }
        writeFixture(root);
      },
      registerManifest: () => Promise.resolve(),
      store: createFileConnectorInstallStore(dataDir),
    });
    const previous = await service.install("github", digest);
    current = next;
    await assert.rejects(() => service.update("github"), RE_UPDATE_FAILED);
    assert.equal((await service.status())[0]?.digest, previous.digest);
    assert.equal(
      await resolveActiveConnectorPath(createFileConnectorInstallStore(dataDir), "github"),
      join(previous.root, "dist", "collection-profile.mjs")
    );
  } finally {
    rmSync(dataDir, { force: true, recursive: true });
  }
});

test("selecting a retained digest root does not redownload or delete it", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-connector-install-"));
  const retained = entry;
  const next = {
    ...entry,
    config_digest: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    digest: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    latest: true,
    version: "2.0.0",
  };
  let current = retained;
  let rejectRetainedDownload = false;
  try {
    const service = createConnectorInstallService({
      catalogLoader: async () => [current],
      dataDir,
      installArtifact: (root, candidate) => {
        if (rejectRetainedDownload && candidate.digest === retained.digest) {
          throw new Error("retained digest must be reused without redownload");
        }
        writeFixture(root);
      },
      registerManifest: () => Promise.resolve(),
      store: createFileConnectorInstallStore(dataDir),
    });
    const first = await service.install("github", retained.digest);
    current = next;
    const second = await service.update("github");
    assert.equal(existsSync(join(first.root, "dist", "collection-profile.mjs")), true);
    assert.equal(second.digest, next.digest);

    current = retained;
    rejectRetainedDownload = true;
    const restored = await service.install("github", retained.digest);

    assert.equal(restored.digest, retained.digest);
    assert.equal(existsSync(join(first.root, "dist", "collection-profile.mjs")), true);
    assert.equal(
      await resolveActiveConnectorPath(createFileConnectorInstallStore(dataDir), "github"),
      join(first.root, "dist", "collection-profile.mjs")
    );
  } finally {
    rmSync(dataDir, { force: true, recursive: true });
  }
});

test("a retained digest registration failure keeps the current active root", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-connector-install-"));
  const retained = entry;
  const next = {
    ...entry,
    config_digest: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    digest: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    latest: true,
    version: "2.0.0",
  };
  let current = retained;
  let registrationCount = 0;
  try {
    const service = createConnectorInstallService({
      catalogLoader: async () => [current],
      dataDir,
      installArtifact: (root) => {
        writeFixture(root);
      },
      registerManifest: () => {
        registrationCount += 1;
        return registrationCount === 3 ? Promise.reject(new Error("manifest registration failed")) : Promise.resolve();
      },
      store: createFileConnectorInstallStore(dataDir),
    });
    await service.install("github", retained.digest);
    current = next;
    const active = await service.update("github");
    current = retained;

    await assert.rejects(() => service.install("github", retained.digest), RE_REGISTRATION_FAILED);

    assert.equal((await service.status())[0]?.digest, active.digest);
    assert.equal(
      await resolveActiveConnectorPath(createFileConnectorInstallStore(dataDir), "github"),
      join(active.root, "dist", "collection-profile.mjs")
    );
  } finally {
    rmSync(dataDir, { force: true, recursive: true });
  }
});

test("a post-publication registration failure restores the previous active root", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-connector-install-"));
  const next = {
    ...entry,
    config_digest: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    digest: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    latest: true,
    version: "2.0.0",
  };
  let current = entry;
  let registrationCount = 0;
  try {
    const service = createConnectorInstallService({
      catalogLoader: async () => [current],
      dataDir,
      installArtifact: (root) => {
        writeFixture(root);
      },
      registerManifest: () => {
        registrationCount += 1;
        return registrationCount === 2 ? Promise.reject(new Error("manifest registration failed")) : Promise.resolve();
      },
      store: createFileConnectorInstallStore(dataDir),
    });
    const previous = await service.install("github", digest);
    current = next;
    await assert.rejects(() => service.update("github"), RE_REGISTRATION_FAILED);
    assert.equal((await service.status())[0]?.digest, previous.digest);
    assert.equal(existsSync(join(dataDir, "connectors", "github", next.digest)), false);
  } finally {
    rmSync(dataDir, { force: true, recursive: true });
  }
});

test("owner install route rejects missing installation fields", async () => {
  type RegisteredHandler = (
    req: { body?: Record<string, unknown> },
    res: {
      json: (value: unknown) => unknown;
      status: (value: number) => unknown;
    }
  ) => Promise<void>;
  const routes = new Map<string, RegisteredHandler>();
  const registrations = new Map<string, unknown[]>();
  const app = {
    get(path: string, ...args: unknown[]) {
      registrations.set(`GET ${path}`, args);
      routes.set(`GET ${path}`, args.at(-1) as RegisteredHandler);
      return this;
    },
    post(path: string, ...args: unknown[]) {
      registrations.set(`POST ${path}`, args);
      routes.set(`POST ${path}`, args.at(-1) as RegisteredHandler);
      return this;
    },
  };
  const tokenGuard = () => undefined;
  const ownerGuard = () => undefined;
  mountOwnerConnectorInstall(app as never, {
    handleError: () => assert.fail("unexpected error"),
    pdppError: (_res, statusCode, code, message, param) => {
      status = statusCode;
      body = { code, message, param };
    },
    requireOwner: ownerGuard,
    requireToken: tokenGuard,
    service: {
      catalog: async () => [],
      install: async () => assert.fail("should not install"),
      uninstall: async () => assert.fail("should not uninstall"),
      status: async () => [],
      update: async () => assert.fail("should not update"),
    },
  });
  let status = 200;
  let body: unknown;
  await routes.get("POST /v1/owner/connector-install/install")?.(
    { body: {} },
    {
      json(value: unknown) {
        body = value;
        return this;
      },
      status(value: number) {
        status = value;
        return this;
      },
    }
  );
  assert.equal(status, 400);
  assert.deepEqual(body, { code: "invalid_request", message: "connector_id is required", param: "connector_id" });
  assert.equal(registrations.get("POST /v1/owner/connector-install/install")?.[0], tokenGuard);
  assert.equal(registrations.get("POST /v1/owner/connector-install/install")?.[1], ownerGuard);
});

test("owner uninstall route calls the service and returns the completed action", async () => {
  type RegisteredHandler = (
    req: { body?: Record<string, unknown> },
    res: { json: (body: unknown) => unknown; status: (code: number) => unknown }
  ) => Promise<void>;
  let handler: RegisteredHandler | undefined;
  let calledWith: string | undefined;
  const app = {
    get() {
      return this;
    },
    post(path: string, ...args: unknown[]) {
      if (path.endsWith("/uninstall")) handler = args.at(-1) as RegisteredHandler;
      return this;
    },
  };
  mountOwnerConnectorInstall(app as never, {
    handleError: (_res, error) => assert.fail(String(error)),
    pdppError: (_res, status, code) => assert.fail(`${status} ${code}`),
    requireOwner: () => undefined,
    requireToken: () => undefined,
    service: {
      catalog: async () => [],
      install: async () => assert.fail("unexpected install"),
      uninstall: async (connectorId) => {
        calledWith = connectorId;
      },
      status: async () => [],
      update: async () => assert.fail("unexpected update"),
    },
  });
  let body: unknown;
  assert.ok(handler);
  await handler(
    { body: { connector_key: "github" } },
    {
      json(value) {
        body = value;
        return this;
      },
      status() {
        return this;
      },
    }
  );
  assert.equal(calledWith, "github");
  assert.deepEqual(body, { data: { connector_key: "github", uninstalled: true }, object: "connector_uninstall" });
});

test("owner uninstall route returns the source count refusal", async () => {
  type RegisteredHandler = (
    req: { body?: Record<string, unknown> },
    res: { json: (body: unknown) => unknown; status: (code: number) => unknown }
  ) => Promise<void>;
  let handler: RegisteredHandler | undefined;
  let seenError: unknown;
  const app = {
    get() {
      return this;
    },
    post(path: string, ...args: unknown[]) {
      if (path.endsWith("/uninstall")) handler = args.at(-1) as RegisteredHandler;
      return this;
    },
  };
  mountOwnerConnectorInstall(app as never, {
    handleError: (_res, error) => {
      seenError = error;
    },
    pdppError: (_res, status, code) => assert.fail(`${status} ${code}`),
    requireOwner: () => undefined,
    requireToken: () => undefined,
    service: {
      catalog: async () => [],
      install: async () => assert.fail("unexpected install"),
      uninstall: async () => {
        throw Object.assign(new Error("Cannot uninstall github: 3 sources still use this connector."), {
          code: "connector_in_use",
          connection_ids: ["source-1", "source-2", "source-3"],
        });
      },
      status: async () => [],
      update: async () => assert.fail("unexpected update"),
    },
  });
  assert.ok(handler);
  await handler(
    { body: { connector_key: "github" } },
    {
      json() {
        return this;
      },
      status() {
        return this;
      },
    }
  );
  assert.equal((seenError as { code: string }).code, "connector_in_use");
  assert.match((seenError as Error).message, /3 sources still use this connector/);
});

test("owner catalog route returns the verified catalog projection", async () => {
  type RegisteredHandler = (req: Record<string, never>, res: { json: (value: unknown) => unknown }) => Promise<void>;
  const routes = new Map<string, RegisteredHandler>();
  const app = {
    get(path: string, ...args: unknown[]) {
      routes.set(`GET ${path}`, args.at(-1) as RegisteredHandler);
      return this;
    },
    post() {
      return this;
    },
  };
  mountOwnerConnectorInstall(app as never, {
    handleError: () => assert.fail("unexpected error"),
    pdppError: () => assert.fail("unexpected error"),
    requireOwner: () => undefined,
    requireToken: () => undefined,
    service: {
      catalog: async () => [
        {
          ...entry,
          display_name: "GitHub",
          latest: true,
          published_at: "2026-09-16T12:00:00Z",
          setup_modality: "oauth",
        },
      ],
      install: async () => assert.fail("should not install"),
      uninstall: async () => assert.fail("should not uninstall"),
      status: async () => [],
      update: async () => assert.fail("should not update"),
    },
  });
  let body: unknown;
  await routes.get("GET /v1/owner/connector-install/catalog")?.(
    {},
    {
      json(value: unknown) {
        body = value;
        return this;
      },
    }
  );
  assert.deepEqual(body, {
    data: [
      {
        bindings: { browser: "optional" },
        connector_id: "github",
        connector_key: "github",
        digest,
        display_name: "GitHub",
        latest: true,
        published_at: "2026-09-16T12:00:00Z",
        setup_modality: "oauth",
        tier: "supported",
        version: "1.0.0",
      },
    ],
    object: "connector_install_catalog",
  });
});
