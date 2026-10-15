// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
	CLIENT_A,
	CLIENT_B,
	CONNECTOR_ID,
	INTERNAL_A,
	INTERNAL_B,
	INTERNAL_FOREIGN,
	INTERNAL_INACTIVE,
	makeFixture,
	OWNER_A,
	OWNER_B,
	type Reply,
} from "./helpers/pairwise-rs-read-fixture.ts";

function code(reply: Reply): unknown {
	const error = reply.body.error;
	return error && typeof error === "object"
		? (error as Record<string, unknown>).code
		: reply.body.code;
}

function clientWindow(handle: string, suffix = ""): string {
	return `/v1/streams/top_artists/records/shared/field-window?field=name&instance_id=${handle}${suffix}`;
}

function ownerWindow(handle: string, suffix = ""): string {
	return `/v1/streams/top_artists/records/shared/field-window?connector_id=${CONNECTOR_ID}&field=name&instance_id=${handle}${suffix}`;
}

test("field windows select pairwise client and owner handles and preserve stored text", async (t) => {
	const fx = await makeFixture(t);
	const replies = await Promise.all([
		fx.client(clientWindow(CLIENT_A)),
		fx.client(clientWindow(CLIENT_A, `&connection_id=${CLIENT_A}`)),
		fx.client(clientWindow(CLIENT_A).replace(`instance_id=${CLIENT_A}`, `connection_id=${CLIENT_A}`)),
		fx.client(clientWindow(CLIENT_B)),
		fx.owner(ownerWindow(OWNER_A)),
		fx.owner(ownerWindow(OWNER_A, `&connection_id=${OWNER_A}`)),
		fx.owner(ownerWindow(OWNER_B)),
	]);
	for (let index = 0; index < replies.length; index++) {
		const reply = replies[index]!;
		assert.equal(reply.status, 200, reply.text);
		assert.equal(reply.body.instance_id, [CLIENT_A, CLIENT_A, CLIENT_A, CLIENT_B, OWNER_A, OWNER_A, OWNER_B][index]);
		assert.equal(reply.body.record_id, "shared");
	}
	assert.equal((replies[0]?.body.window as Record<string, unknown>).text, "application A");
	assert.equal((replies[3]?.body.window as Record<string, unknown>).text, "application B");
	assert.equal((replies[4]?.body.window as Record<string, unknown>).text, "application A");
	assert.equal((replies[6]?.body.window as Record<string, unknown>).text, "application B");
});

test("field-window selectors reject conflicts, duplicates, blank values, and internal aliases", async (t) => {
	const fx = await makeFixture(t);
	const cases = [
		`?field=name&instance_id=${CLIENT_A}&connection_id=${CLIENT_B}`,
		`?field=name&instance_id=${CLIENT_A}&instance_id=${CLIENT_A}`,
		"?field=name&instance_id=",
		`?field=name&connector_instance_id=${INTERNAL_A}`,
	] as const;
	for (const query of cases) {
		const reply = await fx.client(`/v1/streams/top_artists/records/shared/field-window${query}`);
		assert.equal(reply.status, 400, reply.text);
		assert.equal(code(reply), "invalid_request");
	}
	const missing = await fx.client("/v1/streams/top_artists/records/unique-a/field-window?field=name");
	assert.equal(missing.status, 400, missing.text);
	assert.equal(code(missing), "invalid_request");
	const unknown = await fx.client("/v1/streams/top_artists/records/shared/field-window?field=name&instance_id=inst_foreign");
	assert.equal(unknown.status, 404, unknown.text);
	assert.equal(code(unknown), "not_found");
});

