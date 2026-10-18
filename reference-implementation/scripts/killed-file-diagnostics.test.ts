// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
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
import { join } from "node:path";
import test from "node:test";
import {
	KEEP_DAYS,
	KEEP_RUNS,
	killedFileDiagnosticsRoot,
	runDirectoryName,
	writeKilledFileTail,
} from "./killed-file-diagnostics.ts";

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
		}
		const stale = runDirectoryName(
			new Date(nowMs - 8 * 24 * 60 * 60 * 1000),
			1,
		);
		await mkdir(join(root, stale));
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
		assert.equal((await readdir(join(root, current))).length, 2);
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
