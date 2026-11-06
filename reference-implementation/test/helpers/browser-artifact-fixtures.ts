// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalConnectorKey, classifyConnectorIntentModality } from "../../server/connection-setup-plan.ts";
import { createFileLocalConnectorSourceStore } from "../../server/connector-install/local-source.ts";

/** Synthetic executable fixtures for route tests; registration alone is not code availability. */
export function createBrowserArtifactFixtures(): {
  readonly close: () => void;
  readonly publish: (manifest: Record<string, unknown>) => Promise<Record<string, unknown>>;
} {
  const root = mkdtempSync(join(tmpdir(), "browser-artifact-fixtures-"));
  const previous = process.env.PDPP_DATA_DIR;
  process.env.PDPP_DATA_DIR = root;
  const store = createFileLocalConnectorSourceStore(root);
  return {
    close() {
      if (previous === undefined) {
        delete process.env.PDPP_DATA_DIR;
      } else {
        process.env.PDPP_DATA_DIR = previous;
      }
      rmSync(root, { force: true, recursive: true });
    },
    async publish(manifest) {
      if (classifyConnectorIntentModality(manifest) !== "browser_bound") {
        return manifest;
      }
      const rawKey = manifest.connector_key ?? manifest.connector_id;
      if (typeof rawKey !== "string") {
        throw new Error("Browser fixture needs a connector key");
      }
      const key = canonicalConnectorKey(rawKey);
      const provenance = `https://fixtures.pdpp.test/connectors/${encodeURIComponent(key)}`;
      const registered = {
        ...manifest,
        connector_key: key,
        manifest_uri:
          manifest.manifest_uri ?? (URL.canParse(String(manifest.connector_id)) ? manifest.connector_id : provenance),
        version: manifest.version ?? "1.0.0",
      };
      const path = mkdtempSync(join(root, "payload-"));
      mkdirSync(join(path, "profile"));
      mkdirSync(join(path, "dist"));
      writeFileSync(
        join(path, "profile/collection-profile.json"),
        JSON.stringify({ ...registered, connector_id: provenance })
      );
      writeFileSync(join(path, "dist/collection-profile.mjs"), "export {};\n");
      const source = await store.add(path);
      await store.select(key, source.sourceId);
      return registered;
    },
  };
}
