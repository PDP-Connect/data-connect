// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
	CLIENT_A,
	CLIENT_B,
	CLIENT_TOKEN,
	INTERNAL_A,
	INTERNAL_B,
	INTERNAL_SECOND_SOURCE,
	makeFixture,
	OWNER_A,
	OWNER_SECOND_SOURCE,
	OWNER_TOKEN,
	SECOND_CONNECTOR_ID,
} from "./helpers/pairwise-rs-read-fixture.ts";

async function seedBlob(
	fx: Awaited<ReturnType<typeof makeFixture>>,
	instanceId: string,
	key: string,
	options: { bytes?: Buffer; observedAt?: string | null; stream?: string } = {},
) {
	const bytes = options.bytes ?? Buffer.from(`pairwise blob ${key}`);
	const stream = options.stream ?? "top_artists";
	const blob = await fx.uploadBlob({
		bytes,
		connectorInstanceId: instanceId,
		recordKey: key,
		stream,
	});
	assert.ok(blob.blob_id);
	await fx.seedRecord({
		connectorInstanceId: instanceId,
		data: {
			blob_ref: { blob_id: blob.blob_id },
			id: key,
			name: `blob ${key}`,
			rank: 7,
			...(options.observedAt === null
				? {}
				: { observed_at: options.observedAt ?? "2026-03-03T00:00:00Z" }),
		},
		emittedAt: "2026-03-03T00:00:00Z",
		key,
		stream,
	});
	return { blob, bytes };
}

type ClientGrantStream = Record<string, unknown> & {
	fields?: string[];
	instance_ids?: string[];
	name?: string;
	resources?: string[];
	time_constraint?: { field: string; since: string };
};

function clientInfo(fx: Awaited<ReturnType<typeof makeFixture>>) {
	const info = fx.introspection.get(CLIENT_TOKEN);
	assert.ok(info);
	return info;
}

function ownerInfo(fx: Awaited<ReturnType<typeof makeFixture>>) {
	const info = fx.introspection.get(OWNER_TOKEN);
	assert.ok(info);
	return info;
}

function clientGrantStreams(
	info: Record<string, unknown>,
): ClientGrantStream[] {
	const details = info.authorization_details;
	assert.ok(Array.isArray(details));
	const first = details[0];
	assert.ok(first && typeof first === "object" && !Array.isArray(first));
	const streams = (first as Record<string, unknown>).streams;
	assert.ok(Array.isArray(streams));
	return streams as ClientGrantStream[];
}

function grantStreams(fx: Awaited<ReturnType<typeof makeFixture>>) {
	return clientGrantStreams(clientInfo(fx));
}

function setClientInstanceSet(
	fx: Awaited<ReturnType<typeof makeFixture>>,
	allowed: Record<string, string[]>,
) {
	const info = clientInfo(fx);
	const streams = grantStreams(fx);
	for (const stream of streams) {
		stream.instance_ids = allowed[stream.name ?? ""] ?? [];
	}
	info.pdpp_instance_bindings = (
		info.pdpp_instance_bindings as Array<Record<string, unknown>>
	).filter((binding) =>
		(allowed[binding.stream as string] ?? []).includes(
			binding.instance_id as string,
		),
	);
}

function errorCode(reply: { body: Record<string, unknown> }): unknown {
	return ((reply.body.error as Record<string, unknown>) ?? {}).code;
}

test("detail fetch_url selects its public instance and reads the uploaded bytes", async (t) => {
	const fx = await makeFixture(t);
	const seeded = await seedBlob(fx, INTERNAL_A, "client-blob");
	const detail = await fx.client(
		`/v1/streams/top_artists/records/client-blob?instance_id=${CLIENT_A}`,
	);
	assert.equal(detail.status, 200, detail.text);
	const blobRef = (detail.body.data as Record<string, unknown>)
		.blob_ref as Record<string, unknown>;
	const fetchUrl = blobRef.fetch_url as string;
	assert.ok(fetchUrl, "detail returns a fetch_url");

	assert.equal(
		fetchUrl,
		`/v1/blobs/${encodeURIComponent(seeded.blob.blob_id)}?instance_id=${CLIENT_A}`,
	);
	const fetched = await fx.requestRaw(fetchUrl, `Bearer ${CLIENT_TOKEN}`);
	assert.equal(fetched.status, 200);
	assert.deepEqual(Buffer.from(fetched.body), seeded.bytes);
	assert.equal(blobRef.blob_id, seeded.blob.blob_id);
});

