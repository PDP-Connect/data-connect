// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
	chmod,
	mkdir,
	mkdtemp,
	readdir,
	rm,
	stat,
	symlink,
	utimes,
	writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
	KEEP_DAYS,
	KEEP_RUNS,
	killedFileDiagnosticsRoot,
	RUN_MARKER_FILE,
	runDirectoryName,
	writeKilledFileTail,
} from "./killed-file-diagnostics.ts";

const execFileAsync = promisify(execFile);

test("the diagnostics root is a per-user state directory, and there is none on CI", () => {
	assert.equal(
		killedFileDiagnosticsRoot({ XDG_STATE_HOME: "/state" }),
		join("/state", "pdpp-ri-test-diagnostics"),
	);
	assert.equal(
		killedFileDiagnosticsRoot({}),
		join(homedir(), ".local", "state", "pdpp-ri-test-diagnostics"),
	);
	assert.equal(
		killedFileDiagnosticsRoot({ CI: "1", XDG_STATE_HOME: "/state" }),
		undefined,
	);
	assert.equal(
		killedFileDiagnosticsRoot({
			CI: "1",
			PDPP_TEST_DIAGNOSTICS_ROOT:
				"/state/pdpp-ri-test-diagnostics/run-x/nested",
			XDG_STATE_HOME: "/state",
		}),
		undefined,
	);
});

test("a runner started by a test writes inside the outer run's directory, and nowhere else", () => {
	const env = { XDG_STATE_HOME: "/state" };
	const base = "/state/pdpp-ri-test-diagnostics";
	// One nested level, and the same shape repeated for a nested runner's own children.
	for (const accepted of [
		`${base}/run-x/nested`,
		`${base}/run-x/nested/run-y/nested`,
	]) {
		assert.equal(
			killedFileDiagnosticsRoot({
				...env,
				PDPP_TEST_DIAGNOSTICS_ROOT: accepted,
			}),
			accepted,
		);
	}
	for (const refused of [
		"/outer/run/nested",
		"/state",
		base,
		`${base}/run-x`,
		`${base}/run-x/other`,
		`${base}/nested`,
		`${base}/run-/nested`,
		`${base}/not-a-run/nested`,
		`${base}/run-x/nested/run-y`,
		`${base}/run-x/../../elsewhere/nested`,
		`${base}-evil/run-x/nested`,
		"relative/run-x/nested",
	]) {
		assert.equal(
			killedFileDiagnosticsRoot({
				...env,
				PDPP_TEST_DIAGNOSTICS_ROOT: refused,
			}),
			undefined,
			refused,
		);
	}
});

test("an override outside the outer run's directory is ignored: nothing is chmodded, pruned or written there", async () => {
	const parent = await mkdtemp(join(tmpdir(), "killed-file-diagnostics-"));
	try {
		const shared = join(parent, "shared-results");
		await mkdir(shared, { mode: 0o755 });
		await chmod(shared, 0o755);
		const oldRun = join(shared, "run-2020-01-01T00-00-00-000Z-1");
		await mkdir(oldRun);
		const old = new Date("2020-01-01T00:00:00.000Z");
		await utimes(oldRun, old, old);
		const env = {
			PDPP_TEST_DIAGNOSTICS_ROOT: shared,
			XDG_STATE_HOME: join(parent, "state"),
		};
		// What run-tests.ts does: keep no diagnostics when there is no root.
		const root = killedFileDiagnosticsRoot(env);
		assert.equal(root, undefined);
		const path =
			root === undefined
				? undefined
				: await writeKilledFileTail(
						join(root, runDirectoryName()),
						"test/x.test.ts",
						Buffer.from("x"),
					);
		assert.equal(path, undefined);
		assert.equal(
			(await stat(shared)).mode & 0o777,
			0o755,
			"the mode is unchanged",
		);
		assert.deepEqual(await readdir(shared), [basename(oldRun)]);
	} finally {
		await rm(parent, { force: true, recursive: true });
	}
});

