// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalConnectorKey, classifyConnectorIntentModality } from "../../server/connection-setup-plan.ts";
import { createFileLocalConnectorSourceStore } from "../../server/connector-install/local-source.ts";

const BROWSER_HOST_ENV = [
  "PDPP_ALLOW_UNMANAGED_BROWSER_SCHEDULES",
  "PDPP_BROWSER_SURFACE_HOST_ENDPOINT",
  "PDPP_BROWSER_SURFACE_MODE",
  "PDPP_BROWSER_SURFACE_REMOTE_CDP_URL",
  "PDPP_NEKO_CDP_HTTP_URL",
  "PDPP_NEKO_MANAGED_CONNECTORS",
  "PDPP_RUNTIME_BROWSER",
] as const;

/**
 * Sets whether this test process looks like a host with a browser surface, by
 * the same env the scheduler's host rules read. Returns the restore function.
 */
export function setBrowserHostCapability(configured: boolean): () => void {
  const saved = BROWSER_HOST_ENV.map((name) => [name, process.env[name]] as const);
  for (const name of BROWSER_HOST_ENV) {
    delete process.env[name];
  }
  if (configured) {
    process.env.PDPP_ALLOW_UNMANAGED_BROWSER_SCHEDULES = "1";
  }
  return () => {
    for (const [name, value] of saved) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  };
}

/** Synthetic executable fixtures for route tests; registration alone is not code availability. */
export function createBrowserArtifactFixtures(): {
  readonly close: () => void;
  readonly corrupt: (connectorKey: string) => void;
  readonly publish: (manifest: Record<string, unknown>) => Promise<Record<string, unknown>>;
} {
  const entrypoints = new Map<string, string>();
  const root = mkdtempSync(join(tmpdir(), "browser-artifact-fixtures-"));
  const previous = process.env.PDPP_DATA_DIR;
  process.env.PDPP_DATA_DIR = root;
  const store = createFileLocalConnectorSourceStore(root);
  return {
    corrupt(connectorKey) {
      const entrypoint = entrypoints.get(canonicalConnectorKey(connectorKey));
      if (!entrypoint) {
        throw new Error(`No published fixture for ${connectorKey}`);
      }
      appendFileSync(entrypoint, "// changed after it was loaded\n");
    },
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
      entrypoints.set(key, join(path, "dist/collection-profile.mjs"));
      const source = await store.add(path);
      await store.select(key, source.sourceId);
      return registered;
    },
  };
}
