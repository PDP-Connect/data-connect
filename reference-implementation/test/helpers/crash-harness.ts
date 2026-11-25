// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Process-kill harness for durability tests.
 *
 * A test runs real store or install work in a child process, parks the child
 * at a named `crashPoint(...)` (server/crash-point.ts), SIGKILLs it there, and
 * then reopens the same SQLite file, Postgres database or data directory to
 * assert recovery. Parking is a blocking read on a pipe, not a sleep, so the
 * kill lands exactly at the named boundary. (If the inherited pipe is ever
 * non-blocking, the read is retried every 5 ms; the child's code still does
 * not run.)
 *
 * Cleanup: a child still alive when the test that spawned it ends is SIGKILLed.
 * A child whose parent dies kills itself: at once if parked, else within
 * 250 ms (only while its event loop runs; a synchronous hang needs the outer
 * test-sandbox scope).
 *
 * Parent side:
 *   const exit = await killChildAt(script, "uninstall:after-root-move", { env });
 *   const child = spawnCrashChild(script, { points: ["a", "b"] });
 *   await child.parked("a"); child.resume(); await child.parked("b"); await child.kill();
 *
 * Child side (first line of the child script):
 *   armCrashPoints();
 *
 * Limit: SIGKILL loses process memory, not the kernel page cache. These tests
 * prove recovery from a process crash at each boundary. They cannot prove
 * that an fsync is present or sufficient; that needs power loss or a
 * filesystem fault injector, which a black-box test cannot provide.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { readSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { after } from "node:test";

import { __setCrashPointHookForTest } from "../../server/crash-point.ts";

const POINTS_ENV = "PDPP_CRASH_HARNESS_POINTS";
const PARENT_ENV = "PDPP_CRASH_HARNESS_PARENT";
const CONTROL_FD = 3;
const RI_ROOT = resolve(import.meta.dirname, "../..");
const DEFAULT_TIMEOUT_MS = 60_000;

export interface CrashChildExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  readonly stdout: string;
}

export interface CrashChildOptions {
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Crash points at which the child parks every time it reaches them. */
  readonly points?: readonly string[];
  readonly timeoutMs?: number;
}

export interface CrashChild {
  readonly exited: Promise<CrashChildExit>;
  /** SIGKILL the child (if still alive) and wait until it is gone. */
  kill: () => Promise<CrashChildExit>;
  /**
   * Wait until the child parks at its next armed point, which must be `point`.
   * Fails if the child exits first, parks somewhere else, or times out.
   */
  parked: (point: string) => Promise<void>;
  readonly pid: number;
  /** Let the parked child continue past its current point. */
  resume: () => void;
}

function describe(exit: CrashChildExit): string {
  return `code=${String(exit.code)} signal=${String(exit.signal)}\nstderr: ${exit.stderr.slice(-4000)}\nstdout: ${exit.stdout.slice(-2000)}`;
}