test("an accepted nested override still takes a tail", async () => {
	const stateHome = await mkdtemp(join(tmpdir(), "killed-file-diagnostics-"));
	try {
		const outerRun = join(
			stateHome,
			"pdpp-ri-test-diagnostics",
			runDirectoryName(),
		);
		const root = killedFileDiagnosticsRoot({
			PDPP_TEST_DIAGNOSTICS_ROOT: join(outerRun, "nested"),
			XDG_STATE_HOME: stateHome,
		});
		assert.equal(root, join(outerRun, "nested"));
		const path = await writeKilledFileTail(
			join(root ?? "", runDirectoryName()),
			"test/x.test.ts",
			Buffer.from("x"),
		);
		assert.ok(
			path?.startsWith(join(outerRun, "nested")),
			"written under the outer run",
		);
		assert.equal((await stat(join(outerRun, "nested"))).mode & 0o777, 0o700);
		assert.ok(
			(await readdir(outerRun)).includes(RUN_MARKER_FILE),
			"the outer run directory made on the way is marked, so it can be pruned",
		);
		// A symlink anywhere in the chain refuses the override.
		const elsewhere = join(stateHome, "elsewhere");
		await mkdir(elsewhere);
		const linkedRun = join(stateHome, "pdpp-ri-test-diagnostics", "run-linked");
		await symlink(elsewhere, linkedRun);
		assert.equal(
			killedFileDiagnosticsRoot({
				PDPP_TEST_DIAGNOSTICS_ROOT: join(linkedRun, "nested"),
				XDG_STATE_HOME: stateHome,
			}),
			undefined,
		);
	} finally {
		await rm(stateHome, { force: true, recursive: true });
	}
});

test("a run directory that is a symlink is not written through", async () => {
	const parent = await mkdtemp(join(tmpdir(), "killed-file-diagnostics-"));
	try {
		const root = join(parent, "pdpp-ri-test-diagnostics");
		const outside = join(parent, "outside");
		await mkdir(outside, { mode: 0o755 });
		await chmod(outside, 0o755);
		await mkdir(root);
		const runDir = join(root, runDirectoryName());
		await symlink(outside, runDir);
		const path = await writeKilledFileTail(
			runDir,
			"test/x.test.ts",
			Buffer.from("secret"),
		);
		assert.equal(path, undefined, "the result is not saved");
		assert.deepEqual(
			await readdir(outside),
			[],
			"nothing is written through the link",
		);
		assert.equal((await stat(outside)).mode & 0o777, 0o755);
		// A symlinked root is refused too.
		const linkedRoot = join(parent, "linked-root");
		await symlink(outside, linkedRoot);
		assert.equal(
			await writeKilledFileTail(
				join(linkedRoot, runDirectoryName()),
				"test/x.test.ts",
				Buffer.from("secret"),
			),
			undefined,
		);
		assert.deepEqual(await readdir(outside), []);
		assert.equal((await stat(outside)).mode & 0o777, 0o755);
		// An existing run directory the runner did not mark is refused.
		const unmarked = join(root, "run-unmarked");
		await mkdir(unmarked);
		assert.equal(
			await writeKilledFileTail(unmarked, "test/x.test.ts", Buffer.from("x")),
			undefined,
		);
	} finally {
		await rm(parent, { force: true, recursive: true });
	}
});

test("only directories the runner marked are pruned", async () => {
	const stateHome = await mkdtemp(join(tmpdir(), "killed-file-diagnostics-"));
	try {
		const root = killedFileDiagnosticsRoot({ XDG_STATE_HOME: stateHome }) ?? "";
		const nowMs = Date.parse("2026-10-18T12:00:00.000Z");
		const old = new Date(nowMs - 30 * 24 * 60 * 60 * 1000);
		const markedOld = runDirectoryName(old, 1);
		const unmarkedOld = runDirectoryName(old, 2);
		await mkdir(join(root, markedOld), { recursive: true });
		await writeFile(join(root, markedOld, RUN_MARKER_FILE), "");
		await mkdir(join(root, unmarkedOld));
		await utimes(join(root, markedOld), old, old);
		await utimes(join(root, unmarkedOld), old, old);
		assert.ok(
			await writeKilledFileTail(
				join(root, runDirectoryName(new Date(nowMs), 3)),
				"test/x.test.ts",
				Buffer.from("x"),
				nowMs,
			),
		);
		const left = await readdir(root);
		assert.ok(!left.includes(markedOld), "the old marked run is pruned");
		assert.ok(left.includes(unmarkedOld), "the old unmarked run is left alone");
	} finally {
		await rm(stateHome, { force: true, recursive: true });
	}
});

