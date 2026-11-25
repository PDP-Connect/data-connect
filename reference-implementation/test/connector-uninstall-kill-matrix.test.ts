// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Process-kill matrix for connector uninstall and its startup recovery.
 *
 * A child process runs the real uninstall against the production SQLite
 * install store and a real data directory with two retained digest roots. The
 * parent SIGKILLs it at each durability boundary, reopens the SQLite file and
 * data directory, runs the real startup recovery (reconcileConnectorUninstalls)
 * twice, and asserts all-or-nothing: either the connector is fully restored or
 * it is fully gone. Recovery itself is also killed at its boundaries.
 *
 * Limit: SIGKILL keeps the kernel page cache. This matrix proves recovery
 * after a process crash at each boundary. It does not prove the fsyncs exist
 * or are sufficient; that needs power loss or a fault-injecting filesystem.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  type ConnectorCatalogEntry,
  createConnectorInstallService,
  createConnectorInstallStore,
  reconcileConnectorUninstalls,
} from "../server/connector-install/index.ts";
import { listConnectorUninstallJournalIds } from "../server/connector-uninstall-journal.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { spawnCrashChild } from "./helpers/crash-harness.ts";

const CHILD = join(import.meta.dirname, "fixtures/crash/connector-uninstall-child.ts");
const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;
const MARKER_DIR = ".connector-lifecycle-locks";

function catalogEntry(digest: string): ConnectorCatalogEntry {
  return {
    bindings: { browser: "optional" },
    config_digest: `sha256:${"c".repeat(64)}`,
    connector_id: "github",
    connector_key: "github",
    digest,
    tier: "supported",
    version: "1.0.0",
  };
}

function writeFixture(root: string, digest: string): void {
  mkdirSync(join(root, "profile"), { recursive: true });
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(
    join(root, "profile", "collection-profile.json"),
    JSON.stringify({ connector_id: "github", version: "1.0.0" })
  );
  writeFileSync(join(root, "dist", "collection-profile.mjs"), `export const digest = "${digest}";\n`);
  writeFileSync(join(root, "provenance.json"), "{}\n");
}

function readTree(dir: string, prefix = ""): Record<string, string> {
  const tree: Record<string, string> = {};
  if (!existsSync(dir)) return tree;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relative = join(prefix, entry.name);
    if (entry.isDirectory()) {
      tree[`${relative}/`] = "";
      Object.assign(tree, readTree(join(dir, entry.name), relative));
    } else {
      tree[relative] = readFileSync(join(dir, entry.name), "utf8");
    }
  }
  return tree;
}

/** Everything recovery may touch, minus the SQLite file itself (read through SQL). */
function dataDirTree(dataDir: string): Record<string, string> {
  const tree = readTree(dataDir);
  for (const name of Object.keys(tree)) {
    if (name.startsWith("pdpp.sqlite")) delete tree[name];
  }
  return tree;
}

function dbRows(table: string): unknown[] {
  return getDb().prepare(`SELECT * FROM ${table} ORDER BY connector_id`).all();
}

function markerExists(dataDir: string): boolean {
  return existsSync(join(dataDir, MARKER_DIR))
    ? readdirSync(join(dataDir, MARKER_DIR)).some((name) => name.endsWith(".uninstalled"))
    : false;
}

function stagedDirs(dataDir: string): string[] {
  const connectorDir = join(dataDir, "connectors", "github");
  return existsSync(connectorDir) ? readdirSync(connectorDir).filter((name) => name.startsWith(".uninstall-")) : [];
}

interface Fixture {
  readonly activationRow: unknown;
  readonly dataDir: string;
  readonly priorRecord: unknown;
  readonly rootsTree: Record<string, string>;
}

