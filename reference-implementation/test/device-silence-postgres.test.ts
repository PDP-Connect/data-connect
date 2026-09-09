// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PostgreSQL coverage for the silence query.
 *
 * The `.sql` artifacts under `server/queries/` are read only by the SQLite code
 * path, so the PostgreSQL implementation carries its own hand-written copy of
 * this statement in `device-exporter-store.ts`. Nothing keeps the two in sync,
 * and they are not textually identical: the exclusion tests a JSON field, which
 * SQLite reaches with `json_extract` and PostgreSQL with `->>`. JSON handling is
 * exactly where the two engines diverge, so the copy that no test executed was
 * the one most able to rot.
 *
 * These run only when `PDPP_TEST_POSTGRES_URL` names a database, following the
 * pattern in `run-connection-identity-postgres.test.ts`. They skip otherwise
 * rather than silently passing against SQLite.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import { getDefaultConnectorAttentionStore } from "../server/stores/connector-attention-store.ts";
import { createPostgresDeviceExporterStore } from "../server/stores/device-exporter-store.ts";
import {
  createDeviceSilenceStage,
  DEVICE_SILENT_ESCALATION_MS,
  deviceSilenceAttentionId,
} from "../server/stores/device-silence-stage.ts";

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;
const NOW = "2026-05-19T12:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const SILENT_AT = new Date(NOW_MS - DEVICE_SILENT_ESCALATION_MS * 2).toISOString();

async function resetFixtures(): Promise<void> {
  await postgresQuery("DELETE FROM connector_attention_records WHERE reason_code = $1", ["device_collector_silent"]);
  await postgresQuery("DELETE FROM device_source_instances WHERE device_id LIKE $1", ["dev_pgsilence%"]);
  await postgresQuery("DELETE FROM device_exporters WHERE device_id LIKE $1", ["dev_pgsilence%"]);
}

async function seed(sourceInstanceIds: readonly string[]): Promise<void> {
  const store = createPostgresDeviceExporterStore();
  const createdAt = new Date(NOW_MS - DEVICE_SILENT_ESCALATION_MS * 3).toISOString();
  await store.createDevice({
    createdAt,
    deviceId: "dev_pgsilence",
    displayName: "dev_pgsilence",
    ownerSubjectId: "owner_local",
    updatedAt: createdAt,
  });
  for (const sourceInstanceId of sourceInstanceIds) {
    await store.upsertSourceInstance({
      connectorId: "claude_code",
      createdAt,
      deviceId: "dev_pgsilence",
      localBindingId: sourceInstanceId,
      sourceInstanceId,
      updatedAt: createdAt,
    });
    await store.markSourceInstanceHeartbeat("dev_pgsilence", sourceInstanceId, {
      receivedAt: SILENT_AT,
      recordsPending: 0,
      status: "healthy",
    });
  }
}

function withPostgres(fn: () => Promise<void>) {
  return async () => {
    assert.ok(POSTGRES_URL, "Postgres URL is configured when this test runs");
    await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
    try {
      await resetFixtures();
      await fn();
    } finally {
      await resetFixtures().catch(() => {
        // Best effort; the next run resets again before seeding.
      });
      await closePostgresStorage();
    }
  };
}

test(
  "Postgres: the silence query reports an unreported collector and then stops",
  { skip: !POSTGRES_URL },
  withPostgres(async () => {
    await seed(["dsi_pg_1"]);
    const attentionStore = getDefaultConnectorAttentionStore();
    const stage = createDeviceSilenceStage();

    const first = await stage.run({ nowIso: NOW });
    assert.equal(first.detected, 1);
    const attentionId = deviceSilenceAttentionId("dsi_pg_1", SILENT_AT);
    assert.equal(first.opened[0]?.attentionId, attentionId);

    // The `->>` exclusion only works if the id PostgreSQL rebuilds in SQL matches
    // the one the writer built — the same coupling the SQLite test pins.
    await attentionStore.recordNotificationOutcomeById({ attentionId, outcome: "sent", reason: null });
    const second = await stage.run({ nowIso: new Date(NOW_MS + 60_000).toISOString() });
    assert.equal(second.detected, 0, "a delivered episode is excluded by the JSONB accessor");
  })
);

test(
  "Postgres: an undelivered notice stays retryable but an owner decision does not",
  { skip: !POSTGRES_URL },
  withPostgres(async () => {
    await seed(["dsi_pg_retry", "dsi_pg_owner"]);
    const attentionStore = getDefaultConnectorAttentionStore();
    const stage = createDeviceSilenceStage();

    const first = await stage.run({ nowIso: NOW });
    assert.equal(first.detected, 2);

    // Neither was delivered. One is left alone; the owner resolves the other.
    await attentionStore.transitionAttention({
      attentionId: deviceSilenceAttentionId("dsi_pg_owner", SILENT_AT),
      to: "resolved",
    });

    const second = await stage.run({ nowIso: new Date(NOW_MS + 60_000).toISOString() });
    const ids = second.opened.map((entry) => entry.attentionId);
    assert.deepEqual(
      ids,
      [deviceSilenceAttentionId("dsi_pg_retry", SILENT_AT)],
      "the undelivered notice is retried and the resolved one is not reopened"
    );
    assert.equal(
      (await attentionStore.getAttentionById(deviceSilenceAttentionId("dsi_pg_owner", SILENT_AT)))?.lifecycle,
      "resolved"
    );
  })
);

test(
  "Postgres: never-reported collectors are ordered ahead of retries",
  { skip: !POSTGRES_URL },
  withPostgres(async () => {
    // The ordering that keeps a correlated delivery failure from monopolising
    // every batch. Expressed as a correlated subquery, so it is a second place
    // the two hand-copied statements can diverge.
    await seed(["dsi_pg_a", "dsi_pg_b", "dsi_pg_c"]);
    const stage = createDeviceSilenceStage();

    // One instance per tick, so ordering decides which.
    const first = await stage.run({ maxInstances: 1, nowIso: NOW });
    const firstId = first.opened[0]?.attentionId;
    assert.ok(firstId);

    const second = await stage.run({ maxInstances: 1, nowIso: new Date(NOW_MS + 60_000).toISOString() });
    assert.notEqual(
      second.opened[0]?.attentionId,
      firstId,
      "the second tick moves on to a collector with no record rather than retrying the first"
    );
  })
);
