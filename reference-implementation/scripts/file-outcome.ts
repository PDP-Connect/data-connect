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
import { redactDiagnosticText } from "./test-accounting/node-reporter.ts";
import { DIAGNOSTIC_PREFIX } from "./test-accounting/receipt.ts";

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
export function boundedOutputTail(
  output: string,
  maxBytes = KILLED_OUTPUT_TAIL_BYTES,
  totalBytes = Buffer.byteLength(output)
): string {
  const bytes = Buffer.from(output);
  if (bytes.length <= maxBytes && totalBytes <= bytes.length) {
    return output;
  }
  let start = Math.max(0, bytes.length - maxBytes);
  // Skip UTF-8 continuation bytes so the tail does not begin mid-character.
  while (start < bytes.length && ((bytes.at(start) ?? 0) & 0xc0) === 0x80) {
    start += 1;
  }
  return `[output truncated: last ${bytes.length - start} of ${totalBytes} bytes]\n${bytes.subarray(start).toString()}`;
}

// The redactor is quadratic in the length of an unbroken word, so it is fed
// blocks of whole lines no longer than this (the reporter caps its own input
// the same way) and a longer single line is replaced rather than scanned.
const REDACTION_BLOCK_CHARS = 20_000;
const OVERSIZED_LINE_MARKER = "[REDACTED oversized output line]";

/**
 * Redact credentials from `output`, newest lines first, until more than
 * `maxBytes` of redacted text exist; earlier lines are dropped unread. Every
 * kept line is redacted whole, so no cut can separate a credential from its
 * label. Returns the redacted tail and whether earlier lines were dropped.
 */
function redactedOutputTail(output: string, maxBytes: number): { dropped: boolean; text: string } {
  const lines = output.split("\n");
  const kept: string[] = [];
  let keptBytes = 0;
  let block: string[] = [];
  let blockChars = 0;
  const keep = (text: string) => {
    kept.push(text);
    keptBytes += Buffer.byteLength(text) + 1;
  };
  const flushBlock = () => {
    if (block.length > 0) {
      keep(redactDiagnosticText(block.reverse().join("\n")));
      block = [];
      blockChars = 0;
    }
  };
  let index = lines.length - 1;
  for (; index >= 0 && keptBytes <= maxBytes; index -= 1) {
    const line = lines[index] ?? "";
    if (line.length > REDACTION_BLOCK_CHARS) {
      flushBlock();
      keep(OVERSIZED_LINE_MARKER);
      continue;
    }
    if (blockChars + line.length + 1 > REDACTION_BLOCK_CHARS) {
      flushBlock();
    }
    block.push(line);
    blockChars += line.length + 1;
  }
  flushBlock();
  return { dropped: index >= 0, text: kept.reverse().join("\n") };
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

/**
 * Reporter diagnostic lines carry the test's own stdout/stderr, which the
 * accounting reporter otherwise swallows. Show them for a killed file, where no
 * terminal event explains the hang; drop them otherwise.
 */
function withDiagnostics(output: string, keep: boolean): string {
  if (!output.includes(DIAGNOSTIC_PREFIX)) {
    return output;
  }
  return output
    .split("\n")
    .flatMap((line) => {
      if (!line.startsWith(DIAGNOSTIC_PREFIX)) {
        return [line];
      }
      if (!keep) {
        return [];
      }
      try {
        return [String(JSON.parse(line.slice(DIAGNOSTIC_PREFIX.length)))];
      } catch {
        // A line cut off by the kill: keep the raw text for the redaction below.
        return [line];
      }
    })
    .join("\n");
}

/** Turn a closed child into a result: a timeout or signal death becomes a failed file. */
export function fileResultFromClose(input: FileCloseInput): NodeTestResult {
  const line = killedLine(input);
  if (line === undefined) {
    return {
      durationMs: input.durationMs,
      exitCode: input.code ?? 1,
      filePath: input.filePath,
      output: `\n==> ${input.filePath}\n${withDiagnostics(input.output, false)}`,
    };
  }
  // Redact before cutting to a tail: a credential that straddles the cut would
  // otherwise lose its label and survive.
  const shown = withDiagnostics(input.output, true);
  const redacted = redactedOutputTail(shown, KILLED_OUTPUT_TAIL_BYTES);
  const tail = boundedOutputTail(
    redacted.text,
    KILLED_OUTPUT_TAIL_BYTES,
    redacted.dropped ? Buffer.byteLength(shown) : undefined
  );
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
  /** Grace between SIGTERM and SIGKILL when the watchdog kills the child's process group. */
  killGraceMs?: number;
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