/** Install two digest roots through the real service, then add the activation row. */
async function seed(): Promise<Fixture> {
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-uninstall-kill-"));
  const previousPreload = process.env.PDPP_CONNECTOR_PRELOAD_DIR;
  delete process.env.PDPP_CONNECTOR_PRELOAD_DIR;
  closeDb();
  initDb(join(dataDir, "pdpp.sqlite"));
  try {
    const store = createConnectorInstallStore();
    const service = createConnectorInstallService({
      catalogLoader: async () => [catalogEntry(DIGEST_A), catalogEntry(DIGEST_B)],
      dataDir,
      installArtifact: (root, entry) => {
        writeFixture(root, entry.digest);
      },
      registerManifest: () => Promise.resolve(),
      store,
    });
    await service.install("github", DIGEST_A);
    await service.install("github", DIGEST_B);
    assert.notEqual(
      readFileSync(join(dataDir, "connectors", "github", DIGEST_A, "dist", "collection-profile.mjs"), "utf8"),
      readFileSync(join(dataDir, "connectors", "github", DIGEST_B, "dist", "collection-profile.mjs"), "utf8"),
      "fixture digest roots must have distinct payloads so swapped restores are detectable"
    );
    const now = new Date().toISOString();
    getDb()
      .prepare(
        `INSERT INTO connector_activations(
                connector_id,state,record_json,canonical_manifest_json,manifest_revision,
                activation_id,attempt_id,updated_at
                ) VALUES (?, 'active', '{}', '{}', '1', 'activation', 'attempt', ?)`
      )
      .run("github", now);
    const rootsTree = readTree(join(dataDir, "connectors", "github"));
    assert.equal(
      readdirSync(join(dataDir, "connectors", "github")).length,
      2,
      "the fixture must retain two digest roots"
    );
    const priorRecord = await store.getActive("github");
    assert.equal(priorRecord?.digest, DIGEST_B);
    return {
      activationRow: dbRows("connector_activations")[0],
      dataDir,
      priorRecord,
      rootsTree,
    };
  } finally {
    closeDb();
    if (previousPreload !== undefined) process.env.PDPP_CONNECTOR_PRELOAD_DIR = previousPreload;
  }
}

/** Run `point` in the child until its `hit`th arrival, then SIGKILL it. */
async function killAtHit(dataDir: string, mode: "recover" | "uninstall", point: string, hit: number): Promise<void> {
  const child = spawnCrashChild(CHILD, {
    args: [dataDir, mode],
    points: [point],
  });
  for (let arrival = 1; arrival <= hit; arrival++) {
    await child.parked(point);
    if (arrival < hit) child.resume();
  }
  const exit = await child.kill();
  assert.equal(exit.signal, "SIGKILL", `${mode} was not killed at ${point}`);
}

/** The parent's own restart: fresh handles on the same SQLite file and data dir. */
async function startupRecovery(dataDir: string): Promise<void> {
  const previousPreload = process.env.PDPP_CONNECTOR_PRELOAD_DIR;
  delete process.env.PDPP_CONNECTOR_PRELOAD_DIR;
  closeDb();
  initDb(join(dataDir, "pdpp.sqlite"));
  try {
    await reconcileConnectorUninstalls(dataDir, createConnectorInstallStore(), async (connectorId) => {
      getDb().prepare("DELETE FROM connector_activations WHERE connector_id = ?").run(connectorId);
    });
  } finally {
    closeDb();
    if (previousPreload !== undefined) process.env.PDPP_CONNECTOR_PRELOAD_DIR = previousPreload;
  }
}

function openForInspection(dataDir: string): void {
  closeDb();
  initDb(join(dataDir, "pdpp.sqlite"));
}

