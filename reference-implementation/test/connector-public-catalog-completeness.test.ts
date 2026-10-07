// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Catalog completeness for the reference operator console — and the
 * catalog-vs-connection lifecycle boundary.
 *
 * The honesty contract from
 * `openspec/changes/add-connector-public-listing-honesty/` says any
 * first-party manifest that declares an owner-visible lifecycle tier SHALL be
 * visible in the reference connector catalog after the reference starts up —
 * even on a fresh database, before any schedule, run, or connection row
 * exists. The first-party manifests are the profiles of the verified
 * connector installs; this test installs checked-in published profiles
 * (test/fixtures/collection-profiles/) through the real install service.
 *
 * `openspec/changes/separate-connector-catalog-from-connections/` refines
 * what "visible in the catalog" means: catalog completeness is owned by the
 * registered `connectors` table (the connectors you CAN add), NOT by
 * `connector_instances` (the connections you HAVE configured). A dashboard /
 * catalog read SHALL NOT materialize a default-account `connector_instances`
 * row for every listed connector — a read must not persist a connection, and
 * an owner with zero connections SHALL see zero connections while still being
 * able to discover the full catalog.
 *
 * This test exercises both halves end to end:
 *   1. Initialize a fresh DB and install the fixture profiles.
 *   2. Run `reconcilePolyfillManifests` against the verified installs.
 *   3. Catalog completeness: every listed=true first-party manifest resolves
 *      via `listPublicCatalogConnectorIds()` — which reads registered
 *      manifests, independent of any connection row — and is recognized as a
 *      public catalog connector.
 *   4. Lifecycle boundary: `listConnectorSummaries()` (the owner connection
 *      projection) returns ZERO connections on a fresh DB, and the read
 *      persists ZERO `connector_instances` rows (no phantom default-account
 *      connections).
 *
 * The complement (hidden / unproven / local-device manifests stay
 * out of the public catalog) is asserted at the unit level in
 * `polyfill-manifest-reconcile-invalidation.test.js` and the
 * per-manifest catalog filter is pinned in
 * `ref-connectors-list-operation.test.js`. Both paths are kept
 * independent so a regression in one cannot mask the other.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readPolyfillManifests } from "@pdpp/polyfill-connectors/manifests";
import type { ConnectorInstallStore } from "../server/connector-install/index.ts";
import { canonicalConnectorKey } from "../server/connector-key.ts";
import { validateConnectorManifest } from "../server/connector-manifest-validation.ts";
import { closeDb, initDb } from "../server/db.ts";
import { reconcilePolyfillManifests } from "../server/polyfill-manifest-reconcile.ts";
import { listConnectorSummaries, listPublicCatalogConnectorIds } from "../server/ref-control.ts";
import { createSqliteConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";
import { installCollectionProfiles, readCollectionProfileFixture } from "./helpers/installed-collection-profiles.ts";

const REFERENCE_OWNER_SUBJECT_ID = "owner_local";
const INSTALLED_PROFILE_KEYS = ["github", "gmail", "ical", "ynab"] as const;

interface FirstPartyManifestFixture {
  capabilities?: { public_listing?: { tier?: string } };
  connector_id?: unknown;
}

function firstPartyManifests(): FirstPartyManifestFixture[] {
  return INSTALLED_PROFILE_KEYS.map((key) => readCollectionProfileFixture(key) as FirstPartyManifestFixture);
}

// The operator catalog projects connectors under their canonical connector
// key (Decision 1), so the expected sets here resolve each manifest's
// URL-shaped connector_id to its canonical key before comparing against the
// surface output. canonicalConnectorKey(x) ?? x leaves non-first-party shapes
// untouched, matching the runtime's own identity function.
function ownerVisibleConnectorIds(): string[] {
  const ids: string[] = [];
  for (const manifest of firstPartyManifests()) {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
    const tier = manifest?.capabilities?.public_listing?.tier;
    if ((tier === "supported" || tier === "preview") && typeof manifest.connector_id === "string") {
      ids.push(canonicalConnectorKey(manifest.connector_id) ?? manifest.connector_id);
    }
  }
  // biome-ignore lint/suspicious/useArraySortCompare: Fixture values use the runtime default sort semantics under test.
  return ids.sort();
}

function developmentConnectorIds(): string[] {
  const ids: string[] = [];
  for (const manifest of firstPartyManifests()) {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
    if (manifest?.capabilities?.public_listing?.tier === "development" && typeof manifest.connector_id === "string") {
      ids.push(canonicalConnectorKey(manifest.connector_id) ?? manifest.connector_id);
    }
  }
  // biome-ignore lint/suspicious/useArraySortCompare: Fixture values use the runtime default sort semantics under test.
  return ids.sort();
}

function withTmpDb(fn: (installStore: ConnectorInstallStore) => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "pdpp-public-catalog-completeness-"));
    initDb(join(dir, "pdpp.sqlite"));
    try {
      const { store } = await installCollectionProfiles(
        join(dir, "connector-installs"),
        firstPartyManifests() as Record<string, unknown>[]
      );
      await fn(store);
    } finally {
      closeDb();
      rmSync(dir, { force: true, recursive: true });
    }
  };
}