/** Start a child script (a .ts file run under tsx from the reference-implementation root). */
export function spawnCrashChild(script: string, options: CrashChildOptions = {}): CrashChild {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // A child is not a test file: without NODE_TEST_CONTEXT it never registers node:test hooks.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...options.env,
    [PARENT_ENV]: String(process.pid),
    [POINTS_ENV]: JSON.stringify(options.points ?? []),
  };
  delete env.NODE_TEST_CONTEXT;
  const child: ChildProcess = spawn(
    process.execPath,
    ["--import", "tsx", "--import", join(RI_ROOT, "scripts/hermetic/preload.ts"), script, ...(options.args ?? [])],
    {
      cwd: RI_ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe", "pipe"],
    }
  );
  if (child.pid === undefined) {
    throw new Error(`crash child failed to start: ${script}`);
  }
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => (stdout += String(chunk)));
  child.stderr?.on("data", (chunk) => (stderr += String(chunk)));
  const control = child.stdio[CONTROL_FD] as Readable & Writable;
  const parkEvents: string[] = [];
  let wake: (() => void) | null = null;
  let buffered = "";
  control.on("data", (chunk) => {
    buffered += String(chunk);
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    parkEvents.push(...lines);
    wake?.();
  });
  // The control socket errors with EPIPE/ECONNRESET when the child dies; exit is reported by `exited`.
  control.on("error", () => undefined);
  let done = false;
  const exited = new Promise<CrashChildExit>((settle) => {
    child.once("close", (code, signal) => {
      done = true;
      wake?.();
      settle({ code, signal, stderr, stdout });
    });
  });

  // A failed assertion must not leave a parked child holding the test file open:
  // inside a test, `after` runs when the test that spawned this child ends.
  if (process.env.NODE_TEST_CONTEXT !== undefined) {
    after(() => {
      if (!done) {
        child.kill("SIGKILL");
      }
    });
  }

  const kill = async (): Promise<CrashChildExit> => {
    if (!done) {
      child.kill("SIGKILL");
    }
    return await exited;
  };

  const parked = async (point: string): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (parkEvents.length === 0) {
      if (done) {
        throw new Error(`crash child exited before reaching crash point "${point}": ${describe(await exited)}`);
      }
      if (Date.now() >= deadline) {
        const exit = await kill();
        throw new Error(`crash child did not reach crash point "${point}" in ${timeoutMs} ms: ${describe(exit)}`);
      }
      await new Promise<void>((settle) => {
        wake = settle;
        setTimeout(settle, 50).unref();
      });
    }
    const reached = parkEvents.shift();
    if (reached !== point) {
      const exit = await kill();
      throw new Error(`crash child parked at "${reached}", expected "${point}": ${describe(exit)}`);
    }
  };

  return {
    exited,
    kill,
    parked,
    pid: child.pid,
    resume: () => {
      control.write("r");
    },
  };
}

/** Run the child until it parks at `point`, then SIGKILL it there. */
export async function killChildAt(
  script: string,
  point: string,
  options: Omit<CrashChildOptions, "points"> = {}
): Promise<CrashChildExit> {
  const child = spawnCrashChild(script, { ...options, points: [point] });
  await child.parked(point);
  const exit = await child.kill();
  if (exit.signal !== "SIGKILL") {
    throw new Error(`crash child was not killed at "${point}": ${describe(exit)}`);
  }
  return exit;
}

/** Run the child to completion with no armed points; fail unless it exits 0. */
export async function runCrashChild(
  script: string,
  options: Omit<CrashChildOptions, "points"> = {}
): Promise<CrashChildExit> {
  const child = spawnCrashChild(script, options);
  const timer = setTimeout(() => void child.kill(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const exit = await child.exited;
  clearTimeout(timer);
  if (exit.code !== 0) {
    throw new Error(`crash child failed: ${describe(exit)}`);
  }
  return exit;
}

function blockUntilResumed(): void {
  const byte = Buffer.alloc(1);
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    let read: number;
    try {
      read = readSync(CONTROL_FD, byte, 0, 1, null);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EAGAIN") {
        throw error;
      }
      Atomics.wait(pause, 0, 0, 5);
      continue;
    }
    if (read === 1) {
      return;
    }
    // EOF: the parent is gone. Die as abruptly as a SIGKILL would.
    process.kill(process.pid, "SIGKILL");
  }
}

/**
 * Child side: park at every point the parent armed. Call before any work.
 * Outside the harness this does nothing.
 */
export function armCrashPoints(): void {
  const points = process.env[POINTS_ENV];
  if (points === undefined) {
    return;
  }
  // Compare with the pid that spawned us, not our ppid now: the parent may
  // already have died while tsx was still loading this script.
  const parent = Number(process.env[PARENT_ENV]);
  const exitIfOrphaned = () => {
    if (process.ppid !== parent) {
      process.kill(process.pid, "SIGKILL");
    }
  };
  exitIfOrphaned();
  setInterval(exitIfOrphaned, 250).unref();
  const armed = new Set<string>(JSON.parse(points) as string[]);
  if (armed.size === 0) {
    return;
  }
  __setCrashPointHookForTest((name) => {
    if (!armed.has(name)) {
      return;
    }
    writeSync(CONTROL_FD, `${name}\n`);
    blockUntilResumed();
  });
}
