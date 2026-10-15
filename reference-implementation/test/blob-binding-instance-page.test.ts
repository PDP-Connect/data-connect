// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { createBlobStore } from "../server/stores/blob-store.ts";
import { INTERNAL_A, makeFixture } from "./helpers/pairwise-rs-read-fixture.ts";

test("selected-instance page includes the originating blob row once", async (t) => {
	const fx = await makeFixture(t);
	const blob = await fx.uploadBlob({
		bytes: Buffer.from("origin row and binding share one tuple"),
		connectorInstanceId: INTERNAL_A,
		recordKey: "origin-row-once",
		stream: "top_artists",
	});
	const page = await createBlobStore().listBlobBindingsPage({
		blobId: blob.blob_id,
		connectorId: "pairwise-detail-fixture",
		connectorInstanceId: INTERNAL_A,
	});
	assert.equal(page.rows.length, 1);
	assert.deepEqual(page.rows[0], {
		connector_id: "pairwise-detail-fixture",
		connector_instance_id: INTERNAL_A,
		record_key: "origin-row-once",
		stream: "top_artists",
	});
	assert.equal(page.nextCursor, null);
});
