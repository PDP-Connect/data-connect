// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ChildProcess } from "node:child_process";
import { collectChildProcessOutput } from "./child-process-output.ts";
import { PROCESS_GROUP_KILL_GRACE_MS, terminateProcessGroup } from "./file-process-group.ts";
import {
  type FileProcessTimeoutReason,
  type FileProcessWatchdog,
  type FileProcessWatchdogOptions,
  startFileProcessWatchdog,
} from "./file-process-watchdog.ts";
import { writeKilledFileTail } from "./killed-file-diagnostics.ts";
import { lastStartedTestName, withoutProgressEvents } from "./test-accounting/receipt.ts";

/**
 * The outcome of one test file's child process.
 *
 * A child the watchdog kills, or that dies on a signal, is a failed file with
 * its structured fields, not a runner failure. Only a spawn error (the child never
 * ran) is a runner failure and rejects.
 */
export interface NodeTestResult {
  durationMs: number;
  exitCode: number;
  filePath: string;
  /** True when the child did not exit on its own: watchdog kill or signal. */
  killed?: boolean;
  output: string;
}

/** The raw output of a killed child is kept to its newest this many bytes, in a private file. */
export const KILLED_OUTPUT_TAIL_BYTES = 64 * 1024;

/** The newest `maxBytes` of `output`, starting on a character boundary. */
function newestBytes(output: string, maxBytes: number): Buffer {
  const bytes = Buffer.from(output);
  let start = Math.max(0, bytes.length - maxBytes);
  // Skip UTF-8 continuation bytes so the tail does not begin mid-character.
  while (start < bytes.length && ((bytes.at(start) ?? 0) & 0xc0) === 0x80) {
    start += 1;
  }
  return bytes.subarray(start);
}

interface FileCloseInput {
  code: number | null;
  durationMs: number;
  filePath: string;
  hardDeadlineMs: number;
  idleBudgetMs: number;
  output: string;
  /**
   * This run's directory for the raw output tails of killed files (created on
   * first use). Omit it where the log is public (CI): the tail is then neither
   * written nor mentioned.
   */
  rawTailDir?: string | undefined;
  signal: NodeJS.Signals | null;
  timeoutReason: FileProcessTimeoutReason | undefined;
}

function killedLine(input: FileCloseInput): string | undefined {
  if (input.timeoutReason === "idle") {
    return `TIMED OUT (idle) after ${input.idleBudgetMs}ms without child output; the child was killed`;
  }
  if (input.timeoutReason === "hard") {
    return `TIMED OUT (hard) after ${input.hardDeadlineMs}ms; the child was killed`;
  }
  if (input.signal) {
    return `KILLED by signal ${input.signal}`;
  }
  return undefined;
}

/**
 * Turn a closed child into a result: a timeout or signal death becomes a failed
 * file. A killed file's result holds structured fields only: how it ended, how
 * long it ran, and the last test the reporter announced. Its raw output is
 * untrusted text of unknown content, so it goes to a private file, never into
 * the result or the runner's logs.
 */
export async function fileResultFromClose(input: FileCloseInput): Promise<NodeTestResult> {
  const line = killedLine(input);
  if (line === undefined) {
    return {
      durationMs: input.durationMs,
      exitCode: input.code ?? 1,
      filePath: input.filePath,
      output: `\n==> ${input.filePath}\n${withoutProgressEvents(input.output)}`,
    };
  }
  const lastTest = lastStartedTestName(input.output);
  const fields = [
    line,
    `elapsed: ${input.durationMs}ms`,
    `signal: ${input.signal ?? "none"}`,
    `last test started: ${lastTest === undefined ? "none" : JSON.stringify(lastTest)}`,
  ];
  if (input.rawTailDir !== undefined) {
    const path = await writeKilledFileTail(
      input.rawTailDir,
      input.filePath,
      newestBytes(input.output, KILLED_OUTPUT_TAIL_BYTES)
    );
    fields.push(`raw output tail: ${path ?? "not saved"}`);
  }
  return {
    durationMs: input.durationMs,
    exitCode: input.code || 1,
    filePath: input.filePath,
    killed: true,
    output: `\n==> ${input.filePath}\n${fields.join("\n")}\n`,
  };
}