function assertRestored(fixture: Fixture, label: string): void {
  const { dataDir } = fixture;
  const active = dbRows("connector_installs");
  assert.equal(active.length, 1, `${label}: one active record`);
  assert.deepEqual(
    JSON.parse((active[0] as { record_json: string }).record_json),
    fixture.priorRecord,
    `${label}: active record equals the prior record`
  );
  assert.deepEqual(
    dbRows("connector_activations"),
    [fixture.activationRow],
    `${label}: activation row is back, unchanged`
  );
  assert.deepEqual(
    readTree(join(dataDir, "connectors", "github")),
    fixture.rootsTree,
    `${label}: every root is at its original path with its content`
  );
  assert.deepEqual(stagedDirs(dataDir), [], `${label}: no staged dirs`);
  assert.equal(markerExists(dataDir), false, `${label}: no uninstalled marker`);
  assert.deepEqual(listConnectorUninstallJournalIds(dataDir), [], `${label}: no journal`);
}

function assertCleaned(fixture: Fixture, label: string): void {
  const { dataDir } = fixture;
  assert.deepEqual(dbRows("connector_installs"), [], `${label}: no active record`);
  assert.deepEqual(dbRows("connector_activations"), [], `${label}: no activation row`);
  assert.deepEqual(readTree(join(dataDir, "connectors", "github")), {}, `${label}: no roots or staged dirs left`);
  assert.deepEqual(listConnectorUninstallJournalIds(dataDir), [], `${label}: no journal`);
}

/** Recover twice. The second run must change neither the database nor the data dir. */
async function recoverTwiceAndAssert(fixture: Fixture, expected: "cleaned" | "restored", label: string): Promise<void> {
  const { dataDir } = fixture;
  await startupRecovery(dataDir);
  openForInspection(dataDir);
  let afterFirst: unknown;
  try {
    (expected === "restored" ? assertRestored : assertCleaned)(fixture, label);
    afterFirst = {
      activations: dbRows("connector_activations"),
      installs: dbRows("connector_installs"),
      tree: dataDirTree(dataDir),
    };
  } finally {
    closeDb();
  }
  await startupRecovery(dataDir);
  openForInspection(dataDir);
  try {
    assert.deepEqual(
      {
        activations: dbRows("connector_activations"),
        installs: dbRows("connector_installs"),
        tree: dataDirTree(dataDir),
      },
      afterFirst,
      `${label}: the second recovery changed state`
    );
  } finally {
    closeDb();
  }
}

interface UninstallKill {
  readonly expected: "cleaned" | "restored";
  readonly hit?: number;
  readonly point: string;
  /** State the kill must leave behind, so the test knows it landed where it claims. */
  readonly preState: {
    readonly activeRecord: boolean;
    readonly journal: boolean;
    readonly marker: boolean;
    readonly staged: number;
  };
}

const UNINSTALL_KILLS: readonly UninstallKill[] = [
  {
    expected: "restored",
    point: "uninstall-journal:after-temp-fsync",
    preState: { activeRecord: true, journal: false, marker: false, staged: 0 },
  },
  {
    expected: "restored",
    point: "uninstall-journal:after-rename",
    preState: { activeRecord: true, journal: true, marker: false, staged: 0 },
  },
  {
    expected: "restored",
    point: "connector-uninstall:after-marker",
    preState: { activeRecord: true, journal: true, marker: true, staged: 0 },
  },
  {
    expected: "restored",
    hit: 1,
    point: "connector-uninstall:after-root-move",
    preState: { activeRecord: true, journal: true, marker: true, staged: 1 },
  },
  {
    expected: "restored",
    hit: 2,
    point: "connector-uninstall:after-root-move",
    preState: { activeRecord: true, journal: true, marker: true, staged: 2 },
  },
  {
    expected: "cleaned",
    point: "connector-uninstall:after-active-removed",
    preState: { activeRecord: false, journal: true, marker: true, staged: 2 },
  },
  {
    expected: "cleaned",
    point: "connector-uninstall:after-staged-removal",
    preState: { activeRecord: false, journal: true, marker: true, staged: 0 },
  },
];

