// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { buildAppPractice } from "./app-practice.ts";
import { applyAppReading } from "./app-reading.ts";
import type { AppReadDay } from "../lib/ref-client.ts";
const at = "2026-11-25T14:00:00Z";
for (const shape of ["service", "connection", "none"] as const)
	test(`last read uses the same history for ${shape} reads`, () => {
		const app = buildAppPractice("app-one").apps[0]!;
		const source = app.sourceAccess[0]!;
		const row: AppReadDay = {
			day: "2026-11-25",
			client_id: app.clientIds[0]!,
			reads: 8,
			across_sources: shape === "none" ? 8 : 0,
			last_at: at,
			permission_refusals: 0,
			sources:
				shape === "none"
					? []
					: [
							{
								source_id: source.source.connector_id!,
								source_kind: "connector",
								connection_id:
									shape === "connection" ? source.source.connection_id : null,
								reads: 8,
								records: 8,
								last_at: at,
							},
						],
		};
		const updated = applyAppReading(app, [row]);
		assert.equal(updated.lastRead, at);
		assert.equal(
			updated.sourceAccess[0]!.last_read_at,
			shape === "none" ? null : at,
		);
		assert.equal(app.sourceAccess[0]!.last_read_at, source.last_read_at);
	});
test("a service-only read does not claim which of two accounts was read", () => {
	const app = buildAppPractice("app-one").apps[0]!;
	const source = app.sourceAccess[0]!;
	app.sourceAccess.push({
		...structuredClone(source),
		source: { ...source.source, connection_id: "another-account" },
	});
	const updated = applyAppReading(app, [
		{
			day: "2026-11-25",
			client_id: app.clientIds[0]!,
			reads: 1,
			across_sources: 0,
			last_at: at,
			permission_refusals: 0,
			sources: [
				{
					source_id: source.source.connector_id!,
					source_kind: "connector",
					connection_id: null,
					reads: 1,
					records: 1,
					last_at: at,
				},
			],
		},
	]);
	assert.equal(updated.lastRead, at);
	assert.ok(
		updated.sourceAccess.every((source) => source.last_read_at === null),
	);
});
