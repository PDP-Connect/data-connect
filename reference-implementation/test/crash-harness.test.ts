// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { killChildAt, spawnCrashChild } from "./helpers/crash-harness.ts";

const CHILD = join(import.meta.dirname, "fixtures/crash-harness-child.ts");

function withLog(run: (log: string) => Promise<void>): () => Promise<void> {
	return async () => {
		const dir = mkdtempSync(join(tmpdir(), "pdpp-crash-harness-"));
		try {
			await run(join(dir, "log"));
		} finally {
			rmSync(dir, { force: true, recursive: true });
		}
	};
}

test(
	"killChildAt stops the child exactly at the named point",
	withLog(async (log) => {
		const exit = await killChildAt(CHILD, "after-two", { args: [log] });
		assert.equal(exit.signal, "SIGKILL");
		assert.equal(readFileSync(log, "utf8"), "one\ntwo\n");
		assert.equal(exit.stdout, "");
	}),
);

test(
	"a parked child continues when resumed and parks again at the next armed point",
	withLog(async (log) => {
		const child = spawnCrashChild(CHILD, {
			args: [log],
			points: ["after-one", "after-three"],
		});
		await child.parked("after-one");
		assert.equal(readFileSync(log, "utf8"), "one\n");
		child.resume();
		await child.parked("after-three");
		assert.equal(readFileSync(log, "utf8"), "one\ntwo\nthree\n");
		child.resume();
		const exit = await child.exited;
		assert.equal(exit.code, 0);
		assert.equal(exit.stdout, "finished\n");
	}),
);

test(
	"a crash point the child never reaches fails the test instead of passing silently",
	withLog(async (log) => {
		await assert.rejects(
			killChildAt(CHILD, "after-four", { args: [log] }),
			/exited before reaching crash point "after-four"/,
		);
	}),
);

test(
	"parking at a different point than expected fails and kills the child",
	withLog(async (log) => {
		const child = spawnCrashChild(CHILD, {
			args: [log],
			points: ["after-one", "after-two"],
		});
		await assert.rejects(
			child.parked("after-two"),
			/parked at "after-one", expected "after-two"/,
		);
		assert.equal((await child.exited).signal, "SIGKILL");
	}),
);
