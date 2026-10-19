// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The activation/registration promise of the OCI connector installer, tested
 * through production wiring: the SQLite install store, the production
 * `registerManifest` (registerConnector), the lifecycle and install locks, and
 * the startup manifest reconcile. Only the OCI download is replaced.
 *
 * The promise, derived from the code and docs (cited in the PR body):
 *   1. `registerManifest` throws before it commits: the install store goes back
 *      to the previous record (or none) and the published root is removed.
 *   2. The deadline passes before registration starts: same rollback.
 *   3. The deadline passes after registration started: the install completes,
 *      so the active record and the registry manifest agree.
 *   4. The process dies in the window between `store.activate` and the
 *      registry commit: the two disagree until the next start. Startup
 *      reconcile (`reconcilePolyfillManifests` over the install store) re-
 *      registers the installed manifest and restores agreement.
 *   5. The process dies after the registry commit: the derived-repair queue
 *      was written in the same transaction, so the maintenance sweep still
 *      finds it after restart.
 *
 * Limit: SIGKILL keeps the kernel page cache. These tests prove recovery from
 * a process crash, not fsync or power-loss durability.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  __setRegisterConnectorPhaseHookForTest,
  getConnectorManifest,
  normalizeConnectorManifestForStorage,
} from "../server/auth.ts";
import { acquireDirectoryLock } from "../server/connector-install/directory-lock.ts";
import {
  type ConnectorInstallRecord,
  type ConnectorInstallStore,
  ConnectorInstallTimeoutError,
  createConnectorInstallService,
  createConnectorInstallStore,
} from "../server/connector-install/index.ts";
import { installedConnectorManifestRegistration } from "../server/connector-install/manifest-registration.ts";
import { closeDb, initDb } from "../server/db.ts";
import { reconcilePolyfillManifests } from "../server/polyfill-manifest-reconcile.ts";
import { listPendingRecordDerivedRepairs, runRecordDerivedRepairRound } from "../server/record-derived-repair.ts";
import { GMAIL_INSTALL_DIGEST, installedGmail } from "./helpers/connector-install-gmail-fixture.ts";
import { killChildAt, runCrashChild } from "./helpers/crash-harness.ts";

const CHILD = join(import.meta.dirname, "fixtures/crash/connector-install-registration-child.ts");
const UPDATE_DIGEST = `sha256:${"c".repeat(64)}`;
const UPDATE_VERSION = "9.1.0";
const CONFIG_DIGEST = `sha256:${"b".repeat(64)}`;

interface Sandbox {
  readonly dataDir: string;
  readonly dbPath: string;
  readonly dir: string;
}

async function withSandbox(run: (sandbox: Sandbox) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-install-registration-"));
  const sandbox = {
    dataDir: join(dir, "data"),
    dbPath: join(dir, "pdpp.sqlite"),
    dir,
  };
  mkdirSync(sandbox.dataDir, { recursive: true });
  const previous = process.env.PDPP_DATA_DIR;
  process.env.PDPP_DATA_DIR = sandbox.dataDir;
  try {
    await run(sandbox);
  } finally {
    __setRegisterConnectorPhaseHookForTest(null);
    closeDb();
    if (previous === undefined) {
      delete process.env.PDPP_DATA_DIR;
    } else {
      process.env.PDPP_DATA_DIR = previous;
    }
    rmSync(dir, { force: true, recursive: true });
  }
}

function writeArtifact(root: string, manifest: Record<string, unknown>): void {
  mkdirSync(join(root, "profile"), { recursive: true });
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(join(root, "profile", "collection-profile.json"), JSON.stringify(manifest));
  writeFileSync(join(root, "dist", "collection-profile.mjs"), "export {};\n");
  writeFileSync(join(root, "provenance.json"), "{}\n");
}

