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
  utimesSync,
  writeFileSync,
} from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";

import {
  type ConnectorCatalogEntry,
  ConnectorInstallTimeoutError,
  createConfigLimitedFetch,
  createConnectorInstallStore,
  createConnectorInstallService,
  createFileConnectorInstallStore,
  inspectActiveConnector,
  normalizeCoreInstallLayout,
  reconcileConnectorUninstalls,
  resolveActiveConnectorPath,
} from "../server/connector-install/index.ts";
import { acquireDirectoryLock } from "../server/connector-install/directory-lock.ts";
import { withConnectorLifecycleLock, withConnectorLifecycleLockSync } from "../server/connector-lifecycle-lock.ts";
import {
  createFileLocalConnectorSourceStore,
  inspectActiveLocalConnectorSource,
} from "../server/connector-install/local-source.ts";
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
const RE_INSTALL_PAST_DEADLINE = /exceeded its deadline at .* and has not stopped/;
const RE_DERIVED_REPAIR_FAILED = /derived repair failed/;
const RE_SYMBOLIC_LINK = /symbolic-link/;
const RE_UPDATE_FAILED = /crashed while staging update/;
const RE_UPDATE_TARGET_MISSING = /no verified update target/;
const RE_REGISTRATION_FAILED = /manifest registration failed/;
const require = createRequire(import.meta.url);
async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("condition was not met in time");
    }
    await delay(5);
  }
}
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

