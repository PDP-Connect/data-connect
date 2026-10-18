// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import {
  boundedOutputTail,
  countFileOutcomes,
  drainFileQueue,
  fileResultFromClose,
  KILLED_OUTPUT_TAIL_BYTES,
  type NodeTestResult,
  superviseFileChild,
} from "./file-outcome.ts";

const HUNG_CHILD =
  "process.stdout.write('before-hang\\n'); process.stderr.write('stderr-before-hang\\n'); setInterval(() => {}, 1000);";

function spawnNode(source: string) {
  // Detached, like the runner's children: the child leads its own process group.
  return spawn(process.execPath, ["-e", source], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
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

test("a killed child's output never exposes a credential, even with isolation off", async () => {
  // Isolation off puts the test's own stderr straight into the child output.
  const outcome = await superviseFileChild({
    child: spawnNode(
      "process.stderr.write('request failed\\nAuthorization: Bearer SYNTHETIC-BEARER-SECRET\\nCookie: sid=SYNTHETIC-COOKIE-SECRET\\n'); process.stderr.write('{\"Set-Cookie\":\"sid=SYNTHETIC-SET-COOKIE-SECRET\"}\\n'); setInterval(() => {}, 1000);"
    ),
    filePath: "test/credential.test.ts",
    hardDeadlineMs: 20_000,
    idleBudgetMs: 400,
    killGraceMs: 200,
  });
  assert.equal(outcome.killed, true);
  assert.match(outcome.output, /request failed/);
  assert.match(outcome.output, /Authorization: \[REDACTED\]/);
  assert.doesNotMatch(outcome.output, /SYNTHETIC-[A-Z-]*SECRET/);
});

test("a credential line is redacted wherever the tail cut falls", () => {
  const filler = `${"x".repeat(99)}\n`;
  for (let linesFromEnd = 560; linesFromEnd <= 760; linesFromEnd += 1) {
    const output = `${filler.repeat(2000)}Authorization: Bearer SYNTHETIC-TAIL-SECRET\n${filler.repeat(linesFromEnd)}`;
    const outcome = fileResultFromClose({
      code: null,
      durationMs: 1,
      filePath: "test/cut.test.ts",
      hardDeadlineMs: 20_000,
      idleBudgetMs: 400,
      output,
      signal: "SIGKILL",
      timeoutReason: "idle",
    });
    assert.doesNotMatch(outcome.output, /SYNTHETIC-TAIL-SECRET|Bearer/, `${linesFromEnd} lines from the end`);
  }
});

function killedOutput(output: string): string {
  return fileResultFromClose({
    code: null,
    durationMs: 1,
    filePath: "test/killed.test.ts",
    hardDeadlineMs: 20_000,
    idleBudgetMs: 400,
    output,
    signal: "SIGKILL",
    timeoutReason: "idle",
  }).output;
}

test("a line over 2 KB is truncated and marked", () => {
  const output = killedOutput(`before\n${"x".repeat(5000)}\nafter\n`);
  assert.match(output, /x{2048}…\[line truncated\]/);
  assert.doesNotMatch(output, /x{2049}/);
  assert.match(output, /before/);
  assert.match(output, /after/);
});

test("a label at the end of the tail fails closed", () => {
  const output = killedOutput("ran\nAuthorization: Bearer\n");
  assert.match(output, /Authorization/);
  assert.match(output, /\[REDACTED: possible credential continuation\]/);
  const unterminated = killedOutput("ran\n{\"Authorization\":");
  // The structured-header scanner may replace the whole tail with its own marker.
  assert.match(unterminated, /\[REDACTED: possible credential continuation\]|\[REDACTED malformed sensitive header\]/);
});

test("a credential on the line after its label is dropped up to the next blank line", () => {
  const output = killedOutput(
    "ran\nAuthorization: Bearer\nSYNTHETIC-NEXTLINE-SECRET\nSYNTHETIC-SECOND-SECRET\n\nafter-blank\n"
  );
  assert.match(output, /ran/);
  assert.match(output, /\[REDACTED: possible credential continuation\]/);
  assert.match(output, /after-blank/);
  assert.doesNotMatch(output, /SYNTHETIC-[A-Z]+-SECRET/);
  const folded = killedOutput("Cookie: a=1;\n  b=SYNTHETIC-FOLDED-SECRET\nnext\n\nafter-blank\n");
  assert.doesNotMatch(folded, /SYNTHETIC-FOLDED-SECRET/);
  assert.match(folded, /after-blank/);
});

test("a credential is redacted across what used to be a redaction block boundary", () => {
  // The old runner redacted blocks of up to 20,000 characters on their own. A
  // quoted value that runs over two lines needs both lines in one pass; vary the
  // padding so the old block edge falls between them for some length.
  const filler = `${"x".repeat(99)}\n`;
  for (let padding = 0; padding <= 100; padding += 1) {
    const output = `"password": "SYNTHETIC-BOUNDARY\n-SECRET"\n${"x".repeat(padding)}\n${filler.repeat(199)}`;
    assert.doesNotMatch(killedOutput(output), /SYNTHETIC-BOUNDARY|-SECRET/, `${padding} padding characters`);
  }
});

test("a label just before the tail cut still drops its continuation", () => {
  const filler = `${"x".repeat(99)}\n`;
  const secretLine = "SYNTHETIC-CUT-SECRET\n";
  const kept = Math.floor(KILLED_OUTPUT_TAIL_BYTES / 100);
  for (let fillerLines = kept - 8; fillerLines <= kept + 8; fillerLines += 1) {
    const output = `${filler.repeat(50)}Authorization: Bearer\n${secretLine}${filler.repeat(fillerLines)}`;
    assert.doesNotMatch(killedOutput(output), /SYNTHETIC-CUT-SECRET/, `${fillerLines} filler lines`);
  }
});

test("a single unbroken line far over the tail size is cut and its credential never shown", async () => {
  const outcome = await superviseFileChild({
    child: spawnNode(
      `process.stdout.write('Authorization: Bearer ' + 'A'.repeat(${KILLED_OUTPUT_TAIL_BYTES + 4096}) + 'SYNTHETIC-TAIL-SECRET\\nTAIL-MARKER\\n'); setInterval(() => {}, 1000);`
    ),
    filePath: "test/straddle.test.ts",
    hardDeadlineMs: 20_000,
    idleBudgetMs: 800,
    killGraceMs: 200,
  });
  assert.equal(outcome.killed, true);
  assert.match(outcome.output, /TAIL-MARKER/);
  assert.doesNotMatch(outcome.output, /SYNTHETIC-TAIL-SECRET|AAAAAAAAAA/);
});

test("a timeout kills the whole process group before the result resolves", async () => {
  // Both the child and its grandchild ignore SIGTERM, so only the SIGKILL
  // escalation can end them. The grandchild has no stdio, so `close` alone
  // would not wait for it.
  const supervisor = [
    "const { spawn } = require('node:child_process');",
    "const grandchild = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\"], { stdio: 'ignore' });",
    "process.on('SIGTERM', () => {});",
    "process.stdout.write('GRANDCHILD_PID=' + grandchild.pid + '\\n');",
    "setInterval(() => {}, 1000);",
  ].join("\n");
  const outcome = await superviseFileChild({
    child: spawnNode(supervisor),
    filePath: "test/group.test.ts",
    hardDeadlineMs: 20_000,
    idleBudgetMs: 600,
    killGraceMs: 200,
  });
  const pid = Number(/GRANDCHILD_PID=(\d+)/.exec(outcome.output)?.[1]);
  assert.ok(Number.isInteger(pid) && pid > 0, `the grandchild reported its pid\n${outcome.output}`);
  try {
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, "the grandchild must be gone when the result resolves");
  } finally {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  assert.equal(outcome.killed, true);
});

test("a spawn error is a runner error and rejects", async () => {
  const child = spawn("/nonexistent/pdpp-test-binary", [], { stdio: ["ignore", "pipe", "pipe"] });
  await assert.rejects(
    superviseFileChild({ child, filePath: "test/never.test.ts", hardDeadlineMs: 20_000, idleBudgetMs: 20_000 }),
    /ENOENT/
  );
});

test("a killed child's output is bounded to its tail and labelled", async () => {
  const flood = `process.stdout.write('HEAD-MARKER\\n'); process.stdout.write(('x'.repeat(99) + '\\n').repeat(${Math.ceil((KILLED_OUTPUT_TAIL_BYTES * 3) / 100)}) + 'TAIL-MARKER\\n'); setInterval(() => {}, 1000);`;
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