test("blob reads require a public selector even for one visible instance", async (t) => {
	const fx = await makeFixture(t);
	const { blob } = await seedBlob(fx, INTERNAL_A, "required-selector");
	const paths = [
		`/v1/blobs/${blob.blob_id}`,
		"/v1/blobs/blob_that_does_not_exist",
		`/v1/blobs/${blob.blob_id}?instance_id=${CLIENT_A}&instance_id=${CLIENT_A}`,
		`/v1/blobs/${blob.blob_id}?connector_instance_id=${INTERNAL_A}`,
	];
	for (const path of paths) {
		const reply = await fx.client(path);
		assert.equal(reply.status, 400, `status for ${path}`);
		assert.equal(
			((reply.body.error as Record<string, unknown>) ?? {}).code,
			"invalid_request",
		);
	}
	for (const path of [
		`/v1/blobs/${blob.blob_id}`,
		"/v1/blobs/blob_that_does_not_exist",
	]) {
		const ownerReply = await fx.owner(path);
		assert.equal(ownerReply.status, 400);
		assert.equal(errorCode(ownerReply), "invalid_request");
	}
});

test("canonical and equal deprecated aliases select the same blob and preserve byte headers", async (t) => {
	const fx = await makeFixture(t);
	const { blob, bytes } = await seedBlob(fx, INTERNAL_A, "alias-blob");
	const canonical = await fx.requestRaw(
		`/v1/blobs/${blob.blob_id}?instance_id=${CLIENT_A}`,
		`Bearer ${CLIENT_TOKEN}`,
	);
	const equalAlias = await fx.requestRaw(
		`/v1/blobs/${blob.blob_id}?instance_id=${CLIENT_A}&connection_id=${CLIENT_A}`,
		`Bearer ${CLIENT_TOKEN}`,
	);
	const aliasOnly = await fx.requestRaw(
		`/v1/blobs/${blob.blob_id}?connection_id=${CLIENT_A}`,
		`Bearer ${CLIENT_TOKEN}`,
	);
	assert.equal(canonical.status, 200);
	assert.equal(equalAlias.status, 200);
	assert.equal(aliasOnly.status, 200);
	assert.deepEqual(Buffer.from(canonical.body), bytes);
	assert.deepEqual(Buffer.from(equalAlias.body), bytes);
	assert.deepEqual(Buffer.from(aliasOnly.body), bytes);
	for (const reply of [canonical, equalAlias, aliasOnly]) {
		assert.equal(reply.headers.get("Content-Type"), "application/octet-stream");
		assert.equal(reply.headers.get("Content-Length"), String(bytes.length));
		assert.equal(reply.headers.get("Cache-Control"), "private, no-store");
		assert.equal(reply.headers.get("X-Content-Type-Options"), "nosniff");
		assert.equal(reply.headers.get("Content-Disposition"), "attachment");
	}
	assert.equal(
		equalAlias.headers.get("PDPP-Warning"),
		"deprecated_alias_used: connection_id",
	);
	assert.equal(canonical.headers.get("PDPP-Warning"), null);
	assert.equal(
		aliasOnly.headers.get("PDPP-Warning"),
		"deprecated_alias_used: connection_id",
	);
	const ownerEqualAlias = await fx.requestRaw(
		`/v1/blobs/${blob.blob_id}?instance_id=${OWNER_A}&connection_id=${OWNER_A}`,
		`Bearer ${OWNER_TOKEN}`,
	);
	const ownerAliasOnly = await fx.requestRaw(
		`/v1/blobs/${blob.blob_id}?connection_id=${OWNER_A}`,
		`Bearer ${OWNER_TOKEN}`,
	);
	assert.equal(ownerEqualAlias.status, 200);
	assert.equal(ownerAliasOnly.status, 200);
	assert.deepEqual(Buffer.from(ownerEqualAlias.body), bytes);
	assert.deepEqual(Buffer.from(ownerAliasOnly.body), bytes);
	for (const reply of [ownerEqualAlias, ownerAliasOnly]) {
		assert.equal(reply.headers.get("Content-Type"), "application/octet-stream");
		assert.equal(reply.headers.get("Content-Length"), String(bytes.length));
		assert.equal(reply.headers.get("Cache-Control"), "private, no-store");
		assert.equal(reply.headers.get("X-Content-Type-Options"), "nosniff");
		assert.equal(reply.headers.get("Content-Disposition"), "attachment");
	}
	assert.equal(
		ownerEqualAlias.headers.get("PDPP-Warning"),
		"deprecated_alias_used: connection_id",
	);
	assert.equal(
		ownerAliasOnly.headers.get("PDPP-Warning"),
		"deprecated_alias_used: connection_id",
	);
});

