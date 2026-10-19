// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from "node:crypto";
import { lstatSync } from "node:fs";
import { chmod, lstat, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
	sep,
} from "node:path";

/** Run directories kept: the newest this many, and none older than KEEP_DAYS. */
export const KEEP_RUNS = 20;
export const KEEP_DAYS = 7;
const RUN_DIR_PREFIX = "run-";
const NESTED_DIR_NAME = "nested";
/**
 * The file the runner writes inside each run directory it creates. Pruning
 * removes only run directories that hold it, so a directory that merely looks
 * like a run is never deleted.
 */
export const RUN_MARKER_FILE = ".pdpp-ri-run";
/** The diagnostics root for runners started by tests; see killedFileDiagnosticsRoot. */
export const NESTED_DIAGNOSTICS_ROOT_ENV = "PDPP_TEST_DIAGNOSTICS_ROOT";

/**
 * True when `override` is `<defaultRoot>/run-<id>/nested`, or the same shape
 * repeated (a nested runner's own children get `<nested root>/run-<id>/nested`),
 * and no existing part of the chain from `defaultRoot` down is a symlink.
 *
 * The comparison is lexical, not by realpath: the nested directory does not
 * exist until the first write, so it has no realpath, and a realpath would
 * follow a symlink to wherever it points. The lexical shape plus an lstat of
 * every existing part (a symlink or a non-directory is refused) cannot be
 * steered outside `defaultRoot` by a link.
 */
function isOwnNestedRoot(defaultRoot: string, override: string): boolean {
	if (!isAbsolute(override)) {
		return false;
	}
	const rest = relative(defaultRoot, resolve(override));
	if (rest === "" || rest.startsWith("..") || isAbsolute(rest)) {
		return false;
	}
	const parts = rest.split(sep);
	const shaped =
		parts.length % 2 === 0 &&
		parts.every((part, index) =>
			index % 2 === 0
				? part.startsWith(RUN_DIR_PREFIX) && part.length > RUN_DIR_PREFIX.length
				: part === NESTED_DIR_NAME,
		);
	if (!shaped) {
		return false;
	}
	let path = defaultRoot;
	for (const part of ["", ...parts]) {
		path = join(path, part);
		try {
			if (!lstatSync(path).isDirectory()) {
				return false;
			}
		} catch (error) {
			// The rest does not exist yet; the runner will create it.
			return (error as NodeJS.ErrnoException).code === "ENOENT";
		}
	}
	return true;
}

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
	const defaultRoot = join(stateHome, "pdpp-ri-test-diagnostics");
	// Set by an outer RI runner for its test children, so a runner that a test
	// starts keeps its diagnostics inside the outer run's directory instead of
	// filling the user's list of recent runs. The runner chmods and prunes the
	// root it uses, so it accepts only a directory it could have made itself;
	// any other value keeps no diagnostics, never an arbitrary directory.
	const override = env[NESTED_DIAGNOSTICS_ROOT_ENV];
	if (override) {
		return isOwnNestedRoot(defaultRoot, override)
			? resolve(override)
			: undefined;
	}
	return defaultRoot;
}

/** A run directory name that sorts by start time. */
export function runDirectoryName(
	now: Date = new Date(),
	pid: number = process.pid,
): string {
	return `${RUN_DIR_PREFIX}${now.toISOString().replace(/[:.]/g, "-")}-${pid}`;
}

/** True when `runDir` holds the marker as a regular file (not a link). */
async function hasRunMarker(runDir: string): Promise<boolean> {
	try {
		return (await lstat(join(runDir, RUN_MARKER_FILE))).isFile();
	} catch {
		return false;
	}
}

/** True when `path` is a directory itself, not a symlink to one. */
async function isRealDirectory(path: string): Promise<boolean> {
	return (await lstat(path)).isDirectory();
}

/**
 * Remove run directories beyond the newest KEEP_RUNS or older than KEEP_DAYS,
 * never `keep`. Only real directories that hold the runner's marker file count
 * and are removed: a file, a symlink or an unmarked directory named `run-*` is
 * not ours to delete. An entry another run removes mid-scan is skipped.
 */
async function pruneRunDirectories(
	root: string,
	keep: string,
	nowMs: number,
): Promise<void> {
	const candidates = (await readdir(root, { withFileTypes: true }))
		.filter(
			(entry) =>
				entry.isDirectory() &&
				entry.name.startsWith(RUN_DIR_PREFIX) &&
				entry.name !== keep,
		)
		.map((entry) => entry.name);
	const marked = await Promise.all(
		candidates.map(async (name) =>
			(await hasRunMarker(join(root, name))) ? name : undefined,
		),
	);
	const runs = marked
		.filter((name): name is string => name !== undefined)
		.sort()
		.reverse();
	const maxAgeMs = KEEP_DAYS * 24 * 60 * 60 * 1000;
	await Promise.all(
		runs.map(async (name, index) => {
			const path = join(root, name);
			// The current run takes one of the KEEP_RUNS places.
			const tooMany = index >= KEEP_RUNS - 1;
			let tooOld = false;
			try {
				tooOld = nowMs - (await lstat(path)).mtimeMs > maxAgeMs;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") {
					return;
				}
				throw error;
			}
			if (tooMany || tooOld) {
				await rm(path, { force: true, recursive: true });
			}
		}),
	);
}

/**
 * Write `tail` for `filePath` where only its owner can read it: a 0600 file in
 * the run's 0700 directory `runDir`, under a 0700 root (its parent). The caller
 * passes only a root from killedFileDiagnosticsRoot, which the runner owns. The
 * run's first write creates `runDir`, marks it and prunes old runs. A root or
 * run directory that is a symlink, or an existing run directory the runner did
 * not mark, is never written through. Returns the path, or undefined when the
 * write failed or was refused; a failed write must not turn a killed file into
 * a runner error.
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
		if (!(await isRealDirectory(root))) {
			return undefined;
		}
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
			await writeFile(join(runDir, RUN_MARKER_FILE), "", {
				flag: "wx",
				mode: 0o600,
			});
			await pruneRunDirectories(root, basename(runDir), nowMs);
		} else if (
			!(await isRealDirectory(runDir)) ||
			!(await hasRunMarker(runDir))
		) {
			return undefined;
		}
		const name = `${basename(filePath).replace(/[^\w.-]/g, "_")}-${randomBytes(4).toString("hex")}.log`;
		const path = join(runDir, name);
		await writeFile(path, tail, { flag: "wx", mode: 0o600 });
		return path;
	} catch {
		return undefined;
	}
}