test("single authorized instance permits an omitted selector before record lookup", async (t) => {
	const fx = await makeFixture(t);
	const info = fx.introspection.get("pairwise-detail-client-token")!;
	const details = info.authorization_details as Array<Record<string, any>>;
	details[0]!.streams[0]!.instance_ids = [CLIENT_A];
	(info.pdpp_instance_bindings as Array<Record<string, any>>) = (info.pdpp_instance_bindings as Array<Record<string, any>>).filter((binding) => binding.stream !== "top_artists" || binding.instance_id === CLIENT_A);
	const reply = await fx.client("/v1/streams/top_artists/records/unique-a/field-window?field=name");
	assert.equal(reply.status, 200, reply.text);
	assert.equal(reply.body.instance_id, CLIENT_A);
	assert.equal(reply.body.record_id, "unique-a");
	assert.equal((reply.body.window as Record<string, unknown>).text, "unique application A");
	const missing = await fx.client("/v1/streams/top_artists/records/does-not-exist/field-window?field=name");
	assert.equal(missing.status, 404, missing.text);
	assert.equal(code(missing), "not_found");
});

test("foreign and raw stored instance handles never resolve or appear in field-window responses", async (t) => {
	const fx = await makeFixture(t);
	for (const [token, path] of [
		["client", clientWindow("inst_foreign")],
		["client", clientWindow(INTERNAL_A)],
		["owner", ownerWindow("inst_foreign")],
		["owner", ownerWindow(INTERNAL_A)],
	] as const) {
		const reply = token === "client" ? await fx.client(path) : await fx.owner(path);
		assert.ok(reply.status === 400 || reply.status === 404, reply.text);
		assert.ok(!reply.text.includes(INTERNAL_A));
		assert.ok(!reply.text.includes(INTERNAL_B));
	}
});

test("client and owner validate every authenticated binding before selecting a field window", async (t) => {
	const fx = await makeFixture(t);
	const clientBindings = structuredClone(
		fx.introspection.get("pairwise-detail-client-token")!.pdpp_instance_bindings,
	);
	const ownerBindings = structuredClone(
		fx.introspection.get("pairwise-detail-owner-token")!.pdpp_instance_bindings,
	);
	for (const [token, mutate] of [
		["client", (info: Record<string, any>) => { info.pdpp_instance_bindings.find((binding: Record<string, unknown>) => binding.stream === "top_artists" && binding.instance_id === CLIENT_B).source_id = "https://foreign.example/source"; }],
		["client", (info: Record<string, any>) => { info.pdpp_instance_bindings.splice(info.pdpp_instance_bindings.findIndex((binding: Record<string, unknown>) => binding.stream === "top_artists" && binding.instance_id === CLIENT_B), 1); }],
		["client", (info: Record<string, any>) => { info.pdpp_instance_bindings.push({ ...info.pdpp_instance_bindings[0], instance_id: "inst_extra", rs_instance: INTERNAL_B }); }],
		["owner", (info: Record<string, any>) => { info.pdpp_instance_bindings[1].source_id = "https://foreign.example/source"; }],
		["owner", (info: Record<string, any>) => { info.pdpp_instance_bindings[1].rs_instance = INTERNAL_FOREIGN; }],
		["owner", (info: Record<string, any>) => { info.pdpp_instance_bindings[1].rs_instance = INTERNAL_INACTIVE; }],
		["owner", (info: Record<string, any>) => { info.pdpp_instance_bindings[1].rs_instance = "cin_pairwise_detail_missing"; }],
	] as const) {
		const tokenValue = token === "client" ? "pairwise-detail-client-token" : "pairwise-detail-owner-token";
		const info = fx.introspection.get(tokenValue)!;
		info.pdpp_instance_bindings = structuredClone(token === "client" ? clientBindings : ownerBindings);
		mutate(info);
		const reply = token === "client" ? await fx.client(clientWindow(CLIENT_A)) : await fx.owner(ownerWindow(OWNER_A));
		assert.equal(reply.status, 403, reply.text);
		assert.equal(code(reply), "grant_invalid");
		assert.ok(!reply.text.includes(INTERNAL_A));
	}
});

test("field-window field denial remains grant-enforced", async (t) => {
	const fx = await makeFixture(t);
	const info = fx.introspection.get("pairwise-detail-client-token")!;
	(info.authorization_details as Array<Record<string, any>>)[0]!.streams[0]!.fields = ["id"];
	const denied = await fx.client(clientWindow(CLIENT_A));
	assert.equal(denied.status, 403, denied.text);
	assert.equal(code(denied), "field_not_granted");
});