test("raw, malformed, conflicting, and unknown selectors fail with fixed public errors", async (t) => {
	const fx = await makeFixture(t);
	const { blob } = await seedBlob(fx, INTERNAL_A, "selector-errors");
	const cases = [
		[
			`/v1/blobs/${blob.blob_id}?instance_id=${INTERNAL_A}`,
			400,
			"invalid_request",
		],
		[`/v1/blobs/${blob.blob_id}?instance_id=`, 400, "invalid_request"],
		[
			`/v1/blobs/${blob.blob_id}?instance_id=${CLIENT_A}&connection_id=${CLIENT_B}`,
			400,
			"invalid_request",
		],
		[`/v1/blobs/${blob.blob_id}?instance_id=inst_v1_foreign`, 404, "not_found"],
		[`/v1/blobs/${blob.blob_id}?instance_id=inst_v1_unknown`, 404, "not_found"],
	] as const;
	for (const [path, status, code] of cases) {
		const reply = await fx.client(path);
		assert.equal(reply.status, status);
		assert.equal(errorCode(reply), code);
		assert.ok(!reply.text.includes(INTERNAL_A));
		assert.ok(!reply.text.includes(INTERNAL_B));
		assert.ok(!reply.text.includes("available_connections"));
	}
	const ownerRaw = await fx.owner(
		`/v1/blobs/${blob.blob_id}?instance_id=${INTERNAL_A}`,
	);
	assert.equal(ownerRaw.status, 400);
	assert.equal(errorCode(ownerRaw), "invalid_request");
	const ownerUnknown = await fx.owner(
		`/v1/blobs/${blob.blob_id}?instance_id=inst_v1_unknown_owner`,
	);
	assert.equal(ownerUnknown.status, 404);
	assert.equal(errorCode(ownerUnknown), "not_found");
});

test("out-of-scope and nonexistent client selectors have identical error responses", async (t) => {
	const fx = await makeFixture(t);
	const { blob } = await seedBlob(fx, INTERNAL_A, "selector-equivalence");
	const base = structuredClone(clientInfo(fx));
	const makeContext = (handle: string, internalId: string) => {
		const info = structuredClone(base);
		const streams = clientGrantStreams(info);
		for (const stream of streams) stream.instance_ids = [handle];
		info.pdpp_instance_bindings = (
			info.pdpp_instance_bindings as Array<Record<string, unknown>>
		)
			.filter((binding) => binding.rs_instance === internalId)
			.map((binding) => ({ ...binding, instance_id: handle }));
		return info;
	};
	fx.introspection.set(
		"blob-context-a-only",
		makeContext(CLIENT_A, INTERNAL_A),
	);
	fx.introspection.set(
		"blob-context-b-only",
		makeContext(CLIENT_B, INTERNAL_B),
	);
	const read = (handle: string) =>
		fx.requestRaw(
			`/v1/blobs/${blob.blob_id}?instance_id=${handle}`,
			"Bearer blob-context-a-only",
			{ headers: { "request-id": "req_blob_selector_equivalence" } },
		);
	const [outOfScope, nonexistent] = await Promise.all([
		read(CLIENT_B),
		read("inst_v1_blob_never_issued"),
	]);
	assert.equal(outOfScope.status, 404);
	assert.equal(nonexistent.status, 404);
	assert.deepEqual(Buffer.from(outOfScope.body), Buffer.from(nonexistent.body));
	assert.deepEqual(
		[...outOfScope.headers.entries()],
		[...nonexistent.headers.entries()],
	);
	const aRawOther = await fx.requestRaw(
		`/v1/blobs/${blob.blob_id}?instance_id=${INTERNAL_B}`,
		"Bearer blob-context-a-only",
	);
	const bRawOther = await fx.requestRaw(
		`/v1/blobs/${blob.blob_id}?instance_id=${INTERNAL_A}`,
		"Bearer blob-context-b-only",
	);
	assert.equal(aRawOther.status, 404);
	assert.equal(bRawOther.status, 404);
	const bPublicOther = await fx.requestRaw(
		`/v1/blobs/${blob.blob_id}?instance_id=${CLIENT_A}`,
		"Bearer blob-context-b-only",
	);
	assert.equal(bPublicOther.status, 404);
	for (const path of [
		`/v1/blobs/${blob.blob_id}`,
		"/v1/blobs/blob_missing_for_singleton",
	]) {
		const singleton = await fx.request(path, "Bearer blob-context-a-only");
		assert.equal(singleton.status, 400);
		assert.equal(errorCode(singleton), "invalid_request");
	}
});

