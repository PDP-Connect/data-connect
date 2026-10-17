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
