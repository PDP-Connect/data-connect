// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// Preload for a connector CHILD (NODE_OPTIONS=--import=<this file>), test harness only.
// Spotify and GitHub hard-code their API origins (`const API = "https://api.spotify.com/v1"`,
// parsers.ts API_BASE), so a local mock server cannot be pointed at. This shim replaces the
// child's global fetch with a handler module (NET_SHIM_HANDLER, a file URL) that answers
// constructed fixture responses, and refuses every other fetch and every non-loopback socket.
// Every attempt is logged to <os.tmpdir()>/net-shim.jsonl. The connector bundle is unmodified.
import { appendFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const record = (entry) =>
	appendFileSync(
		join(tmpdir(), "net-shim.jsonl"),
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

const handler = process.env.NET_SHIM_HANDLER
	? (await import(process.env.NET_SHIM_HANDLER)).default
	: () => null;

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
	const url = new URL(
		typeof input === "string"
			? input
			: input instanceof URL
				? input.href
				: input.url,
	);
	const method = init?.method ?? "GET";
	if (loopback(url.hostname)) {
		record({ method, url: `${url.origin}${url.pathname}`, loopback: true });
		return realFetch(input, init);
	}
	const answer = handler({ method, url, headers: init?.headers ?? {} });
	if (!answer) {
		record({ blocked: "fetch", method, url: `${url.origin}${url.pathname}` });
		throw new Error(
			`net_shim_blocked_fetch: ${method} ${url.origin}${url.pathname}`,
		);
	}
	record({
		method,
		url: `${url.origin}${url.pathname}${url.search}`,
		status: answer.status ?? 200,
	});
	return new Response(JSON.stringify(answer.body), {
		status: answer.status ?? 200,
		headers: { "content-type": "application/json", ...(answer.headers ?? {}) },
	});
};