test("all client and owner bindings are checked before selected-instance lookup", async (t) => {
	const fx = await makeFixture(t);
	const clientToken = clientInfo(fx);
	const ownerToken = ownerInfo(fx);
	const clientBindings = structuredClone(
		clientToken.pdpp_instance_bindings,
	) as Array<Record<string, unknown>>;
	const ownerBindings = structuredClone(
		ownerToken.pdpp_instance_bindings,
	) as Array<Record<string, unknown>>;
	const clientCases = [
		{ ...clientBindings[1]!, rs_instance: "cin_pairwise_unowned_unselected" },
		{ ...clientBindings[1]!, rs_instance: INTERNAL_A },
		{ ...clientBindings[1]!, rs_instance: "cin_pairwise_detail_foreign_owner" },
		{ ...clientBindings[1]!, rs_instance: "cin_pairwise_detail_inactive" },
		{ ...clientBindings[1]!, source_id: "https://foreign.example/source" },
	] as const;
	for (const replacement of clientCases) {
		clientToken.pdpp_instance_bindings = [
			clientBindings[0]!,
			replacement,
			...clientBindings.slice(2),
		];
		const reply = await fx.client(
			`/v1/blobs/blob_missing?instance_id=${CLIENT_A}`,
		);
		assert.equal(reply.status, 403);
		assert.equal(errorCode(reply), "grant_invalid");
		assert.ok(!reply.text.includes(INTERNAL_A));
	}
	clientToken.pdpp_instance_bindings = clientBindings;
	for (const replacement of [
		{ ...ownerBindings[1]!, rs_instance: "cin_pairwise_unowned_unselected" },
		{ ...ownerBindings[1]!, rs_instance: "cin_pairwise_detail_foreign_owner" },
		{ ...ownerBindings[1]!, rs_instance: "cin_pairwise_detail_inactive" },
		{ ...ownerBindings[1]!, source_id: "https://foreign.example/source" },
	]) {
		ownerToken.pdpp_instance_bindings = [ownerBindings[0]!, replacement];
		const reply = await fx.owner(
			`/v1/blobs/blob_missing?instance_id=${OWNER_A}`,
		);
		assert.equal(reply.status, 403);
		assert.equal(errorCode(reply), "grant_invalid");
		assert.ok(!reply.text.includes(INTERNAL_A));
	}
});

