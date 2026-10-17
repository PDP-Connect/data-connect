// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A gmail connector as a migrated instance has it (registered, connections,
 * records), plus an install service that publishes a newer gmail artifact
 * through the production manifest registration. Shared by
 * connector-install-postgres.test.ts and the child process it kills.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registerConnector } from "../../server/auth.ts";
import {
  type ConnectorCatalogEntry,
  createConnectorInstallService,
  createConnectorInstallStore,
} from "../../server/connector-install/index.ts";
import { installedConnectorManifestRegistration } from "../../server/connector-install/manifest-registration.ts";
import { postgresQuery } from "../../server/postgres-storage.ts";

export const GMAIL_CONNECTOR_ID = "gmail";
export const GMAIL_INSTALL_DIGEST = `sha256:${"a".repeat(64)}`;
const configDigest = `sha256:${"b".repeat(64)}`;
export const GMAIL_INSTALL_VERSION = "9.0.0";

export const shippedGmail = JSON.parse(
  readFileSync(new URL("../fixtures/collection-profiles/gmail.json", import.meta.url), "utf8")
) as Record<string, unknown>;

/** The manifest the install publishes. */
export const installedGmail = { ...shippedGmail, version: GMAIL_INSTALL_VERSION };

/**
 * Register gmail and seed connections with `messages` and `message_bodies`
 * records. `registered` picks the registry manifest: the shipped one, or the
 * one the install publishes (a registry left ahead of its install).
 */
export async function seedMigratedGmail(options: {
  readonly instances: readonly string[];
  readonly recordsPerStream: number;
  readonly registered?: Record<string, unknown>;
}): Promise<void> {
  await registerConnector(options.registered ?? shippedGmail, { backfillRetrievalIndexes: false });
  const now = new Date().toISOString();
  for (const connectorInstanceId of options.instances) {
    await postgresQuery(
      `INSERT INTO connector_instances(connector_instance_id, owner_subject_id, connector_id, display_name,
         source_kind, source_binding_key, created_at, updated_at)
       VALUES($1, 'owner', $2, 'Gmail', 'account', $1, $3, $3)`,
      [connectorInstanceId, GMAIL_CONNECTOR_ID, now]
    );
    for (const stream of ["messages", "message_bodies"]) {
      for (let start = 0; start < options.recordsPerStream; start += 500) {
        const values: string[] = [];
        const params: unknown[] = [];
        for (let index = start; index < Math.min(options.recordsPerStream, start + 500); index += 1) {
          const id = `${stream}-${String(index).padStart(6, "0")}`;
          const receivedAt = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
          const data =
            stream === "messages"
              ? { id, received_at: receivedAt, snippet: `snippet ${id}`, subject: `subject ${id}` }
              : { body_text: `body ${id}`, id, message_received_at: receivedAt };
          const base = values.length * 5;
          values.push(
            `($1, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}::jsonb, $${base + 6}, $${base + 4})`
          );
          params.push(connectorInstanceId, stream, id, JSON.stringify(data), receivedAt);
        }
        // Every row shares $1, the connector id.
        await postgresQuery(
          `INSERT INTO records(connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, primary_key_text)
           VALUES ${values.join(", ")}`,
          [GMAIL_CONNECTOR_ID, ...params]
        );
      }
    }
  }
}

export function gmailInstallService(
  dataDir: string,
  hooks: { readonly onRepair?: (repair: Promise<unknown>) => void; readonly stage?: Promise<void> } = {},
  artifact: { readonly digest: string; readonly manifest: Record<string, unknown> } = {
    digest: GMAIL_INSTALL_DIGEST,
    manifest: installedGmail,
  }
) {
  const entry: ConnectorCatalogEntry = {
    bindings: {},
    config_digest: configDigest,
    connector_id: GMAIL_CONNECTOR_ID,
    connector_key: GMAIL_CONNECTOR_ID,
    digest: artifact.digest,
    latest: true,
    version: String(artifact.manifest.version),
  };
  return createConnectorInstallService({
    catalogLoader: async () => [entry],
    dataDir,
    installArtifact: async (root) => {
      await hooks.stage;
      mkdirSync(join(root, "profile"), { recursive: true });
      mkdirSync(join(root, "dist"), { recursive: true });
      writeFileSync(join(root, "profile", "collection-profile.json"), JSON.stringify(artifact.manifest));
      writeFileSync(join(root, "dist", "collection-profile.mjs"), "export {};\n");
      writeFileSync(join(root, "provenance.json"), "{}\n");
    },
    registerManifest: installedConnectorManifestRegistration.registerManifest,
    repairManifestDerivedState: (manifest) => {
      const repair = installedConnectorManifestRegistration.repairManifestDerivedState(manifest);
      hooks.onRepair?.(repair);
      return repair;
    },
    store: createConnectorInstallStore(),
  });
}
