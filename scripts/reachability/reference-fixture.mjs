// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
// Explicit e2e entrypoint. Never imported by the production server.
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, statfs, writeFile, readFile } from "node:fs/promises";
import http from "node:http";
import { join } from "node:path";
import { createGozar } from "@tnunamak/gozar";
import { startServer } from "../../reference-implementation/server/index.ts";
import { projectRoute } from "../../reference-implementation/server/reachability/projection.ts";
import { ReachabilityService } from "../../reference-implementation/server/reachability/service.ts";
import { FixtureSecretBackend } from "../../reference-implementation/test/fixtures/reachability/secret-backend.ts";
import { createEffectFixtures } from "./effect-fixtures.ts";
import { createEffectFixtureHost } from "./testing-effects.mjs";
import { createSetupRegistry } from "./setup-registry.mjs";
import { createUnknownRegistry } from "./unknown-registry.mjs";

const disk = await statfs(process.cwd());
if (disk.bavail * disk.bsize < 110_000_000_000)
	throw new Error("NOT RUN (disk): browser stack needs 110 GB free");
const data = process.env.PDPP_DATA_DIR;
if (!data || !process.env.PDPP_OWNER_PASSWORD)
	throw new Error("Use the owned e2e harness");
const target = new URL(process.env.PDPP_REFERENCE_ORIGIN);
if (target.hostname !== "127.0.0.1")
	throw new Error("Fixture target must be the owned loopback console");
const mode = process.argv[2] ?? "unknown";
if (!["unknown", "stream", "setup"].includes(mode))
	throw new Error("Unknown fixture mode");
let home = join(data, "reachability-home");
await mkdir(home, { recursive: true, mode: 0o700 });
const backend = new FixtureSecretBackend(),
	identity = { instanceId: randomUUID(), bootId: randomUUID() };
const hostCapabilities = Object.fromEntries(
	[
		"installer.execute",
		"privilege.elevate",
		"secrets.backend",
		"runtime.attached",
		"runtime.durable",
	].map((id) => [id, { known: true, value: id !== "privilege.elevate" }]),
);
let registry =
	mode === "unknown"
		? await createUnknownRegistry(join(data, "reachability-registry"))
		: mode === "setup" ? await createSetupRegistry(join(data, "reachability-registry")) : null;
const effects =
	mode === "stream"
		? createEffectFixtures({ streamDelayMs: 2500, failInitialStream: true })
		: null;
const harness = effects
	? await createEffectFixtureHost(
			{ secretBackend: backend, identity, hostCapabilities },
			effects.effects,
		)
	: null;
let gozar =
	mode === "stream"
		? harness.gozar
		: createGozar({
				manifest: registry.manifest,
				root: registry.root,
				secretBackend: backend,
				identity,
				hostCapabilities,
			});
const inventory = await gozar
	.listProviders({ home, owner: "fixture-owner" })
	.catch((error) => {
		throw new Error(
			`Fixture inventory failed (${error.code}): ${error.message}`,
		);
	});
const provider = registry
	? inventory.providers[0]
	: inventory.providers.find(
			(item) =>
				item.transport === "https" &&
				item.configuration.inputRequirements.some((field) => field.secret) &&
				item.prerequisites.every(
					(item) =>
						item.state !== "missing" ||
						["provide-secret", "provide-value"].includes(item.remedy?.kind),
				),
		);
if (!provider)
	throw new Error(
		"No executable fixture provider matches the declared protocol requirements",
	);