test("selected-instance blob reads honor per-stream membership and current record visibility", async (t) => {
	const fx = await makeFixture(t);
	const sameBytes = Buffer.from("shared content-addressed bytes");
	const { blob } = await seedBlob(fx, INTERNAL_B, "stream-first-b", {
		bytes: sameBytes,
		stream: "top_artists",
	});
	await fx.uploadBlob({
		bytes: sameBytes,
		connectorInstanceId: INTERNAL_A,
		recordKey: "stream-later-a",
		stream: "parents",
	});
	await fx.seedRecord({
		connectorInstanceId: INTERNAL_A,
		data: {
			blob_ref: { blob_id: blob.blob_id },
			id: "stream-later-a",
			name: "parent blob",
		},
		key: "stream-later-a",
		stream: "parents",
	});
	setClientInstanceSet(fx, {
		top_artists: [CLIENT_B],
		parents: [CLIENT_A],
		children: [CLIENT_A],
	});
	const laterStream = await fx.requestRaw(
		`/v1/blobs/${blob.blob_id}?instance_id=${CLIENT_A}`,
		`Bearer ${CLIENT_TOKEN}`,
	);
	assert.equal(laterStream.status, 200);
	assert.deepEqual(Buffer.from(laterStream.body), sameBytes);
	const firstStream = await fx.requestRaw(
		`/v1/blobs/${blob.blob_id}?instance_id=${CLIENT_B}`,
		`Bearer ${CLIENT_TOKEN}`,
	);
	assert.equal(firstStream.status, 200);
});

test("a selected instance cannot borrow another visible instance's blob reference", async (t) => {
	const fx = await makeFixture(t);
	const sameBytes = Buffer.from("shared content-addressed bytes");
	const a = await seedBlob(fx, INTERNAL_A, "resource-hidden-a", {
		bytes: sameBytes,
		observedAt: "2026-01-01T00:00:00Z",
	});
	await seedBlob(fx, INTERNAL_B, "resource-visible-b", {
		bytes: sameBytes,
		observedAt: "2026-03-03T00:00:00Z",
	});
	const stream = grantStreams(fx).find(
		(candidate) => candidate.name === "top_artists",
	)!;
	stream.time_constraint = {
		field: "observed_at",
		since: "2026-02-01T00:00:00Z",
	};
	const selectedA = await fx.requestRaw(
		`/v1/blobs/${a.blob.blob_id}?instance_id=${CLIENT_A}`,
		`Bearer ${CLIENT_TOKEN}`,
	);
	assert.equal(selectedA.status, 404);
	const selectedB = await fx.requestRaw(
		`/v1/blobs/${a.blob.blob_id}?instance_id=${CLIENT_B}`,
		`Bearer ${CLIENT_TOKEN}`,
	);
	assert.equal(selectedB.status, 200);
	assert.deepEqual(Buffer.from(selectedB.body), sameBytes);
});

