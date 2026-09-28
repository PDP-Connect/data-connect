// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registerConnector } from "../../server/auth.ts";
import { __setConnectorActivationPhaseHookForTest } from "../../server/connector-install/activation-authority.ts";
import {
  type ConnectorCatalogEntry,
  createConnectorInstallService,
  createConnectorInstallStore,
} from "../../server/connector-install/index.ts";
import { initDb } from "../../server/db.ts";
import { initPostgresStorage } from "../../server/postgres-storage.ts";

const dataDir = process.env.PDPP_F1_DATA_DIR;
if (!dataDir) {
  throw new Error("PDPP_F1_DATA_DIR is required");
}
process.env.PDPP_DATA_DIR = dataDir;
const postgresUrl = process.env.PDPP_F1_PG_URL;
await initDb(postgresUrl ? ":memory:" : join(dataDir, "activation.sqlite"));
if (postgresUrl) {
  await initPostgresStorage({ backend: "postgres", databaseUrl: postgresUrl });
}

const connectorId = "f1-activation";
const firstDigest = `sha256:${"a".repeat(64)}`;
const secondDigest = `sha256:${"b".repeat(64)}`;
const first: ConnectorCatalogEntry = {
  config_digest: `sha256:${"c".repeat(64)}`,
  connector_id: connectorId,
  connector_key: connectorId,
  digest: firstDigest,
  version: "1.0.0",
};
const second: ConnectorCatalogEntry = { ...first, digest: secondDigest, latest: true, version: "2.0.0" };
let current = first;
const service = createConnectorInstallService({
  catalogLoader: async () => [current],
  dataDir,
  installArtifact: (root, entry) => {
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
        version: entry.version,
      })
    );
    writeFileSync(
      join(root, "dist", "collection-profile.mjs"),
      `export const version = ${JSON.stringify(entry.version)};\n`
    );
    writeFileSync(join(root, "provenance.json"), "{}\n");
  },
  registerManifest: (manifest, options) => registerConnector(manifest, options),
  store: createConnectorInstallStore(),
});
await service.install(connectorId, firstDigest);
current = second;
__setConnectorActivationPhaseHookForTest((point) => {
  if (point === "after-publication-commit") {
    process.exit(77);
  }
});
await service.update(connectorId);
throw new Error("Crash hook did not stop the installer");
