// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from "node:crypto";
import { chmod, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

/** Run directories kept: the newest this many, and none older than KEEP_DAYS. */
export const KEEP_RUNS = 20;
export const KEEP_DAYS = 7;
const RUN_DIR_PREFIX = "run-";

/**
 * Where the raw output tails of killed test files go: a per-user state
 * directory that outlives the run, so a sandboxed run (whose TMPDIR is removed
 * when it ends) still leaves the tail to read. Undefined on CI, where logs are
 * public and nothing is kept.
 */
export function killedFileDiagnosticsRoot(
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	if (env.CI) {
		return undefined;
	}
	const stateHome = env.XDG_STATE_HOME || join(homedir(), ".local", "state");
	return join(stateHome, "pdpp-ri-test-diagnostics");
}

/** A run directory name that sorts by start time. */
export function runDirectoryName(
	now: Date = new Date(),
	pid: number = process.pid,
): string {
	return `${RUN_DIR_PREFIX}${now.toISOString().replace(/[:.]/g, "-")}-${pid}`;
}

/** Remove run directories beyond the newest KEEP_RUNS or older than KEEP_DAYS, never `keep`. */
async function pruneRunDirectories(
	root: string,
	keep: string,
	nowMs: number,
): Promise<void> {
	const runs = (await readdir(root))
		.filter((name) => name.startsWith(RUN_DIR_PREFIX) && name !== keep)
		.sort()
		.reverse();
	const maxAgeMs = KEEP_DAYS * 24 * 60 * 60 * 1000;
	await Promise.all(
		runs.map(async (name, index) => {
			const path = join(root, name);
			// The current run takes one of the KEEP_RUNS places.
			const tooMany = index >= KEEP_RUNS - 1;
			const tooOld = nowMs - (await stat(path)).mtimeMs > maxAgeMs;
			if (tooMany || tooOld) {
				await rm(path, { force: true, recursive: true });
			}
		}),
	);
}

/**
 * Write `tail` for `filePath` where only its owner can read it: a 0600 file in
 * the run's 0700 directory `runDir`, under a 0700 root (its parent). The run's
 * first write creates `runDir` and prunes old runs. Returns the path, or
 * undefined when the write failed; a failed write must not turn a killed file
 * into a runner error.
 */
export async function writeKilledFileTail(
	runDir: string,
	filePath: string,
	tail: Buffer,
	nowMs: number = Date.now(),
): Promise<string | undefined> {
	try {
		const root = dirname(runDir);
		await mkdir(root, { mode: 0o700, recursive: true });
		await chmod(root, 0o700);
		let created = true;
		try {
			await mkdir(runDir, { mode: 0o700 });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
				throw error;
			}
			created = false;
		}
		if (created) {
			await pruneRunDirectories(root, basename(runDir), nowMs);
		}
		const name = `${basename(filePath).replace(/[^\w.-]/g, "_")}-${randomBytes(4).toString("hex")}.log`;
		const path = join(runDir, name);
		await writeFile(path, tail, { flag: "wx", mode: 0o600 });
		return path;
	} catch {
		return undefined;
	}
}
