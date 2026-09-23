// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Runtime controller — connector path resolution.
 *
 * Regression: the reference fixture manifest and a catalog Collection
 * Profile can share a `connector_id`. GitHub is the live example today:
 * reference-implementation/fixtures/seed-manifests/github.json and the
 * published github profile both use connector_id
 * https://registry.pdpp.dev/connectors/github. A controller-triggered
 * catalog GitHub run once executed the reference seed connector, whose
 * GitHub fixture emits a `commits` PROGRESS stream the catalog manifest
 * does not declare. That surfaced in production as:
 *
 *   run.failed reason=connector_protocol_violation
 *   subtype=progress_for_undeclared_stream message_type=PROGRESS
 *   stream=commits expected=[user, repositories, starred, issues,
 *   pull_requests, gists]
 *
 * Catalog connectors now execute only from a verified install record. These
 * tests prove the resolver picks the installed profile's entrypoint when one
 * is active, still picks the reference seed for the reference fixture, and
 * resolves no catalog code at all for a connector that is not installed.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  __resetControllerPathResolverCachesForTests,
  type ConnectorManifest,
  resolveActiveInstallFirstConnectorPath,
  resolveDefaultConnectorPath,
} from "../runtime/controller.ts";
import { createFileLocalConnectorSourceStore } from "../server/connector-install/local-source.ts";
import { canonicalConnectorKeyFromManifest } from "../server/connector-key.ts";
import { installCollectionProfiles, readCollectionProfileFixture } from "./helpers/installed-collection-profiles.ts";

const SEED_CONNECTOR_PATH_REGEX = /reference-implementation\/connectors\/seed\/index\.ts$/;
const INVALID_INSTALL_REGEX = /Active connector install is invalid for github/;

interface FixtureManifest extends ConnectorManifest {
  readonly connector_id: string;
  readonly streams: readonly { name: string }[];
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, "..");
const REFERENCE_MANIFESTS_DIR = join(REFERENCE_IMPL_DIR, "fixtures", "seed-manifests");

function readManifest(dir: string, file: string): FixtureManifest {
  return JSON.parse(readFileSync(join(dir, file), "utf8"));
}

async function withInstalls(
  keys: readonly string[],
  fn: (stores: {
    installStore: Awaited<ReturnType<typeof installCollectionProfiles>>["store"];
    localStore: ReturnType<typeof createFileLocalConnectorSourceStore>;
    records: Awaited<ReturnType<typeof installCollectionProfiles>>["records"];
  }) => Promise<void>
): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-connector-path-resolution-"));
  try {
    const { records, store } = await installCollectionProfiles(
      dataDir,
      keys.map((key) => readCollectionProfileFixture(key))
    );
    await fn({ installStore: store, localStore: createFileLocalConnectorSourceStore(dataDir), records });
  } finally {
    rmSync(dataDir, { force: true, recursive: true });
  }
}

test("resolves the installed GitHub profile when the active manifest is the catalog manifest", async () => {
  __resetControllerPathResolverCachesForTests();
  const catalogGithub = readCollectionProfileFixture("github") as unknown as FixtureManifest;
  const referenceGithub = readManifest(REFERENCE_MANIFESTS_DIR, "github.json");

  // Sanity: the collision is real, otherwise this regression cannot trip.
  assert.equal(catalogGithub.connector_id, referenceGithub.connector_id);
  assert.notDeepEqual(
    [...catalogGithub.streams.map((s) => s.name)].sort(),
    [...referenceGithub.streams.map((s) => s.name)].sort(),
    "manifests must differ in declared streams; otherwise the seed could not violate the catalog manifest"
  );

  await withInstalls(["github"], async ({ installStore, localStore, records }) => {
    const resolved = await resolveActiveInstallFirstConnectorPath(
      "github",
      catalogGithub,
      undefined,
      localStore,
      installStore
    );
    assert.equal(resolved, join(records[0]?.root ?? "", "dist", "collection-profile.mjs"));
    assert.doesNotMatch(
      resolved ?? "",
      SEED_CONNECTOR_PATH_REGEX,
      "an installed GitHub run must not fall through to the reference seed fixture"
    );
    // Without a manifest hint the install record still wins over the seed.
    assert.equal(
      await resolveActiveInstallFirstConnectorPath("github", undefined, undefined, localStore, installStore),
      resolved
    );
  });
});

