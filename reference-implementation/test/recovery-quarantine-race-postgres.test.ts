// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { closeDb, initDb } from "../server/db.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import { createPostgresConnectorDetailGapStore } from "../server/stores/connector-detail-gap-store.ts";
import { maybeQuarantineGap } from "../server/stores/terminal-gap-classifier.ts";

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;
const CONNECTOR_ID = "quarantine_cas_race";
const INSTANCE_ID = "cin_quarantine_cas_race";

test("Postgres quarantine compare-and-swap preserves a concurrent recovery", { skip: !POSTGRES_URL }, async () => {
  initDb(":memory:");
  await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL as string });
  const store = createPostgresConnectorDetailGapStore();
  try {
    const gap = await store.upsertPendingGap({
      connectorId: CONNECTOR_ID,
      connectorInstanceId: INSTANCE_ID,
      detailLocator: { id: "gap", kind: "test" },
      grantId: "grant_test",
      reason: "temporary_unavailable",
      recordKey: "gap",
      stream: "messages",
    });
    assert.ok(gap);
    await store.markGapStatus(gap.gap_id, "in_progress");
    let intercepted = false;
    const adapter: Parameters<typeof maybeQuarantineGap>[0] = {
      getGapById: async (id) => {
        const snapshot = await store.getGapById(id);
        if (!intercepted && snapshot) {
          intercepted = true;
          await store.markGapStatus(id, "recovered", { runId: "winning_recovery" });
        }
        return snapshot ? { ...snapshot } : null;
      },
      markGapQuarantined: async (id, expectedStatus, expectedAttemptCount, options) => {
        const result = await store.markGapQuarantined(id, expectedStatus, expectedAttemptCount, options);
        return result ? { ...result } : null;
      },
      markGapStatus: async (id, status, options) => {
        const result = await store.markGapStatus(id, status, options);
        return result ? { ...result } : null;
      },
    };

    const outcome = await maybeQuarantineGap(
      adapter,
      gap.gap_id,
      { failure_class: "interrupted" },
      { maxNoProgressAttempts: 1 }
    );

    assert.equal(intercepted, true);
    assert.equal((await store.getGapById(gap.gap_id))?.status, "recovered");
    assert.equal(outcome.quarantined, false);
  } finally {
    await postgresQuery("DELETE FROM connector_detail_gaps WHERE connector_id = $1", [CONNECTOR_ID]);
    await closePostgresStorage();
    closeDb();
  }
});