/** The production install service with a replaceable store and manifest. */
function installService(
  dataDir: string,
  options: {
    readonly digest?: string;
    readonly installTimeoutMs?: number;
    readonly manifest?: Record<string, unknown>;
    readonly store?: ConnectorInstallStore;
  } = {}
) {
  const digest = options.digest ?? GMAIL_INSTALL_DIGEST;
  const manifest = options.manifest ?? installedGmail;
  return createConnectorInstallService({
    catalogLoader: async () => [
      {
        bindings: {},
        config_digest: CONFIG_DIGEST,
        connector_id: "gmail",
        connector_key: "gmail",
        digest,
        latest: true,
        version: String(manifest.version),
      },
    ],
    dataDir,
    installArtifact: (root) => {
      writeArtifact(root, manifest);
    },
    ...(options.installTimeoutMs === undefined ? {} : { installTimeoutMs: options.installTimeoutMs }),
    registerManifest: installedConnectorManifestRegistration.registerManifest,
    store: options.store ?? createConnectorInstallStore(),
  });
}

const updatedGmail = { ...installedGmail, version: UPDATE_VERSION };
/** The registry rejects this manifest before it writes anything. */
const unregistrableGmail = {
  ...updatedGmail,
  runtime_requirements: { bindings: "not-an-object" },
};

function rootOf(dataDir: string, digest: string): string {
  return join(dataDir, "connectors", "gmail", digest);
}

async function registeredVersion(): Promise<unknown> {
  return (await getConnectorManifest("gmail"))?.version ?? null;
}

async function activeRecord(): Promise<ConnectorInstallRecord | null> {
  return await createConnectorInstallStore().getActive("gmail");
}

/** What a reader of the install store and the registry sees right now. */
async function agreement(): Promise<{
  readonly agree: boolean;
  readonly activeDigest: string | null;
  readonly activeVersion: unknown;
  readonly registeredVersion: unknown;
}> {
  const active = await activeRecord();
  const registered = await getConnectorManifest("gmail");
  const agree =
    active !== null &&
    registered !== null &&
    JSON.stringify(sortKeys(normalizeConnectorManifestForStorage(active.manifest).storedManifest)) ===
      JSON.stringify(sortKeys(registered));
  return {
    activeDigest: active?.digest ?? null,
    activeVersion: active?.manifest.version ?? null,
    agree,
    registeredVersion: registered?.version ?? null,
  };
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([key, entry]) => [key, sortKeys(entry)])
    );
  }
  return value;
}

/** The real startup path: reconcile the registry against verified installs. */
async function startupReconcile(dir: string): Promise<Awaited<ReturnType<typeof reconcilePolyfillManifests>>> {
  const emptyFixtures = join(dir, "no-reference-fixtures");
  mkdirSync(emptyFixtures, { recursive: true });
  return await reconcilePolyfillManifests({
    enabled: true,
    installStore: createConnectorInstallStore(),
    log: () => undefined,
    referenceFixturesDir: emptyFixtures,
  });
}

async function waitFor(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    assert.ok(Date.now() - started < timeoutMs, "condition was not met in time");
    await new Promise((settle) => setTimeout(settle, 20));
  }
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

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

// ---------------------------------------------------------------------------
// 1 and 2: rollback while nothing is committed in the registry
// ---------------------------------------------------------------------------

test("a registry rejection before commit restores the previous install and registry (update)", async () => {
  await withSandbox(async ({ dataDir, dbPath }) => {
    await initDb(dbPath);
    const previous = await installService(dataDir).install("gmail", GMAIL_INSTALL_DIGEST);
    assert.deepEqual(await registeredVersion(), previous.manifest.version);

    await assert.rejects(
      installService(dataDir, {
        digest: UPDATE_DIGEST,
        manifest: unregistrableGmail,
      }).install("gmail", UPDATE_DIGEST),
      /bindings/
    );

    assert.deepEqual(
      (await activeRecord())?.digest,
      GMAIL_INSTALL_DIGEST,
      "the pointer is back on the previous digest"
    );
    assert.equal(existsSync(rootOf(dataDir, UPDATE_DIGEST)), false, "the new root is removed");
    assert.equal(existsSync(rootOf(dataDir, GMAIL_INSTALL_DIGEST)), true, "the previous root stays");
    assert.deepEqual(await agreement(), {
      activeDigest: GMAIL_INSTALL_DIGEST,
      activeVersion: previous.manifest.version,
      agree: true,
      registeredVersion: previous.manifest.version,
    });
  });
});

