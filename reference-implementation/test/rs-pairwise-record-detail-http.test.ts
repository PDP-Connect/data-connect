// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
	assertNoInternalIds,
	CLIENT_A,
	CLIENT_B,
	CLIENT_TOKEN,
	CONNECTOR_ID,
	INTERNAL_A,
	makeFixture,
	OWNER_A,
	OWNER_TOKEN,
} from "./helpers/pairwise-rs-read-fixture.ts";

test("authenticated client and owner record detail use pairwise instance handles", async (t) => {
	const fx = await makeFixture(t);
	const requests = [
		[
			"client canonical handle",
			() =>
				fx.client(
					`/v1/streams/top_artists/records/shared?instance_id=${CLIENT_A}`,
				),
			CLIENT_A,
			"application A",
		],
		[
			"client deprecated alias",
			() =>
				fx.client(
					`/v1/streams/top_artists/records/shared?connection_id=${CLIENT_A}`,
				),
			CLIENT_A,
			"application A",
		],
		[
			"owner canonical handle",
			() =>
				fx.owner(
					`/v1/streams/top_artists/records/shared?connector_id=${CONNECTOR_ID}&instance_id=${OWNER_A}`,
				),
			OWNER_A,
			"application A",
		],
		[
			"owner deprecated alias",
			() =>
				fx.owner(
					`/v1/streams/top_artists/records/shared?connector_id=${CONNECTOR_ID}&connection_id=${OWNER_A}`,
				),
			OWNER_A,
			"application A",
		],
	] as const;
	const replies = await Promise.all(
		requests.map(async ([label, request]) => [label, await request()] as const),
	);
	for (const [label, reply] of replies)
		console.log(`PAIRWISE_DETAIL_RED ${label} ${JSON.stringify(reply)}`);
	for (let i = 0; i < replies.length; i++) {
		const [label, reply] = replies[i]!;
		const [, , expectedHandle, expectedName] = requests[i]!;
		assert.equal(reply.status, 200, `${label}: ${reply.text}`);
		assert.equal(
			reply.body.instance_id,
			expectedHandle,
			`${label} must emit a public handle`,
		);
		assert.equal(
			(reply.body.data as Record<string, unknown>)?.name,
			expectedName,
			`${label} selected wrong application data`,
		);
		assertNoInternalIds(reply.text);
		assert.equal(
			Object.hasOwn(reply.body, "connection_id"),
			false,
			`${label} must not emit an internal selector`,
		);
	}
});

test("detail selectors reject conflicting, malformed, raw, or missing selection before lookup", async (t) => {
	const fx = await makeFixture(t);
	const cases = [
		[
			"same aliases",
			`/v1/streams/top_artists/records/shared?instance_id=${CLIENT_A}&connection_id=${CLIENT_A}`,
			200,
			CLIENT_A,
		],
		[
			"different aliases",
			`/v1/streams/top_artists/records/shared?instance_id=${CLIENT_A}&connection_id=${CLIENT_B}`,
			400,
			null,
		],
		[
			"duplicate selector",
			`/v1/streams/top_artists/records/shared?instance_id=${CLIENT_A}&instance_id=${CLIENT_A}`,
			400,
			null,
		],
		[
			"empty selector",
			"/v1/streams/top_artists/records/shared?instance_id=",
			400,
			null,
		],
		[
			"raw stored selector",
			`/v1/streams/top_artists/records/shared?instance_id=${INTERNAL_A}`,
			400,
			null,
		],
		[
			"missing selector before unique lookup",
			"/v1/streams/top_artists/records/unique-a",
			400,
			null,
		],
	] as const;
	const replies = await Promise.all(
		cases.map(async ([label, path, status, handle]) => ({
			label,
			path,
			status,
			handle,
			reply: await fx.client(path),
		})),
	);
	const failures: string[] = [];
	for (const { label, status, handle, reply } of replies) {
		console.log(`PAIRWISE_DETAIL_RED ${label} ${JSON.stringify(reply)}`);
		if (reply.status !== status)
			failures.push(`${label}: expected ${status}, got ${reply.status}`);
		if (handle && reply.body.instance_id !== handle)
			failures.push(`${label}: wrong public instance_id`);
		try {
			assertNoInternalIds(reply.text);
		} catch {
			failures.push(`${label}: response disclosed an internal selector`);
		}
	}
	assert.deepEqual(failures, []);
});

