// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { closeDb } from "../server/db.ts";
import { EXPERIMENTAL_PARTIAL_UPDATE_TYPE } from "../server/experimental-record-updates.ts";
import { startServer } from "../server/index.ts";
import { closePostgresStorage } from "../server/postgres-storage.ts";
import { createRequestConnectorInstanceStore } from "../server/request-store-factories.ts";
import { admitOwnerRunConnection } from "../server/stores/connector-instance-store.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";

const postgresUrl = dedicatedPostgresTestUrl(
	process.env.PDPP_TEST_POSTGRES_URL,
);
const password = "experimental-record-updates-test-password";
const subject = "owner_alice";
const csrfPattern = /name="_csrf" value="([^"]+)"/;
function cookie(response: Response, name: string): string {
	const cookieValue = response.headers
		.getSetCookie()
		.map((value) => value.split(";")[0])
		.find((value) => value?.startsWith(`${name}=`));
	assert.ok(cookieValue);
	return cookieValue;
}
async function post(
	url: string,
	body: unknown,
	headers: Record<string, string> = {},
) {
	const response = await fetch(url, {
		body: JSON.stringify(body),
		headers: { "Content-Type": "application/json", ...headers },
		method: "POST",
	});
	const text = await response.text();
	const parsed = text.startsWith("{")
		? (JSON.parse(text) as Record<string, unknown>)
		: {};
	return { body: parsed, status: response.status };
}

