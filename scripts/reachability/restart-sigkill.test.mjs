// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// A real reference server is SIGKILLed while remote access is On, and a second server
// starts on the same state directory. Nothing here is faked except the provider: the
// server, the reachability service, the operation journal, the sealed secret store and
// Gozar's detached controller are the real ones. In-process tests cannot show a lost
// owner, a controller that outlives it, or two processes sharing one state directory.
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createGozar, createServiceVerifier } from "@tnunamak/gozar";
import { ReachabilityOperations } from "../../reference-implementation/server/reachability/operations.ts";
import { FixtureSecretBackend } from "../../reference-implementation/test/fixtures/reachability/secret-backend.ts";
import { requireDiskFloor } from "./disk-floor.mjs";
import { prepareDraft } from "./journey-support.mjs";
import { createUnknownRegistry } from "./unknown-registry.mjs";

const SERVER = new URL("./restart-sigkill-server.mjs", import.meta.url);
const REFERENCE = new URL("../../reference-implementation/", import.meta.url);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Polls until `read` returns something other than undefined, or the deadline passes.
async function until(label, deadlineMs, read) {
	const stop = Date.now() + deadlineMs;
	for (;;) {
		const value = await read();
		if (value !== undefined) return value;
		if (Date.now() > stop) throw new Error(`Timed out after ${deadlineMs} ms waiting for: ${label}`);
		await sleep(50);
	}
}
const alive = (pid) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (error.code === "ESRCH") return false;
		throw error;
	}
};
async function freePort() {
	const listener = net.createServer();
	listener.listen(0, "127.0.0.1");
	await once(listener, "listening");
	const { port } = listener.address();
	listener.close();
	await once(listener, "close");
	return port;
}
const readLines = async (path) => {
	try {
		return (await readFile(path, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
	} catch (error) {
		if (error.code === "ENOENT") return [];
		throw error;
	}
};

// One reference server process on the shared state directory.
async function bootServer(world, { hold = false } = {}) {
	const asPort = await freePort(),
		rsPort = await freePort();
	const holdFile = join(world.root, "hold-close");
	if (hold) await writeFile(holdFile, "");
	const child = fork(SERVER, [world.descriptorPath], {
		cwd: REFERENCE,
		execArgv: ["--import", "tsx"],
		stdio: ["ignore", "ignore", "ignore", "ipc"],
		env: {
			PATH: process.env.PATH,
			HOME: process.env.HOME,
			PDPP_DATA_DIR: world.data,
			PDPP_DB_PATH: join(world.data, "restart.sqlite"),
			PDPP_OWNER_PASSWORD: world.password,
			PDPP_CREDENTIAL_ENCRYPTION_KEY: world.encryptionKey,
			PDPP_BIND_HOST: "127.0.0.1",
			PDPP_EMBEDDING_DOWNLOAD_ALLOWED: "0",
			PDPP_SEMANTIC_EMBEDDING_BACKEND: "stub",
			AS_PORT: String(asPort),
			RS_PORT: String(rsPort),
			PDPP_AS_URL: `http://127.0.0.1:${asPort}`,
			PDPP_RS_URL: `http://127.0.0.1:${rsPort}`,
			...(hold ? { RESTART_HOLD_FILE: holdFile } : {}),
		},
	});
	world.children.add(child);
	const exited = once(child, "exit");
	const deadline = new Promise((_, reject) => setTimeout(() => reject(new Error("Server did not become ready in 45 s")), 45_000));
	await Promise.race([
		once(child, "message"),
		exited.then(([code, signal]) => {
			throw new Error(`Server exited before it was ready (${code ?? signal})`);
		}),
		deadline,
	]);
	return { child, exited, holdFile, api: await ownerApi(asPort, rsPort, world.password) };
}

// The console's own path: sign in to the authorization server, mint the owner
// bearer through the device flow, then call the resource server's owner routes.
async function ownerApi(asPort, rsPort, password) {
	const as = `http://127.0.0.1:${asPort}`;
	const login = await fetch(`${as}/owner/login`, {
		method: "POST",
		redirect: "manual",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ password }),
	});
	assert.equal(login.status, 302, "Owner sign-in must succeed");
	const cookie = login.headers
		.getSetCookie()
		.map((value) => value.split(";")[0])
		.filter((pair) => !pair.endsWith("="))
		.join("; ");
	const post = (path, body) =>
		fetch(`${as}${path}`, {
			method: "POST",
			headers: { "content-type": "application/json", cookie },
			body: JSON.stringify(body),
		});
	const device = await (await post("/oauth/device_authorization", { client_id: "dataconnect-console" })).json();
	assert.equal((await post("/device/approve", { user_code: device.user_code })).status, 200);
	const token = await (
		await post("/oauth/token", {
			client_id: "dataconnect-console",
			device_code: device.device_code,
			grant_type: "urn:ietf:params:oauth:grant-type:device_code",
		})
	).json();
	assert.ok(token.access_token, "Owner device flow must issue a bearer");
	async function request(path, input) {
		const response = await fetch(`http://127.0.0.1:${rsPort}/v1/owner/reachability${path}`, {
			method: input === undefined ? "GET" : "POST",
			headers: { authorization: `Bearer ${token.access_token}`, "content-type": "application/json" },
			...(input === undefined ? {} : { body: JSON.stringify(input) }),
		});
		return { status: response.status, ...(await response.json()) };
	}
	async function call(path, input) {
		const result = await request(path, input);
		if (result.error) throw Object.assign(new Error(`Owner call refused: ${result.error.code}`), { code: result.error.code, step: path });
		return result.data;
	}
	return { request, call };
}

