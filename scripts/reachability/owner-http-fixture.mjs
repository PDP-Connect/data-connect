// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import pino from "pino";
import { createOwnerAuthPlaceholder } from "../../reference-implementation/server/owner-auth.ts";
import { createMemoryOwnerSessionStore } from "../../reference-implementation/server/owner-session.ts";
import { ReachabilityOperations } from "../../reference-implementation/server/reachability/operations.ts";
import { ReachabilityService } from "../../reference-implementation/server/reachability/service.ts";
import { mountOwnerReachability } from "../../reference-implementation/server/routes/owner-reachability.ts";
import { mountOwnerRemoteAccess } from "../../reference-implementation/server/routes/owner-remote-access.ts";
import { createApp } from "../../reference-implementation/server/transport.ts";

// Real transport, owner session and CSRF middleware; no request handler shortcuts.
export async function createOwnerHttpFixture(
	gozar,
	query,
	root,
	canary,
	identity,
	hostCapabilities,
	{ acknowledgeDisconnect = async () => {} } = {},
) {
	const logs = [];
	const app = createApp({
		logger: pino(
			{},
			{
				write: (line) => {
					logs.push(line);
				},
			},
		),
	});
	const password = randomBytes(32).toString("hex");
	const auth = createOwnerAuthPlaceholder({
		password,
		allowUnauthenticatedWhenDisabled: false,
		loginRateLimit: false,
		sessionStore: createMemoryOwnerSessionStore(),
	});
	auth.attachRoutes(app);
	const diagnostics = [];
	const observedGozar = new Proxy(gozar, {
		get(target, property) {
			const value = target[property];
			if (typeof value !== "function" || property === "watchRoutes")
				return value;
			return async (...args) => {
				try {
					return await value(...args);
				} catch (error) {
					diagnostics.push({
						method: property,
						code: error.code ?? null,
						cause: error.cause?.code ?? null,
						message: String(error.message).replaceAll(canary, "[redacted]"),
						causeMessage: String(error.cause?.message ?? "").replaceAll(
							canary,
							"[redacted]",
						),
					});
					throw error;
				}
			};
		},
	});
	const service = new ReachabilityService(observedGozar, {
		query,
		identity,
		hostCapabilities,
		prepare: async () => {},
		acknowledgeDisconnect,
	});
	const context = {
		service,
		operations: new ReachabilityOperations(join(root, "host-operations")),
		requireToken: auth.requireOwnerSession,
		requireOwner: auth.requireOwnerSession,
		requireCsrf: auth.requireCookieMutationCsrf,
		usage: (kind) =>
			kind === "attached"
				? { kind }
				: kind === "session"
					? { kind, lifetimeMs: 60000 }
					: {
							kind: "durable",
							routeId: `fixture-${randomBytes(12).toString("hex")}`,
						},
	};
	mountOwnerReachability(app, context);
	mountOwnerRemoteAccess(app, context);
	await app.listen(0, "localhost");
	const port = app.fastify.server.address().port;
	const origin = `http://localhost:${port}`;
	const cookies = new Map();
	function remember(response) {
		for (const value of response.headers.getSetCookie()) {
			const pair = value.split(";")[0],
				index = pair.indexOf("=");
			cookies.set(pair.slice(0, index), pair.slice(index + 1));
		}
	}
	const cookie = () =>
		[...cookies].map(([key, value]) => `${key}=${value}`).join("; ");
	const login = await fetch(`${origin}/owner/login`, {
		headers: { accept: "text/html" },
		redirect: "manual",
	});
	remember(login);
	const html = await login.text();
	let csrf = html.match(/name="_csrf"[^>]*value="([^"]+)"/)?.[1];
	assert.ok(csrf, "Real owner login must offer a CSRF field");
	const signedIn = await fetch(`${origin}/owner/login`, {
		method: "POST",
		redirect: "manual",
		headers: {
			cookie: cookie(),
			"content-type": "application/x-www-form-urlencoded",
			accept: "text/html",
		},
		body: new URLSearchParams({
			password,
			_csrf: csrf,
			return_to: "/owner/login",
		}),
	});
	remember(signedIn);
	const refreshed = await fetch(`${origin}/owner/login`, {
		headers: { cookie: cookie(), accept: "text/html" },
		redirect: "manual",
	});
	remember(refreshed);
	await refreshed.text();
	csrf = cookies.get("pdpp_owner_csrf");
	assert.ok(csrf, "Authenticated session must refresh its CSRF cookie");
	if (signedIn.status < 300 || signedIn.status >= 400) {
		await app.fastify.close();
		throw new Error(
			`Owner login must succeed: ${signedIn.status} ${await signedIn.text()}`,
		);
	}
	const responses = [];
	async function request(path, input, options = {}) {
		const response = await fetch(`${origin}/v1/owner/reachability${path}`, {
			method: input === undefined ? "GET" : "POST",
			redirect: "manual",
			headers: {
				accept: "application/json",
				...(options.invalidBearer ? { authorization: "Bearer invalid" } : {}),
				"content-type": "application/json",
				...(options.anonymous ? {} : { cookie: cookie() }),
			},
			...(input === undefined
				? {}
				: {
						body: options.rawBody ?? JSON.stringify({
							...input,
							...(options.noCsrf ? {} : { _csrf: csrf }),
						}),
					}),
		});
		const text = await response.text();
		assert.ok(
			!text.includes(canary),
			"Credential canary escaped through an owner read/error response",
		);
		responses.push(text);
		let payload;
		try {
			payload = JSON.parse(text);
		} catch {
			throw new Error(`Owner API returned non-JSON status ${response.status}`);
		}
		return { status: response.status, ...payload };
	}
	async function call(path, body) {
		const result = await request(path, body);
		if (result.error)
			throw Object.assign(new Error("Owner operation refused"), {
				code: result.error.code,
				step: path,
			});
		return result.data;
	}
	return {
		app,
		service,
		operations: context.operations,
		request,
		call,
		responses,
		diagnostics,
		logs,
		origin,
		close: async () => {
			service.closeObservers();
			await app.fastify.close();
			assert.ok(
				!logs.join("").includes(canary),
				"Credential reached a server log",
			);
		},
	};
}
