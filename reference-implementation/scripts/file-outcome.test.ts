// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
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

/** A scratch directory standing in for the run's TMPDIR; removed after `body`. */
async function withScratch<T>(body: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "file-outcome-test-"));
  try {
    return await body(dir);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
}

/** The one raw-tail file a killed result points at, with its modes. */
async function readRawTail(dir: string, output: string) {
  const path = /raw output tail: (.+)\n/.exec(output)?.[1];
  if (path === undefined || !path.startsWith(dir)) {
    assert.fail(`the result names a raw tail file inside the scratch dir\n${output}`);
  }
  return {
    dirMode: (await stat(join(path, ".."))).mode & 0o777,
    fileMode: (await stat(path)).mode & 0o777,
    text: await readFile(path, "utf8"),
  };
}

function killedResult(output: string, rawTailDir?: string) {
  return fileResultFromClose({
    code: null,
    durationMs: 1234,
    filePath: "test/killed.test.ts",
    hardDeadlineMs: 20_000,
    idleBudgetMs: 400,
    output,
    rawTailDir,
    signal: "SIGKILL",
    timeoutReason: "idle",
  });
}

test("a child killed for idleness is a failed result with structured fields and no raw output", async () => {
  await withScratch(async (dir) => {
    const outcome = await superviseFileChild({
      child: spawnNode(HUNG_CHILD),
      filePath: "test/hung.test.ts",
      hardDeadlineMs: 20_000,
      idleBudgetMs: 400,
      rawTailDir: dir,
    });
    assert.notEqual(outcome.exitCode, 0);
    assert.equal(outcome.killed, true);
    assert.match(outcome.output, /==> test\/hung\.test\.ts/);
    assert.match(outcome.output, /TIMED OUT \(idle\) after 400ms/);
    assert.match(outcome.output, /elapsed: \d+ms/);
    assert.match(outcome.output, /signal: \w+/);
    assert.match(outcome.output, /last test started: none/);
    assert.doesNotMatch(outcome.output, /before-hang/);
    const raw = await readRawTail(dir, outcome.output);
    assert.match(raw.text, /before-hang/);
    assert.match(raw.text, /stderr-before-hang/);
  });
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
  assert.doesNotMatch(outcome.output, /tick/);
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
  assert.match(outcome.output, /signal: SIGTERM/);
  assert.doesNotMatch(outcome.output, /about-to-die/);
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

test("the result names the last test the reporter announced as started", async () => {
  const events = [
    '{"type":"test:running","details":{"name":"first"}}',
    '{"type":"test:pass","details":{"type":"test","name":"first"}}',
    '{"type":"test:running","details":{"name":"the one that hung"}}',
    '{"type":"test:running","details":{"name":"cut off by the ki',
  ]
    .map((json) => `PDPP_TEST_ACCOUNTING_EVENT ${json}\n`)
    .join("");
  const outcome = await killedResult(events);
  assert.match(outcome.output, /last test started: "the one that hung"\n/);
});

// Each shape hid a secret from a redactor in a past review round: a label whose
// value starts after a pause or a 2 KB line cap, a PEM block that has no label,
// and a credential region that began more than 16 lines before the cut. No
// redactor is involved now, so none of them may reach a result.
const LEAK_SHAPES: [name: string, output: string, secret: string][] = [
  ["a label, 3,000 spaces, then the value on the next line", `{"password":${" ".repeat(3000)}\n"SYNTHETIC-PAD-SECRET"\n}\n\nSAFE\n`, "SYNTHETIC-PAD-SECRET"],
  ["a value past the line cap", `{"password": "${"A".repeat(3000)}\nSYNTHETIC-CAP-SECRET"}\n\nSAFE\n`, "SYNTHETIC-CAP-SECRET"],
  ["a PEM block", "-----BEGIN PRIVATE KEY-----\nSYNTHETIC-PEM-SECRET\n-----END PRIVATE KEY-----\n\nSAFE\n", "SYNTHETIC-PEM-SECRET"],
  [
    "a credential region far back in the output",
    `Authorization: Bearer\n${`${"A".repeat(2040)}\n`.repeat(60)}SYNTHETIC-FARBACK-SECRET\n\nSAFE\n`,
    "SYNTHETIC-FARBACK-SECRET",
  ],
  ["a bearer header and a cookie", "Authorization: Bearer SYNTHETIC-BEARER-SECRET\nCookie: sid=SYNTHETIC-COOKIE-SECRET\n", "SYNTHETIC-BEARER-SECRET"],
];

for (const [name, output, secret] of LEAK_SHAPES) {
  test(`${name}: the secret is in no result, and is in the private file locally`, async () => {
    const withoutDir = await killedResult(output);
    assert.doesNotMatch(withoutDir.output, new RegExp(secret));
    assert.doesNotMatch(withoutDir.output, /raw output tail/, "no directory, no path is mentioned");
    await withScratch(async (dir) => {
      const withDir = await killedResult(output, dir);
      assert.doesNotMatch(withDir.output, new RegExp(secret));
      assert.doesNotMatch(withDir.output, /SAFE|AAAAAAAA/, "no raw text at all, only the path");
      const raw = await readRawTail(dir, withDir.output);
      assert.equal(raw.fileMode, 0o600);
      assert.equal(raw.dirMode, 0o700);
      assert.match(raw.text, new RegExp(secret));
    });
  });
}

test("with no directory (CI) a killed file writes nothing and names no path", async () => {
  await withScratch(async (dir) => {
    const outcome = await killedResult("Authorization: Bearer SYNTHETIC-CI-SECRET\n");
    assert.equal(outcome.killed, true);
    assert.doesNotMatch(outcome.output, /SYNTHETIC-CI-SECRET|raw output tail/);
    assert.deepEqual(await readdir(dir), []);
  });
});

test("a raw tail that cannot be written is reported as not saved and the file is still killed", async () => {
  const outcome = await killedResult("anything\n", join(tmpdir(), "file-outcome-test-no-such-dir", "nested"));
  assert.equal(outcome.killed, true);
  assert.match(outcome.output, /raw output tail: not saved\n/);
});

test("the private file holds the newest 64 KB of a flood, from a character boundary", async () => {
  await withScratch(async (dir) => {
    const flood = `HEAD-MARKER\n${"é".repeat(KILLED_OUTPUT_TAIL_BYTES)}\nTAIL-MARKER\n`;
    const outcome = await killedResult(flood, dir);
    const raw = await readRawTail(dir, outcome.output);
    assert.match(raw.text, /TAIL-MARKER/);
    assert.doesNotMatch(raw.text, /HEAD-MARKER|�/);
    assert.ok(Buffer.byteLength(raw.text) <= KILLED_OUTPUT_TAIL_BYTES);
    assert.ok(Buffer.byteLength(raw.text) > KILLED_OUTPUT_TAIL_BYTES - 4);
  });
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
  const dir = await mkdtemp(join(tmpdir(), "file-outcome-test-"));
  const outcome = await superviseFileChild({
    child: spawnNode(supervisor),
    filePath: "test/group.test.ts",
    hardDeadlineMs: 20_000,
    idleBudgetMs: 600,
    killGraceMs: 200,
    rawTailDir: dir,
  });
  // The grandchild's pid is raw output, so it is read from the private file.
  const pid = Number(/GRANDCHILD_PID=(\d+)/.exec((await readRawTail(dir, outcome.output)).text)?.[1]);
  await rm(dir, { force: true, recursive: true });
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
