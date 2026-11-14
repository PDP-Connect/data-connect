// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { spawn } from "node:child_process";
import { statfs, mkdir, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
const output = process.env.GOZAR_COVERAGE_MATRIX;
if (!output)
	throw new Error("GOZAR_COVERAGE_MATRIX must name an external evidence file");
const results = [];
async function run(name, args, reserve = 5_000_000_000, extraEnv = {}) {
	const disk = await statfs(process.cwd());
	if (disk.bavail * disk.bsize < 100_000_000_000 + reserve) {
		results.push({
			name,
			result: "NOT RUN (disk)",
			requiredFreeBytes: 100_000_000_000 + reserve,
		});
		return;
	}
	const child = spawn(args[0], args.slice(1), {
		stdio: "inherit",
		env: { ...process.env, ...extraEnv },
	});
	const exitCode = await new Promise((accept, reject) => {
		child.once("error", reject);
		child.once("exit", (code, signal) => accept(code ?? signal));
	});
	results.push({ name, command: args, exitCode });
}
await run("install checked tarball", [
	process.execPath,
	"scripts/reachability/install-tarball.mjs",
]);
if (results[0].exitCode === 0) {
	await run(
		"public API preflight",
		[
			process.execPath,
			"--test",
			"scripts/reachability/contract-preflight.test.mjs",
		],
		undefined,
		{ GOZAR_COVERAGE_MATRIX: `${output}.preflight.json` },
	);
	await run("owner HTTP matrix", [
		"scripts/test-sandbox/test-sandbox",
		"--isolate",
		"cgroup",
		"--",
		process.execPath,
		"--import",
		"tsx",
		"--test",
		"--test-force-exit",
		"scripts/reachability/release-journey.test.mjs",
	]);
	await run("controller and secret boundaries", [
		"scripts/test-sandbox/test-sandbox",
		"--isolate",
		"cgroup",
		"--",
		process.execPath,
		"--import",
		"tsx",
		"--test",
		"--test-force-exit",
		"scripts/reachability/draft-boundary.test.mjs",
		"scripts/reachability/recovery.test.mjs",
		"scripts/reachability/runtime-consent.test.mjs",
		"scripts/reachability/initial-proof.test.mjs",
		"scripts/reachability/host-route-history.test.mjs",
		"scripts/reachability/install-boundary.test.mjs",
		"scripts/reachability/sdk-refusal.test.mjs",
	]);
	for (const [flag, spec] of [
		["--reachability", "reachability.spec.ts"],
		["--reachability-stream", "reachability-stream.spec.ts"],
	]) {
		await run(
			spec,
			[process.execPath, "e2e/harness.mjs", flag, spec],
			10_000_000_000,
			{ TEST_SANDBOX_ACTIVE: "" },
		);
	}
	await run("source and built bundle independence", [
		process.execPath,
		"--import",
		"tsx",
		"--test",
		"scripts/reachability/provider-independence.test.mjs",
	]);
}
await mkdir(dirname(resolve(output)), { recursive: true });
await writeFile(
	`${output}.steps.json`,
	`${JSON.stringify(results, null, 2)}\n`,
);
if (results.some((result) => result.exitCode !== 0)) process.exitCode = 1;
