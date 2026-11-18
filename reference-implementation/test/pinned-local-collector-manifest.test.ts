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
import {
  getConnectorManifest as getConnectorManifestUntyped,
  normalizeConnectorManifestForStorage,
  registerConnector,
} from "../server/auth.ts";
import { installedConnectorManifestRegistration } from "../server/connector-install/manifest-registration.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { pinnedLocalCollectorManifest } from "../server/local-collector-profiles.ts";
import { reconcilePolyfillManifests } from "../server/polyfill-manifest-reconcile.ts";
import { listPendingRecordDerivedRepairs, runRecordDerivedRepairRound } from "../server/record-derived-repair.ts";
import { ingestRecords } from "../server/records.ts";
import { configureSemanticBackend, makeStubBackend } from "../server/search-semantic.ts";

const getConnectorManifest = getConnectorManifestUntyped as (id: string) => Promise<{ version?: string } | null>;

const CONNECTOR_KEY = "claude-code";
const INSTANCE_ID = "cin_pinned_manifest_test";
const STARTED_AT = "2026-01-01T00:00:00.000Z";
const LAST_EVENT_AT = "2026-02-01T00:00:00.000Z";

interface StreamDeclaration extends Record<string, unknown> {
  consent_time_field?: string;
  name: string;
  primary_key: string[];
  schema: { properties: Record<string, unknown> } & Record<string, unknown>;
}

function pinnedManifest(): Record<string, unknown> {
  const pinned = pinnedLocalCollectorManifest(CONNECTOR_KEY);
  assert.ok(pinned, "claude-code is a pinned local-collector connector");
  return pinned;
}

/**
 * A catalog release that differs from the pin where the server observes it:
 * the `sessions` stream is keyed by `uuid` instead of `id` (upload identity
 * validation) and takes its semantic time from `last_event_at` instead of
 * `started_at` (a derived column the repair rewrites).
 */
function catalogRelease(): Record<string, unknown> {
  const pinned = pinnedManifest();
  const streams = (pinned.streams as StreamDeclaration[]).map((stream) =>
    stream.name === "sessions"
      ? {
          ...stream,
          consent_time_field: "last_event_at",
          primary_key: ["uuid"],
          schema: { ...stream.schema, properties: { ...stream.schema.properties, uuid: { type: "string" } } },
        }
      : stream
  );
  return { ...pinned, streams, version: "99.0.0" };
}

function storageConnectorId(): string {
  return normalizeConnectorManifestForStorage(pinnedManifest()).connectorId;
}

async function storedVersion(): Promise<string | undefined> {
  return (await getConnectorManifest(CONNECTOR_KEY))?.version;
}

/** Valid under the pinned contract only: `id` is the pinned key, `uuid` disagrees with the key. */
const PINNED_ONLY_RECORD = {
  data: { id: "s-pinned", last_event_at: LAST_EVENT_AT, started_at: STARTED_AT, uuid: "someone-else" },
  emitted_at: LAST_EVENT_AT,
  key: "s-pinned",
  stream: "sessions",
};

/** Valid under the catalog contract only: `uuid` is the catalog key, `id` disagrees with the key. */
const CATALOG_ONLY_RECORD = {
  data: { id: "someone-else", last_event_at: LAST_EVENT_AT, started_at: STARTED_AT, uuid: "s-catalog" },
  emitted_at: LAST_EVENT_AT,
  key: "s-catalog",
  stream: "sessions",
};

async function upload(record: typeof PINNED_ONLY_RECORD): Promise<boolean> {
  const [outcome] = await ingestRecords({ connector_id: storageConnectorId(), connector_instance_id: INSTANCE_ID }, [record]);
  return outcome?.accepted === true;
}

/** The upload contract the server enforces right now: the pinned one accepts, the catalog one rejects. */
async function assertUploadsFollowThePin(): Promise<void> {
  assert.equal(await upload(PINNED_ONLY_RECORD), true, "a record valid under the pinned contract is accepted");
  assert.equal(await upload(CATALOG_ONLY_RECORD), false, "a record valid only under the catalog contract is rejected");
}

function semanticTime(key: string): string | undefined {
  return getDb()
    .prepare("SELECT semantic_time FROM records WHERE connector_instance_id = ? AND stream = 'sessions' AND record_key = ?")
    .get<{ semantic_time: string }>(INSTANCE_ID, key)?.semantic_time;
}