test("run directory names sort by start time", () => {
	const earlier = runDirectoryName(new Date("2026-10-18T09:59:59.999Z"), 99);
	const later = runDirectoryName(new Date("2026-10-18T10:00:00.000Z"), 1);
	assert.ok(earlier < later);
	assert.match(later, /^run-[\w-]+-1$/);
});

test("a tail is a 0600 file in a 0700 run directory under a 0700 root", async () => {
	const parent = await mkdtemp(join(tmpdir(), "killed-file-diagnostics-"));
	try {
		const root = join(parent, "pdpp-ri-test-diagnostics");
		await mkdir(root, { mode: 0o755 });
		await chmod(root, 0o755);
		const path = await writeKilledFileTail(
			join(root, runDirectoryName()),
			"test/a b.test.ts",
			Buffer.from("tail"),
		);
		if (path === undefined) {
			assert.fail("the tail was not written");
		}
		assert.ok(path?.startsWith(root), "the tail was written under the root");
		assert.equal(
			(await stat(root)).mode & 0o777,
			0o700,
			"an existing root is tightened",
		);
		assert.equal((await stat(join(path, ".."))).mode & 0o777, 0o700);
		assert.equal((await stat(path)).mode & 0o777, 0o600);
	} finally {
		await rm(parent, { force: true, recursive: true });
	}
});

test(`a new run keeps the newest ${KEEP_RUNS} runs, none older than ${KEEP_DAYS} days`, async () => {
	const root = await mkdtemp(join(tmpdir(), "killed-file-diagnostics-"));
	try {
		const nowMs = Date.parse("2026-10-18T12:00:00.000Z");
		const recent: string[] = [];
		// 25 recent runs, one minute apart, and one run eight days old.
		for (let index = 0; index < 25; index += 1) {
			const name = runDirectoryName(new Date(nowMs - (25 - index) * 60_000), 1);
			recent.push(name);
			await mkdir(join(root, name));
			await writeFile(join(root, name, RUN_MARKER_FILE), "");
		}
		const stale = runDirectoryName(
			new Date(nowMs - 8 * 24 * 60 * 60 * 1000),
			1,
		);
		await mkdir(join(root, stale));
		await writeFile(join(root, stale, RUN_MARKER_FILE), "");
		const staleTime = new Date(nowMs - 8 * 24 * 60 * 60 * 1000);
		await utimes(join(root, stale), staleTime, staleTime);
		const unrelated = join(root, "not-a-run");
		await mkdir(unrelated);

		const current = runDirectoryName(new Date(nowMs), 1);
		assert.ok(
			await writeKilledFileTail(
				join(root, current),
				"test/x.test.ts",
				Buffer.from("x"),
				nowMs,
			),
		);
		const left = (await readdir(root)).sort();
		assert.deepEqual(
			left,
			[...recent.slice(-(KEEP_RUNS - 1)), current, "not-a-run"].sort(),
		);

		// A second write in the same run prunes nothing more and keeps the first file.
		assert.ok(
			await writeKilledFileTail(
				join(root, current),
				"test/x.test.ts",
				Buffer.from("y"),
				nowMs,
			),
		);
		assert.equal(
			(await readdir(join(root, current))).filter((name) =>
				name.endsWith(".log"),
			).length,
			2,
		);
	} finally {
		await rm(root, { force: true, recursive: true });
	}
});

