// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fakeRegistry } from "@tnunamak/gozar/testing";

const unknownSpecification = JSON.parse(
	await readFile(
		new URL(
			"../../reference-implementation/test/fixtures/reachability/unknown-provider.json",
			import.meta.url,
		),
		"utf8",
	),
);
export async function createUnknownRegistry(
	dir,
	{ runtimeObservations = false, fixture = "unknown", kinds, addedFacts = [] } = {},
) {
	const specification =
		fixture === "non-http"
			? JSON.parse(
					await readFile(
						new URL(
							"../../reference-implementation/test/fixtures/reachability/non-http-provider.json",
							import.meta.url,
						),
						"utf8",
					),
				)
			: unknownSpecification;
	const { addedFact, ...options } = specification;
	const registry = await fakeRegistry({
		...options,
		facts: [...(options.facts ?? []), ...addedFacts],
		...(kinds ? { kinds } : {}),
		dir,
	});
	const observationFile = resolve(
		registry.root,
		"..",
		"runtime-observations.json",
	);
	if (runtimeObservations) {
		const module = await readFile(
			new URL(
				"../../reference-implementation/test/fixtures/reachability/runtime-provider.mjs",
				import.meta.url,
			),
			"utf8",
		);
		const runtimePath = join(registry.root, "providers", specification.id, "runtime.mjs");
		await writeFile(runtimePath, module);
		await writeFile(
			join(registry.root, "providers", specification.id, "runtime-cost.mjs"),
			await readFile(
				new URL(
					"../../reference-implementation/test/fixtures/reachability/runtime-cost.mjs",
					import.meta.url,
				),
				"utf8",
			),
		);
		registry.manifest.providers[0].module = `providers/${specification.id}/runtime.mjs`;
		await writeFile(observationFile, JSON.stringify({ costKind: "free" }));
		// The route's creation-time recheck reads the static definition before
		// runtime facts exist, so the definition must state the same initial
		// cost that properties() reports for the observation.
		const { cost } = await import(
			"../../reference-implementation/test/fixtures/reachability/runtime-cost.mjs"
		);
		const definitionPath = join(registry.root, registry.manifest.providers[0].definition);
		const definition = JSON.parse(await readFile(definitionPath, "utf8"));
		definition.adapter.capabilities.cost = cost("free");
		await writeFile(definitionPath, JSON.stringify(definition));
	}
	return {
		...registry,
		specification,
		addedFact,
		setRuntimeCost: async (costKind) =>
			writeFile(observationFile, JSON.stringify({ costKind })),
	};
}
