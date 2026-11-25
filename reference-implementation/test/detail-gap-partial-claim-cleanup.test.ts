// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { createDetailGapPageReader } from "../runtime/detail-gap-paging.ts";

type DetailGapStoreParam = Parameters<typeof createDetailGapPageReader>[0]["detailGapStore"];
type ReaderOptions = Parameters<typeof createDetailGapPageReader>[0];

test("a rejected page claim leaves successful leases visible for cleanup", async () => {
  const served: NonNullable<ReaderOptions["allServedGapLeases"]> = new Map();
  const acquired = new Map<string, { leaseId: string; runId: string }>();
  const store: DetailGapStoreParam = {
    claimPendingGaps(ids, options) {
      const [id] = ids;
      if (typeof id !== "string") {
        return Promise.reject(new Error("claim expected one gap id"));
      }
      if (id === "failed") {
        return Promise.reject(new Error("injected claim failure"));
      }
      if (typeof options.leaseId !== "string" || typeof options.runId !== "string") {
        return Promise.reject(new Error("claim expected lease ownership"));
      }
      acquired.set(id, { leaseId: options.leaseId, runId: options.runId });
      return Promise.resolve([id]);
    },
    listPendingGaps() {
      return Promise.resolve(
        ["claimed", "failed"].map((gap_id) => ({
          detail_locator: "locator",
          gap_id,
          record_key: gap_id,
          status: "pending",
          stream: "messages",
        }))
      );
    },
    markGapStatus() {
      return Promise.resolve();
    },
  };
  const readPage = createDetailGapPageReader({
    allServedGapLeases: served,
    connectorId: "connector",
    connectorInstanceId: "instance",
    detailGapStore: store,
    grantId: "grant",
    runId: "run",
  });

  await assert.rejects(readPage(), { message: "injected claim failure" });
  assert.equal(acquired.size, 1, "one durable claim succeeded before the page failed");
  for (const [id, lease] of acquired) {
    const tracked = served.get(id);
    assert.ok(tracked, "every successful claim must be available to outstanding-lease cleanup");
    assert.equal(tracked.leaseId, lease.leaseId);
    assert.equal(tracked.runId, lease.runId);
    assert.equal(tracked.attempted, false, "failed page delivery is not a provider attempt");
  }
});