test("owner local-source state lives in PDPP_DATA_DIR even when PDPP_CONNECTOR_PRELOAD_DIR is set", async () => {
  const preloadDir = mkdtempSync(join(tmpdir(), "pdpp-local-source-preload-"));
  const ownerDataDir = mkdtempSync(join(tmpdir(), "pdpp-local-source-data-"));
  const sourceRoot = mkdtempSync(join(tmpdir(), "pdpp-local-source-profile-"));
  const previousPreload = process.env.PDPP_CONNECTOR_PRELOAD_DIR;
  const previousData = process.env.PDPP_DATA_DIR;
  process.env.PDPP_CONNECTOR_PRELOAD_DIR = preloadDir;
  process.env.PDPP_DATA_DIR = ownerDataDir;
  try {
    mkdirSync(join(sourceRoot, "profile"));
    mkdirSync(join(sourceRoot, "dist"));
    writeFileSync(
      join(sourceRoot, "profile", "collection-profile.json"),
      JSON.stringify({
        connector_id: "https://registry.pdpp.dev/connectors/preload-split-fixture",
        connector_key: "preload-split-fixture",
        display_name: "Preload split fixture",
        runtime_requirements: { bindings: { network: { required: true } } },
        streams: [{ name: "items" }],
        version: "0.1.0",
      })
    );
    writeFileSync(join(sourceRoot, "dist", "collection-profile.mjs"), "export default {};\n");

    // Production call sites pass neither dataDir nor localSourceStore.
    const service = createConnectorInstallService({ registerManifest: () => Promise.resolve() });
    const added = await service.addLocalSource?.(sourceRoot);
    assert.ok(added);
    await service.selectLocalSource?.(added.connectorKey, added.sourceId);

    // The run path (runtime/controller.ts, server/index.ts) builds its store with
    // no argument, which resolves to PDPP_DATA_DIR.
    const runSideStore = createFileLocalConnectorSourceStore();
    assert.deepEqual(
      (await runSideStore.list()).map((source) => source.sourceId),
      [added.sourceId]
    );
    const active = await inspectActiveLocalConnectorSource(runSideStore, added.connectorId);
    assert.equal(active.status, "active");
    assert.equal(existsSync(join(preloadDir, "connector-local-sources.json")), false);
  } finally {
    if (previousPreload === undefined) delete process.env.PDPP_CONNECTOR_PRELOAD_DIR;
    else process.env.PDPP_CONNECTOR_PRELOAD_DIR = previousPreload;
    if (previousData === undefined) delete process.env.PDPP_DATA_DIR;
    else process.env.PDPP_DATA_DIR = previousData;
    for (const dir of [preloadDir, ownerDataDir, sourceRoot]) rmSync(dir, { force: true, recursive: true });
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

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function fixtureService(dataDir: string, extra: Partial<Parameters<typeof createConnectorInstallService>[0]> = {}) {
  return createConnectorInstallService({
    catalogLoader: async () => [entry],
    dataDir,
    installArtifact: (root) => {
      writeFixture(root);
    },
    registerManifest: () => Promise.resolve(),
    store: createFileConnectorInstallStore(dataDir),
    ...extra,
  });
}

/** True when nothing holds the install fence: probe it by taking and dropping it. */
function installFenceIsFree(dataDir: string): boolean {
  try {
    acquireDirectoryLock(dataDir, ".connector-install.lock", "busy").release();
    return true;
  } catch {
    return false;
  }
}

/**
 * A child process that takes the install fence, prints one line per event,
 * and holds the fence until its stdin closes. With a gate directory it also
 * stops before and after any rename of the old `mkdir` lock path, printing
 * `PAUSED <point>` and waiting for the file `<gate>/<point>`. A lock that
 * reclaims by renaming the lock path aside thus shows its race window to
 * the test; a lock that never renames it never stops.
 */
const LOCK_CHILD_PROGRAM = `
  import fs, { existsSync, writeSync } from "node:fs";
  import { syncBuiltinESMExports } from "node:module";
  import { join } from "node:path";
  const dataDir = process.env.PDPP_LOCK_CHILD_DATA_DIR;
  const gateDir = process.env.PDPP_LOCK_CHILD_GATE_DIR;
  const say = (line) => writeSync(1, line + "\\n");
  if (gateDir) {
    const lockPath = join(dataDir, ".connector-install.lock");
    const realRename = fs.renameSync;
    const cell = new Int32Array(new SharedArrayBuffer(4));
    const stop = (point) => {
      say("PAUSED " + point);
      while (!existsSync(join(gateDir, point))) Atomics.wait(cell, 0, 0, 10);
    };
    fs.renameSync = (from, to) => {
      if (String(from) !== lockPath) return realRename(from, to);
      stop("before-rename");
      realRename(from, to);
      stop("after-rename");
    };
    syncBuiltinESMExports();
  }
  const { acquireDirectoryLock } = await import("./server/connector-install/directory-lock.ts");
  let lock;
  try {
    lock = acquireDirectoryLock(dataDir, ".connector-install.lock", "Another connector installation is in progress.");
  } catch (error) {
    say("BUSY " + error.message);
    process.exit(0);
  }
  say("ACQUIRED");
  process.stdin.resume();
  process.stdin.on("end", () => {
    lock.release();
    process.exit(0);
  });
`;

interface LockChild {
  readonly exited: Promise<void>;
  kill: () => Promise<void>;
  next: () => Promise<string>;
  readonly pid: number | undefined;
}

function spawnLockChild(dataDir: string, gateDir?: string): LockChild {
  return spawnChildProgram(LOCK_CHILD_PROGRAM, {
    PDPP_LOCK_CHILD_DATA_DIR: dataDir,
    ...(gateDir ? { PDPP_LOCK_CHILD_GATE_DIR: gateDir } : {}),
  });
}

/** A child that holds the github lifecycle lock on a shared SQLite file until its stdin closes. */
const LIFECYCLE_CHILD_PROGRAM = `
  import { writeSync } from "node:fs";
  import { initDb } from "./server/db.ts";
  import { withConnectorLifecycleLock } from "./server/connector-lifecycle-lock.ts";
  initDb(process.env.PDPP_LOCK_CHILD_DB);
  await withConnectorLifecycleLock(process.env.PDPP_LOCK_CHILD_DATA_DIR, "github", async () => {
    writeSync(1, "ACQUIRED\\n");
    process.stdin.resume();
    await new Promise((settle) => process.stdin.on("end", settle));
  });
  process.exit(0);
`;

/** A child program run under tsx from the reference-implementation root; it prints one line per event. */
function spawnChildProgram(program: string, env: Record<string, string>): LockChild {
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", program], {
    cwd: resolve(import.meta.dirname, ".."),
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines: string[] = [];
  let buffered = "";
  let stderr = "";
  let wake: (() => void) | null = null;
  child.stdout.on("data", (chunk) => {
    buffered += String(chunk);
    const parts = buffered.split("\n");
    buffered = parts.pop() ?? "";
    lines.push(...parts);
    wake?.();
  });
  child.stderr.on("data", (chunk) => (stderr += String(chunk)));
  const exited = new Promise<void>((settle) => child.once("close", () => settle()));
  void exited.then(() => wake?.());
  return {
    exited,
    kill: async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
    },
    next: async () => {
      const deadline = Date.now() + 30_000;
      while (lines.length === 0) {
        assert.ok(child.exitCode === null, `lock child exited without output: ${stderr.slice(-2000)}`);
        assert.ok(Date.now() < deadline, `lock child printed nothing: ${stderr.slice(-2000)}`);
        await new Promise<void>((settle) => {
          wake = settle;
          setTimeout(settle, 100);
        });
      }
      return lines.shift() as string;
    },
    pid: child.pid,
  };
}

test("an install lock whose holder process died does not block", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-connector-install-"));
  const holder = spawnLockChild(dataDir);
  try {
    assert.equal(await holder.next(), "ACQUIRED");
    await holder.kill();
    assert.equal((await fixtureService(dataDir).install("github", digest)).digest, digest);
    assert.equal(installFenceIsFree(dataDir), true);
  } finally {
    await holder.kill();
    rmSync(dataDir, { force: true, recursive: true });
  }
});

test("an older build's lock directory keeps the fence busy unless it is provably stale, and stays in place", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-connector-install-"));
  const legacyLockDir = join(dataDir, ".connector-install.lock");
  const writeLegacy = (records: { owner?: number; pid?: number }, ageMs = 0) => {
    rmSync(legacyLockDir, { force: true, recursive: true });
    mkdirSync(legacyLockDir);
    if (records.owner) writeFileSync(join(legacyLockDir, "owner"), `${String(records.owner)}\ntoken\n`);
    if (records.pid) writeFileSync(join(legacyLockDir, "pid"), `${String(records.pid)}\n`);
    const at = new Date(Date.now() - ageMs);
    utimesSync(legacyLockDir, at, at);
  };
  try {
    const exited = spawnSync(process.execPath, ["-e", ""]);
    assert.equal(exited.status, 0);
    const busy = [
      ["a live older server", { owner: process.ppid }, 0],
      // This pid: a restarted container, or a live server in another container.
      ["this pid", { pid: process.pid }, 0],
      ["an owner record not written yet", {}, 0],
    ] as const;
    for (const [what, records, ageMs] of busy) {
      writeLegacy(records, ageMs);
      await assert.rejects(
        () => fixtureService(dataDir).install("github", digest),
        /Another connector installation is in progress\. An older build's lock directory .* is held/,
        what
      );
      assert.equal(existsSync(legacyLockDir), true, what);
    }
    const stale = [
      ["a dead owner", { owner: exited.pid }, 0],
      ["no owner record past the grace period", {}, 120_000],
    ] as const;
    for (const [what, records, ageMs] of stale) {
      writeLegacy(records, ageMs);
      assert.equal((await fixtureService(dataDir).install("github", digest)).digest, digest, what);
      assert.equal(existsSync(legacyLockDir), true, `${what}: the directory is left in place`);
    }
  } finally {
    rmSync(dataDir, { force: true, recursive: true });
  }
});

