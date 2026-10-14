// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Legacy-upgrade preservation (SQLite).
 *
 * An instance upgraded from RI commit c82718d4 holds connectors registered
 * from the old bundled package (`connectors.connector_id` is the manifest's
 * `connector_key`, e.g. `apple_contacts` with an underscore), plus connector
 * instances (some paused), per-instance state, grants and records. At the
 * target, catalog connectors run only from verified OCI installs or
 * developer-local sources. These tests prove the upgrade paths keep that
 * owner data in place:
 *
 *   1. A developer-local source preserves an underscore legacy id: select is
 *      accepted, the run-path resolver finds the source under the stored id,
 *      no hyphen registration appears, and instance/state/grant/record rows
 *      do not change.
 *   2. `POST /v1/owner/connector-install/update` over HTTP on a
 *      legacy-registered connector changes only the manifest and
 *      `manifest_generation`; a key with no catalog entry fails without
 *      creating rows. (Shared with the Postgres file.)
 *   3. Install and activation never change instance status.
 *
 * Fixtures and shared scenarios: test/helpers/legacy-upgrade.ts. The device
 * push case is in legacy-upgrade-device-push.test.ts.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveActiveInstallFirstConnectorPath } from "../runtime/controller.ts";
import { registerConnector } from "../server/auth.ts";
import {
  createConnectorInstallService,
  createFileConnectorInstallStore,
} from "../server/connector-install/index.ts";
import { createFileLocalConnectorSourceStore } from "../server/connector-install/local-source.ts";
import { getDb } from "../server/db.ts";
import {
  assertUpdatePreservesOwnerRows,
  assertUpdateWithoutCatalogEntryCreatesNothing,
  catalogGithubProfile,
  fakeCatalogFor,
  fetchJson,
  installServiceFor,
  legacyManifest,
  seedLegacyRegistration,
  snapshotOwnerRows,
  sqliteBackend,
  withLegacyServer,
} from "./helpers/legacy-upgrade.ts";

function scratchDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `pdpp-legacy-${label}-`));
}

test("a developer-local source preserves the underscore legacy id apple_contacts", async () => {
  const dir = scratchDir("apple-contacts");
  const sourceRoot = join(dir, "source");
  const dataDir = join(dir, "data");
  mkdirSync(join(sourceRoot, "profile"), { recursive: true });
  mkdirSync(join(sourceRoot, "dist"), { recursive: true });
  // The profile is the O-era manifest unchanged (connector_key apple_contacts).
  writeFileSync(
    join(sourceRoot, "profile", "collection-profile.json"),
    JSON.stringify(legacyManifest("apple_contacts"))
  );
  writeFileSync(join(sourceRoot, "dist", "collection-profile.mjs"), "export default {};\n");
  const localStore = createFileLocalConnectorSourceStore(dataDir);
  const installStore = createFileConnectorInstallStore(dataDir);
  let catalogLoads = 0;
  let registrations = 0;
  const service = createConnectorInstallService({
    catalogLoader: async () => {
      catalogLoads += 1;
      return [];
    },
    dataDir,
    localSourceStore: localStore,
    registerManifest: (manifest) => {
      registrations += 1;
      return registerConnector(manifest);
    },
    store: installStore,
  });
  try {
    await withLegacyServer({ backend: sqliteBackend, service }, async (urls) => {
      await seedLegacyRegistration(
        sqliteBackend,
        urls,
        "apple_contacts",
        [{ id: "cin_apple_contacts_legacy", status: "active" }],
        "contacts"
      );
      const before = await snapshotOwnerRows(sqliteBackend);
      assert.deepEqual(before.connectors, [{ connector_id: "apple_contacts" }]);
      assert.equal(before.instances.length, 1);
      assert.equal(before.records.length, 1);
      assert.equal(before.state.length, 1);
      assert.equal(before.grants.length, 1);

      const owner = { Authorization: `Bearer ${urls.ownerToken}`, "Content-Type": "application/json" };
      const added = await fetchJson(`${urls.rsUrl}/v1/owner/connector-install/local-sources/add`, {
        body: JSON.stringify({ source_path: sourceRoot }),
        headers: owner,
        method: "POST",
      });
      assert.equal(added.status, 201, JSON.stringify(added.body));
      assert.equal(added.body.data.connector_key, "apple_contacts");
      const selected = await fetchJson(`${urls.rsUrl}/v1/owner/connector-install/local-sources/select`, {
        body: JSON.stringify({ connector_key: "apple_contacts", source_id: added.body.data.source_id }),
        headers: owner,
        method: "POST",
      });
      assert.equal(selected.status, 200, JSON.stringify(selected.body));

      // The run path looks the source up under the stored id.
      assert.equal(
        await resolveActiveInstallFirstConnectorPath(
          "apple_contacts",
          legacyManifest("apple_contacts") as never,
          undefined,
          localStore,
          installStore
        ),
        join(sourceRoot, "dist", "collection-profile.mjs")
      );

      // Add and select neither re-register, hit the catalog, nor touch owner rows.
      assert.equal(registrations, 0, "local-source add/select must not register a manifest");
      assert.equal(catalogLoads, 0, "local-source add/select must not read the catalog");
      const after = await snapshotOwnerRows(sqliteBackend);
      assert.deepEqual(after, before);
      assert.equal(
        after.connectors.some((row) => row.connector_id === "apple-contacts"),
        false,
        "no parallel apple-contacts registration"
      );
      assert.equal(after.instances[0]?.connector_instance_id, "cin_apple_contacts_legacy");

      // Records still read back under the legacy id.
      const read = await fetchJson(
        `${urls.rsUrl}/v1/streams/contacts/records?connector_id=apple_contacts&connector_instance_id=cin_apple_contacts_legacy`,
        { headers: { Authorization: `Bearer ${urls.ownerToken}` } }
      );
      assert.equal(read.status, 200, JSON.stringify(read.body));
      assert.equal(read.body.data.length, 1);
    });
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("/update over HTTP on a legacy-registered github changes only the manifest and manifest_generation", async () => {
  const dir = scratchDir("update");
  try {
    await assertUpdatePreservesOwnerRows(sqliteBackend, join(dir, "data"));
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("/update with a key that has no catalog entry fails and creates no rows", async () => {
  const dir = scratchDir("update-missing");
  try {
    await assertUpdateWithoutCatalogEntryCreatesNothing(sqliteBackend, join(dir, "data"));
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("install then activation keeps a paused instance paused", async () => {
  const dir = scratchDir("paused");
  const catalog = fakeCatalogFor(catalogGithubProfile());
  const service = installServiceFor(join(dir, "data"), catalog);
  try {
    await withLegacyServer({ backend: sqliteBackend, service }, async (urls) => {
      await seedLegacyRegistration(
        sqliteBackend,
        urls,
        "github",
        [{ id: "cin_github_paused", status: "paused" }],
        "repositories"
      );
      const installed = await fetchJson(`${urls.rsUrl}/v1/owner/connector-install/install`, {
        body: JSON.stringify({ connector_id: "github", digest: catalog.entry.digest }),
        headers: { Authorization: `Bearer ${urls.ownerToken}`, "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(installed.status, 201, JSON.stringify(installed.body));
      const row = getDb()
        .prepare("SELECT status, revoked_at FROM connector_instances WHERE connector_instance_id = 'cin_github_paused'")
        .get() as { revoked_at: string | null; status: string };
      assert.deepEqual(row, { revoked_at: null, status: "paused" });
    });
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
