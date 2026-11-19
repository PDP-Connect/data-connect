// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const runner = fileURLToPath(new URL("./run-release.mjs", import.meta.url));
const waiver = {
	PDPP_LOCAL_DISK_FLOOR_BYTES: "15000000000",
	PDPP_LOCAL_DISK_WAIVER_REASON: "local qualification",
	PDPP_LOCAL_DISK_FOOTPRINT_BYTES: "1234",
};
// Isolated child process: only the test preloader substitutes disk/spawn. The
// actual aggregate module, helper, step ordering and evidence writer all execute.
async function aggregate(t, available, overrides = {}, failedInstall = false) {
	const root = await mkdtemp(join(tmpdir(), "release-disk-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const output = join(root, "matrix"),
		preload = join(root, "preload.mjs");
	await writeFile(
		preload,
		`
import fs from 'node:fs/promises';
import {appendFileSync} from 'node:fs';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {EventEmitter} from 'node:events';
fs.statfs=async()=>{appendFileSync(${JSON.stringify(join(root, "measurements"))},'measured\\n');return {bavail:${available},bsize:1};};
cp.spawn=(command,args,options)=>{appendFileSync(${JSON.stringify(join(root, "spawns"))},JSON.stringify({command,args,env:{TEST_SANDBOX_ACTIVE:options.env.TEST_SANDBOX_ACTIVE}})+'\\n');const child=new EventEmitter();process.nextTick(()=>child.emit('exit',${failedInstall ? 7 : 0},null));return child;};
syncBuiltinESMExports();
`,
	);
	const env = { ...process.env };
	for (const key of Object.keys(env))
		if (
			key.startsWith("PDPP_LOCAL_DISK_") ||
			[
				"CI",
				"GITHUB_ACTIONS",
				"RELEASE",
				"SEMANTIC_RELEASE",
				"NODE_OPTIONS",
			].includes(key)
		)
			delete env[key];
	const child = spawnSync(process.execPath, ["--import", preload, runner], {
		env: {
			...env,
			GOZAR_COVERAGE_MATRIX: output,
			PDPP_LOCAL_DISK_WAIVER_LOG: join(root, "waiver"),
			...overrides,
		},
		encoding: "utf8",
		timeout: 10000,
	});
	assert.ifError(child.error);
	const optional = async (path) => {
		try {
			return await readFile(path, "utf8");
		} catch (e) {
			if (e.code === "ENOENT") return "";
			throw e;
		}
	};
	return {
		status: child.status,
		stderr: child.stderr,
		steps: JSON.parse((await optional(`${output}.steps.json`)) || "[]"),
		spawns: (await optional(join(root, "spawns")))
			.trim()
			.split("\n")
			.filter(Boolean)
			.map(JSON.parse),
		logs: (await optional(join(root, "waiver")))
			.trim()
			.split("\n")
			.filter(Boolean)
			.map(JSON.parse),
		measurements: (await optional(join(root, "measurements")))
			.trim()
			.split("\n")
			.filter(Boolean).length,
	};
}
test("aggregate honors local total floor at 50 GB and logs every real step measurement", async (t) => {
	const r = await aggregate(t, 50_000_000_000, waiver);
	assert.equal(r.status, 0);
	assert.equal(r.spawns.length, 7);
	assert.equal(r.measurements, 7);
	assert.equal(r.logs.length, 7);
	assert.deepEqual(
		r.steps.map((s) => s.name),
		[
			"install checked tarball",
			"public API preflight",
			"owner HTTP matrix",
			"controller and secret boundaries",
			"reachability.spec.ts",
			"reachability-setup.spec.ts",
			"source and built bundle independence",
		],
	);
	for (const [i, log] of r.logs.entries()) {
		assert.equal(log.availableBytes, 50_000_000_000);
		assert.equal(log.waivedFloorBytes, 15_000_000_000);
		assert.equal(
			log.releaseFloorBytes,
			i >= 4 && i <= 5 ? 110_000_000_000 : 105_000_000_000,
		);
		assert.equal(log.reason, "local qualification");
		assert.equal(log.measuredFootprintBytes, 1234);
	}
	assert.ok(r.spawns[2].command.endsWith("scripts/test-sandbox/test-sandbox"));
	for (const i of [4, 5])
		assert.equal(r.spawns[i].env.TEST_SANDBOX_ACTIVE, "");
});
test("aggregate refuses one byte below local floor and allows exact boundary", async (t) => {
	const low = await aggregate(t, 14_999_999_999, waiver);
	assert.equal(low.status, 1);
	assert.equal(low.spawns.length, 0);
	assert.equal(low.steps[0].result, "NOT RUN (disk)");
	assert.equal(low.steps[0].requiredFreeBytes, 15_000_000_000);
	assert.equal(low.logs[0].availableBytes, 14_999_999_999);
	const exact = await aggregate(t, 15_000_000_000, waiver);
	assert.equal(exact.status, 0);
	assert.equal(exact.spawns.length, 7);
});
test("aggregate rejects missing reason and every CI/release marker without running suites", async (t) => {
	for (const env of [
		{ PDPP_LOCAL_DISK_FLOOR_BYTES: "15000000000" },
		...["CI", "GITHUB_ACTIONS", "RELEASE", "SEMANTIC_RELEASE"].map(
			(marker) => ({ ...waiver, [marker]: "true" }),
		),
	]) {
		const r = await aggregate(t, 50_000_000_000, env);
		assert.notEqual(r.status, 0);
		assert.equal(r.spawns.length, 0);
		assert.match(r.stderr, /required|refused/);
	}
});
test("aggregate keeps 105/110 GB defaults, including one-byte boundaries", async (t) => {
	for (const [available, spawns] of [
		[104_999_999_999, 0],
		[105_000_000_000, 5],
		[109_999_999_999, 5],
		[110_000_000_000, 7],
		[200_000_000_000, 7],
	]) {
		const r = await aggregate(t, available);
		assert.equal(r.spawns.length, spawns);
		assert.equal(r.status, spawns === 7 ? 0 : 1);
		assert.equal(r.logs.length, 0);
		for (const step of r.steps.filter((s) => s.result === "NOT RUN (disk)"))
			assert.equal(
				step.requiredFreeBytes,
				step.name.endsWith(".spec.ts") ? 110_000_000_000 : 105_000_000_000,
			);
	}
});
test("failed install still blocks every later step", async (t) => {
	const r = await aggregate(t, 50_000_000_000, waiver, true);
	assert.equal(r.status, 1);
	assert.equal(r.spawns.length, 1);
	assert.equal(r.steps[0].exitCode, 7);
});
// The runner's step floor is not the only check: the installer and the e2e
// fixture are separate processes and must apply the same helper and waiver.
async function standalone(t, script, available, overrides, nodeArgs = []) {
	const root = await mkdtemp(join(tmpdir(), "standalone-disk-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const tarball = join(root, "package.tgz"),
		preload = join(root, "preload.mjs");
	await writeFile(tarball, "x");
	await writeFile(
		preload,
		`
import fs from 'node:fs/promises';
import cp from 'node:child_process';
import {appendFileSync} from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
fs.statfs=async()=>({bavail:${available},bsize:1});
cp.spawnSync=()=>{appendFileSync(${JSON.stringify(join(root, "npm"))},'ran\\n');return {status:9};};
syncBuiltinESMExports();
`,
	);
	const env = { ...process.env };
	for (const key of Object.keys(env))
		if (
			key.startsWith("PDPP_LOCAL_DISK_") ||
			["CI", "GITHUB_ACTIONS", "RELEASE", "SEMANTIC_RELEASE", "NODE_OPTIONS", "PDPP_DATA_DIR"].includes(key)
		)
			delete env[key];
	const child = spawnSync(
		process.execPath,
		["--import", preload, ...nodeArgs, fileURLToPath(new URL(script, import.meta.url))],
		{
			cwd: root,
			env: {
				...env,
				GOZAR_TARBALL: tarball,
				GOZAR_TARBALL_SHA256:
					"2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4f1",
				GOZAR_SOURCE_SHA: "a".repeat(40),
				...overrides,
			},
			encoding: "utf8",
			timeout: 20000,
		},
	);
	assert.ifError(child.error);
	let npmRan = false;
	try {
		npmRan = (await readFile(join(root, "npm"), "utf8")).length > 0;
	} catch (e) {
		if (e.code !== "ENOENT") throw e;
	}
	return { status: child.status, stderr: child.stderr, npmRan };
}
test("installer applies the release floor and the local waiver", async (t) => {
	const sha = (await import("node:crypto")).createHash("sha256").update("x").digest("hex");
	const base = { GOZAR_TARBALL_SHA256: sha };
	const refused = await standalone(t, "./install-tarball.mjs", 50_000_000_000, base);
	assert.notEqual(refused.status, 0);
	assert.match(refused.stderr, /NOT RUN \(disk\): need 105 GB free/);
	assert.equal(refused.npmRan, false);
	// A one-byte tarball reserves 100 MB + 20 bytes on top of the release floor.
	const belowTotal = await standalone(t, "./install-tarball.mjs", 105_100_000_019, base);
	assert.match(belowTotal.stderr, /NOT RUN \(disk\)/);
	assert.equal(belowTotal.npmRan, false);
	const atFloor = await standalone(t, "./install-tarball.mjs", 105_100_000_020, base);
	assert.doesNotMatch(atFloor.stderr, /NOT RUN \(disk\)/);
	assert.equal(atFloor.npmRan, true);
	const waived = await standalone(t, "./install-tarball.mjs", 50_000_000_000, { ...base, ...waiver });
	assert.doesNotMatch(waived.stderr, /NOT RUN \(disk\)/);
	assert.equal(waived.npmRan, true);
	assert.match(waived.stderr, /DISK_PREFLIGHT_WAIVED/);
	const below = await standalone(t, "./install-tarball.mjs", 14_999_999_999, { ...base, ...waiver });
	assert.match(below.stderr, /NOT RUN \(disk\): need 15 GB free/);
	assert.equal(below.npmRan, false);
});
test("e2e fixture applies the 110 GB floor and the local waiver", async (t) => {
	const args = ["--import", import.meta.resolve("tsx")];
	const refused = await standalone(t, "./reference-fixture.mjs", 50_000_000_000, {}, args);
	assert.match(refused.stderr, /NOT RUN \(disk\): need 110 GB free/);
	const waived = await standalone(t, "./reference-fixture.mjs", 50_000_000_000, waiver, args);
	assert.doesNotMatch(waived.stderr, /NOT RUN \(disk\)/);
	assert.match(waived.stderr, /Use the owned e2e harness/);
});
