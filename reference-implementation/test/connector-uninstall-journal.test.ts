// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  connectorUninstallJournalPath,
  reconcileConnectorUninstallJournal,
  readConnectorUninstallJournal,
  updateConnectorUninstallJournalRoots,
  writeConnectorUninstallJournal,
} from "../server/connector-uninstall-journal.ts";

function tempDataDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-connector-uninstall-journal-"));
  t.after(() => rmSync(dir, { force: true, recursive: true }));
  return dir;
}

test("journal restores prior active record and moved roots when active record still exists", async (t) => {
  const dataDir = tempDataDir(t);
  const root = join(dataDir, "connectors", "github", "sha256-one");
  const moved = join(dataDir, "connectors", "github", ".uninstall-sha256-one");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "entrypoint.mjs"), "export {};\n");

  writeConnectorUninstallJournal(dataDir, {
    connectorId: "github",
    priorActiveRecord: { connectorId: "github", root },
    rootMoves: [{ moved, original: root }],
  });
  renameSync(root, moved);

  let restored: unknown = null;
  assert.deepEqual(
    await reconcileConnectorUninstallJournal(dataDir, "github", {
      getActive: () => ({ connectorId: "github" }),
      restoreActive: (record) => {
        restored = record;
      },
    }),
    { connectorId: "github", status: "restored" }
  );

  assert.deepEqual(restored, { connectorId: "github", root });
  assert.equal(existsSync(root), true);
  assert.equal(existsSync(moved), false);
  assert.equal(existsSync(connectorUninstallJournalPath(dataDir, "github")), false);
});

test("journal cleans moved and original roots when active record is gone", async (t) => {
  const dataDir = tempDataDir(t);
  const original = join(dataDir, "connectors", "github", "sha256-two");
  const moved = join(dataDir, "connectors", "github", ".uninstall-sha256-two");
  mkdirSync(original, { recursive: true });
  writeFileSync(join(original, "entrypoint.mjs"), "export {};\n");

  writeConnectorUninstallJournal(dataDir, {
    connectorId: "github",
    priorActiveRecord: { connectorId: "github", root: original },
    rootMoves: [{ moved, original }],
  });
  renameSync(original, moved);

  assert.deepEqual(
    await reconcileConnectorUninstallJournal(dataDir, "github", {
      getActive: () => null,
      restoreActive: () => assert.fail("cleanup must not restore active records"),
    }),
    { connectorId: "github", status: "cleaned" }
  );

  assert.equal(existsSync(original), false);
  assert.equal(existsSync(moved), false);
  assert.equal(existsSync(connectorUninstallJournalPath(dataDir, "github")), false);
});

test("journal rejects paths outside the connector root", (t) => {
  const dataDir = tempDataDir(t);
  assert.throws(
    () =>
      writeConnectorUninstallJournal(dataDir, {
        connectorId: "github",
        priorActiveRecord: { connectorId: "github" },
        rootMoves: [{ moved: join(dataDir, "connectors", "github", ".uninstall"), original: "/tmp/outside" }],
      }),
    /outside the connector root/
  );
});

test("journal update preserves prior active record", (t) => {
  const dataDir = tempDataDir(t);
  const original = join(dataDir, "connectors", "github", "sha256-three");
  const moved = join(dataDir, "connectors", "github", ".uninstall-sha256-three");
  const nextMoved = join(dataDir, "connectors", "github", ".uninstall-sha256-three-next");

  writeConnectorUninstallJournal(dataDir, {
    connectorId: "github",
    priorActiveRecord: { connectorId: "github", root: original },
    rootMoves: [{ moved, original }],
  });
  updateConnectorUninstallJournalRoots(dataDir, "github", [{ moved: nextMoved, original }]);

  assert.deepEqual(readConnectorUninstallJournal(dataDir, "github"), {
    connectorId: "github",
    priorActiveRecord: { connectorId: "github", root: original },
    rootMoves: [{ moved: nextMoved, original }],
    version: 1,
  });
  assert.match(readFileSync(connectorUninstallJournalPath(dataDir, "github"), "utf8"), /sha256-three-next/);
});

test("journal read rejects a different connector identity than its filename", (t) => {
  const dataDir = tempDataDir(t);
  writeConnectorUninstallJournal(dataDir, {
    connectorId: "github",
    priorActiveRecord: { connectorId: "github" },
    rootMoves: [],
  });
  const path = connectorUninstallJournalPath(dataDir, "github");
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      connectorId: "calendar",
      priorActiveRecord: { connectorId: "calendar" },
      rootMoves: [],
    })
  );

  assert.throws(
    () => readConnectorUninstallJournal(dataDir, "github"),
    "a filename-scoped lifecycle lock must never admit another connector's journal"
  );
  assert.equal(existsSync(path), true, "rejected journal remains available for diagnosis");
});

