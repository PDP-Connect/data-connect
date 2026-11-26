#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Move the browser stack to one version in every manifest that declares it, so
// one pull request carries all three folders. Dependabot cannot do this: its
// only cross-directory grouping is `group-by: dependency-name`, which opens one
// pull request per package name, and patchright and playwright are different
// names. The weekly workflow .github/workflows/browser-stack-bump.yml runs this
// script, regenerates the three lock files, and runs
// scripts/check-patchright-version.mjs before it opens the pull request.
//
// Usage: node scripts/bump-browser-stack.mjs <version>

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./is-main-module.js";

/** Manifests to rewrite: the dependency name and whether its range keeps a caret. */
export const MANIFESTS = [
	{ path: "package.json", name: "patchright" },
	{ path: "reference-implementation/package.json", name: "patchright" },
	{ path: "pdpp-runtime/package.json", name: "patchright" },
	{ path: "playwright-runner/package.json", name: "playwright" },
];

/** Folders whose lock file `npm install --package-lock-only` must regenerate. */
export const LOCK_FOLDERS = [".", "pdpp-runtime", "playwright-runner"];

/** Rewrites one dependency's version in manifest text, keeping a leading `^` or `~`. */
export function bumpManifestText(text, name, version) {
	const pattern = new RegExp(`("${name}"\\s*:\\s*")([\\^~]?)[^"]+(")`, "g");
	let count = 0;
	const next = text.replace(pattern, (_match, open, prefix, close) => {
		count += 1;
		return `${open}${prefix}${version}${close}`;
	});
	if (count !== 1) {
		throw new Error(
			`expected exactly one "${name}" dependency, found ${count}`,
		);
	}
	return next;
}

if (isMainModule(import.meta.url, process.argv[1])) {
	const version = process.argv[2];
	if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
		console.error(
			"usage: node scripts/bump-browser-stack.mjs <major.minor.patch>",
		);
		process.exit(2);
	}
	const root = dirname(dirname(fileURLToPath(import.meta.url)));
	for (const { path, name } of MANIFESTS) {
		const file = join(root, path);
		writeFileSync(
			file,
			bumpManifestText(readFileSync(file, "utf8"), name, version),
		);
		console.log(`${path}: ${name} -> ${version}`);
	}
}
