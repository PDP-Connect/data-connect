// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ReachabilityOperations } from "../../reference-implementation/server/reachability/operations.ts";
import { createPreparedFixture } from "./prepared-fixture.mjs";

async function main() {
	const fixture = await createPreparedFixture(process.argv[2], {
		usage: process.argv[3] ?? "attached",
	});
	// Trusted test descriptor contains no credential or handle. It is not Gozar state.
	await writeFile(
		join(fixture.root, "recovery-descriptor.json"),
		JSON.stringify({
			home: fixture.home,
			owner: fixture.owner,
			manifest: fixture.registry.manifest,
			root: fixture.registry.root,
			identity: fixture.factoryOptions.identity,
			hostCapabilities: fixture.factoryOptions.hostCapabilities,
		}),
		{ mode: 0o600 },
	);
	const operations = new ReachabilityOperations(
		join(fixture.root, "host-operations"),
		true,
	);
	const intent = {
		instanceId: fixture.factoryOptions.identity.instanceId,
		bootId: fixture.factoryOptions.identity.bootId,
		providerId: fixture.request.providerId,
		configurationRevision: (await fixture.gozar.catalogRoutes(fixture.request))
			.candidates[0].configuration.revision,
		target: fixture.request.target,
		usage: fixture.request.usage,
		expectedOrigin: fixture.request.origin ?? null,
		consentFactsDigest: fixture.request.approval.consentFactsDigest,
	};
	const pending = await operations.start(
		"start",
		null,
		async (operationId) => {
			await fixture.start({ ...fixture.request, operationId });
			process.send?.({
				stage: "allocated-before-host-handle-write",
				operationId,
			});
			// Parent SIGKILLs exactly here: no handle is ever returned to the host journal.
			return new Promise(() => {});
		},
		intent,
	);
	const monitor = setInterval(async () => {
		const record = await operations.read(pending.operationId);
		if (record.stage === "unknown-possibly-live") {
			clearInterval(monitor);
			process.send?.({ stage: "start-failed", reason: record.failureCode });
		}
	}, 30);
}
main().catch(() => process.exit(1));