test("journal cleanup refuses a symlink ancestor and preserves outside bytes", async (t) => {
  if (process.platform === "win32") {
    t.skip("directory symlink privilege is platform-dependent");
    return;
  }
  const { symlinkSync } = await import("node:fs");
  const dataDir = tempDataDir(t);
  const outside = tempDataDir(t);
  const connectorDir = join(dataDir, "connectors", "github");
  const original = join(connectorDir, "sha256-one");
  const moved = join(connectorDir, ".uninstall-one");
  mkdirSync(join(dataDir, "connectors"), { recursive: true });
  mkdirSync(join(outside, "sha256-one"), { recursive: true });
  const sentinel = join(outside, "sha256-one", "keep.txt");
  writeFileSync(sentinel, "outside bytes must survive");

  writeConnectorUninstallJournal(dataDir, {
    connectorId: "github",
    priorActiveRecord: { connectorId: "github", root: original },
    rootMoves: [{ original, moved }],
  });
  symlinkSync(outside, connectorDir, "dir");

  let rejected = false;
  try {
    await reconcileConnectorUninstallJournal(dataDir, "github", {
      getActive: () => null,
      restoreActive: () => assert.fail("cleanup must not restore"),
    });
  } catch {
    rejected = true;
  }
  assert.equal(existsSync(sentinel), true, "recovery must never remove outside bytes");
  assert.equal(readFileSync(sentinel, "utf8"), "outside bytes must survive");
  assert.equal(rejected, true, "unsafe recovery must reject");
  assert.equal(existsSync(connectorUninstallJournalPath(dataDir, "github")), true);
});

test("journal cleanup still runs when the data directory itself is reached through a symlink", async (t) => {
  if (process.platform === "win32") {
    t.skip("directory symlink privilege is platform-dependent");
    return;
  }
  const { symlinkSync } = await import("node:fs");
  const realDataDir = tempDataDir(t);
  const linkParent = tempDataDir(t);
  const dataDir = join(linkParent, "data");
  symlinkSync(realDataDir, dataDir, "dir");
  const original = join(dataDir, "connectors", "github", "sha256-one");
  const moved = join(dataDir, "connectors", "github", ".uninstall-one");
  mkdirSync(moved, { recursive: true });
  writeFileSync(join(moved, "entrypoint.mjs"), "export {};\n");

  writeConnectorUninstallJournal(dataDir, {
    connectorId: "github",
    priorActiveRecord: { connectorId: "github", root: original },
    rootMoves: [{ moved, original }],
  });

  assert.deepEqual(
    await reconcileConnectorUninstallJournal(dataDir, "github", {
      getActive: () => null,
      restoreActive: () => assert.fail("cleanup must not restore"),
    }),
    { connectorId: "github", status: "cleaned" }
  );
  assert.equal(existsSync(moved), false);
  assert.equal(existsSync(connectorUninstallJournalPath(dataDir, "github")), false);
});

test("journal cleanup does not follow a symlink hidden behind a dot-dot segment", async (t) => {
  if (process.platform === "win32") {
    t.skip("directory symlink privilege is platform-dependent");
    return;
  }
  const { symlinkSync } = await import("node:fs");
  const dataDir = tempDataDir(t);
  const outside = tempDataDir(t);
  const connectorDir = join(dataDir, "connectors", "github");
  mkdirSync(connectorDir, { recursive: true });
  mkdirSync(join(outside, "child"), { recursive: true });
  mkdirSync(join(outside, "victim"), { recursive: true });
  const sentinel = join(outside, "victim", "keep.txt");
  writeFileSync(sentinel, "outside bytes must survive");
  symlinkSync(join(outside, "child"), join(connectorDir, "link"), "dir");

  // A hand-edited journal: lexically `connectors/github/victim`, but the
  // filesystem resolves `link` first and lands in `<outside>/victim`. The
  // writer normalizes paths, so edit the file after writing it.
  const moved = join(connectorDir, "victim");
  writeConnectorUninstallJournal(dataDir, {
    connectorId: "github",
    priorActiveRecord: { connectorId: "github" },
    rootMoves: [{ moved, original: join(connectorDir, "sha256-one") }],
  });
  const journalPath = connectorUninstallJournalPath(dataDir, "github");
  const raw = readFileSync(journalPath, "utf8");
  writeFileSync(journalPath, raw.replace(JSON.stringify(moved), JSON.stringify(`${connectorDir}/link/../victim`)));
  assert.notEqual(readFileSync(journalPath, "utf8"), raw);

  await reconcileConnectorUninstallJournal(dataDir, "github", {
    getActive: () => null,
    restoreActive: () => assert.fail("cleanup must not restore"),
  });
  assert.equal(readFileSync(sentinel, "utf8"), "outside bytes must survive");
});
