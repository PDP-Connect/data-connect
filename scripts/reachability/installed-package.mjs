// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, rename, rm, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";

// Map of relative path -> "file:<sha256>" or "link:<target>" for every entry
// under `root`, plus "dir" for each directory. Sorted so the first
// difference between two trees is deterministic.
async function digestTree(root) {
	const entries = new Map();
	async function walk(relative) {
		const names = await readdir(join(root, relative));
		for (const name of names.sort()) {
			const child = relative ? `${relative}/${name}` : name;
			const stat = await lstat(join(root, child));
			if (stat.isDirectory()) {
				// Record the directory itself so an extra or missing empty folder differs.
				entries.set(child, "dir");
				await walk(child);
			}
			else if (stat.isSymbolicLink())
				entries.set(child, `link:${await readlink(join(root, child))}`);
			else if (stat.isFile())
				entries.set(
					child,
					`file:${createHash("sha256")
						.update(await readFile(join(root, child)))
						.digest("hex")}`,
				);
			else throw new Error(`Unsupported file kind in package tree: ${join(root, child)}`);
		}
	}
	await walk("");
	return entries;
}

/** First path whose bytes differ between two trees, or null when identical. */
export async function firstTreeDifference(expectedRoot, actualRoot) {
	const [expected, actual] = await Promise.all([
		digestTree(expectedRoot),
		digestTree(actualRoot),
	]);
	const paths = [...new Set([...expected.keys(), ...actual.keys()])].sort();
	for (const path of paths) {
		if (expected.get(path) !== actual.get(path)) {
			const kind = !actual.has(path)
				? "missing"
				: !expected.has(path)
					? "extra"
					: "changed";
			return { path, kind };
		}
	}
	return null;
}

/**
 * Make `target` resolve to the package at `source`. A symlink is created when
 * nothing is there. An existing entry (for example a real directory left by
 * `npm ci`) is accepted only when its file tree has the same relative paths and
 * SHA-256 digests as `source`. Returns how the package is installed.
 */
export async function linkInstalledPackage(source, target) {
	await mkdir(dirname(target), { recursive: true });
	try {
		await symlink(source, target, "dir");
		return { mode: "linked", target };
	} catch (error) {
		if (error.code !== "EEXIST") throw error;
	}
	if ((await lstat(target)).isSymbolicLink()) {
		const staging = await mkdtemp(join(dirname(target), ".gozar-link-"));
		const replacement = join(staging, "link");
		try {
			await symlink(source, replacement, "dir");
			await rename(replacement, target);
			return { mode: "linked", target };
		} finally {
			await rm(staging, { recursive: true, force: true });
		}
	}
	if (!(await lstat(target)).isDirectory())
		throw new Error(`Existing package is not a directory or link: ${target}`);
	const difference = await firstTreeDifference(source, target);
	if (difference)
		throw new Error(
			`Existing package differs from the selected tarball prefix: ${difference.kind} ${difference.path}`,
		);
	return { mode: "identical-directory", target };
}
