// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import {
  boundedOutputTail,
  countFileOutcomes,
  drainFileQueue,
  KILLED_OUTPUT_TAIL_BYTES,
  type NodeTestResult,
  superviseFileChild,
} from "./file-outcome.ts";

const HUNG_CHILD =
  "process.stdout.write('before-hang\\n'); process.stderr.write('stderr-before-hang\\n'); setInterval(() => {}, 1000);";

function spawnNode(source: string) {
  return spawn(process.execPath, ["-e", source], { stdio: ["ignore", "pipe", "pipe"] });
}

function result(filePath: string, exitCode: number, killed?: boolean): NodeTestResult {
  return { durationMs: 1, exitCode, filePath, ...(killed ? { killed } : {}), output: `\n==> ${filePath}\n` };
}

test("a child killed for idleness is a failed result that keeps its output", async () => {
  const outcome = await superviseFileChild({
    child: spawnNode(HUNG_CHILD),
    filePath: "test/hung.test.ts",
    hardDeadlineMs: 20_000,
    idleBudgetMs: 400,
  });
  assert.notEqual(outcome.exitCode, 0);
  assert.equal(outcome.killed, true);
  assert.match(outcome.output, /==> test\/hung\.test\.ts/);
  assert.match(outcome.output, /before-hang/);
  assert.match(outcome.output, /stderr-before-hang/);
  assert.match(outcome.output, /TIMED OUT \(idle\) after 400ms/);
});

test("a child killed at the hard deadline is a failed result labelled hard", async () => {
  // Output every 100ms keeps the idle budget alive, so only the hard deadline can fire.
  const chatty = "setInterval(() => process.stdout.write('tick\\n'), 100);";
  const outcome = await superviseFileChild({
    child: spawnNode(chatty),
    filePath: "test/chatty.test.ts",
    hardDeadlineMs: 700,
    idleBudgetMs: 700,
  });
  assert.notEqual(outcome.exitCode, 0);
  assert.equal(outcome.killed, true);
  assert.match(outcome.output, /tick/);
  assert.match(outcome.output, /TIMED OUT \((hard|idle)\) after 700ms/);
});

test("a child that dies on a signal is a failed result, not a rejection", async () => {
  const outcome = await superviseFileChild({
    child: spawnNode("process.stdout.write('about-to-die\\n'); process.kill(process.pid, 'SIGTERM'); setInterval(() => {}, 1000);"),
    filePath: "test/signalled.test.ts",
    hardDeadlineMs: 20_000,
    idleBudgetMs: 20_000,
  });
  assert.notEqual(outcome.exitCode, 0);
  assert.equal(outcome.killed, true);
  assert.match(outcome.output, /KILLED by signal SIGTERM/);
});

test("a child that exits on its own keeps its exit code and full output", async () => {
  const outcome = await superviseFileChild({
    child: spawnNode("process.stdout.write('done\\n'); process.exit(3);"),
    filePath: "test/exits.test.ts",
    hardDeadlineMs: 20_000,
    idleBudgetMs: 20_000,
  });
  assert.equal(outcome.exitCode, 3);
  assert.equal(outcome.killed, undefined);
  assert.equal(outcome.output, "\n==> test/exits.test.ts\ndone\n");
});

test("a spawn error is a runner error and rejects", async () => {
  const child = spawn("/nonexistent/pdpp-test-binary", [], { stdio: ["ignore", "pipe", "pipe"] });
  await assert.rejects(
    superviseFileChild({ child, filePath: "test/never.test.ts", hardDeadlineMs: 20_000, idleBudgetMs: 20_000 }),
    /ENOENT/
  );
});

test("a killed child's output is bounded to its tail and labelled", async () => {
  const flood = `process.stdout.write('HEAD-MARKER\\n'); process.stdout.write('x'.repeat(${KILLED_OUTPUT_TAIL_BYTES * 3}) + '\\nTAIL-MARKER\\n'); setInterval(() => {}, 1000);`;
  const outcome = await superviseFileChild({
    child: spawnNode(flood),
    filePath: "test/flood.test.ts",
    hardDeadlineMs: 20_000,
    idleBudgetMs: 600,
  });
  assert.match(outcome.output, /output truncated: last \d+ of \d+ bytes/);
  assert.match(outcome.output, /TAIL-MARKER/);
  assert.doesNotMatch(outcome.output, /HEAD-MARKER/);
  assert.ok(outcome.output.length < KILLED_OUTPUT_TAIL_BYTES + 1024);
});

test("tail truncation never splits a multi-byte character", () => {
  const tail = boundedOutputTail("é".repeat(10), 5);
  assert.doesNotMatch(tail, /�/);
  assert.equal(boundedOutputTail("short", 100), "short");
});

test("completed_files counts every executed file even when one failed", () => {
  const counts = countFileOutcomes([result("a", 0), result("b", 1, true), result("c", 0)]);
  assert.deepEqual(counts, { completed_files: 3, failed_files: 1 });
});

test("a failed file does not stop the queue; a runner error does", async () => {
  const ran: string[] = [];
  const collected: NodeTestResult[] = [];
  let stopping = false;
  await drainFileQueue({
    isStopping: () => stopping,
    onResult: (r) => collected.push(r),
    queue: ["hung", "next"],
    runFile: async (file) => {
      ran.push(file);
      return result(file, file === "hung" ? 1 : 0, file === "hung");
    },
    stop: () => {
      stopping = true;
    },
  });
  assert.deepEqual(ran, ["hung", "next"]);
  assert.equal(collected.length, 2);

  ran.length = 0;
  await assert.rejects(
    drainFileQueue({
      isStopping: () => stopping,
      onResult: () => undefined,
      queue: ["boom", "never"],
      runFile: async (file) => {
        ran.push(file);
        throw new Error("spawn failed");
      },
      stop: () => {
        stopping = true;
      },
    }),
    /spawn failed/
  );
  assert.deepEqual(ran, ["boom"]);
  assert.equal(stopping, true);
});