test("a dangling run-* symlink does not stop the tail being saved, and is left alone", async () => {
	const root = await mkdtemp(join(tmpdir(), "killed-file-diagnostics-"));
	try {
		const link = join(
			root,
			runDirectoryName(new Date("2026-01-01T00:00:00.000Z"), 1),
		);
		await symlink(join(root, "no-such-target"), link);
		const path = await writeKilledFileTail(
			join(root, runDirectoryName()),
			"test/x.test.ts",
			Buffer.from("x"),
		);
		assert.ok(path, "the tail is saved despite the dangling symlink");
		assert.ok((await readdir(root)).includes(link.slice(root.length + 1)));
	} finally {
		await rm(root, { force: true, recursive: true });
	}
});

test("a regular file named run-* is not pruned", async () => {
	const root = await mkdtemp(join(tmpdir(), "killed-file-diagnostics-"));
	try {
		const nowMs = Date.now();
		const name = runDirectoryName(
			new Date(nowMs - 30 * 24 * 60 * 60 * 1000),
			1,
		);
		await writeFile(join(root, name), "not a run directory");
		const old = new Date(nowMs - 30 * 24 * 60 * 60 * 1000);
		await utimes(join(root, name), old, old);
		assert.ok(
			await writeKilledFileTail(
				join(root, runDirectoryName(new Date(nowMs))),
				"test/x.test.ts",
				Buffer.from("x"),
				nowMs,
			),
		);
		assert.ok((await readdir(root)).includes(name), "the file is left alone");
	} finally {
		await rm(root, { force: true, recursive: true });
	}
});

// Two killed files of one run finish together. The first writer is held just
// before it writes the run's marker; on the old code the second writer then
// found the run directory made but unmarked, refused it, and lost its tail.
// A child process mocks node:fs/promises to hold that one write, so the
// interleaving is fixed rather than left to timing.
const MARKER_RACE_PROBE = `
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { mock } from "node:test";
let hold;
const writeFile = async (...args) => {
	if (hold && String(args[0]).endsWith(".pdpp-ri-run")) await hold(args[0]);
	return fs.writeFile(...args);
};
mock.module("node:fs/promises", { namedExports: { ...fs, writeFile } });
const m = await import(process.argv[2]);
const runDir = join(process.argv[3], m.runDirectoryName());
let release;
const gate = new Promise((resolve) => { release = resolve; });
let entered;
const hit = new Promise((resolve) => { entered = resolve; });
hold = async () => { hold = undefined; entered(); await gate; };
const first = m.writeKilledFileTail(runDir, "test/a.test.ts", Buffer.from("a"));
await hit;
const second = m.writeKilledFileTail(runDir, "test/b.test.ts", Buffer.from("b"));
// The old code settles the second writer without the held write; the fixed
// code waits for the shared preparation, so release after a bound.
await Promise.race([second, new Promise((resolve) => setTimeout(resolve, 1000))]);
release();
const saved = (await Promise.all([first, second])).map((path) => path !== undefined);
process.stdout.write(JSON.stringify(saved));
`;

test("two killed files of one run that finish together both keep their tails", async () => {
	const root = await mkdtemp(join(tmpdir(), "killed-file-diagnostics-"));
	try {
		const probe = join(root, "probe.mjs");
		await writeFile(probe, MARKER_RACE_PROBE);
		const modulePath = fileURLToPath(
			new URL("./killed-file-diagnostics.ts", import.meta.url),
		);
		const { stdout } = await execFileAsync(
			process.execPath,
			[
				"--experimental-test-module-mocks",
				"--no-warnings",
				probe,
				modulePath,
				root,
			],
			{
				encoding: "utf8",
				env: { ...process.env, NODE_TEST_CONTEXT: undefined },
			},
		);
		assert.deepEqual(
			JSON.parse(stdout),
			[true, true],
			"both writers saved their tail",
		);
	} finally {
		await rm(root, { force: true, recursive: true });
	}
});