function seedConnectorInstance(): void {
  getDb()
    .prepare(
      `INSERT INTO connector_instances(
        connector_instance_id, owner_subject_id, connector_id, display_name,
        source_kind, source_binding_key, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(INSTANCE_ID, "owner_test", storageConnectorId(), "Claude Code", "local_device", "device_test", STARTED_AT, STARTED_AT);
}

function withTmpDb(fn: (dir: string, dbPath: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "pdpp-pinned-manifest-"));
    const dbPath = join(dir, "pdpp.sqlite");
    initDb(dbPath);
    // The pinned profile declares semantic fields; search repair needs a backend to prove them.
    configureSemanticBackend(makeStubBackend({ dimensions: 32 }));
    try {
      await fn(dir, dbPath);
    } finally {
      configureSemanticBackend(null);
      closeDb();
      rmSync(dir, { force: true, recursive: true });
    }
  };
}

test(
  "a catalog install keeps the pinned manifest and the pinned upload contract, before and after repair",
  withTmpDb(async () => {
    await registerConnector(pinnedManifest(), { replaceAcceptedDigest: true });
    seedConnectorInstance();

    await installedConnectorManifestRegistration.registerManifest(catalogRelease());
    assert.equal(await storedVersion(), pinnedManifest().version);
    await assertUploadsFollowThePin();

    await installedConnectorManifestRegistration.repairManifestDerivedState(catalogRelease());
    assert.equal(await storedVersion(), pinnedManifest().version);
    await assertUploadsFollowThePin();
  })
);

test(
  "a catalog install re-derives record columns from the pinned manifest and drains the repair queue",
  withTmpDb(async () => {
    // State before the fix shipped: the catalog release is registered and a record
    // was ingested under it, so its semantic time came from `last_event_at`.
    await registerConnector(catalogRelease(), { replaceAcceptedDigest: true });
    seedConnectorInstance();
    assert.equal(await upload(CATALOG_ONLY_RECORD), true);
    assert.equal(semanticTime("s-catalog"), LAST_EVENT_AT);

    await installedConnectorManifestRegistration.registerManifest(catalogRelease());
    const queued = await listPendingRecordDerivedRepairs({ connectorId: storageConnectorId() });
    assert.ok(
      queued.some((repair) => repair.stream === "sessions" && repair.connectorInstanceId === INSTANCE_ID),
      "the install queues a repair for the seeded connection and stream"
    );

    await installedConnectorManifestRegistration.repairManifestDerivedState(catalogRelease());

    assert.equal(semanticTime("s-catalog"), STARTED_AT, "semantic time is re-derived from the pinned consent_time_field");
    assert.deepEqual(await listPendingRecordDerivedRepairs({ connectorId: storageConnectorId() }), []);
    assert.deepEqual(await runRecordDerivedRepairRound({ connectorId: storageConnectorId() }), {
      attempted: 0,
      completed: 0,
      failed: 0,
      incomplete: false,
    });
  })
);

test(
  "after a real restart, boot reconcile moves a replaced row back to the pin and keeps it there",
  withTmpDb(async (dir, dbPath) => {
    const manifestsDir = join(dir, "catalog");
    mkdirSync(manifestsDir);
    writeFileSync(join(manifestsDir, "claude-code.json"), JSON.stringify(catalogRelease()));

    // The row a catalog install replaced before this fix shipped.
    await registerConnector(catalogRelease(), { replaceAcceptedDigest: true });
    assert.equal(await storedVersion(), "99.0.0");

    // Restart: close the database and open the same file again.
    closeDb();
    initDb(dbPath);
    assert.equal(await storedVersion(), "99.0.0", "the replaced row survives the restart");

    const first = await reconcilePolyfillManifests({ manifestsDir });
    assert.equal(first.updated, 1);
    assert.equal(await storedVersion(), pinnedManifest().version);
    seedConnectorInstance();
    await assertUploadsFollowThePin();

    // A second restart finds nothing to change.
    closeDb();
    initDb(dbPath);
    const second = await reconcilePolyfillManifests({ manifestsDir });
    assert.equal(second.unchanged, 1);
    assert.equal(await storedVersion(), pinnedManifest().version);
  })
);