test("an installed profile whose bytes changed stops resolution instead of falling back", async () => {
  __resetControllerPathResolverCachesForTests();
  const catalogGithub = readCollectionProfileFixture("github") as unknown as FixtureManifest;
  await withInstalls(["github"], async ({ installStore, localStore, records }) => {
    writeFileSync(join(records[0]?.root ?? "", "dist", "collection-profile.mjs"), "tampered\n");
    await assert.rejects(
      resolveActiveInstallFirstConnectorPath("github", catalogGithub, undefined, localStore, installStore),
      INVALID_INSTALL_REGEX
    );
  });
});

test("resolves reference seed when active manifest is the reference GitHub fixture", () => {
  __resetControllerPathResolverCachesForTests();
  const referenceGithub = readManifest(REFERENCE_MANIFESTS_DIR, "github.json");
  const resolved = resolveDefaultConnectorPath(referenceGithub.connector_id, referenceGithub);
  assert.ok(resolved, "reference GitHub fixture must still resolve");
  assert.match(resolved, SEED_CONNECTOR_PATH_REGEX, `expected reference seed, got ${resolved}`);
});

test("a catalog GitHub manifest with no active install fails closed instead of running the seed", async () => {
  // The seed GitHub fixture shares this connector_id. Running it for the
  // catalog manifest would persist its synthetic records as owner data.
  __resetControllerPathResolverCachesForTests();
  const catalogGithub = readCollectionProfileFixture("github") as unknown as FixtureManifest;
  assert.equal(resolveDefaultConnectorPath(catalogGithub.connector_id, catalogGithub), null);
  assert.equal(resolveDefaultConnectorPath("github", { ...catalogGithub, connector_id: "github" }), null);
  await withInstalls([], async ({ installStore, localStore }) => {
    assert.equal(
      await resolveActiveInstallFirstConnectorPath("github", catalogGithub, undefined, localStore, installStore),
      null
    );
  });
});

test("the seed is not selected without a manifest to match against the reference fixture", () => {
  __resetControllerPathResolverCachesForTests();
  const referenceGithub = readManifest(REFERENCE_MANIFESTS_DIR, "github.json");
  assert.equal(resolveDefaultConnectorPath(referenceGithub.connector_id), null);
});

test("a catalog connector that is not installed resolves no connector code", async () => {
  __resetControllerPathResolverCachesForTests();
  const ynab = readCollectionProfileFixture("ynab") as unknown as FixtureManifest;
  await withInstalls([], async ({ installStore, localStore }) => {
    assert.equal(resolveDefaultConnectorPath(ynab.connector_id, ynab), null);
    assert.equal(
      await resolveActiveInstallFirstConnectorPath(ynab.connector_id, ynab, undefined, localStore, installStore),
      null
    );
  });
});

test("an installed catalog connector with no reference fixture resolves to its installed entrypoint", async () => {
  __resetControllerPathResolverCachesForTests();
  const ynab = readCollectionProfileFixture("ynab") as unknown as FixtureManifest;
  await withInstalls(["ynab"], async ({ installStore, localStore, records }) => {
    const resolved = await resolveActiveInstallFirstConnectorPath("ynab", ynab, undefined, localStore, installStore);
    assert.equal(resolved, join(records[0]?.root ?? "", "dist", "collection-profile.mjs"));
  });
});

test("resolves canonical connector keys for URL-shaped reference fixture manifests", () => {
  __resetControllerPathResolverCachesForTests();
  const spotify = readManifest(REFERENCE_MANIFESTS_DIR, "spotify.json");
  const canonicalKey = canonicalConnectorKeyFromManifest(spotify);
  assert.equal(canonicalKey, "spotify");

  const storedManifest = {
    ...spotify,
    connector_id: canonicalKey,
    manifest_uri: spotify.connector_id,
  };
  const resolved = resolveDefaultConnectorPath(canonicalKey, storedManifest);
  assert.ok(resolved, "canonical spotify key must resolve to a runnable connector path");
  assert.match(resolved, SEED_CONNECTOR_PATH_REGEX, `expected reference seed for canonical spotify key, got ${resolved}`);
});