test("a live lifecycle lock holder in another process excludes this one even when its row shows this pid", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-connector-install-"));
  const dbPath = join(dataDir, "pdpp.sqlite");
  initDb(dbPath);
  const holder = spawnChildProgram(LIFECYCLE_CHILD_PROGRAM, {
    PDPP_LOCK_CHILD_DATA_DIR: dataDir,
    PDPP_LOCK_CHILD_DB: dbPath,
  });
  try {
    assert.equal(await holder.next(), "ACQUIRED");
    // Two containers, each with the server as pid 1: the holder's row shows our own pid.
    getDb().prepare("UPDATE connector_lifecycle_locks SET owner_pid = ?").run(process.pid);
    let entered = false;
    assert.throws(
      () =>
        withConnectorLifecycleLockSync(dataDir, "github", () => {
          entered = true;
        }),
      /Connector lifecycle operation is busy/
    );
    const waiting = new AbortController();
    const waiter = withConnectorLifecycleLock(
      dataDir,
      "github",
      async () => {
        entered = true;
      },
      { signal: waiting.signal }
    );
    await delay(200);
    waiting.abort(new Error("test gave up"));
    await assert.rejects(waiter, /test gave up/);
    assert.equal(entered, false);

    await holder.kill();
    withConnectorLifecycleLockSync(dataDir, "github", () => {
      entered = true;
    });
    assert.equal(entered, true, "the lock is free once the holder process is gone");
  } finally {
    await holder.kill();
    closeDb();
    rmSync(dataDir, { force: true, recursive: true });
  }
});