test("field, resource, and time filters hide blob references without exposing bytes", async (t) => {
	const fx = await makeFixture(t);
	const { blob } = await seedBlob(fx, INTERNAL_A, "projection-hidden");
	const stream = grantStreams(fx).find(
		(candidate) => candidate.name === "top_artists",
	)!;
	stream.fields = ["id", "name", "rank"];
	const hiddenDetail = await fx.client(
		`/v1/streams/top_artists/records/projection-hidden?instance_id=${CLIENT_A}`,
	);
	assert.equal(hiddenDetail.status, 200, hiddenDetail.text);
	assert.equal(
		Object.hasOwn(
			hiddenDetail.body.data as Record<string, unknown>,
			"blob_ref",
		),
		false,
	);
	const hiddenField = await fx.client(
		`/v1/blobs/${blob.blob_id}?instance_id=${CLIENT_A}`,
	);
	assert.equal(hiddenField.status, 404);
	assert.equal(errorCode(hiddenField), "blob_not_found");

	stream.fields = ["id", "name", "rank", "blob_ref"];
	stream.instance_ids = [CLIENT_A];
	fx.introspection.get(CLIENT_TOKEN)!.pdpp_instance_bindings = (
		fx.introspection.get(CLIENT_TOKEN)!.pdpp_instance_bindings as Array<
			Record<string, unknown>
		>
	).filter(
		(binding) =>
			binding.stream !== "top_artists" || binding.instance_id === CLIENT_A,
	);
	stream.resources = ["projection-hidden"];
	const resourceVisible = await fx.client(
		`/v1/blobs/${blob.blob_id}?instance_id=${CLIENT_A}`,
	);
	assert.equal(resourceVisible.status, 200);
	stream.resources = ["resource-excluded"];
	const resourceHidden = await fx.client(
		`/v1/blobs/${blob.blob_id}?instance_id=${CLIENT_A}`,
	);
	assert.equal(resourceHidden.status, 404);
	assert.equal(errorCode(resourceHidden), "blob_not_found");
	delete stream.resources;

	stream.time_constraint = {
		field: "observed_at",
		since: "2026-02-01T00:00:00Z",
	};
	const timeVisible = await fx.client(
		`/v1/blobs/${blob.blob_id}?instance_id=${CLIENT_A}`,
	);
	assert.equal(timeVisible.status, 200);
	stream.time_constraint = {
		field: "observed_at",
		since: "2026-04-01T00:00:00Z",
	};
	const timeExcluded = await fx.client(
		`/v1/blobs/${blob.blob_id}?instance_id=${CLIENT_A}`,
	);
	assert.equal(timeExcluded.status, 404);
	assert.equal(errorCode(timeExcluded), "blob_not_found");
	stream.time_constraint = {
		field: "observed_at",
		since: "2026-02-01T00:00:00Z",
	};
	for (const [key, observedAt] of [
		["timestamp-absent", null],
		["timestamp-invalid", "not-a-timestamp"],
	] as const) {
		const malformed = await seedBlob(fx, INTERNAL_A, key, { observedAt });
		const hidden = await fx.client(
			`/v1/blobs/${malformed.blob.blob_id}?instance_id=${CLIENT_A}`,
		);
		assert.equal(hidden.status, 404);
		assert.equal(errorCode(hidden), "blob_not_found");
	}
	delete stream.time_constraint;

	const absent = await fx.uploadBlob({
		bytes: Buffer.from("stale binding"),
		connectorInstanceId: INTERNAL_A,
		recordKey: "record-not-seeded",
		stream: "top_artists",
	});
	const stale = await fx.client(
		`/v1/blobs/${absent.blob_id}?instance_id=${CLIENT_A}`,
	);
	assert.equal(stale.status, 404);
	assert.equal(errorCode(stale), "blob_not_found");
	const missing = await fx.client(
		`/v1/blobs/blob_content_missing?instance_id=${CLIENT_A}`,
	);
	assert.equal(missing.status, 404);
	assert.equal(errorCode(missing), "blob_not_found");
	await fx.deleteRecord({
		connectorInstanceId: INTERNAL_A,
		key: "projection-hidden",
		stream: "top_artists",
	});
	const deleted = await fx.client(
		`/v1/blobs/${blob.blob_id}?instance_id=${CLIENT_A}`,
	);
	assert.equal(deleted.status, 404);
	assert.equal(errorCode(deleted), "blob_not_found");
});

test("valid blob URLs still require bearer authentication and owner source selection is private", async (t) => {
	const fx = await makeFixture(t, { withSecondSource: true });
	const { blob, bytes } = await seedBlob(fx, INTERNAL_A, "auth-blob");
	const validPath = `/v1/blobs/${blob.blob_id}?instance_id=${CLIENT_A}`;
	const noBearer = await fx.requestRaw(validPath);
	const wrongBearer = await fx.requestRaw(validPath, "Bearer wrong-blob-token");
	for (const reply of [noBearer, wrongBearer]) {
		assert.equal(reply.status, 401);
		assert.equal(reply.body.length > 0, true);
		assert.notDeepEqual(Buffer.from(reply.body), bytes);
	}
	const sourceMismatch = await fx.owner(
		`/v1/blobs/${blob.blob_id}?connector_id=${SECOND_CONNECTOR_ID}&instance_id=${OWNER_A}`,
	);
	assert.equal(sourceMismatch.status, 404);
	assert.equal(errorCode(sourceMismatch), "not_found");
	assert.ok(!sourceMismatch.text.includes(INTERNAL_A));
	assert.ok(!sourceMismatch.text.includes(INTERNAL_SECOND_SOURCE));
	const mismatch = await fx.requestRaw(
		`/v1/blobs/${blob.blob_id}?connector_id=${SECOND_CONNECTOR_ID}&instance_id=${OWNER_A}`,
		`Bearer ${OWNER_TOKEN}`,
		{ headers: { "request-id": "req_owner_source_mismatch" } },
	);
	const nonexistent = await fx.requestRaw(
		`/v1/blobs/${blob.blob_id}?instance_id=inst_v1_owner_never_issued`,
		`Bearer ${OWNER_TOKEN}`,
		{ headers: { "request-id": "req_owner_source_mismatch" } },
	);
	assert.equal(mismatch.status, 404);
	assert.deepEqual(Buffer.from(mismatch.body), Buffer.from(nonexistent.body));
	assert.deepEqual(
		[...mismatch.headers.entries()],
		[...nonexistent.headers.entries()],
	);
});

