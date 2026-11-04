// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { createBlobStore } from "../server/stores/blob-store.ts";
import {
	CLIENT_A,
	CLIENT_TOKEN,
	INTERNAL_A,
	makeFixture,
} from "./helpers/pairwise-rs-read-fixture.ts";

test("selected-instance page includes the originating blob row once", async (t) => {
	const fx = await makeFixture(t);
	const upload = {
		bytes: Buffer.from("origin row and binding share one tuple"),
		connectorInstanceId: INTERNAL_A,
		recordKey: "origin-row-once",
		stream: "top_artists",
	};
	const blob = await fx.uploadBlob(upload);
	assert.ok(blob.blob_id, "fixture setup: authenticated upload returned a blob");
	await fx.seedRecord({
		connectorInstanceId: INTERNAL_A,
		data: {
			blob_ref: { blob_id: blob.blob_id },
			id: upload.recordKey,
			name: "origin-only readable record",
			rank: 7,
		},
		key: upload.recordKey,
		stream: upload.stream,
	});
	const detail = await fx.client(
		`/v1/streams/top_artists/records/${upload.recordKey}?instance_id=${CLIENT_A}`,
	);
	assert.equal(detail.status, 200, `fixture setup: ${detail.text}`);
	const blobRef = (detail.body.data as Record<string, unknown>)
		.blob_ref as Record<string, unknown>;
	assert.equal(blobRef.blob_id, blob.blob_id, "fixture setup: projected blob_ref");
	const pageArgs = {
		blobId: blob.blob_id,
		connectorId: "pairwise-detail-fixture",
		connectorInstanceId: INTERNAL_A,
	};
	const expectedTuple = {
		connector_id: "pairwise-detail-fixture",
		connector_instance_id: INTERNAL_A,
		record_key: "origin-row-once",
		stream: "top_artists",
	};
	await fx.removeOriginBlobBinding({
		blobId: blob.blob_id,
		connectorInstanceId: INTERNAL_A,
		recordKey: upload.recordKey,
		stream: upload.stream,
	});
	try {
		const originOnly = await createBlobStore().listBlobBindingsPage(pageArgs);
		assert.equal(originOnly.rows.length, 1, "origin row survives without a binding");
		assert.deepEqual(originOnly.rows[0], expectedTuple);
		assert.equal(originOnly.nextCursor, null);
		const fetched = await fx.requestRaw(
			`/v1/blobs/${blob.blob_id}?instance_id=${CLIENT_A}`,
			`Bearer ${CLIENT_TOKEN}`,
		);
		assert.equal(fetched.status, 200);
		assert.deepEqual(Buffer.from(fetched.body), upload.bytes);
	} finally {
		const restored = await fx.uploadBlob(upload);
		assert.equal(restored.blob_id, blob.blob_id, "restore the duplicate binding");
	}
	const page = await createBlobStore().listBlobBindingsPage(pageArgs);
	assert.equal(page.rows.length, 1);
	assert.deepEqual(page.rows[0], expectedTuple);
	assert.equal(page.nextCursor, null);
});
