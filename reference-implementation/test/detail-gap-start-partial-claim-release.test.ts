// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Runtime-level check for the START page. When one gap's claim fails while a
 * sibling claim succeeds, the run fails before START is sent. The cleanup that
 * normally releases leases (`cleanupChildHandles`) does not exist yet on that
 * path, so the START catch must release the sibling lease itself. Otherwise the
 * gap stays `in_progress` until the one-hour lease expiry.
 *
 * Real SQLite store; only `claimPendingGaps` is wrapped to fail for one gap.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runConnector } from "../runtime/index.ts";
import { closeDb, initDb } from "../server/db.ts";
import { createSqliteConnectorDetailGapStore } from "../server/stores/connector-detail-gap-store.ts";
import { makeDefaultAccountConnectorInstanceId } from "../server/stores/connector-instance-store.ts";

type Store = ReturnType<typeof createSqliteConnectorDetailGapStore>;
type RunOptions = Parameters<typeof runConnector>[0];

const CONNECTOR_ID = "start_partial_claim_conn";
const INSTANCE_ID = "cin_start_partial_claim";

function identity(recordKey: string) {
	return {
		connectorId: CONNECTOR_ID,
		connectorInstanceId: INSTANCE_ID,
		detailLocator: { item: recordKey, kind: "test.item" },
		grantId: "grant_1",
		recordKey,
		stream: "messages",
	};
}

async function seedPendingGap(
	store: Store,
	recordKey: string,
): Promise<string> {
	const gap = await store.upsertPendingGap({
		...identity(recordKey),
		now: "2026-06-01T00:00:00.000Z",
		reason: "temporary_unavailable",
		retryable: true,
	});
	assert.ok(gap);
	return gap.gap_id;
}

test("a START-page claim failure releases the sibling lease that was already claimed", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pdpp-start-partial-claim-"));
	initDb(join(dir, "pdpp.sqlite"));
	try {
		const store = createSqliteConnectorDetailGapStore();
		const okGapId = await seedPendingGap(store, "ok");
		const badGapId = await seedPendingGap(store, "bad");
		const connectorPath = join(dir, "connector.mjs");
		writeFileSync(
			connectorPath,
			"setInterval(() => undefined, 1000);\n",
			"utf8",
		);

		const failingStore = new Proxy(
			store as unknown as Record<string, unknown>,
			{
				get(target, prop, receiver) {
					const value = Reflect.get(target, prop, receiver);
					if (prop === "claimPendingGaps") {
						return async (ids: string[], options: unknown) => {
							if (ids.includes(badGapId)) {
								throw new Error("injected start claim failure");
							}
							return await (
								value as (ids: string[], options: unknown) => Promise<string[]>
							).call(target, ids, options);
						};
					}
					return typeof value === "function" ? value.bind(target) : value;
				},
			},
		) as unknown as Store;

		await assert.rejects(
			runConnector({
				admitRunConnection: ({
					connectorId,
					connectorInstanceId,
					ownerSubjectId,
				}) =>
					Promise.resolve({
						connectorId,
						connectorInstanceId:
							connectorInstanceId ??
							makeDefaultAccountConnectorInstanceId("owner_local", connectorId),
						ownerSubjectId: ownerSubjectId ?? "owner_local",
					}),
				connectorId: CONNECTOR_ID,
				connectorInstanceId: INSTANCE_ID,
				connectorPath,
				detailGapStore: failingStore,
				grantId: "grant_1",
				manifest: { streams: [{ name: "messages" }] },
				onProgress: () => {},
				ownerToken: "owner",
				persistState: false,
				rsUrl: "http://127.0.0.1:9",
			} as RunOptions),
			{ message: "injected start claim failure" },
		);

		const released = await store.getGapById(okGapId);
		assert.equal(
			released?.status,
			"pending",
			"the sibling's lease is released, not left in_progress",
		);
		assert.equal(released?.lease_id, null);
		const untouched = await store.getGapById(badGapId);
		assert.equal(untouched?.status, "pending");
	} finally {
		closeDb();
		rmSync(dir, { force: true, recursive: true });
	}
});
