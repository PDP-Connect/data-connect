// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Child for test/connector-uninstall-kill-matrix.test.ts. It runs the real
// uninstall (mode "uninstall") or the real startup recovery (mode "recover")
// against the production SQLite install store, in a data directory the parent
// seeded. The parent parks and kills it at a crash point.
import { join } from "node:path";

import {
  createConnectorInstallService,
  createConnectorInstallStore,
  reconcileConnectorUninstalls,
} from "../../../server/connector-install/index.ts";
import { getDb, initDb } from "../../../server/db.ts";
import { armCrashPoints } from "../../helpers/crash-harness.ts";

armCrashPoints();
const [dataDir, mode] = process.argv.slice(2) as [string, string];
delete process.env.PDPP_CONNECTOR_PRELOAD_DIR;
initDb(join(dataDir, "pdpp.sqlite"));
const store = createConnectorInstallStore();
const removeActivation = (connectorId: string): Promise<void> => {
  getDb().prepare("DELETE FROM connector_activations WHERE connector_id = ?").run(connectorId);
  return Promise.resolve();
};

if (mode === "uninstall") {
  await createConnectorInstallService({
    assertUninstallAllowed: async () => undefined,
    catalogLoader: async () => [],
    dataDir,
    registerManifest: () => Promise.resolve(),
    removeActivation,
    store,
  }).uninstall("github");
} else if (mode === "recover") {
  await reconcileConnectorUninstalls(dataDir, store, removeActivation);
} else {
  throw new Error(`unknown mode: ${mode}`);
}
process.stdout.write("finished\n");