export interface SuperviseFileChildOptions {
  child: ChildProcess;
  filePath: string;
  hardDeadlineMs: number;
  idleBudgetMs: number;
  /** Grace between SIGTERM and SIGKILL when the watchdog kills the child's process group. */
  killGraceMs?: number;
  /** Where a killed file's raw output tail goes; omit to keep none (see FileCloseInput). */
  rawTailDir?: string | undefined;
  startedAt?: number;
  watchdog?: Pick<FileProcessWatchdogOptions, "cancel" | "now" | "schedule">;
}

/**
 * Watch one spawned test child to its end. Resolves with the file's result,
 * including when the watchdog killed it. A watchdog kill takes down the
 * child's whole process group (spawn the child detached) and the result
 * resolves only once the group is gone, so the caller can release the file's
 * slot knowing no descendant of the file is still running. Rejects only when
 * the child could not be spawned.
 */
export function superviseFileChild({
  child,
  filePath,
  hardDeadlineMs,
  idleBudgetMs,
  killGraceMs = PROCESS_GROUP_KILL_GRACE_MS,
  rawTailDir,
  startedAt = Date.now(),
  watchdog: watchdogOptions,
}: SuperviseFileChildOptions): Promise<NodeTestResult> {
  return new Promise<NodeTestResult>((resolve, reject) => {
    // Reporter output proves that a long file is still making progress. The
    // hard deadline separately bounds a chatty process that never exits.
    let groupTerminated: Promise<void> = Promise.resolve();
    const watchdog: FileProcessWatchdog = startFileProcessWatchdog({
      ...watchdogOptions,
      hardDeadlineMs,
      idleBudgetMs,
      kill: () => {
        groupTerminated = terminateProcessGroup(child, killGraceMs);
        // A failure still rejects through the join below; this only stops it
        // being unhandled before the child's `close` arrives.
        groupTerminated.catch(() => undefined);
      },
    });
    const outputPromise = collectChildProcessOutput(child, watchdog.markProgress);
    let settled = false;

    child.on("error", (error) => {
      if (!settled) {
        settled = true;
        watchdog.clear();
        reject(error);
      }
    });
    child.on("close", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      watchdog.clear();
      // Join the group kill: `close` can fire while a descendant still lives.
      Promise.all([outputPromise, groupTerminated])
        .then(([output]) =>
          resolve(
            fileResultFromClose({
              code,
              durationMs: Date.now() - startedAt,
              filePath,
              hardDeadlineMs,
              idleBudgetMs,
              output,
              rawTailDir,
              signal,
              timeoutReason: watchdog.timeoutReason(),
            })
          )
        )
        .catch(reject);
    });
  });
}

/** Per-file accounting: a file is completed once its child exited, pass or fail. */
export function countFileOutcomes(results: readonly NodeTestResult[]): {
  completed_files: number;
  failed_files: number;
} {
  return {
    completed_files: results.length,
    failed_files: results.filter((result) => result.exitCode !== 0).length,
  };
}

/**
 * One worker's loop over a shared file queue. A failed file does not stop the
 * queue; only `isStopping()` (a runner-wide signal) or a thrown runner error
 * does, and a runner error also stops every other worker through `stop()`.
 */
export async function drainFileQueue(options: {
  isStopping: () => boolean;
  onResult: (result: NodeTestResult) => void;
  queue: string[];
  runFile: (file: string) => Promise<NodeTestResult>;
  stop: () => void;
}): Promise<void> {
  const { isStopping, onResult, queue, runFile, stop } = options;
  while (!isStopping() && queue.length > 0) {
    const file = queue.shift();
    if (!file) {
      return;
    }
    try {
      // Each worker pulls one file at a time; awaiting here preserves the concurrency cap.
      onResult(await runFile(file));
    } catch (error) {
      stop();
      throw error;
    }
  }
}