function assertPreState(fixture: Fixture, kill: Pick<UninstallKill, "preState">, label: string): void {
  openForInspection(fixture.dataDir);
  try {
    assert.deepEqual(
      {
        activeRecord: dbRows("connector_installs").length === 1,
        journal: listConnectorUninstallJournalIds(fixture.dataDir).length === 1,
        marker: markerExists(fixture.dataDir),
        staged: stagedDirs(fixture.dataDir).length,
      },
      kill.preState,
      `${label}: the kill did not land at the claimed boundary`
    );
  } finally {
    closeDb();
  }
}

for (const kill of UNINSTALL_KILLS) {
  const label = `${kill.point}${kill.hit ? ` #${kill.hit}` : ""}`;
  test(`kill during uninstall at ${label}: recovery ends ${kill.expected}, twice`, async (t) => {
    const fixture = await seed();
    t.after(() => rmSync(fixture.dataDir, { force: true, recursive: true }));
    await killAtHit(fixture.dataDir, "uninstall", kill.point, kill.hit ?? 1);
    assertPreState(fixture, kill, label);
    await recoverTwiceAndAssert(fixture, kill.expected, label);
  });
}

interface RecoveryKill {
  readonly expected: "cleaned" | "restored";
  readonly hit?: number;
  readonly point: string;
  readonly preState: UninstallKill["preState"];
  /** Where the uninstall is killed first, to give recovery something to do. */
  readonly uninstallKill: { readonly hit?: number; readonly point: string };
}

const ROOT_MOVES_DONE = {
  hit: 2,
  point: "connector-uninstall:after-root-move",
};
const ACTIVE_REMOVED = { point: "connector-uninstall:after-active-removed" };

const RECOVERY_KILLS: readonly RecoveryKill[] = [
  {
    expected: "restored",
    point: "uninstall-recovery:after-restore-active",
    preState: { activeRecord: true, journal: true, marker: true, staged: 2 },
    uninstallKill: ROOT_MOVES_DONE,
  },
  {
    expected: "restored",
    hit: 1,
    point: "uninstall-recovery:after-root-restore",
    preState: { activeRecord: true, journal: true, marker: true, staged: 1 },
    uninstallKill: ROOT_MOVES_DONE,
  },
  {
    expected: "restored",
    hit: 2,
    point: "uninstall-recovery:after-root-restore",
    preState: { activeRecord: true, journal: true, marker: true, staged: 0 },
    uninstallKill: ROOT_MOVES_DONE,
  },
  {
    expected: "restored",
    point: "uninstall-recovery:after-marker-clear",
    preState: { activeRecord: true, journal: true, marker: false, staged: 0 },
    uninstallKill: ROOT_MOVES_DONE,
  },
  {
    expected: "cleaned",
    hit: 1,
    point: "uninstall-recovery:after-root-removal",
    preState: { activeRecord: false, journal: true, marker: true, staged: 1 },
    uninstallKill: ACTIVE_REMOVED,
  },
  {
    expected: "cleaned",
    hit: 2,
    point: "uninstall-recovery:after-root-removal",
    preState: { activeRecord: false, journal: true, marker: true, staged: 0 },
    uninstallKill: ACTIVE_REMOVED,
  },
  {
    expected: "cleaned",
    point: "uninstall-recovery:after-activation-cleanup",
    preState: { activeRecord: false, journal: true, marker: true, staged: 0 },
    uninstallKill: ACTIVE_REMOVED,
  },
];

for (const kill of RECOVERY_KILLS) {
  const label = `${kill.point}${kill.hit ? ` #${kill.hit}` : ""}`;
  test(`kill during recovery at ${label}: a later recovery ends ${kill.expected}, twice`, async (t) => {
    const fixture = await seed();
    t.after(() => rmSync(fixture.dataDir, { force: true, recursive: true }));
    await killAtHit(fixture.dataDir, "uninstall", kill.uninstallKill.point, kill.uninstallKill.hit ?? 1);
    await killAtHit(fixture.dataDir, "recover", kill.point, kill.hit ?? 1);
    assertPreState(fixture, kill, label);
    await recoverTwiceAndAssert(fixture, kill.expected, label);
  });
}
