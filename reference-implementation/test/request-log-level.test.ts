// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { Writable } from "node:stream";
import test from "node:test";

import pino from "pino";
import { createApp } from "../server/transport.ts";

// A few agent sessions can hit `/introspect` and `GET /mcp` many times a second.
// Their per-request completion record must not flood the info-level log, while
// failures and ordinary traffic keep info-level detail.

interface Res {
	json: (body: unknown) => unknown;
	status: (code: number) => Res;
}

async function completionLevels(
	requests: { method: "GET" | "POST" | "DELETE"; url: string }[],
) {
	const lines: { level: number; url?: string; statusCode?: number }[] = [];
	const sink = new Writable({
		write(chunk, _enc, cb) {
			lines.push(JSON.parse(String(chunk)));
			cb();
		},
	});
	const app = createApp({ logger: pino({ level: "debug" }, sink) });
	const reply = (status: number) => (_req: unknown, res: Res) =>
		res.status(status).json({});
	app.post("/introspect", reply(200));
	app.get("/mcp", reply(405));
	app.delete("/mcp", reply(405));
	app.post("/mcp", reply(200));
	app.get("/v1/other", reply(200));
	app.get("/v1/broken", reply(500));
	await app.fastify.ready();
	for (const r of requests) {
		await app.fastify.inject(r);
	}
	const DEBUG = 20;
	return lines
		.filter((l) => l.statusCode !== undefined)
		.map((l) => ({ debug: l.level === DEBUG, url: l.url }));
}

test("successful /introspect and any GET/DELETE /mcp complete at debug; other requests stay at info", async () => {
	const out = await completionLevels([
		{ method: "POST", url: "/introspect" },
		{ method: "GET", url: "/mcp" },
		{ method: "DELETE", url: "/mcp" },
		{ method: "POST", url: "/mcp" },
		{ method: "GET", url: "/v1/other" },
		{ method: "GET", url: "/v1/broken" },
	]);
	assert.deepEqual(out, [
		{ debug: true, url: "/introspect" },
		{ debug: true, url: "/mcp" },
		{ debug: true, url: "/mcp" },
		{ debug: false, url: "/mcp" },
		{ debug: false, url: "/v1/other" },
		{ debug: false, url: "/v1/broken" },
	]);
});
