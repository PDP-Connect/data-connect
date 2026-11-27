// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
// Which folders make Gozar refuse its state home, and the one safe repair.
//
// Gozar checks every folder from the filesystem root down to its home: each must be a real
// directory, owned by the invoking user or root, with no group or other write bit (a root-owned
// sticky folder may be writable). It reports the first failure as a message string. This module
// applies the same rule, so the console can name every offending folder as data.
//
// The repair removes the group and other write bits (`chmod go-w`) and nothing else. It touches
// a folder only if it lies inside DataConnect's own data directory and belongs to the server's
// own user. It opens each folder without following a link, never recurses, and never changes an owner.
import { constants } from "node:fs";
import type { Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";

export type UnsafeReason = "writable-by-others" | "wrong-owner" | "not-directory" | "symlink-in-path";
export type UnsafePath = { path: string; reason: UnsafeReason; fixable: boolean };
export type StatePathReport = { paths: UnsafePath[]; command: string | null };

const OTHERS_WRITE = 0o022;
const STICKY = 0o1000;

function reasonFor(stat: Stats, uid: number): UnsafeReason | null {
  if (!stat.isDirectory()) return "not-directory";
  if (stat.uid !== 0 && stat.uid !== uid) return "wrong-owner";
  const rootSticky = stat.uid === 0 && (stat.mode & STICKY) !== 0;
  return (stat.mode & OTHERS_WRITE) !== 0 && !rootSticky ? "writable-by-others" : null;
}

function inside(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** The only folders the repair may change: real, group/other-writable, ours, inside the data directory. */
export function isFixable(stat: Stats, path: string, dataDir: string, uid: number): boolean {
  return reasonFor(stat, uid) === "writable-by-others" && stat.uid === uid && inside(path, dataDir);
}

// Preserve components (including "..") until lstat has rejected symlinks.
function chain(path: string): string[] {
  const absolute = isAbsolute(path) ? path : process.cwd() + sep + path;
  const names: string[] = [sep];
  let current = "";
  for (const part of absolute.split(sep).filter(Boolean)) {
    current += sep + part;
    names.push(current);
  }
  return names;
}

type StatPath = (path: string) => Promise<Stats>;
async function inspect(home: string, dataDir: string, uid: number, statPath: StatPath): Promise<StatePathReport> {
  const paths: UnsafePath[] = [];
  const dataChain = chain(dataDir);
  const ancestors = new Set(dataChain.slice(0, -1));
  const root = resolve(dataDir);
  let blocked = false;
  for (const path of new Set([...dataChain, ...chain(home)])) {
    let stat: Stats;
    try { stat = await statPath(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      paths.push({ path, reason: "not-directory", fixable: false });
      blocked = true;
      break;
    }
    if (stat.isSymbolicLink()) {
      paths.push({ path, reason: "symlink-in-path", fixable: false });
      blocked = true;
      break; // Never follow a discovered link to inspect its descendants.
    }
    const reason = reasonFor(stat, uid);
    if (reason) paths.push({ path, reason, fixable: isFixable(stat, resolve(path), root, uid) });
    if (!stat.isDirectory() || (ancestors.has(path) && reason !== null)) blocked = true;
  }
  // A blocked chain disables automatic repair, but must not turn an app-owned
  // descendant into a terminal-command target behind its unsafe ancestor.
  const command = fixCommand(paths);
  if (blocked) for (const item of paths) item.fixable = false;
  return { paths, command };
}

export function fixCommand(paths: readonly UnsafePath[]): string | null {
  const manual = paths.filter((item) => !item.fixable && item.reason === "writable-by-others");
  const links = paths.filter((item) => item.reason === "symlink-in-path");
  // chmod follows symlinks. Offer inspection, not a command that modifies their targets.
  if (links.length) return `ls -ld -- ${links.map((item) => `'${item.path.replaceAll("'", `'\\''`)}'`).join(" ")}`;
  if (manual.length === 0) return null;
  return `chmod go-w -- ${manual.map((item) => `'${item.path.replaceAll("'", `'\\''`)}'`).join(" ")}`;
}

export async function inspectStatePaths(home: string, dataDir: string, uid = process.getuid!()): Promise<StatePathReport> {
  return inspect(home, dataDir, uid, lstat);
}

/** Revalidate namespace and descriptor identity; never follow a link or repair an unsafe parent. */
export async function fixNamedPaths(
  named: readonly UnsafePath[], dataDir: string, uid = process.getuid!(), statPath: StatPath = lstat,
): Promise<string[]> {
  const changed: string[] = [];
  for (const { path } of named) {
    const report = await inspect(path, dataDir, uid, statPath);
    if (!report.paths.some((item) => item.path === path && item.fixable)) continue;
    // Repair parents first. Direct callers must not skip a writable directory
    // inside the data root that could still let another account replace a child.
    if (report.paths.some((item) => item.path !== path && inside(resolve(path), resolve(item.path)))) continue;
    const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW).catch(() => null);
    if (!handle) continue;
    try {
      const stat = await handle.stat();
      const current = await statPath(path).catch(() => null);
      if (!current || current.isSymbolicLink() || stat.dev !== current.dev || stat.ino !== current.ino) continue;
      if (!isFixable(stat, resolve(path), resolve(dataDir), uid)) continue;
      await handle.chmod(stat.mode & 0o7777 & ~OTHERS_WRITE);
      changed.push(path);
    } finally {
      await handle.close();
    }
  }
  return changed;
}

export async function fixStatePaths(home: string, dataDir: string, uid = process.getuid!()): Promise<StatePathReport> {
  const before = await inspectStatePaths(home, dataDir, uid);
  await fixNamedPaths(before.paths.filter((item) => item.fixable), dataDir, uid);
  return inspectStatePaths(home, dataDir, uid);
}

// Gozar reports an unsafe state folder as `setup_required` and names the fix in a structured
// `nextAction` (error-normalizer.mjs, stateAction). The original code survives only on a
// `cause` when a layer keeps it, so match any of the three. Never read the message.
const FIX_ACTION_ID = "fix-state-permissions";
const MAX_CAUSE_DEPTH = 5;
export const unsafeStatePathCause = (error: unknown): boolean => {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current && typeof current === "object"; depth += 1) {
    const { code, nextAction, cause } = current as { code?: unknown; nextAction?: unknown; cause?: unknown };
    if (code === "unsafe_state_path") return true;
    if (nextAction && typeof nextAction === "object" && (nextAction as { id?: unknown }).id === FIX_ACTION_ID) return true;
    current = cause;
  }
  return false;
};
