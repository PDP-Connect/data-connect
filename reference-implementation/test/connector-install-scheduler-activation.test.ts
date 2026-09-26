// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveActiveInstallFirstConnectorPath } from "../runtime/controller.ts";
import { createScheduler } from "../runtime/scheduler.ts";
import { __setRegisterConnectorPhaseHookForTest, getConnectorManifest, registerConnector } from "../server/auth.ts";
import { getConnectorActivation } from "../server/connector-install/activation-authority.ts";
import { createConnectorInstallService, createConnectorInstallStore } from "../server/connector-install/index.ts";
import { createFileLocalConnectorSourceStore } from "../server/connector-install/local-source.ts";
import { closeDb, initDb } from "../server/db.ts";
import { closePostgresStorage, initPostgresStorage } from "../server/postgres-storage.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";

const connectorId = "scheduled-activation";
const REPAIR_FAILURE = /controlled repair failure/;
const REPAIR_REQUIRED = /repair_required/;
const first = {
  config_digest: `sha256:${"c".repeat(64)}`,
  connector_id: connectorId,
  connector_key: connectorId,
  digest: `sha256:${"a".repeat(64)}`,
  version: "1.0.0",
};
const second = { ...first, digest: `sha256:${"b".repeat(64)}`, latest: true, version: "2.0.0" };

async function assertScheduledRunRejectsStaleActivation(): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-scheduled-activation-"));
  const previousDataDir = process.env.PDPP_DATA_DIR;
  process.env.PDPP_DATA_DIR = dataDir;
  const marker = join(dataDir, "old-bytes-spawned");
  const store = createConnectorInstallStore();
  const localStore = createFileLocalConnectorSourceStore(dataDir);
  let current = first;
  let scheduler: ReturnType<typeof createScheduler> | null = null;
  try {
    const service = createConnectorInstallService({
      catalogLoader: async () => [current],
      dataDir,
      installArtifact(root, selected) {
        mkdirSync(join(root, "profile"), { recursive: true });
        mkdirSync(join(root, "dist"), { recursive: true });
        writeFileSync(
          join(root, "profile", "collection-profile.json"),
          JSON.stringify({
            capabilities: {
              human_interaction: [],
              refresh_policy: {
                background_safe: true,
                rationale: "Scheduled activation test fixture",
                recommended_mode: "automatic",
              },
            },
            connector_id: connectorId,
            display_name: "Scheduled activation test",
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
            version: selected.version,
          })
        );
        writeFileSync(
          join(root, "dist", "collection-profile.mjs"),
          `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, ${JSON.stringify(selected.version)});\nprocess.exit(0);\n`
        );
        writeFileSync(join(root, "provenance.json"), "{}\n");
      },
      registerManifest: (manifest, options) => registerConnector(manifest, options),
      store,
    });
    const installed = await service.install(connectorId, first.digest);
    const cachedPath = await resolveActiveInstallFirstConnectorPath(
      connectorId,
      installed.manifest,
      undefined,
      localStore,
      store
    );
    assert.ok(cachedPath);
    const completed: string[] = [];
    scheduler = createScheduler({
      admitRunConnection: async ({ connectorId: id, connectorInstanceId, ownerSubjectId }) => ({
        connectorId: id,
        connectorInstanceId: connectorInstanceId ?? id,
        ownerSubjectId: ownerSubjectId ?? "owner_local",
      }),
      connectors: [
        {
          connectorId,
          connectorInstanceId: connectorId,
          connectorPath: cachedPath,
          intervalMs: 25,
          manifest: installed.manifest,
          maxRetries: 0,
          ownerSubjectId: "owner_local",
          ownerToken: "scheduled-test-token",
          resolveImplementation: async () => {
            const manifest = await getConnectorManifest(connectorId);
            assert.ok(manifest);
            const connectorPath = await resolveActiveInstallFirstConnectorPath(
              connectorId,
              manifest,
              undefined,
              localStore,
              store
            );
            return connectorPath ? { connectorPath, manifest } : null;
          },
        },
      ],
      onInteraction: () => undefined,
      onRunComplete: (record) => completed.push(record.status),
      readinessChecker: async () => ({ ready: true }),
      rsUrl: "http://localhost.invalid",
    });

    current = second;
    __setRegisterConnectorPhaseHookForTest((point) => {
      if (point === "after-manifest-persisted") {
        return Promise.reject(new Error("controlled repair failure"));
      }
      return Promise.resolve();
    });
    await assert.rejects(service.update(connectorId), REPAIR_FAILURE);
    __setRegisterConnectorPhaseHookForTest(null);
    assert.equal((await getConnectorActivation(connectorId))?.state, "repair_required");
    await assert.rejects(
      resolveActiveInstallFirstConnectorPath(connectorId, installed.manifest, undefined, localStore, store),
      REPAIR_REQUIRED
    );

    scheduler.start();
    const deadline = Date.now() + 5000;
    while (completed.length === 0 && !existsSync(marker) && Date.now() < deadline) {
      // biome-ignore lint/performance/noAwaitInLoops: Poll until the scheduled attempt starts or the bounded deadline expires.
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(completed.length > 0 || existsSync(marker), "scheduler never attempted the run");
    assert.equal(
      existsSync(marker),
      false,
      `scheduled run executed cached ${existsSync(marker) ? readFileSync(marker, "utf8") : "unknown"} bytes`
    );
  } finally {
    scheduler?.stop();
    __setRegisterConnectorPhaseHookForTest(null);
    if (previousDataDir === undefined) {
      delete process.env.PDPP_DATA_DIR;
    } else {
      process.env.PDPP_DATA_DIR = previousDataDir;
    }
    rmSync(dataDir, { force: true, recursive: true });
  }
}

test("SQLite: scheduled run rejects a stale executable after activation repair fails", async () => {
  initDb(":memory:");
  try {
    await assertScheduledRunRejectsStaleActivation();
  } finally {
    closeDb();
  }
});

test("PostgreSQL: scheduled run rejects a stale executable after activation repair fails", {
  skip: !process.env.PDPP_TEST_POSTGRES_URL,
}, async () => {
  const url = process.env.PDPP_TEST_POSTGRES_URL;
  assert.ok(url);
  await withTemporaryPostgresDatabase(
    {
      closeConnections: closePostgresStorage,
      connectionString: url,
      databaseName: `pdpp_test_scheduled_activation_${Date.now().toString(36)}`,
      templateName: null,
    },
    async (databaseUrl) => {
      initDb(":memory:");
      try {
        await initPostgresStorage({ backend: "postgres", databaseUrl });
        await assertScheduledRunRejectsStaleActivation();
      } finally {
        await closePostgresStorage();
        closeDb();
      }
    }
  );
});
