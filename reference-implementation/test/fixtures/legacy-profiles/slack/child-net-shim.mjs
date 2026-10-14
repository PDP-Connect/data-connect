// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// Preload for the connector CHILD (NODE_OPTIONS=--import=<this file>), test harness only.
// The Slack connector hard-codes API_BASE = "https://slack.com/api/" (slack-api.ts), so
// its base URL cannot be pointed at a local mock. This shim therefore (1) refuses every
// non-loopback socket and every fetch except slack.com/api/<method>, and (2) answers those
// with constructed fixtures (NET_SHIM_MODE=fixture) or with a refusal (NET_SHIM_MODE=deny). Every attempt is logged to <os.tmpdir()>/slack-net-shim.jsonl.
// The connector bundle is unmodified; only the child's global fetch and net.connect change.
import { appendFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mode = process.env.NET_SHIM_MODE === "fixture" ? "fixture" : "deny";
const record = (entry) =>
	appendFileSync(
		join(tmpdir(), "slack-net-shim.jsonl"),
		`${JSON.stringify(entry)}\n`,
	);
const loopback = (host) =>
	!host ||
	host === "localhost" ||
	host === "127.0.0.1" ||
	host === "::1" ||
	host === "[::1]";

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function patched(...argv) {
	const first = argv[0];
	const host =
		typeof first === "object" && first !== null
			? first.host
			: typeof argv[1] === "string"
				? argv[1]
				: undefined;
	const unixPath =
		typeof first === "object" && first !== null ? first.path : undefined;
	if (!unixPath && !loopback(host)) {
		record({ blocked: "socket", host });
		queueMicrotask(() =>
			this.destroy(new Error(`net_shim_blocked_socket: ${host}`)),
		);
		return this;
	}
	return connect.apply(this, argv);
};

const NOW = 1791000000;
const FIXTURES = {
	"stars.list": {
		ok: true,
		items: [
			{
				type: "message",
				channel: "C0GENERAL1",
				date_create: NOW - 50,
				message: { ts: "1791000100.000100", user: "U0ALICE01" },
			},
		],
		response_metadata: { next_cursor: "" },
	},
	"usergroups.list": {
		ok: true,
		usergroups: [
			{
				id: "S0GROUP001",
				team_id: "T0ACME001",
				handle: "eng",
				name: "Engineering",
				description: "Engineers",
				is_external: false,
				is_subteam: true,
				users: ["U0TESTER1", "U0ALICE01"],
				prefs: { channels: ["C0GENERAL1"] },
				date_create: NOW - 9000,
				date_update: NOW - 8000,
				date_delete: 0,
			},
		],
	},
	"reminders.list": {
		ok: true,
		reminders: [
			{
				id: "Rm0REMIND01",
				creator: "U0TESTER1",
				user: "U0TESTER1",
				text: "Review the canvas",
				recurring: false,
				time: NOW + 3600,
				complete_ts: 0,
			},
		],
	},
};
const DM_INFO = {
	D0DIRECT01: {
		id: "D0DIRECT01",
		last_read: "1791000400.000100",
		unread_count: 0,
		unread_count_display: 0,
	},
};

globalThis.fetch = async (input, init) => {
	const url = new URL(
		typeof input === "string"
			? input
			: input instanceof URL
				? input.href
				: input.url,
	);
	const method = url.pathname.replace(/^\/api\//, "");
	const entry = { mode, host: url.host, method, via: init?.method ?? "GET" };
	if (url.host !== "slack.com" || !url.pathname.startsWith("/api/")) {
		record({ ...entry, blocked: "fetch" });
		throw new Error(`net_shim_blocked_fetch: ${url.origin}`);
	}
	if (mode === "deny") {
		// A thrown connection error would be retried by the connector (4 attempts, exponential backoff, 3 s
		// pacing per call), turning this test into minutes. A non-retryable refusal exercises the same
		// "optional stream fails and is skipped" path without the wait.
		record({ ...entry, blocked: "deny-mode" });
		return new Response(
			JSON.stringify({ ok: false, error: "net_shim_denied" }),
			{ status: 400, headers: { "content-type": "application/json" } },
		);
	}
	let body = FIXTURES[method];
	if (method === "conversations.info") {
		const channel = url.searchParams.get("channel");
		body = DM_INFO[channel]
			? { ok: true, channel: DM_INFO[channel] }
			: { ok: false, error: "channel_not_found" };
	}
	record({ ...entry, served: Boolean(body) });
	return new Response(
		JSON.stringify(body ?? { ok: false, error: "unknown_method" }),
		{
			status: 200,
			headers: { "content-type": "application/json" },
		},
	);
};