test("a live holder in another process keeps the install fence until it exits", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-connector-install-"));
  const holder = spawnLockChild(dataDir);
  try {
    assert.equal(await holder.next(), "ACQUIRED");
    await assert.rejects(
      () => fixtureService(dataDir).install("github", digest),
      new RegExp(`Another connector installation is in progress\\. Held by pid ${String(holder.pid)} since `)
    );
    await holder.kill();
    assert.equal((await fixtureService(dataDir).install("github", digest)).digest, digest);
  } finally {
    await holder.kill();
    rmSync(dataDir, { force: true, recursive: true });
  }
});

test("three processes that find a crashed holder's lock never hold the install fence at once", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-connector-install-"));
  const gateDir = mkdtempSync(join(tmpdir(), "pdpp-connector-install-gate-"));
  const children: LockChild[] = [];
  const start = (gate?: string) => {
    const child = spawnLockChild(dataDir, gate);
    children.push(child);
    return child;
  };
  try {
    const crashed = start();
    assert.equal(await crashed.next(), "ACQUIRED");
    await crashed.kill();

    // B finds the dead holder's lock. If its way to take over is to move the
    // lock path aside, B stops right there, after it judged the lock stale.
    const b = start(gateDir);
    let bState = await b.next();
    // A finds the same dead holder's lock while B is stopped.
    const a = start();
    const aState = await a.next();
    if (bState === "PAUSED before-rename") {
      // B moves the lock path aside and stops again before it checks the owner.
      writeFileSync(join(gateDir, "before-rename"), "");
      bState = await b.next();
    }
    // C arrives while the lock path may be missing.
    const c = start();
    const cState = await c.next();

    const states = { A: aState, B: bState, C: cState };
    const holders = Object.entries(states)
      .filter(([, state]) => state === "ACQUIRED")
      .map(([name]) => name);
    assert.equal(holders.length, 1, `holders at the same time: ${holders.join(", ")}; ${JSON.stringify(states)}`);
  } finally {
    await Promise.all(children.map((child) => child.kill()));
    rmSync(gateDir, { force: true, recursive: true });
    rmSync(dataDir, { force: true, recursive: true });
  }
});

