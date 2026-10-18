// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { createDetailGapPageReader } from "../runtime/detail-gap-paging.ts";

type DetailGapStoreParam = Parameters<typeof createDetailGapPageReader>[0]["detailGapStore"];

test("detail page byte accounting includes lease tokens for individually fitting rows", async () => {
  const budget = 16 * 1024;
  const runId = "r".repeat(400);
  const rows = ["a", "b"].map((gap_id) => ({
    detail_locator: "x".repeat(7900),
    gap_id,
    record_key: gap_id,
    status: "pending",
    stream: "messages",
  }));
  const store: DetailGapStoreParam = {
    claimPendingGaps(ids) {
      return Promise.resolve(ids.filter((id): id is string => typeof id === "string"));
    },
    listPendingGaps() {
      return Promise.resolve(rows);
    },
    markGapStatus() {
      return Promise.resolve();
    },
  };
  const readPage = createDetailGapPageReader({
    connectorId: "connector",
    connectorInstanceId: "instance",
    detailGapStore: store,
    grantId: "grant",
    runId,
  });

  const page = await readPage({ maxBytes: budget });
  assert.ok(page.detailGaps.length > 0, "not a vacuous empty-page pass");
  for (const entry of page.detailGaps) {
    assert.ok(
      Buffer.byteLength(JSON.stringify([entry]), "utf8") <= budget,
      "every individual entry fits; the intentional single-oversize escape does not apply"
    );
  }
  const actualBytes = Buffer.byteLength(JSON.stringify(page.detailGaps), "utf8");
  assert.ok(actualBytes <= budget, "final wire entries including lease_id must fit the budget");
  assert.ok(page.serializedBytes >= actualBytes, "reported accounting must not understate final entries");
  assert.deepEqual(
    page.servedGapIds,
    page.detailGaps.map((gap) => gap.gap_id)
  );
});