test("owner detail fetch_url uses its authenticated public selector", async (t) => {
	const fx = await makeFixture(t);
	const seeded = await seedBlob(fx, INTERNAL_A, "owner-blob");
	const detail = await fx.owner(
		`/v1/streams/top_artists/records/owner-blob?instance_id=${OWNER_A}`,
	);
	assert.equal(detail.status, 200, detail.text);
	const blobRef = (detail.body.data as Record<string, unknown>)
		.blob_ref as Record<string, unknown>;
	const fetched = await fx.requestRaw(
		blobRef.fetch_url as string,
		`Bearer ${OWNER_TOKEN}`,
	);
	assert.equal(fetched.status, 200);
	assert.deepEqual(Buffer.from(fetched.body), seeded.bytes);
});

test("owner fetch_url resolves a selected source without connector_id", async (t) => {
	const fx = await makeFixture(t, { withSecondSource: true });
	const bytes = Buffer.from("owner second source blob");
	const blob = await fx.uploadBlob({
		bytes,
		connectorId: SECOND_CONNECTOR_ID,
		connectorInstanceId: INTERNAL_SECOND_SOURCE,
		recordKey: "second-source-blob",
		stream: "top_artists",
	});
	await fx.seedRecord({
		connectorId: SECOND_CONNECTOR_ID,
		connectorInstanceId: INTERNAL_SECOND_SOURCE,
		data: {
			blob_ref: { blob_id: blob.blob_id },
			id: "second-source-blob",
			name: "second source blob record",
			rank: 8,
			observed_at: "2026-03-03T00:00:00Z",
		},
		key: "second-source-blob",
		stream: "top_artists",
	});
	const detail = await fx.owner(
		`/v1/streams/top_artists/records/second-source-blob?instance_id=${OWNER_SECOND_SOURCE}`,
	);
	assert.equal(detail.status, 200, detail.text);
	const blobRef = (detail.body.data as Record<string, unknown>)
		.blob_ref as Record<string, unknown>;
	assert.equal(
		blobRef.fetch_url,
		`/v1/blobs/${encodeURIComponent(blob.blob_id)}?instance_id=${OWNER_SECOND_SOURCE}`,
	);
	const fetched = await fx.requestRaw(
		blobRef.fetch_url as string,
		`Bearer ${OWNER_TOKEN}`,
	);
	assert.equal(fetched.status, 200);
	assert.deepEqual(Buffer.from(fetched.body), bytes);
	assert.equal(fetched.headers.get("Content-Type"), "application/octet-stream");
	assert.equal(fetched.headers.get("Content-Length"), String(bytes.length));
	assert.equal(fetched.headers.get("Cache-Control"), "private, no-store");
	assert.equal(fetched.headers.get("X-Content-Type-Options"), "nosniff");
	assert.equal(fetched.headers.get("Content-Disposition"), "attachment");
	assert.equal(fetched.headers.get("PDPP-Warning"), null);
});