test("record detail projects the pairwise handle to expanded child envelopes", async (t) => {
	const fx = await makeFixture(t);
	const reply = await fx.owner(
		`/v1/streams/parents/records/parent-a?connector_id=${CONNECTOR_ID}&instance_id=${OWNER_A}&expand=children`,
	);
	console.log(
		`PAIRWISE_DETAIL_RED owner expanded child ${JSON.stringify(reply)}`,
	);
	assert.equal(reply.status, 200, reply.text);
	assert.equal(reply.body.instance_id, OWNER_A);
	assert.equal(
		(reply.body.data as Record<string, unknown>)?.name,
		"parent application data",
	);
	const expanded = reply.body.expanded as Record<
		string,
		Record<string, unknown>
	>;
	const children = expanded.children!.data as Array<Record<string, unknown>>;
	assert.equal(children[0]?.instance_id, OWNER_A);
	assert.equal(
		(children[0]?.data as Record<string, unknown>)?.name,
		"child application data",
	);
	assertNoInternalIds(reply.text);
});

test("client detail keeps the current expansion restriction", async (t) => {
	const fx = await makeFixture(t);
	const reply = await fx.client(
		`/v1/streams/parents/records/parent-a?instance_id=${CLIENT_A}&expand=children`,
	);
	assert.equal(reply.status, 400, reply.text);
	assert.equal(
		(reply.body.error as Record<string, unknown>)?.code,
		"invalid_request",
	);
	assert.equal(
		(reply.body.error as Record<string, unknown>)?.param,
		"expand",
	);
	assertNoInternalIds(reply.text);
});

test("owner detail requires a selector before looking up a uniquely present record", async (t) => {
	const fx = await makeFixture(t);
	const reply = await fx.owner(
		`/v1/streams/top_artists/records/unique-a?connector_id=${CONNECTOR_ID}`,
	);
	console.log(
		`PAIRWISE_DETAIL_RED owner missing selector before unique lookup ${JSON.stringify(reply)}`,
	);
	assert.equal(reply.status, 400, reply.text);
	assert.equal(
		(reply.body.error as Record<string, unknown>)?.code,
		"invalid_request",
	);
	assertNoInternalIds(reply.text);
});

test("detail validates every authenticated client binding before selector narrowing", async (t) => {
	const fx = await makeFixture(t);
	const bindings = fx.introspection.get(CLIENT_TOKEN)!
		.pdpp_instance_bindings as Array<Record<string, unknown>>;
	bindings[1]!.rs_instance = "cin_unowned_unselected";
	const reply = await fx.client(
		`/v1/streams/top_artists/records/shared?instance_id=${CLIENT_A}`,
	);
	console.log(
		`PAIRWISE_DETAIL_RED invalid unselected binding ${JSON.stringify(reply)}`,
	);
	assert.equal(reply.status, 403, reply.text);
	assertNoInternalIds(reply.text);
});

test("detail validates every authenticated owner binding before selector narrowing", async (t) => {
	const fx = await makeFixture(t);
	const bindings = fx.introspection.get(OWNER_TOKEN)!
		.pdpp_instance_bindings as Array<Record<string, unknown>>;
	bindings[1]!.rs_instance = "cin_unowned_unselected";
	const reply = await fx.owner(
		`/v1/streams/top_artists/records/unique-a?connector_id=${CONNECTOR_ID}&instance_id=${OWNER_A}`,
	);
	console.log(
		`PAIRWISE_DETAIL_RED invalid unselected owner binding ${JSON.stringify(reply)}`,
	);
	assert.equal(reply.status, 403, reply.text);
	assertNoInternalIds(reply.text);
});
