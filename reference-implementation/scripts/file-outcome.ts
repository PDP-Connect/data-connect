// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ChildProcess } from "node:child_process";
import { collectChildProcessOutput } from "./child-process-output.ts";
import {
  type FileProcessTimeoutReason,
  type FileProcessWatchdog,
  type FileProcessWatchdogOptions,
  startFileProcessWatchdog,
} from "./file-process-watchdog.ts";

/**
 * The outcome of one test file's child process.
 *
 * A child the watchdog kills, or that dies on a signal, is a failed file with
 * its diagnostics, not a runner failure. Only a spawn error (the child never
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

/** Output kept for a killed child: enough to show where it stopped. */
export const KILLED_OUTPUT_TAIL_BYTES = 64 * 1024;

/** The last `maxBytes` of `output`, cut on a character boundary and labelled when shortened. */
export function boundedOutputTail(output: string, maxBytes = KILLED_OUTPUT_TAIL_BYTES): string {
  const bytes = Buffer.from(output);
  if (bytes.length <= maxBytes) {
    return output;
  }
  let start = bytes.length - maxBytes;
  // Skip UTF-8 continuation bytes so the tail does not begin mid-character.
  while (start < bytes.length && ((bytes.at(start) ?? 0) & 0xc0) === 0x80) {
    start += 1;
  }
  return `[output truncated: last ${bytes.length - start} of ${bytes.length} bytes]\n${bytes.subarray(start).toString()}`;
}

interface FileCloseInput {
  code: number | null;
  durationMs: number;
  filePath: string;
  hardDeadlineMs: number;
  idleBudgetMs: number;
  output: string;
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

/** Turn a closed child into a result: a timeout or signal death becomes a failed file. */
export function fileResultFromClose(input: FileCloseInput): NodeTestResult {
  const line = killedLine(input);
  if (line === undefined) {
    return {
      durationMs: input.durationMs,
      exitCode: input.code ?? 1,
      filePath: input.filePath,
      output: `\n==> ${input.filePath}\n${input.output}`,
    };
  }
  const tail = boundedOutputTail(input.output);
  return {
    durationMs: input.durationMs,
    exitCode: input.code || 1,
    filePath: input.filePath,
    killed: true,
    output: `\n==> ${input.filePath}\n${tail}${tail === "" || tail.endsWith("\n") ? "" : "\n"}${line}\n`,
  };
}

export interface SuperviseFileChildOptions {
  child: ChildProcess;
  filePath: string;
  hardDeadlineMs: number;
  idleBudgetMs: number;
  startedAt?: number;
  watchdog?: Pick<FileProcessWatchdogOptions, "cancel" | "now" | "schedule">;
}

/**
 * Watch one spawned test child to its end. Resolves with the file's result,
 * including when the watchdog killed it. Rejects only when the child could not
 * be spawned.
 */
export function superviseFileChild({
  child,
  filePath,
  hardDeadlineMs,
  idleBudgetMs,
  startedAt = Date.now(),
  watchdog: watchdogOptions,
}: SuperviseFileChildOptions): Promise<NodeTestResult> {
  return new Promise<NodeTestResult>((resolve, reject) => {
    // Reporter output proves that a long file is still making progress. The
    // hard deadline separately bounds a chatty process that never exits.
    const watchdog: FileProcessWatchdog = startFileProcessWatchdog({
      ...watchdogOptions,
      hardDeadlineMs,
      idleBudgetMs,
      kill: () => child.kill("SIGKILL"),
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
      outputPromise
        .then((output) =>
          resolve(
            fileResultFromClose({
              code,
              durationMs: Date.now() - startedAt,
              filePath,
              hardDeadlineMs,
              idleBudgetMs,
              output,
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