test("expanded record envelopes project child blob URLs to their public instance", async (t) => {
	const fx = await makeFixture(t);
	const bytes = Buffer.from("expanded child blob");
	const blob = await fx.uploadBlob({
		bytes,
		connectorInstanceId: INTERNAL_A,
		recordKey: "child-with-blob",
		stream: "children",
	});
	await fx.seedRecord({
		connectorInstanceId: INTERNAL_A,
		data: {
			blob_ref: { blob_id: blob.blob_id },
			id: "child-with-blob",
			name: "child with blob",
			parent_id: "parent-a",
		},
		key: "child-with-blob",
		stream: "children",
	});
	const detail = await fx.owner(
		`/v1/streams/parents/records/parent-a?instance_id=${OWNER_A}&expand=children`,
	);
	assert.equal(detail.status, 200, detail.text);
	const expanded = detail.body.expanded as Record<
		string,
		Record<string, unknown>
	>;
	const children = expanded.children!.data as Array<Record<string, unknown>>;
	const child = children.find(
		(record) =>
			(record.data as Record<string, unknown>).id === "child-with-blob",
	);
	assert.ok(child);
	assert.equal(child.instance_id, OWNER_A);
	const blobRef = (child.data as Record<string, unknown>).blob_ref as Record<
		string,
		unknown
	>;
	assert.equal(
		blobRef.fetch_url,
		`/v1/blobs/${encodeURIComponent(blob.blob_id)}?instance_id=${OWNER_A}`,
	);
	const fetched = await fx.requestRaw(
		blobRef.fetch_url as string,
		`Bearer ${OWNER_TOKEN}`,
	);
	assert.equal(fetched.status, 200);
	assert.deepEqual(Buffer.from(fetched.body), bytes);
});
test("selected-instance blob read filters other-instance candidates before paging", async (t) => {
	const fx = await makeFixture(t);
	const bytes = Buffer.from("selected instance after other instance candidates");
	let lastBlob: { blob_id: string } | undefined;
	for (let index = 0; index < 1024; index++) {
		lastBlob = await fx.uploadBlob({
			bytes,
			connectorInstanceId: INTERNAL_A,
			recordKey: `a-candidate-${String(index).padStart(4, "0")}`,
			stream: "top_artists",
		});
	}
	const selected = await fx.uploadBlob({
		bytes,
		connectorInstanceId: INTERNAL_B,
		recordKey: "z-selected-visible",
		stream: "top_artists",
	});
	assert.equal(selected.blob_id, lastBlob?.blob_id);
	await fx.seedRecord({
		connectorInstanceId: INTERNAL_B,
		data: {
			blob_ref: { blob_id: selected.blob_id },
			id: "z-selected-visible",
			name: "selected after other instance candidates",
			rank: 1,
			observed_at: "2026-03-03T00:00:00Z",
		},
		key: "z-selected-visible",
		stream: "top_artists",
	});
	const response = await fx.requestRaw(
		`/v1/blobs/${selected.blob_id}?instance_id=${CLIENT_B}`,
		`Bearer ${CLIENT_TOKEN}`,
	);
	assert.equal(response.status, 200);
	assert.deepEqual(Buffer.from(response.body), bytes);
});

test("selected-instance blob read continues beyond 1024 same-instance candidates", async (t) => {
	const fx = await makeFixture(t);
	const bytes = Buffer.from("selected instance tail beyond 1024 candidates");
	let tailBlob: { blob_id: string } | undefined;
	for (let index = 0; index < 1024; index++) {
		tailBlob = await fx.uploadBlob({
			bytes,
			connectorInstanceId: INTERNAL_A,
			recordKey: `a-candidate-${String(index).padStart(4, "0")}`,
			stream: "top_artists",
		});
	}
	const visible = await fx.uploadBlob({
		bytes,
		connectorInstanceId: INTERNAL_A,
		recordKey: "z-visible-tail",
		stream: "top_artists",
	});
	assert.equal(visible.blob_id, tailBlob?.blob_id);
	await fx.seedRecord({
		connectorInstanceId: INTERNAL_A,
		data: {
			blob_ref: { blob_id: visible.blob_id },
			id: "z-visible-tail",
			name: "visible after 1024 selected-instance candidates",
			rank: 1,
			observed_at: "2026-03-03T00:00:00Z",
		},
		key: "z-visible-tail",
		stream: "top_artists",
	});
	const response = await fx.requestRaw(
		`/v1/blobs/${visible.blob_id}?instance_id=${CLIENT_A}`,
		`Bearer ${CLIENT_TOKEN}`,
	);
	assert.equal(response.status, 200);
	assert.deepEqual(Buffer.from(response.body), bytes);
});