test("field-window resource and time exclusions remain hidden", async (t) => {
	const fx = await makeFixture(t);
	const stream = (fx.introspection.get("pairwise-detail-client-token")!.authorization_details as Array<Record<string, any>>)[0]!.streams[0]!;
	stream.resources = ["shared"];
	const resourceAllowed = await fx.client(clientWindow(CLIENT_A));
	assert.equal(resourceAllowed.status, 200, resourceAllowed.text);
	stream.resources = ["different-key"];
	const resourceHidden = await fx.client(clientWindow(CLIENT_A));
	assert.equal(resourceHidden.status, 404, resourceHidden.text);
	delete stream.resources;
	stream.time_constraint = { field: "observed_at", since: "2026-02-01T00:00:00Z" };
	const timeAllowed = await fx.client(clientWindow(CLIENT_A));
	assert.equal(timeAllowed.status, 200, timeAllowed.text);
	stream.time_constraint = { field: "observed_at", since: "2026-04-01T00:00:00Z" };
	const timeHidden = await fx.client(clientWindow(CLIENT_A));
	assert.equal(timeHidden.status, 404, timeHidden.text);
});

test("field-window bounds, search, and paging preserve stable public identity", async (t) => {
	const fx = await makeFixture(t);
	const replies = await Promise.all([
		fx.client(clientWindow(CLIENT_A, "&offset_chars=2&limit_chars=4")),
		fx.client(clientWindow(CLIENT_A, "&q=ation&before_chars=2&after_chars=3")),
		fx.client(clientWindow(CLIENT_A, "&offset_chars=99&limit_chars=999999")),
	]);
	for (const reply of replies) {
		assert.equal(reply.status, 200, reply.text);
		assert.equal(reply.body.instance_id, CLIENT_A);
		assert.equal(reply.body.record_id, "shared");
	}
	assert.equal((replies[0]?.body.window as Record<string, unknown>).text, "plic");
	assert.equal((replies[1]?.body.window as Record<string, unknown>).text, "ication A");
	assert.equal((replies[0]?.body.window as Record<string, unknown>).next_offset_chars, 6);
	assert.equal((replies[0]?.body.window as Record<string, unknown>).previous_offset_chars, 0);
	assert.equal((replies[2]?.body.window as Record<string, unknown>).text, "");
	assert.deepEqual(
		(replies[2]?.body.meta as Record<string, unknown>).warnings,
		[{ code: "limit_clamped", message: "limit_chars clamped to 16384", param: "limit_chars" }],
	);
});

test("field-window typed errors and operational output do not disclose stored selectors", async (t) => {
	const fx = await makeFixture(t);
	const cases = [
		["field=&instance_id=" + CLIENT_A, 400, "invalid_field_path"],
		["field=name&offset_chars=-1&instance_id=" + CLIENT_A, 400, "invalid_window"],
		["field=rank&instance_id=" + CLIENT_A, 422, "field_not_text"],
		["field=name&q=missing&instance_id=" + CLIENT_A, 404, "query_not_found"],
	] as const;
	for (const [query, status, expectedCode] of cases) {
		const reply = await fx.client(`/v1/streams/top_artists/records/shared/field-window?${query}`);
		assert.equal(reply.status, status, reply.text);
		assert.equal(code(reply), expectedCode);
		assert.ok(!reply.text.includes(INTERNAL_A));
		assert.ok(!reply.text.includes(INTERNAL_B));
	}
	const absent = await fx.owner(
		ownerWindow(OWNER_A).replace("field=name", "field=missing"),
	);
	assert.equal(absent.status, 404, absent.text);
	assert.equal(code(absent), "field_not_found");
	const response = await fx.client(clientWindow(CLIENT_A));
	assert.ok(!response.text.includes(INTERNAL_A));
	assert.ok(!response.text.includes(INTERNAL_B));
	assert.equal(response.body.url, `/v1/streams/top_artists/records/shared/field-window?field=name&instance_id=${CLIENT_A}`);
});