test("a registry rejection before commit leaves no install, no root and no registry row (first install)", async () => {
  await withSandbox(async ({ dataDir, dbPath }) => {
    await initDb(dbPath);

    await assert.rejects(
      installService(dataDir, { manifest: unregistrableGmail }).install("gmail", GMAIL_INSTALL_DIGEST),
      /bindings/
    );

    assert.equal(await activeRecord(), null);
    assert.equal(existsSync(rootOf(dataDir, GMAIL_INSTALL_DIGEST)), false);
    assert.equal(await getConnectorManifest("gmail"), null);
  });
});

test("a deadline that passes before registration starts rolls the install back", async () => {
  await withSandbox(async ({ dataDir, dbPath }) => {
    await initDb(dbPath);
    const previous = await installService(dataDir).install("gmail", GMAIL_INSTALL_DIGEST);
    // The pointer write is slow; the deadline passes while it runs, before
    // registerManifest is reached.
    const base = createConnectorInstallStore();
    const gate = deferred();
    const entered = deferred();
    const slowStore: ConnectorInstallStore = {
      ...base,
      activate: async (record) => {
        await base.activate(record);
        if (record.digest === UPDATE_DIGEST) {
          entered.resolve();
          await gate.promise;
        }
      },
    };
    const installing = installService(dataDir, {
      digest: UPDATE_DIGEST,
      installTimeoutMs: 100,
      manifest: updatedGmail,
      store: slowStore,
    }).install("gmail", UPDATE_DIGEST);
    const settled = installing.then(
      () => null,
      (error: unknown) => error
    );
    await entered.promise;
    await new Promise((settle) => setTimeout(settle, 300));
    const error = await settled;
    assert.ok(error instanceof ConnectorInstallTimeoutError, String(error));
    gate.resolve();
    // The aborted work still owns the install fence; it ends by rolling back.
    await waitFor(() => installFenceIsFree(dataDir));
    assert.equal((await activeRecord())?.digest, GMAIL_INSTALL_DIGEST, "the pointer is back on the previous digest");
    assert.equal(existsSync(rootOf(dataDir, UPDATE_DIGEST)), false);
    assert.equal(await registeredVersion(), previous.manifest.version, "the registry never saw the new manifest");
  });
});

// ---------------------------------------------------------------------------
// 3: the deadline passes after the registry committed
// ---------------------------------------------------------------------------

test("a deadline after the registry committed lets the install finish with pointer and registry agreeing", async () => {
  await withSandbox(async ({ dataDir, dbPath }) => {
    await initDb(dbPath);
    await installService(dataDir).install("gmail", GMAIL_INSTALL_DIGEST);
    const committed = deferred();
    const resume = deferred();
    __setRegisterConnectorPhaseHookForTest(async (point, context) => {
      if (
        point === "after-manifest-persisted" &&
        context.manifest &&
        (context.manifest as { version?: unknown }).version === UPDATE_VERSION
      ) {
        committed.resolve();
        await resume.promise;
      }
    });
    const installing = installService(dataDir, {
      digest: UPDATE_DIGEST,
      installTimeoutMs: 100,
      manifest: updatedGmail,
    }).install("gmail", UPDATE_DIGEST);
    const settled = installing.then(
      () => null,
      (error: unknown) => error
    );
    await committed.promise;
    // The registry row is already committed on its own connection.
    assert.equal(await registeredVersion(), UPDATE_VERSION);
    const timeout = await settled;
    assert.ok(timeout instanceof ConnectorInstallTimeoutError, String(timeout));
    resume.resolve();
    // Wait for the late completion to release the lifecycle lock and settle.
    await waitFor(() => installFenceIsFree(dataDir));

    assert.deepEqual(await agreement(), {
      activeDigest: UPDATE_DIGEST,
      activeVersion: UPDATE_VERSION,
      agree: true,
      registeredVersion: UPDATE_VERSION,
    });
    assert.equal(existsSync(rootOf(dataDir, UPDATE_DIGEST)), true, "the new root stays published");
  });
});