for (const backend of ["sqlite", "postgres"] as const) {
	test(`${backend}: HTTP prototype conflicts and malformed instructions have permanent replayable receipts`, {
		skip:
			backend === "postgres" && !postgresUrl
				? "PDPP_TEST_POSTGRES_URL unset"
				: false,
	}, async () => {
		async function run(databaseUrl?: string) {
			process.env.PDPP_EXPERIMENTAL_RECORD_UPDATES = "1";
			const server = await startServer({
				asPort: 0,
				ownerAuthPassword: password,
				ownerAuthSubjectId: subject,
				quiet: true,
				rsPort: 0,
				...(databaseUrl
					? { databaseUrl, storageBackend: "postgres" }
					: { dbPath: ":memory:" }),
			});
			try {
				const asUrl = `http://localhost:${server.asPort}`;
				const rsUrl = `http://localhost:${server.rsPort}`;
				const loginPage = await fetch(`${asUrl}/owner/login`, {
					redirect: "manual",
				});
				const csrfCookie = cookie(loginPage, "pdpp_owner_csrf");
				const csrf = (await loginPage.text()).match(csrfPattern)?.[1];
				assert.ok(csrf);
				const login = await fetch(`${asUrl}/owner/login`, {
					body: new URLSearchParams({ _csrf: csrf, password, return_to: "/" }),
					headers: {
						"Content-Type": "application/x-www-form-urlencoded",
						Cookie: csrfCookie,
					},
					method: "POST",
					redirect: "manual",
				});
				const ownerSession = cookie(login, "pdpp_owner_session");
				const device = await post(`${asUrl}/oauth/device_authorization`, {
					client_id: "pdpp_cli",
				});
				const approved = await post(
					`${asUrl}/device/approve`,
					{ subject_id: subject, user_code: device.body.user_code },
					{ Cookie: ownerSession },
				);
				assert.equal(approved.status, 200);
				const token = await post(`${asUrl}/oauth/token`, {
					client_id: "pdpp_cli",
					device_code: device.body.device_code,
					grant_type: "urn:ietf:params:oauth:grant-type:device_code",
				});
				assert.equal(token.status, 200);
				const connectorId = `experimental-http-${backend}`;
				const registration = await post(
					`${asUrl}/connectors`,
					{
						connector_id: connectorId,
						connector_key: connectorId,
						display_name: "Experimental HTTP",
						manifest_uri: `https://example.test/${connectorId}`,
						protocol_version: "0.1.0",
						streams: ["events", "state"].map((name) => ({
							name,
							primary_key: ["id"],
							schema: {
								properties: {
									id: { type: "string" },
									optional: { type: ["string", "null"] },
									value: { type: "string" },
								},
								required: ["id", "value"],
								type: "object",
							},
							selection: { fields: true, resources: true },
							semantics: name === "events" ? "append_only" : "mutable_state",
							views: [
								{ fields: ["id", "optional"], id: "basic", label: "Basic" },
							],
						})),
						version: "1.0.0",
					},
					{ Cookie: ownerSession },
				);
				assert.ok(
					[200, 201].includes(registration.status),
					JSON.stringify(registration.body),
				);
				const { connectorInstanceId } = await admitOwnerRunConnection({
					connectorId,
					connectorInstanceId: null,
					connectorInstanceStore: createRequestConnectorInstanceStore(),
					ownerSubjectId: subject,
				});
				const authorization = `Bearer ${token.body.access_token}`;
				async function ingest(stream: string, records: unknown[]) {
					const response = await fetch(
						`${rsUrl}/v1/ingest/${stream}?connector_id=${connectorId}&connector_instance_id=${connectorInstanceId}`,
						{
							body: records.map((input) => JSON.stringify(input)).join("\n"),
							headers: {
								Authorization: authorization,
								"Content-Type": "application/x-ndjson",
							},
							method: "POST",
						},
					);
					assert.equal(response.status, 200);
					return (await response.json()) as {
						records_accepted: number;
						records_rejected: number;
						rejections?: Array<{ receipt_id: string; code: string }>;
					};
				}
				assert.equal(
					(
						await ingest("events", [
							{
								data: { id: "a", value: "original" },
								key: "a",
								type: "RECORD",
							},
						])
					).records_accepted,
					1,
				);
				const rejected = [
					{ data: { id: "a", value: "changed" }, key: "a" },
					{
						key: "a",
						remove: [],
						set: [],
						type: EXPERIMENTAL_PARTIAL_UPDATE_TYPE,
					},
				];
				const first = await ingest("events", rejected);
				assert.equal(first.records_rejected, 2);
				assert.deepEqual(
					first.rejections?.map((receipt) => receipt.code),
					["append_only_record_conflict", "invalid_partial_update"],
				);
				const replay = await ingest("events", rejected);
				assert.deepEqual(
					replay.rejections,
					first.rejections,
					"permanent input has stable receipt IDs on retry",
				);
				const read = await fetch(
					`${rsUrl}/v1/streams/events/records/a?connector_id=${connectorId}&connector_instance_id=${connectorInstanceId}`,
					{ headers: { Authorization: authorization } },
				);
				assert.equal(read.status, 200);
				const record = (await read.json()) as { data: { value: string } };
				assert.equal(record.data.value, "original");
				await ingest("state", [
					{
						data: { id: "a", optional: "present", value: "original" },
						key: "a",
					},
				]);
				const partial = await ingest("state", [
					{
						key: "a",
						remove: ["optional"],
						set: { value: "updated" },
						type: EXPERIMENTAL_PARTIAL_UPDATE_TYPE,
					},
				]);
				assert.equal(partial.records_accepted, 1);
				for (const projection of ["fields=id,optional", "view=basic"]) {
					const ownerRead = await fetch(
						`${rsUrl}/v1/streams/state/records?connector_id=${connectorId}&connector_instance_id=${connectorInstanceId}&${projection}`,
						{ headers: { Authorization: authorization } },
					);
					assert.equal(ownerRead.status, 200);
					const projected = (await ownerRead.json()) as {
						data: Array<{ data: Record<string, unknown> }>;
					};
					assert.deepEqual(
						projected.data[0]?.data,
						{ id: "a", value: "updated" },
						"resolved owner projection omits absent optional and out-of-projection stored values",
					);
				}
				const sparseDetail = await fetch(
					`${rsUrl}/v1/streams/state/records/a?connector_id=${connectorId}&connector_instance_id=${connectorInstanceId}&fields=id,optional`,
					{ headers: { Authorization: authorization } },
				);
				assert.equal(sparseDetail.status, 200);
				assert.deepEqual(
					((await sparseDetail.json()) as { data: Record<string, unknown> })
						.data,
					{ id: "a", value: "updated" },
					"owner detail projection retains required fields and omits removed fields",
				);
				const malformed = await ingest("state", [
					{
						data: null,
						key: "a",
						remove: [],
						set: {},
						type: EXPERIMENTAL_PARTIAL_UPDATE_TYPE,
					},
					{
						key: "a",
						op: "nonsense",
						remove: [],
						set: {},
						type: EXPERIMENTAL_PARTIAL_UPDATE_TYPE,
					},
				]);
				assert.equal(malformed.records_rejected, 2);
				assert.deepEqual(
					malformed.rejections?.map((receipt) => receipt.code),
					["invalid_partial_update", "invalid_partial_update"],
				);
			} finally {
				server.schedulerManager?.stop?.();
				server.abortStartupBackfill?.("test shutdown");
				server.asServer.closeAllConnections?.();
				server.rsServer.closeAllConnections?.();
				await Promise.all([
					new Promise<void>((resolve) =>
						server.asServer.close(() => resolve()),
					),
					new Promise<void>((resolve) =>
						server.rsServer.close(() => resolve()),
					),
				]);
				closeDb();
				await closePostgresStorage();
				delete process.env.PDPP_EXPERIMENTAL_RECORD_UPDATES;
			}
		}
		if (backend === "postgres") {
			await withTemporaryPostgresDatabase(
				{
					closeConnections: closePostgresStorage,
					connectionString: postgresUrl ?? "",
					databaseName: `pdpp_test_record_updates_http_${Date.now().toString(36)}`,
				},
				run,
			);
		} else {
			await run();
		}
	});
}
