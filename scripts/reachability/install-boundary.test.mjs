// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { createGozar } from "@tnunamak/gozar";
import { fakeRegistry } from "@tnunamak/gozar/testing";
import { setupApproval } from "./journey-support.mjs";
import { FixtureSecretBackend } from "../../reference-implementation/test/fixtures/reachability/secret-backend.ts";
const specification = JSON.parse(
	await readFile(
		new URL(
			"../../reference-implementation/test/fixtures/reachability/install-provider.json",
			import.meta.url,
		),
		"utf8",
	),
);
for (const permitted of [false, true])
	test(
		permitted
			? "artifact hash mismatch executes nothing through the public install boundary"
			: "host refusal of installer.execute executes nothing",
		async () => {
			const parent = join(homedir(), ".tmp", "ra");
			await mkdir(parent, { recursive: true, mode: 0o700 });
			const root = await mkdtemp(join(parent, "install-"));
			const registry = await fakeRegistry({
				...specification,
				dir: join(root, "r"),
			});
			const backend = new FixtureSecretBackend();
			const gozar = createGozar({
				manifest: registry.manifest,
				root: registry.root,
				secretBackend: backend,
				hostCapabilities: {
					"installer.execute": { known: true, value: permitted },
				},
			});
			const home = join(root, "g"),
				owner = "fixture-owner";
			try {
				const provider = (await gozar.listProviders({ home, owner }))
					.providers[0];
				const draft = await gozar.beginConfigurationDraft({
					home,
					owner,
					providerId: provider.providerId,
					expectedConfigurationRevision: provider.configuration.revision,
				});
				const action = draft.configuration.actions.find(
					(action) => action.kind === "install-artifact",
				);
				assert.ok(action);
				await assert.rejects(
					gozar.runSetupAction({
						home,
						owner,
						providerId: provider.providerId,
						draftId: draft.draftId,
						expectedConfigurationRevision: draft.configuration.revision,
						actionId: action.id,
						approval: setupApproval(action),
					}),
					{ code: permitted ? "artifact_integrity_failed" : "unsupported" },
				);
				assert.ok(!backend.trace.includes("put"));
			} finally {
				await registry.cleanup();
				await rm(root, { recursive: true, force: true });
			}
		},
	);