// Turn on, exactly as the console does: draft, review, approve, then poll the operation.
async function turnOn(world, api) {
	const catalog = await api.call("/catalog");
	const provider = catalog.providers.find((item) => item.providerId === world.providerId);
	assert.ok(provider, "The fixture provider must be offered");
	const draft = await prepareDraft(api, provider, world.canary, [], { trace: [] });
	await api.call(`/drafts/${draft.draftId}/commit`, { expectedRevision: draft.configuration.revision });
	const review = await api.call(`/drafts/${draft.draftId}/review`, { usage: "attached" });
	return approve(api, review);
}
const approve = (api, review) =>
	api.call("/operations", {
		reviewId: review.id,
		kind: "route",
		consentFactsDigest: review.candidate.consentFactsDigest,
		acknowledgeDisconnect: true,
	});
async function settled(api, operationId) {
	return until(`operation ${operationId} settles`, 30_000, async () => {
		const record = await api.call(`/operations/${operationId}`);
		return record.stage === "applying" ? undefined : record;
	});
}
async function currentRoute(api) {
	return until("a route is On", 30_000, async () => {
		const state = await api.call("/state");
		// On: the lifecycle names this route as verified and the route is published.
		return state.routes.find(
			(route) =>
				route.published &&
				route.state === "usable" &&
				route.cleanup.state === "none" &&
				state.lifecycle.phase === "verified" &&
				state.lifecycle.handle?.id === route.handle.id,
		);
	});
}

async function createWorld() {
	await requireDiskFloor();
	const parent = join(homedir(), ".tmp", "ra");
	await mkdir(parent, { recursive: true, mode: 0o700 });
	// Gozar binds Unix sockets under this path; it must stay short.
	const root = await mkdtemp(join(parent, "sk-"));
	const registry = await createUnknownRegistry(join(root, "registry"), { fixture: "non-http" });
	const identity = { instanceId: randomUUID(), bootId: randomUUID() };
	const hostCapabilities = Object.fromEntries(
		["installer.execute", "privilege.elevate", "secrets.backend", "runtime.attached", "runtime.durable"].map((id) => [id, { known: true, value: id !== "privilege.elevate" }]),
	);
	const home = join(root, "gozar"),
		owner = "fixture-owner";
	// Used only to read the provider's declared requirements and, if the test fails,
	// to close what a server left behind. The servers use their own instances.
	const library = createGozar({ manifest: registry.manifest, root: registry.root, secretBackend: new FixtureSecretBackend(), identity, hostCapabilities });
	const { providers } = await library.listProviders({ home, owner });
	assert.equal(providers.length, 1);
	const [provider] = providers;
	const verifyService = createServiceVerifier();
	const app = http.createServer((request, response) => {
		if (!verifyService(request, response)) response.end("fixture application");
	});
	app.listen(0, "127.0.0.1");
	await once(app, "listening");
	const data = join(root, "data");
	await mkdir(data, { mode: 0o700 });
	const descriptorPath = join(root, "descriptor.json");
	await writeFile(
		descriptorPath,
		JSON.stringify({
			root,
			home,
			owner,
			instanceId: identity.instanceId,
			manifest: registry.manifest,
			registryRoot: registry.root,
			providerId: provider.providerId,
			target: `127.0.0.1:${app.address().port}`,
			requirements: {
				reach: provider.reach,
				transport: provider.transport === "http" ? "any" : provider.transport,
				payloadAccess: "allow-provider",
				address: "any",
				setup: "allow",
				protocols: [],
			},
		}),
		{ mode: 0o600 },
	);
	return {
		root,
		data,
		home,
		owner,
		registry,
		library,
		app,
		descriptorPath,
		providerId: provider.providerId,
		password: randomBytes(24).toString("hex"),
		encryptionKey: randomBytes(32).toString("base64"),
		canary: randomBytes(32).toString("hex"),
		events: join(registry.root, "providers", provider.providerId, "events.jsonl"),
		journal: new ReachabilityOperations(join(data, "reachability-operations"), true),
		children: new Set(),
		pids: new Set(),
	};
}

