// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	mkdir,
	readFile,
	realpath,
	statfs,
	symlink,
	writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";

const path = process.env.GOZAR_TARBALL;
const expected = process.env.GOZAR_TARBALL_SHA256;
const sourceSha = process.env.GOZAR_SOURCE_SHA;
if (!/^[a-f0-9]{40}$/.test(sourceSha ?? ""))
	throw new Error(
		"Set GOZAR_SOURCE_SHA to the full source revision from the artifact receipt",
	);
if (!path || !/^[a-f0-9]{64}$/.test(expected ?? "")) {
	throw new Error(
		"Set GOZAR_TARBALL and GOZAR_TARBALL_SHA256; registry installation is not supported by this gate",
	);
}
const absolute = resolve(path);
const actual = createHash("sha256")
	.update(await readFile(absolute))
	.digest("hex");
if (actual !== expected)
	throw new Error("Tarball checksum mismatch; nothing installed");
const disk = await statfs(process.cwd());
// This isolated package install has no dependency lifecycle builds. Reserve
// space for package expansion and metadata above the mandatory disk floor.
const reserve = 100_000_000 + (await readFile(absolute)).byteLength * 20;
if (disk.bavail * disk.bsize < 100_000_000_000 + reserve)
	throw new Error("Insufficient disk space above the 100 GB floor");
const prefix = resolve("node_modules/.reachability-artifact");
await mkdir(prefix, { recursive: true });
const result = spawnSync(
	"npm",
	[
		"--prefix",
		prefix,
		"--workspaces=false",
		"install",
		"--allow-git=root",
		"--no-save",
		"--package-lock=false",
		"--ignore-scripts",
		"--omit=optional",
		absolute,
	],
	{ stdio: "inherit" },
);
if (result.error) throw result.error;
if (result.status !== 0) process.exitCode = result.status ?? 1;
else {
	await mkdir("node_modules/@tnunamak", { recursive: true });
	try {
		await symlink(
			resolve(prefix, "node_modules/@tnunamak/gozar"),
			"node_modules/@tnunamak/gozar",
			"dir",
		);
	} catch (error) {
		if (error.code !== "EEXIST") throw error;
		if (
			(await realpath("node_modules/@tnunamak/gozar")) !==
			(await realpath(resolve(prefix, "node_modules/@tnunamak/gozar")))
		)
			throw new Error(
				"Existing package differs from the selected tarball prefix",
			);
	}
	await writeFile(
		resolve(prefix, "receipt.json"),
		JSON.stringify({ sourceSha, sha256: actual, artifact: absolute }, null, 2),
	);
}