test("a lifecycle lock row that an earlier start of this process left does not block an install", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-connector-install-"));
  initDb(join(dataDir, "pdpp.sqlite"));
  try {
    // Creates the lock table.
    await withConnectorLifecycleLock(dataDir, "github", async () => undefined);
    // A crash, then a container restart: the new process has the old pid.
    getDb()
      .prepare("INSERT INTO connector_lifecycle_locks(connector_id, owner_token, owner_pid) VALUES(?, ?, ?)")
      .run("github", "token-from-before-the-restart", process.pid);
    const installed = await fixtureService(dataDir, { installTimeoutMs: 5000 }).install("github", digest);
    assert.equal(installed.digest, digest);
    assert.equal(
      getDb().prepare("SELECT count(*) AS n FROM connector_lifecycle_locks").get<{ n: number }>()?.n,
      0,
      "the stale row is gone and the install released its own"
    );
  } finally {
    // Lets a waiter that never reclaims finish instead of polling forever.
    getDb()?.prepare("DELETE FROM connector_lifecycle_locks").run();
    closeDb();
    rmSync(dataDir, { force: true, recursive: true });
  }
});

test("a deadline while an install waits for the lifecycle lock releases the install fence", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-connector-install-"));
  initDb(join(dataDir, "pdpp.sqlite"));
  const entered = deferred();
  const holderDone = deferred();
  let holding: Promise<void> | undefined;
  try {
    holding = withConnectorLifecycleLock(dataDir, "github", async () => {
      entered.resolve();
      await holderDone.promise;
    });
    await entered.promise;
    let staged = false;
    const service = fixtureService(dataDir, {
      installArtifact: (root) => {
        staged = true;
        writeFixture(root);
      },
      installTimeoutMs: 100,
    });
    await assert.rejects(service.install("github", digest), ConnectorInstallTimeoutError);
    await waitFor(() => installFenceIsFree(dataDir), 2000);
    assert.equal(staged, false, "the install never started its work");
    assert.equal(
      getDb().prepare("SELECT count(*) AS n FROM connector_lifecycle_locks").get<{ n: number }>()?.n,
      1,
      "the live holder keeps its lifecycle lock"
    );

    holderDone.resolve();
    await holding;
    assert.equal((await fixtureService(dataDir).install("github", digest)).digest, digest);
  } finally {
    holderDone.resolve();
    await holding;
    closeDb();
    rmSync(dataDir, { force: true, recursive: true });
  }
});

test("a stuck install fails at its deadline, keeps the fence until it stops, and never activates", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-connector-install-"));
  const entered = deferred();
  const stuck = deferred();
  let observedSignal: AbortSignal | undefined;
  try {
    const service = fixtureService(dataDir, {
      installArtifact: async (root, _entry, signal) => {
        observedSignal = signal;
        entered.resolve();
        await stuck.promise;
        writeFixture(root);
      },
      installTimeoutMs: 50,
    });
    const installing = service.install("github", digest);
    await entered.promise;
    await assert.rejects(installing, (error: unknown) => {
      assert.ok(error instanceof ConnectorInstallTimeoutError);
      assert.equal(error.code, "connector_install_timeout");
      return true;
    });
    assert.equal(observedSignal?.aborted, true);
    // The stuck work still owns the fence, and the busy error says why.
    await assert.rejects(() => fixtureService(dataDir).install("github", digest), RE_INSTALL_PAST_DEADLINE);

    stuck.resolve();
    await waitFor(() => installFenceIsFree(dataDir));
    assert.deepEqual(await service.status(), []);
    assert.equal((await fixtureService(dataDir).install("github", digest)).digest, digest);
  } finally {
    stuck.resolve();
    rmSync(dataDir, { force: true, recursive: true });
  }
});

function writeVersionedFixture(root: string, version: string): void {
  mkdirSync(join(root, "profile"), { recursive: true });
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(join(root, "profile", "collection-profile.json"), JSON.stringify({ connector_id: "github", version }));
  writeFileSync(join(root, "dist", "collection-profile.mjs"), "export {};\n");
  writeFileSync(join(root, "provenance.json"), "{}\n");
}