const query = {
	schemaVersion: 1,
	home,
	owner: "fixture-owner",
	target: target.host,
	requirements: {
		reach: provider.reach,
		transport: provider.transport === "http" ? "any" : provider.transport,
		payloadAccess: "allow-provider",
		address: "any",
		setup: "allow",
		protocols: mode === "stream" ? ["sse"] : [],
	},
};
function makeService(currentGozar, currentQuery) {
return new ReachabilityService(currentGozar, {
	evidenceSource: "synthetic",
	query: currentQuery,
	identity,
	hostCapabilities,
	prepare: async () => {
		if (!process.env.PDPP_OWNER_PASSWORD)
			throw Object.assign(new Error("password required"), {
				code: "owner_password_required",
			});
	},
	acknowledgeDisconnect: async () => {},
});
}
let service = makeService(gozar, query);
const ownerService = new Proxy({}, { get(_target, key) {
  const value = service[key];
  return typeof value === "function" ? value.bind(service) : value;
} });
const retired = [];
async function fixtureStarts(currentRegistry) {
  try {
    const content = await readFile(join(currentRegistry.root, "providers", currentRegistry.specification.id, "events.jsonl"), "utf8");
    return content.split("\n").filter(Boolean).map(line => JSON.parse(line)).filter(event => event.event === "start").length;
  } catch (error) { if (error.code === "ENOENT") return 0; throw error; }
}
const controlToken = randomBytes(32).toString("hex");
const controls = http.createServer(async (request, response) => {
	if (request.headers.authorization !== `Bearer ${controlToken}`) {
		response.writeHead(401).end();
		return;
	}
	try {
        if (mode === "setup" && registry) {
            if (request.url === "/reset-setup" && request.method === "POST") {
                const state = await registry.readWorld();
                if (state.owned || (await gozar.listRoutes({ home, owner: query.owner })).routes.length) {
                    response.writeHead(409).end();
                    return;
                }
                service.closeObservers();
                const suffix = randomUUID().slice(0, 8);
                registry = await createSetupRegistry(join(data, `provider-${suffix}`));
                home = join(data, `home-${suffix}`);
                await mkdir(home, { mode: 0o700 });
                gozar = createGozar({ manifest: registry.manifest, root: registry.root, secretBackend: backend, identity, hostCapabilities });
                service = makeService(gozar, { ...query, home });
                response.writeHead(204).end();
                return;
            }
            if (request.url === "/setup-world" && request.method === "GET") {
                response.setHeader("content-type", "application/json");
                response.end(JSON.stringify(await registry.readWorld()));
                return;
            }
            if (request.url === "/setup-permission" && request.method === "POST") {
                const current = await registry.readWorld();
                await registry.updateWorld({ blockedInstructions: !current.blockedInstructions, descriptiveGuidance: true });
                response.writeHead(204).end();
                return;
            }
            if (request.url === "/verify-setup" && request.method === "POST") {
                await registry.updateWorld({ grant: "verified" });
                response.writeHead(204).end();
                return;
            }
        }
        if (mode === "unknown" && request.url === "/fixture-state" && registry) {
            response.setHeader("content-type", "application/json");
            response.end(JSON.stringify({ starts: await fixtureStarts(registry) }));
            return;
        }
        if (mode === "unknown" && request.url === "/reload-registry" && request.method === "POST" && registry) {
            if (await fixtureStarts(registry) !== 0) throw new Error("A fixture with started resources cannot be replaced");
            const next = await createUnknownRegistry(join(data, "reachability-registry-next"), { addedFacts: [registry.addedFact] });
            const moduleAt = current => join(current.root, "providers", current.specification.id, "index.mjs");
            if (await readFile(moduleAt(next), "utf8") !== await readFile(moduleAt(registry), "utf8")) throw new Error("A new fact must not change adapter code");
            service.closeObservers();
            retired.push({ gozar, home });
            registry = next;
            home = join(data, "reachability-home-next");
            await mkdir(home, { recursive: true, mode: 0o700 });
            gozar = createGozar({ manifest: next.manifest, root: next.root, secretBackend: backend, identity, hostCapabilities });
            await gozar.listProviders({ home, owner: "fixture-owner" });
            service = makeService(gozar, { ...query, home });
            response.setHeader("content-type", "application/json");
            response.end(JSON.stringify({ reloaded: true, starts: 0 }));
            return;
        }
		if (request.url !== "/concurrent-observations") {
			response.writeHead(404).end();
			return;
		}
		const deadline = Date.now() + 8000;
		while (effects && !effects.initialStreamSeen) {
			if (Date.now() > deadline)
				throw new Error("Initial stream was never reached");
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		const listed = await gozar.listRoutes({ home, owner: "fixture-owner" });
		const observations = await Promise.all(
			listed.routes.map(async (route) => {
				const abort = new AbortController();
				const iterator = gozar
					.watchRoutes({ home, handle: route.handle, signal: abort.signal })
					[Symbol.asyncIterator]();
				const pending = { pending: true };
				const limit = (promise) =>
					Promise.race([
						promise,
						new Promise((resolve) => setTimeout(() => resolve(pending), 100)),
					]);
				const [status, watch] = await Promise.all([
					limit(
						gozar
							.routeStatus({ home, handle: route.handle })
							.then(projectRoute),
					),
					limit(
						iterator
							.next()
							.then((event) =>
								event.value ? projectRoute(event.value.route) : pending,
							),
					),
				]);
				abort.abort();
				void iterator.return?.();
				return { status, watch };
			}),
		);
		response.setHeader("content-type", "application/json");
		response.end(
			JSON.stringify({
				initialStreamSeen: effects?.initialStreamSeen,
				observations,
			}),
		);
	} catch {
		response
			.writeHead(409)
			.end(JSON.stringify({ error: "fixture-observation-failed" }));
	}
});
controls.listen(0, "localhost");
await once(controls, "listening");
await writeFile(
	join(data, "reachability-browser-plan.json"),
	JSON.stringify({
		mode,
		providerId: provider.providerId,
		label: provider.label,
		inputs: provider.configuration.inputRequirements,
		controlOrigin: `http://localhost:${controls.address().port}`,
		controlToken,
	}),
	{ mode: 0o600 },
);
const servers = await startServer({
	reachability: { service: ownerService, usage: () => ({ kind: "attached" }) },
	quiet: true,
});
let closing = false;
async function close() {
	if (closing) return;
	closing = true;
	service.closeObservers();
	for (const route of (await gozar.listRoutes({ home, owner: "fixture-owner" }))
		.routes)
		await gozar.closeRoute({ home, handle: route.handle, mode: "remove" });
	await harness?.close();
	await effects?.close();
	controls.close();
	servers.asServer.closeAllConnections();
	servers.rsServer.closeAllConnections();
	servers.asServer.close();
	servers.rsServer.close();
	process.exit(0);
}
process.on("SIGTERM", () => {
	void close().catch(() => process.exit(1));
});
process.on("SIGINT", () => {
	void close().catch(() => process.exit(1));
});
