// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	statfs,
} from "node:fs/promises";
import http from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { createGozar } from "@tnunamak/gozar";
import { FixtureSecretBackend } from "../../reference-implementation/test/fixtures/reachability/secret-backend.ts";
import { prepareDraft } from "./journey-support.mjs";
import { createOwnerHttpFixture } from "./owner-http-fixture.mjs";
import { createUnknownRegistry } from "./unknown-registry.mjs";

export async function createPreparedFixture(root, options = {}) {
	const disk = await statfs(process.cwd());
	if (disk.bavail * disk.bsize < 105_000_000_000)
		throw new Error("NOT RUN (disk): need 105 GB free");
	if (!root) {
		const parent = join(homedir(), ".tmp", "ra");
		await mkdir(parent, { recursive: true, mode: 0o700 });
		root = await mkdtemp(join(parent, "recovery-"));
	}
	const usageKind = options.usage ?? "attached";
	const registry = await createUnknownRegistry(join(root, "registry"), {
		fixture: "non-http",
		...options,
		...(usageKind === "attached" ? {} : { kinds: ["attached", usageKind] }),
	});
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
	const factoryOptions = {
		manifest: registry.manifest,
		root: registry.root,
		secretBackend: backend,
		hostCapabilities,
		identity,
	};
	const gozar = createGozar(factoryOptions);
	const app = http.createServer((_request, response) =>
		response.end("fixture application"),
	);
	app.listen(0, "127.0.0.1");
	await once(app, "listening");
	const home = join(root, "gozar"),
		owner = "fixture-owner",
		canary = randomBytes(32).toString("hex");
	const initial = await gozar.listProviders({ home, owner });
	assert.equal(initial.providers.length, 1);
	const provider = initial.providers[0];
	const query = {
		schemaVersion: 1,
		home,
		owner,
		providerId: provider.providerId,
		target: `127.0.0.1:${app.address().port}`,
		usage:
			usageKind === "attached"
				? { kind: usageKind }
				: usageKind === "session"
					? { kind: usageKind, lifetimeMs: 60000 }
					: { kind: usageKind, routeId: "fixture-route" },
		requirements: {
			reach: provider.reach,
			transport: provider.transport === "http" ? "any" : provider.transport,
			payloadAccess: "allow-provider",
			address: "any",
			setup: "allow",
			protocols: [],
		},
	};
	const api = await createOwnerHttpFixture(
		gozar,
		query,
		root,
		canary,
		identity,
		hostCapabilities,
	);
	const draft = await prepareDraft(api, provider, canary, [], backend);
	await api.call(`/drafts/${draft.draftId}/commit`, {
		expectedRevision: draft.configuration.revision,
	});
	const catalog = await gozar.catalogRoutes(query),
		candidate = catalog.candidates[0];
	assert.ok(candidate?.candidateToken);
	const request = {
		...query,
		intent: "create",
		operationId: randomUUID(),
		wait: "verified",
		approval: {
			kind: "route",
			candidateToken: candidate.candidateToken,
			disclosureRevision: candidate.disclosure.revision,
			consentFactsDigest: candidate.consentFactsDigest,
		},
	};
	async function startCount() {
		if (usageKind === "durable") {
			const store = JSON.parse(
				await readFile(
					join(registry.root, "providers", provider.providerId, "store.json"),
					"utf8",
				),
			);
			return Object.keys(store.entries).length;
		}
		const path = join(
			registry.root,
			"providers",
			provider.providerId,
			"events.jsonl",
		);
		let content = "";
		try {
			content = await readFile(path, "utf8");
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
		return content
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line))
			.filter((event) => event.event === "start").length;
	}
	return {
		start: (input) =>
			usageKind === "durable"
				? gozar.ensureRoute(input ?? request)
				: gozar.expose(input ?? request),
		draftId: draft.draftId,
		root,
		registry,
		backend,
		factoryOptions,
		gozar,
		home,
		owner,
		api,
		request,
		canary,
		startCount,
		close: async () => {
			let clean = true;
			try {
				for (const route of (await gozar.listRoutes({ home, owner })).routes) {
					let closed = await gozar.closeRoute({
						home,
						handle: route.handle,
						mode: "remove",
					});
					if (closed.cleanup.state !== "confirmed")
						closed = await gozar.closeRoute({
							home,
							handle: route.handle,
							mode: "remove",
						});
					if (closed.cleanup.state !== "confirmed") clean = false;
				}
			} catch {
				clean = false;
			}
			await api.close();
			app.closeAllConnections();
			app.close();
			await once(app, "close");
			if (clean) {
				await registry.cleanup();
				await rm(root, { recursive: true, force: true });
			} else
				throw new Error(
					`Fixture cleanup is unconfirmed; retained evidence at ${root}`,
				);
		},
	};
}