for (const path of ["first install", "update"] as const) {
  test(`a deadline after manifest persistence keeps artifact and catalog manifest in agreement (${path})`, async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pdpp-connector-install-"));
    const next = {
      ...entry,
      config_digest: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      digest: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      latest: true,
      version: "2.0.0",
    };
    let current = entry;
    // The registry row registerConnector commits on its own connection.
    let catalogManifestVersion: unknown = null;
    let holdAfterPersist = false;
    const persisted = deferred();
    const resume = deferred();
    try {
      const service = fixtureService(dataDir, {
        catalogLoader: async () => [current],
        installArtifact: (root, target) => {
          writeVersionedFixture(root, target.version ?? "0.0.0");
        },
        installTimeoutMs: 50,
        registerManifest: async (manifest) => {
          catalogManifestVersion = manifest.version;
          if (holdAfterPersist) {
            persisted.resolve();
            await resume.promise;
          }
        },
      });
      if (path === "update") {
        await service.install("github", digest);
        current = next;
      }
      holdAfterPersist = true;
      const pending = path === "update" ? service.update("github") : service.install("github", digest);
      await persisted.promise;
      await assert.rejects(pending, ConnectorInstallTimeoutError);
      resume.resolve();
      await waitFor(() => installFenceIsFree(dataDir));

      const active = (await service.status())[0];
      assert.equal(active?.manifest.version, catalogManifestVersion);
      assert.equal(active?.digest, path === "update" ? next.digest : digest);
    } finally {
      resume.resolve();
      rmSync(dataDir, { force: true, recursive: true });
    }
  });
}

test("derived-state repair runs after the install returns and its locks are released", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-connector-install-"));
  const repairEntered = deferred();
  const repairRelease = deferred();
  const repairErrors: unknown[] = [];
  try {
    const service = fixtureService(dataDir, {
      onDerivedRepairError: (_connectorId, error) => {
        repairErrors.push(error);
      },
      repairManifestDerivedState: async () => {
        repairEntered.resolve();
        await repairRelease.promise;
        throw new Error("derived repair failed");
      },
    });
    const installed = await service.install("github", digest);
    await repairEntered.promise;
    assert.equal(installFenceIsFree(dataDir), true);
    // The fence is free while the O(records) repair runs.
    assert.equal((await fixtureService(dataDir).install("github", digest)).digest, digest);

    repairRelease.resolve();
    await waitFor(() => repairErrors.length === 1);
    assert.match(String(repairErrors[0]), RE_DERIVED_REPAIR_FAILED);
    // A failed repair is reported; it does not roll back the activation.
    assert.equal((await service.status())[0]?.digest, installed.digest);
  } finally {
    repairRelease.resolve();
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

test("owner update route reports an implementation change only after the update succeeds", async () => {
  type RegisteredHandler = (
    req: { body?: Record<string, unknown> },
    res: { json: (body: unknown) => unknown; status: (code: number) => unknown }
  ) => Promise<void>;
  let handler: RegisteredHandler | undefined;
  let changes = 0;
  let failNext = false;
  const app = {
    get() {
      return this;
    },
    post(path: string, ...args: unknown[]) {
      if (path.endsWith("/update")) handler = args.at(-1) as RegisteredHandler;
      return this;
    },
  };
  mountOwnerConnectorInstall(app as never, {
    handleError: () => undefined,
    onImplementationChanged: () => {
      changes += 1;
    },
    pdppError: (_res, status, code) => assert.fail(`${status} ${code}`),
    requireOwner: () => undefined,
    requireToken: () => undefined,
    service: {
      catalog: async () => [],
      install: async () => assert.fail("unexpected install"),
      status: async () => [],
      uninstall: async () => assert.fail("unexpected uninstall"),
      update: async (connectorId) => {
        if (failNext) throw new Error("no verified update target");
        return { connectorId, digest } as never;
      },
    },
  });
  const res = {
    json() {
      return this;
    },
    status() {
      return this;
    },
  };
  assert.ok(handler);
  await handler({ body: { connector_id: "chase" } }, res);
  assert.equal(changes, 1, "a successful update invalidates cached summaries");
  failNext = true;
  await handler({ body: { connector_id: "chase" } }, res);
  assert.equal(changes, 1, "a failed update leaves the cached summaries alone");
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