// A failed run must not leave a server, a controller or a route behind.
async function cleanUp(world) {
	for (const child of world.children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	let clean = true;
	try {
		for (const route of (await world.library.listRoutes({ home: world.home, owner: world.owner })).routes) {
			let closed = await world.library.closeRoute({ home: world.home, handle: route.handle, mode: "remove" });
			if (closed.cleanup.state !== "confirmed") closed = await world.library.closeRoute({ home: world.home, handle: route.handle, mode: "remove" });
			clean &&= closed.cleanup.state === "confirmed";
		}
	} catch {
		clean = false;
	}
	for (const pid of world.pids) {
		await until(`controller ${pid} exits`, 30_000, async () => (alive(pid) ? undefined : true)).catch(() => {
			clean = false;
		});
	}
	world.app.closeAllConnections();
	world.app.close();
	if (!clean) throw new Error(`Cleanup is unconfirmed; retained evidence at ${world.root}`);
	await world.registry.cleanup();
	await rm(world.root, { recursive: true, force: true });
}

test("a killed server's route is closed by its exact handle on restart, never adopted", { timeout: 120_000 }, async () => {
	const world = await createWorld();
	let failure;
	try {
		// 1-2. First server: Turn on through the owner API until the route is On.
		const first = await bootServer(world);
		const started = await turnOn(world, first.api);
		assert.equal((await settled(first.api, started.operationId)).stage, "settled");
		const oldRoute = await currentRoute(first.api);
		const oldHandle = oldRoute.handle;
		assert.equal(oldHandle.kind, "attached");
		const oldDir = join(world.home, "attached", oldHandle.id);
		const control = JSON.parse(await readFile(join(oldDir, "control.json"), "utf8"));
		const controllerPid = control.pid;
		world.pids.add(controllerPid);
		assert.ok(alive(controllerPid), "The detached controller runs while the server is up");
		assert.equal((await readLines(world.events)).filter((event) => event.event === "start").length, 1);

		// 3. SIGKILL the server. The controller is a separate process and outlives it.
		first.child.kill("SIGKILL");
		const [, signal] = await first.exited;
		assert.equal(signal, "SIGKILL");
		const killedAt = Date.now();
		assert.ok(alive(controllerPid), "The controller outlives its killed owner");
		const record = await world.journal.read(started.operationId);
		assert.equal(record.stage, "settled");
		assert.equal(record.stopTombstone, false, "Nothing confirmed a close before the kill");
		assert.equal(record.recovery, null);

		// 4. Second server on the same state directory. Its boot pass is held at the
		// library's close call, so a Turn on can be tried while the pass is running.
		const firstCalls = new Set((await readdir(world.root)).filter((file) => file.startsWith("calls-")));
		const second = await bootServer(world, { hold: true });
		const callsFile = await until("the boot pass reaches the library", 20_000, async () => {
			const [name] = (await readdir(world.root)).filter((file) => file.startsWith("calls-") && !firstCalls.has(file));
			return name ? join(world.root, name) : undefined;
		});
		await until("the boot pass asks to close the old route", 20_000, async () => ((await readLines(callsFile)).length ? true : undefined));
		const [asked] = await readLines(callsFile);
		assert.deepEqual([asked.call, asked.phase, asked.handle, asked.mode], ["closeRoute", "begin", oldHandle, "remove"], "The first thing the new process asks the library is to close the old handle");

		// 6. While the pass runs, a Turn on is refused at the start fence.
		const catalog = await second.api.call("/catalog");
		const provider = catalog.providers.find((item) => item.providerId === world.providerId);
		const draft = await prepareDraft(second.api, provider, world.canary, [], { trace: [] });
		// The configuration is already committed; commit itself is refused while a route is owed a close.
		const review = await second.api.call(`/drafts/${draft.draftId}/review`, { usage: "attached" });
		await assert.rejects(approve(second.api, review), { code: "operation_in_progress" });
		assert.equal((await readLines(world.events)).filter((event) => event.event === "start").length, 1, "A refused Turn on starts nothing");
		await rm(second.holdFile);

		// The fence lifts when the pass settles. Until then every Turn on is refused, and
		// the old handle is never shown as the current route.
		const opened = await until("the start fence lifts", 45_000, async () => {
			const view = await second.api.call("/state");
			assert.ok(!view.routes.some((route) => route.handle.id === oldHandle.id && route.published), "The old handle is never shown as published");
			assert.notEqual(view.lifecycle.handle?.id === oldHandle.id && view.lifecycle.phase, "verified", "The old handle is never the current verified route");
			try {
				return await approve(second.api, review);
			} catch (error) {
				if (error.code === "operation_in_progress") return undefined;
				if (!["review_not_found", "consent_expired"].includes(error.code)) throw error;
				return turnOn(world, second.api);
			}
		});

		// 5a. The old route is settled in the journal ...
		const journaled = await world.journal.read(started.operationId);
		assert.equal(journaled.stage, "settled");
		assert.equal(journaled.stopTombstone, true, "The boot pass recorded the Stop tombstone");
		assert.equal(journaled.recovery, null);
		assert.equal(journaled.failureCode, null);
		assert.deepEqual(journaled.handle, oldHandle);
		//     ... the library closed it by that handle: its own record and the provider's effect log.
		const state = JSON.parse(await readFile(join(oldDir, "state.json"), "utf8"));
		assert.equal(state.phase, "released");
		assert.deepEqual(state.handle, oldHandle);
		assert.equal(state.lastView.cleanup.state, "confirmed");
		assert.deepEqual(state.resourceRemoval.handle, oldHandle, "The library's removal record names the exact old handle");
		const lifecycleEvents = (await readLines(world.events)).map((event) => event.event).filter((event) => ["start", "stop", "cleanup"].includes(event));
		assert.deepEqual(lifecycleEvents.slice(0, 3), ["start", "stop", "cleanup"], "The provider saw the old route removed before any new start");
		const calls = await readLines(callsFile);
		const closes = calls.filter((call) => call.call === "closeRoute" && call.phase === "end");
		assert.deepEqual(closes.map((call) => [call.handle, call.mode, call.cleanup]), [[oldHandle, "remove", "confirmed"]], "The new process closed exactly the old handle, once, and it confirmed");

		// 5d. The old controller is gone.
		await until("the old controller exits", 30_000, async () => (alive(controllerPid) ? undefined : true));
		const exitedAfterMs = Date.now() - killedAt;
		world.pids.delete(controllerPid);

		// 5b. Not adopted: the only expose in the new process is the Turn on, with its own operation.
		const exposes = calls.filter((call) => call.call === "expose" && call.phase === "begin");
		assert.equal(exposes.length, 1, "Exactly one expose ran in the new process: the Turn on");
		assert.equal(exposes[0].operationId, opened.operationId);
		assert.notEqual(exposes[0].operationId, started.operationId);

		// 5c. The Turn on reaches On with a new handle.
		assert.equal((await settled(second.api, opened.operationId)).stage, "settled");
		const newRoute = await currentRoute(second.api);
		assert.notEqual(newRoute.handle.id, oldHandle.id);
		const finalEvents = (await readLines(world.events)).map((event) => event.event).filter((event) => ["start", "stop", "cleanup"].includes(event));
		assert.deepEqual(finalEvents, ["start", "stop", "cleanup", "start"]);

		// Leave nothing behind: stop the new route as the owner would, then end the server.
		const newPid = JSON.parse(await readFile(join(world.home, "attached", newRoute.handle.id, "control.json"), "utf8")).pid;
		world.pids.add(newPid);
		await second.api.call(`/routes/${encodeURIComponent(newRoute.handle.id)}/stop`, { generation: newRoute.handle.generation, acknowledgeDisconnect: true });
		await until("the new controller exits after Stop", 30_000, async () => (alive(newPid) ? undefined : true));
		world.pids.delete(newPid);
		second.child.kill("SIGKILL");
		await second.exited;
		console.log(`old controller exited ${exitedAfterMs} ms after the kill`);
	} catch (error) {
		failure = error;
	} finally {
		try {
			await cleanUp(world);
		} catch (error) {
			failure = failure ? new AggregateError([failure, error], "Assertions and cleanup both failed") : error;
		}
		if (failure) throw failure;
	}
});
