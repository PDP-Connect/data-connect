// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The scheduler's durable recovery probes must not count or project permanent
 * source loss (`retryable: false`). Two copies of the probes exist
 * (`server/scheduler-manager-factory.ts` and an inline pair in
 * `server/index.ts`); the fix extracts/exports the factory functions and has
 * index.ts reuse them, so one test pins both. Rows are read back from a REAL
 * SQLite store, not hand-built.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeDb, initDb } from "../server/db.ts";
import { countNonPressureGaps, mapPressureGaps } from "../server/scheduler-manager-factory.ts";
import { createSqliteConnectorDetailGapStore } from "../server/stores/connector-detail-gap-store.ts";

const CONNECTOR = "probe_conn";
const INSTANCE = "cin_probe";

async function seededRows() {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-permanent-gap-probes-"));
  initDb(join(dir, "pdpp.sqlite"));
  const store = createSqliteConnectorDetailGapStore();
  const seed = (recordKey: string, reason: string, retryable?: boolean) =>
    store.upsertPendingGap({
      connectorId: CONNECTOR,
      connectorInstanceId: INSTANCE,
      detailLocator: { item: recordKey, kind: "test.item" },
      reason,
      recordKey,
      ...(retryable === undefined ? {} : { retryable }),
      stream: "messages",
    });
  await seed("p1", "source_unrepresentable", false);
  await seed("p2", "rate_limited", false); // pressure-looking reason, explicit false
  await seed("t1", "temporary_unavailable", true);
  await seed("t2", "rate_limited", true);
  await seed("l1", "retry_exhausted"); // legacy NULL
  const rows = await store.listPendingGapsForConnector(CONNECTOR);
  return {
    cleanup: () => {
      closeDb();
      rmSync(dir, { force: true, recursive: true });
    },
    rows,
  };
}

test("non-pressure recovery probe counts only retryable and legacy rows", async () => {
  const { cleanup, rows } = await seededRows();
  try {
    assert.equal(rows.length, 5, "all five losses are inspectable");
    assert.equal(
      countNonPressureGaps(rows, INSTANCE, CONNECTOR),
      2,
      "t1 (true) and l1 (legacy NULL) count; p1 and p2 (explicit false) do not launch a doomed recovery-only run"
    );
  } finally {
    cleanup();
  }
});

test("pressure probe never projects a permanent gap into the cooldown, even with a pressure-looking reason", async () => {
  const { cleanup, rows } = await seededRows();
  try {
    const pressure = mapPressureGaps(rows, INSTANCE, CONNECTOR);
    assert.deepEqual(
      pressure.map((gap) => gap.reason),
      ["rate_limited"],
      "only the retryable rate_limited row (t2) arms the cooldown; p2 (false) does not"
    );
  } finally {
    cleanup();
  }
});
