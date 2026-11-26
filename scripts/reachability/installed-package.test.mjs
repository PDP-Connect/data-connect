// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { cp, lstat, mkdir, mkdtemp, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linkInstalledPackage } from "./installed-package.mjs";

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "installed-package-"));
	const source = join(root, "prefix", "gozar");
	await mkdir(join(source, "dist"), { recursive: true });
	await writeFile(join(source, "package.json"), '{"name":"gozar","version":"1.0.0"}');
	await writeFile(join(source, "dist", "index.js"), "export const a = 1;\n");
	const target = join(root, "node_modules", "@scope", "gozar");
	await mkdir(join(root, "node_modules", "@scope"), { recursive: true });
	return { root, source, target };
}

test("absent target becomes a link to the prefix", async () => {
	const { root, source, target } = await fixture();
	try {
		assert.equal((await linkInstalledPackage(source, target)).mode, "linked");
		assert.equal(await readlink(target), source);
	} finally {
		await rm(root, { recursive: true });
	}
});

test("a real directory with identical bytes is accepted and left alone", async () => {
	const { root, source, target } = await fixture();
	try {
		await cp(source, target, { recursive: true });
		assert.equal(
			(await linkInstalledPackage(source, target)).mode,
			"identical-directory",
		);
		assert.ok((await lstat(target)).isDirectory());
	} finally {
		await rm(root, { recursive: true });
	}
});

for (const [name, mutate, expected] of [
	["one changed byte", (t) => writeFile(join(t, "dist", "index.js"), "export const a = 2;\n"), "changed dist/index.js"],
	["an extra file", (t) => writeFile(join(t, "extra.js"), ""), "extra extra.js"],
	["a missing file", (t) => rm(join(t, "dist", "index.js")), "missing dist/index.js"],
]) {
	test(`a real directory with ${name} is refused and names the path`, async () => {
		const { root, source, target } = await fixture();
		try {
			await cp(source, target, { recursive: true });
			await mutate(target);
			await assert.rejects(
				linkInstalledPackage(source, target),
				(error) =>
					error.message.startsWith("Existing package differs") &&
					error.message.endsWith(expected),
			);
		} finally {
			await rm(root, { recursive: true });
		}
	});
}

test("a real directory with an extra empty folder is refused and names the path", async () => {
	const { root, source, target } = await fixture();
	try {
		await cp(source, target, { recursive: true });
		await mkdir(join(target, "empty"));
		await assert.rejects(linkInstalledPackage(source, target), /extra empty/);
	} finally {
		await rm(root, { recursive: true });
	}
});

test("an existing file in place of the package is refused", async () => {
	const { root, source, target } = await fixture();
	try {
		await writeFile(target, "not a package");
		await assert.rejects(linkInstalledPackage(source, target), /not a directory or link/);
	} finally {
		await rm(root, { recursive: true });
	}
});
