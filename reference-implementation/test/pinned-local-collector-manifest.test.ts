// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The local collector runs a pinned release on the owner's device, and the
 * server validates that device's uploads against the pinned profile. A catalog
 * install of the same connector, or the boot reconcile that follows it, must
 * not replace that manifest with a release the device does not run.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getConnectorManifest as getConnectorManifestUntyped, registerConnector } from "../server/auth.ts";
import { installedConnectorManifestRegistration } from "../server/connector-install/manifest-registration.ts";
import { closeDb, initDb } from "../server/db.ts";
import { pinnedLocalCollectorManifest } from "../server/local-collector-profiles.ts";
import { reconcilePolyfillManifests } from "../server/polyfill-manifest-reconcile.ts";

const getConnectorManifest = getConnectorManifestUntyped as (id: string) => Promise<{ version?: string } | null>;

const CONNECTOR_KEY = "claude-code";

function pinnedManifest(): Record<string, unknown> {
  const pinned = pinnedLocalCollectorManifest(CONNECTOR_KEY);
  assert.ok(pinned, "claude-code is a pinned local-collector connector");
  return pinned;
}

function catalogRelease(): Record<string, unknown> {
  return { ...pinnedManifest(), version: "99.0.0" };
}

async function storedVersion(): Promise<string | undefined> {
  return (await getConnectorManifest(CONNECTOR_KEY))?.version;
}

function withTmpDb(fn: (dir: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "pdpp-pinned-manifest-"));
    initDb(join(dir, "pdpp.sqlite"));
    try {
      await fn(dir);
    } finally {
      closeDb();
      rmSync(dir, { force: true, recursive: true });
    }
  };
}

test(
  "a catalog install does not replace the pinned local-collector manifest",
  withTmpDb(async () => {
    const pinnedVersion = pinnedManifest().version as string;
    await registerConnector(pinnedManifest(), { replaceAcceptedDigest: true });

    await installedConnectorManifestRegistration.registerManifest(catalogRelease());
    await installedConnectorManifestRegistration.repairManifestDerivedState(catalogRelease());

    assert.equal(await storedVersion(), pinnedVersion);
  })
);

test(
  "a restart reconciles a replaced row back to the pinned manifest, and keeps it there",
  withTmpDb(async (dir) => {
    const pinnedVersion = pinnedManifest().version as string;
    const manifestsDir = join(dir, "catalog");
    mkdirSync(manifestsDir);
    writeFileSync(join(manifestsDir, "claude-code.json"), JSON.stringify(catalogRelease()));

    // The row a catalog install replaced before this fix shipped.
    await registerConnector(catalogRelease(), { replaceAcceptedDigest: true });
    assert.equal(await storedVersion(), "99.0.0");

    const first = await reconcilePolyfillManifests({ manifestsDir });
    assert.equal(first.updated, 1);
    assert.equal(await storedVersion(), pinnedVersion);

    const second = await reconcilePolyfillManifests({ manifestsDir });
    assert.equal(second.unchanged, 1);
    assert.equal(await storedVersion(), pinnedVersion);
  })
);
