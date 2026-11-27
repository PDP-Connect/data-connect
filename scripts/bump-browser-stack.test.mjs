// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { bumpManifestText, MANIFESTS } from "./bump-browser-stack.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

describe("bumpManifestText", () => {
	it("rewrites an exact pin and keeps the rest of the text", () => {
		const text =
			'{\n  "dependencies": {\n    "patchright": "1.63.0",\n    "react": "^19.0.0"\n  }\n}\n';
		expect(bumpManifestText(text, "patchright", "1.65.0")).toBe(
			'{\n  "dependencies": {\n    "patchright": "1.65.0",\n    "react": "^19.0.0"\n  }\n}\n',
		);
	});

	it("keeps a caret range", () => {
		expect(
			bumpManifestText('{"playwright": "^1.63.0"}', "playwright", "1.65.0"),
		).toBe('{"playwright": "^1.65.0"}');
	});

	it("does not touch a dependency whose name only starts the same", () => {
		expect(() =>
			bumpManifestText('{"patchright-core": "1.63.0"}', "patchright", "1.65.0"),
		).toThrow(/found 0/);
	});

	it("refuses a manifest that declares the dependency twice", () => {
		expect(() =>
			bumpManifestText(
				'{"patchright": "1.63.0", "x": {"patchright": "1.63.0"}}',
				"patchright",
				"1.65.0",
			),
		).toThrow(/found 2/);
	});

	it("matches each manifest the repository really has, exactly once", () => {
		for (const { path, name } of MANIFESTS) {
			expect(() =>
				bumpManifestText(readFileSync(join(root, path), "utf8"), name, "9.9.9"),
			).not.toThrow();
		}
	});
});
