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
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, sep } from "node:path";

export type UnsafeReason = "writable-by-others" | "wrong-owner" | "not-directory";
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

// Existing ancestors of the canonical home, root first. A missing tail is skipped: Gozar creates it private.
async function chain(home: string): Promise<string[]> {
  let existing = home;
  for (;;) {
    try {
      existing = await realpath(existing);
      break;
    } catch {
      const parent = dirname(existing);
      if (parent === existing) return [];
      existing = parent;
    }
  }
  const names: string[] = [];
  for (let path = existing; ; path = dirname(path)) {
    names.unshift(path);
    if (dirname(path) === path) return names;
  }
}

export function fixCommand(paths: readonly UnsafePath[]): string | null {
  const manual = paths.filter((item) => !item.fixable && item.reason === "writable-by-others");
  if (manual.length === 0) return null;
  return `chmod go-w -- ${manual.map((item) => `'${item.path.replaceAll("'", `'\\''`)}'`).join(" ")}`;
}

export async function inspectStatePaths(home: string, dataDir: string, uid = process.getuid!()): Promise<StatePathReport> {
  const paths: UnsafePath[] = [];
  const root = await realpath(dataDir).catch(() => dataDir);
  for (const path of await chain(home)) {
    const stat = await lstat(path).catch(() => null);
    const reason = stat && reasonFor(stat, uid);
    if (stat && reason) paths.push({ path, reason, fixable: isFixable(stat, path, root, uid) });
  }
  return { paths, command: fixCommand(paths) };
}

/** Removes group/other write from each named folder that passes the guard. Returns the folders it changed. */
export async function fixNamedPaths(named: readonly UnsafePath[], dataDir: string, uid = process.getuid!()): Promise<string[]> {
  const root = await realpath(dataDir).catch(() => dataDir);
  const changed: string[] = [];
  for (const { path } of named) {
    // O_NOFOLLOW refuses a link in the last position; the checks run on the opened folder itself.
    const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW).catch(() => null);
    if (!handle) continue;
    try {
      const stat = await handle.stat();
      if (!isFixable(stat, path, root, uid)) continue;
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

export const unsafeStatePathCause = (error: unknown): boolean => {
  const cause = error && typeof error === "object" && "cause" in error ? error.cause : null;
  return !!cause && typeof cause === "object" && "code" in cause && cause.code === "unsafe_state_path";
};