test(
  "startup reconciliation scans exactly the verified installs",
  withTmpDb(async (installStore) => {
    // Defensive: if the reconcile source ever drifts from the install store,
    // every later assertion in this file becomes vacuously true.
    const summary = await reconcilePolyfillManifests({
      enabled: true,
      installStore,
      log: () => {
        /* intentionally empty */
      },
    });
    assert.equal(summary.disabled_reason, null);
    assert.equal(summary.scanned, INSTALLED_PROFILE_KEYS.length);
  })
);

// This check still reads the pinned development package's manifest set. It
// validates connector data rather than a reference-implementation manifest
// source, and moves to the published profiles when that pin is removed.
test("every shipped first-party manifest passes the live registration validator", () => {
  const failures: string[] = [];
  for (const entry of readPolyfillManifests()) {
    try {
      validateConnectorManifest(entry.manifest as Record<string, unknown>);
    } catch (error) {
      failures.push(`${entry.file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  assert.deepEqual(
    failures,
    [],
    `shipped manifests rejected by the live registration validator:\n${failures.join("\n")}`
  );
});

test(
  "every owner-visible first-party manifest is catalog-visible after startup reconciliation, with no connection row",
  withTmpDb(async (installStore) => {
    const expectedListed = ownerVisibleConnectorIds();
    assert.ok(
      expectedListed.length > 0,
      "first-party manifest set must contain at least one owner-visible manifest for this test to be meaningful"
    );

    const summary = await reconcilePolyfillManifests({
      enabled: true,
      installStore,
      log: () => {
        /* intentionally empty */
      },
    });

    assert.equal(summary.errors, 0, "reconciliation completes without errors");
    assert.ok(
      summary.registered >= expectedListed.length,
      `reconciliation must register at least every listed manifest (registered=${summary.registered}, listed=${expectedListed.length})`
    );

    // Catalog completeness is owned by the registered connectors table, not by
    // connection rows. The public catalog projection (`listPublicCatalogConnectorIds`,
    // which reads the registered `connectors` table filtered by
    // `isPublicReferenceConnector` and creates no connection row) must contain
    // every listed=true first-party connector.
    const catalog = await listPublicCatalogConnectorIds();
    const visible = new Set(catalog);
    const missing = expectedListed.filter((id) => !visible.has(id));
    assert.deepEqual(
      missing,
      [],
      `listed=true first-party manifests must appear in the public connector catalog after startup: missing ${missing.join(", ")}`
    );
  })
);

test(
  "a fresh-DB catalog read projects zero connections and persists no phantom connection rows",
  withTmpDb(async (installStore) => {
    await reconcilePolyfillManifests({
      enabled: true,
      installStore,
      log: () => {
        /* intentionally empty */
      },
    });

    const store = createSqliteConnectorInstanceStore();
    // Pre-condition: a freshly reconciled instance has registered connectors
    // but no configured connections.
    assert.equal(
      store.listByOwner(REFERENCE_OWNER_SUBJECT_ID).length,
      0,
      "fresh instance starts with zero connector_instances rows"
    );

    // The owner connection projection is the path that previously
    // materialized one default-account connection per registered connector.
    const summaries = await listConnectorSummaries();
    assert.equal(
      summaries.length,
      0,
      `owner with zero connections must see zero connections, not phantom catalog rows (saw ${summaries.length})`
    );

    // The read SHALL NOT persist a connection. After the projection, the
    // owner's connector_instances set must still be empty.
    assert.equal(
      store.listByOwner(REFERENCE_OWNER_SUBJECT_ID).length,
      0,
      "catalog/dashboard read must not persist any connector_instances row"
    );
  })
);

test(
  "Development first-party manifests stay out of the public catalog",
  withTmpDb(async (installStore) => {
    const hidden = developmentConnectorIds();
    assert.ok(
      hidden.length > 0,
      "first-party manifest set must contain at least one hidden manifest for this test to be meaningful"
    );

    await reconcilePolyfillManifests({
      enabled: true,
      installStore,
      log: () => {
        /* intentionally empty */
      },
    });

    const catalog = new Set(await listPublicCatalogConnectorIds());
    const leaks = hidden.filter((id) => catalog.has(id));
    assert.deepEqual(
      leaks,
      [],
      `hidden / unproven first-party manifests must NOT be public catalog connectors: leaked ${leaks.join(", ")}`
    );
  })
);