// ---------------------------------------------------------------------------
// 4 and 5: process death around the registry commit
// ---------------------------------------------------------------------------

test("killed between the pointer write and the registry commit: startup reconcile restores agreement (update)", async () => {
  await withSandbox(async ({ dataDir, dbPath, dir }) => {
    const env = { PDPP_DATA_DIR: dataDir };
    await runCrashChild(CHILD, { args: [dbPath, dataDir, "seed"], env });
    await killChildAt(CHILD, "connector-install:after-activate", {
      args: [dbPath, dataDir, "update"],
      env,
    });

    await initDb(dbPath);
    // The crash window is real: the pointer is ahead of the registry.
    assert.deepEqual(await agreement(), {
      activeDigest: UPDATE_DIGEST,
      activeVersion: UPDATE_VERSION,
      agree: false,
      registeredVersion: installedGmail.version,
    });

    const first = await startupReconcile(dir);
    assert.equal(first.updated, 1, "reconcile re-registered the installed manifest");
    assert.deepEqual(await agreement(), {
      activeDigest: UPDATE_DIGEST,
      activeVersion: UPDATE_VERSION,
      agree: true,
      registeredVersion: UPDATE_VERSION,
    });
    // A second start finds nothing to do.
    const second = await startupReconcile(dir);
    assert.equal(second.unchanged, 1);
    assert.equal(second.updated, 0);
  });
});

test("killed between the pointer write and the registry commit: startup reconcile registers the manifest (first install)", async () => {
  await withSandbox(async ({ dataDir, dbPath, dir }) => {
    const env = { PDPP_DATA_DIR: dataDir };
    await killChildAt(CHILD, "connector-install:after-activate", {
      args: [dbPath, dataDir, "install"],
      env,
    });

    await initDb(dbPath);
    assert.deepEqual(await agreement(), {
      activeDigest: GMAIL_INSTALL_DIGEST,
      activeVersion: installedGmail.version,
      agree: false,
      registeredVersion: null,
    });

    const summary = await startupReconcile(dir);
    assert.equal(summary.registered, 1, "the missing manifest of a listed install is registered");
    assert.equal((await agreement()).agree, true);
  });
});

test("killed after the registry commit: pointer and registry agree and the derived-repair queue survives", async () => {
  await withSandbox(async ({ dataDir, dbPath, dir }) => {
    const env = { PDPP_DATA_DIR: dataDir };
    await runCrashChild(CHILD, { args: [dbPath, dataDir, "seed"], env });
    await killChildAt(CHILD, "connector-install:after-register", {
      args: [dbPath, dataDir, "update"],
      env,
    });

    await initDb(dbPath);
    assert.deepEqual(await agreement(), {
      activeDigest: UPDATE_DIGEST,
      activeVersion: UPDATE_VERSION,
      agree: true,
      registeredVersion: UPDATE_VERSION,
    });
    const queued = await listPendingRecordDerivedRepairs({
      connectorId: "gmail",
    });
    assert.ok(queued.length > 0, "the repair queued with the manifest is still there after the kill");
    assert.ok(queued.every((repair) => repair.connectorInstanceId === "cin_gmail_crash"));

    // The maintenance sweep drains it; startup reconcile has nothing to change.
    const round = await runRecordDerivedRepairRound({ connectorId: "gmail" });
    assert.equal(round.failed, 0);
    assert.deepEqual(await listPendingRecordDerivedRepairs({ connectorId: "gmail" }), []);
    assert.equal((await startupReconcile(dir)).unchanged, 1);
  });
});

test("a retried install after a kill between pointer and registry also restores agreement", async () => {
  await withSandbox(async ({ dataDir, dbPath }) => {
    const env = { PDPP_DATA_DIR: dataDir };
    await killChildAt(CHILD, "connector-install:after-activate", {
      args: [dbPath, dataDir, "install"],
      env,
    });
    await initDb(dbPath);
    assert.equal((await agreement()).agree, false);

    await installService(dataDir).install("gmail", GMAIL_INSTALL_DIGEST);

    assert.equal((await agreement()).agree, true);
  });
});
