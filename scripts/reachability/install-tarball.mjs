// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import { firstTreeDifference, linkInstalledPackage } from "./installed-package.mjs";
import { RELEASE_DISK_FLOOR_BYTES, requireDiskFloor } from "./disk-floor.mjs";

export async function installTarball({ env = process.env, cwd = process.cwd(), run = spawnSync, diskFloor = requireDiskFloor } = {}) {
	const path = env.GOZAR_TARBALL;
	const expected = env.GOZAR_TARBALL_SHA256;
	const sourceSha = env.GOZAR_SOURCE_SHA;
	if (!/^[a-f0-9]{40}$/.test(sourceSha ?? ""))
		throw new Error("Set GOZAR_SOURCE_SHA to the full source revision from the artifact receipt");
	if (!path || !/^[a-f0-9]{64}$/.test(expected ?? ""))
		throw new Error("Set GOZAR_TARBALL and GOZAR_TARBALL_SHA256; registry installation is not supported by this gate");

	const bytes = await readFile(resolve(cwd, path));
	const actual = createHash("sha256").update(bytes).digest("hex");
	if (actual !== expected)
		throw new Error("Tarball checksum mismatch; nothing installed");
	// Count the checked archive's expanded bytes without retaining the expanded tar in memory.
	const expanded = Readable.from([bytes]).pipe(createGunzip());
	let expandedBytes = 0;
	for await (const chunk of expanded) expandedBytes += chunk.byteLength;
	// The staged archive, npm install, and verification extraction coexist.
	const reserve = 100_000_000 + bytes.byteLength + 2 * expandedBytes;
	await diskFloor(env, cwd, RELEASE_DISK_FLOOR_BYTES, { reserveBytes: reserve });
	const modules = resolve(cwd, "node_modules");
	await mkdir(modules, { recursive: true });
	const prefix = await mkdtemp(resolve(modules, ".reachability-artifact-"));
	let published = false;
	try {
		const artifact = resolve(prefix, "artifact.tgz");
		await writeFile(artifact, bytes, { flag: "wx", mode: 0o600 });
		const result = run("npm", [
			"--prefix", prefix, "--workspaces=false", "install",
			"--allow-git=root", "--no-save", "--package-lock=false",
			"--ignore-scripts", "--omit=optional", artifact,
		], { cwd, env, stdio: "inherit" });
		if (result.error) throw result.error;
		if (result.status !== 0) return { status: result.status ?? 1 };

		const extraction = resolve(prefix, "verification");
		await mkdir(extraction, { mode: 0o700 });
		const unpack = run("tar", ["-xzf", artifact, "-C", extraction], { cwd, env, stdio: "inherit" });
		if (unpack.error) throw unpack.error;
		if (unpack.status !== 0) throw new Error("Could not extract the staged tarball for verification");
		const source = resolve(prefix, "node_modules/@tnunamak/gozar");
		const difference = await firstTreeDifference(resolve(extraction, "package"), source);
		if (difference)
			throw new Error(`Installed package differs from the staged tarball: ${difference.kind} ${difference.path}`);
		await rm(extraction, { recursive: true });
		// The receipt is written before the package is linked, so a published package always has one.
		await writeFile(resolve(prefix, "receipt.json"), JSON.stringify({ sourceSha, sha256: actual, artifact }, null, 2), { flag: "wx" });
		const installed = await linkInstalledPackage(source, resolve(modules, "@tnunamak/gozar"));
		published = true;
		return { status: 0, prefix, installed };
	} finally {
		if (!published) await rm(prefix, { recursive: true, force: true });
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	const { status, installed } = await installTarball();
	if (status !== 0) process.exitCode = status;
	else console.log(
		installed.mode === "linked"
			? `Gozar installed as a link to the checked tarball prefix`
			: `Gozar already installed as a directory with the same file tree (relative paths and SHA-256) as the checked tarball`,
	);
}
