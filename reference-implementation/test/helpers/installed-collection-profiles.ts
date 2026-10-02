// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ConnectorCatalogEntry,
  type ConnectorInstallRecord,
  type ConnectorInstallStore,
  createConnectorInstallService,
  createFileConnectorInstallStore,
} from "../../server/connector-install/index.ts";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "collection-profiles");
const CONFIG_DIGEST = `sha256:${"c".repeat(64)}`;

/** One checked-in Collection Profile manifest (see fixtures/collection-profiles/README.md). */
export function readCollectionProfileFixture(connectorKey: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, `${connectorKey}.json`), "utf8")) as Record<string, unknown>;
}

/**
 * Installs each manifest through the real install service into a
 * file-backed store under `dataDir`, so every record carries real byte
 * digests and passes the same verification production reads apply. Only
 * the OCI fetch is replaced: the artifact is written locally, with a
 * placeholder entrypoint.
 */
export async function installCollectionProfiles(
  dataDir: string,
  manifests: readonly Record<string, unknown>[]
): Promise<{ records: ConnectorInstallRecord[]; store: ConnectorInstallStore }> {
  const bytesByKey = new Map<string, string>();
  const entries: ConnectorCatalogEntry[] = manifests.map((manifest) => {
    const key = manifest.connector_key;
    if (typeof key !== "string") {
      throw new Error("Collection Profile fixture has no connector_key");
    }
    const bytes = JSON.stringify(manifest, null, 2);
    bytesByKey.set(key, bytes);
    return {
      config_digest: CONFIG_DIGEST,
      connector_id: key,
      connector_key: key,
      digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      tier: "supported",
      version: typeof manifest.version === "string" ? manifest.version : "0.0.0",
    };
  });
  const store = createFileConnectorInstallStore(dataDir);
  const service = createConnectorInstallService({
    catalogLoader: async () => entries,
    dataDir,
    installArtifact: (root, entry) => {
      mkdirSync(join(root, "profile"), { recursive: true });
      mkdirSync(join(root, "dist"), { recursive: true });
      writeFileSync(join(root, "profile", "collection-profile.json"), bytesByKey.get(entry.connector_key) ?? "");
      writeFileSync(join(root, "dist", "collection-profile.mjs"), "export {};\n");
      writeFileSync(join(root, "provenance.json"), "{}\n");
    },
    registerManifest: () => Promise.resolve(),
    store,
  });
  const records: ConnectorInstallRecord[] = [];
  for (const entry of entries) {
    // biome-ignore lint/performance/noAwaitInLoops: The install service holds one install lock at a time.
    records.push(await service.install(entry.connector_id, entry.digest));
  }
  return { records, store };
}
