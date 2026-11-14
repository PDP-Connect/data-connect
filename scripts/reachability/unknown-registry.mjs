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
		await writeFile(
			join(registry.root, "providers", specification.id, "runtime.mjs"),
			module,
		);
		registry.manifest.providers[0].module = `providers/${specification.id}/runtime.mjs`;
		await writeFile(observationFile, JSON.stringify({ costKind: "free" }));
	}
	return {
		...registry,
		specification,
		addedFact,
		setRuntimeCost: async (costKind) =>
			writeFile(observationFile, JSON.stringify({ costKind })),
	};
}
