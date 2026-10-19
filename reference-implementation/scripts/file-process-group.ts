// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ChildProcess } from "node:child_process";

/**
 * Signal and reap the whole process group of a test file's child.
 *
 * `node --test` runs each file in a descendant process, so killing only the
 * supervisor child leaves the real test process (and anything it spawned)
 * alive. The runner spawns each file's child detached, which makes the child a
 * process-group leader; these helpers target that group.
 */

/** Time a group gets to exit on SIGTERM before it is sent SIGKILL. */
export const PROCESS_GROUP_KILL_GRACE_MS = 2000;
/** Longest wait for a SIGKILLed group to disappear (a zombie only counts until its parent reaps it). */
const PROCESS_GROUP_REAP_LIMIT_MS = 5000;
const POLL_MS = 25;

function isMissingProcess(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ESRCH";
}

/** Send `signal` to the child's process group, and to the child itself when it is not a group leader. */
export function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  const { pid } = child;
  if (pid === undefined) {
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (!isMissingProcess(error)) {
      throw error;
    }
  }
  child.kill(signal);
}

/** True while any process is left in the child's process group. */
export function processGroupAlive(child: ChildProcess): boolean {
  const { pid } = child;
  if (pid === undefined) {
    return false;
  }
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (isMissingProcess(error)) {
      return false;
    }
    throw error;
  }
}

async function waitUntilGroupGone(child: ChildProcess, limitMs: number): Promise<boolean> {
  const deadline = Date.now() + limitMs;
  while (processGroupAlive(child)) {
    if (Date.now() >= deadline) {
      return false;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, POLL_MS));
  }
  return true;
}

/**
 * SIGTERM the child's process group, then SIGKILL whatever survives the grace
 * period. Resolves once no process is left in the group, or after a bounded
 * wait if the kernel still lists unreaped zombies.
 */
export async function terminateProcessGroup(
  child: ChildProcess,
  graceMs: number = PROCESS_GROUP_KILL_GRACE_MS
): Promise<void> {
  signalProcessGroup(child, "SIGTERM");
  if (await waitUntilGroupGone(child, graceMs)) {
    return;
  }
  signalProcessGroup(child, "SIGKILL");
  await waitUntilGroupGone(child, PROCESS_GROUP_REAP_LIMIT_MS);
}
