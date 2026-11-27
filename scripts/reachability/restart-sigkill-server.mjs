// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
// Child entrypoint for restart-sigkill.test.mjs. It runs the real reference server
// (startServer) with the real reachability service, the real sealed secret backend and
// the real Gozar library over a fake registry. Never imported by the production server.
import { appendFileSync, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createGozar } from "@tnunamak/gozar";
import { startServer } from "../../reference-implementation/server/index.ts";
import { createHostSecretBackend, createSealedSecretBackend } from "../../reference-implementation/server/reachability/secret-backend.ts";
import { ReachabilityService } from "../../reference-implementation/server/reachability/service.ts";

const descriptor = JSON.parse(await readFile(process.argv[2], "utf8"));
const hostCapabilities = Object.fromEntries(
	[
		"installer.execute",
		"privilege.elevate",
		"secrets.backend",
		"runtime.attached",
		"runtime.durable",
	].map((id) => [id, { known: true, value: id !== "privilege.elevate" }]),
);
// A restarted process has the same installation and a new boot.
const identity = { instanceId: descriptor.instanceId, bootId: randomUUID() };
const gozar = createGozar({
	manifest: descriptor.manifest,
	root: descriptor.registryRoot,
	secretBackend: createHostSecretBackend(createSealedSecretBackend(join(descriptor.home, "custody"))),
	identity,
	hostCapabilities,
});
// The only seam: while the hold file exists, a close waits. It lets the test observe the
// start fence while the boot pass is running. Every close still reaches the real library.
const holdFile = process.env.RESTART_HOLD_FILE;
// It also appends each close and expose call to a per-boot file, so the test can read what
// this process asked the library to do without trusting the service's memory.
const callLog = join(descriptor.root, `calls-${identity.bootId}.jsonl`);
const held = new Proxy(gozar, {
	get(target, property) {
		const value = target[property];
		if (!["closeRoute", "expose"].includes(property)) return value;
		return async (...args) => {
			const [input] = args;
			const note = (phase, extra = {}) =>
				appendFileSync(callLog, `${JSON.stringify({ at: Date.now(), call: property, phase, handle: input.handle ?? null, mode: input.mode ?? null, operationId: input.operationId ?? null, ...extra })}\n`);
			note("begin");
			if (property === "closeRoute" && holdFile) {
				const deadline = Date.now() + 60_000;
				while (existsSync(holdFile) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
			}
			const result = await value.apply(target, args);
			note("end", { handle: result.handle ?? null, cleanup: result.cleanup?.state ?? null });
			return result;
		};
	},
});
const service = new ReachabilityService(held, {
	query: {
		schemaVersion: 1,
		home: descriptor.home,
		owner: descriptor.owner,
		providerId: descriptor.providerId,
		target: descriptor.target,
		usage: { kind: "attached" },
		requirements: descriptor.requirements,
	},
	identity,
	hostCapabilities,
	prepare: async () => {},
	acknowledgeDisconnect: async () => {},
});
const servers = await startServer({
	reachability: { service, usage: () => ({ kind: "attached" }) },
	quiet: true,
});
process.send?.({ ready: true });
process.on("SIGTERM", () => {
	service.closeObservers();
	servers.asServer.closeAllConnections();
	servers.rsServer.closeAllConnections();
	servers.asServer.close();
	servers.rsServer.close();
	process.exit(0);
});
await new Promise(() => {});
