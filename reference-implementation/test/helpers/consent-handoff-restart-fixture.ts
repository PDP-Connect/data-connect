// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { TEST_RS_INTROSPECTION_CREDENTIALS } from "./introspection-test-credentials.ts";

export const CONSENT_HANDOFF_RESTART_FIXTURE_PATH = fileURLToPath(
  new URL("../fixtures/consent-handoff-restart-server-fixture.mjs", import.meta.url)
);

/**
 * Runs one AS/RS server session against `dbPath` in a genuinely separate OS
 * process, performs `go` against it, and returns its single JSON result
 * line — simulating a real AS process lifetime. A real server restart is
 * two SEPARATE processes sharing one on-disk SQLite file, so the caller
 * runs both the pre-restart and the post-restart server through this
 * helper: `closeDb()` plus a second in-process `startServer()` cannot
 * exercise cross-process WAL recovery or SQLite file-lock handover.
 *
 * The child owns a listening socket and an open handle on the SQLite file,
 * and the caller deletes that file's directory as soon as this returns. So
 * every exit path — success, assertion failure, a child that dies before
 * `ready`, a child that refuses to exit — goes through the `finally` below,
 * which kills the child if it is still running and waits for its real
 * exit. A child that can no longer produce a line rejects the pending read
 * with its exit code, signal and stderr rather than leaving it unsettled.
 *
 * Stdio protocol matches fixtures/connector-instance-two-process-race-fixture.ts,
 * and the guarded-SIGKILL teardown matches its two established callers
 * (connector-instance-delete-upsert-two-process-race.test.ts,
 * connector-summary-evidence-engine-two-process-interleaving.test.ts).
 * Unlike those two this helper does not assert the child's exit code: its
 * fixture prints the result line before closing its servers, so it is
 * always still running at that point and its exit status is not yet
 * observable. Child-reported failures arrive on the result line instead.
 *
 * The lifecycle contract is pinned by
 * security-consent-token-handoff-fixture-lifecycle.test.ts.
 */
export async function runConsentHandoffRestartFixture(
  dbPath: string,
  go: { op: "exchange"; code: string } | { op: "mint"; spotifyManifestPath: string },
  // Overridden only by the lifecycle tests, which point this at fixtures
  // that die before `ready` or refuse to exit.
  fixturePath: string = CONSENT_HANDOFF_RESTART_FIXTURE_PATH
): Promise<Record<string, unknown>> {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", fixturePath, dbPath, JSON.stringify(TEST_RS_INTROSPECTION_CREDENTIALS)],
    { stdio: ["pipe", "pipe", "pipe"] }
  );
  let stderrText = "";
  child.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    stderrText += text;
    process.stderr.write(text);
  });
  let stdoutBuffer = "";
  const lines: string[] = [];
  const lineWaiters: Array<{ reject: (err: Error) => void; resolve: (line: string) => void }> = [];
  // Set once the child can no longer produce a line, so both a waiter
  // already parked in `nextLine()` and any later call fail with a real
  // diagnosis instead of hanging on a promise nothing will ever settle.
  let childGone: Error | null = null;
  function rejectAllWaiters(err: Error): void {
    childGone ??= err;
    while (lineWaiters.length > 0) {
      lineWaiters.shift()?.reject(err);
    }
  }
  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBuffer += chunk.toString("utf8");
    let idx = stdoutBuffer.indexOf("\n");
    while (idx >= 0) {
      const line = stdoutBuffer.slice(0, idx);
      stdoutBuffer = stdoutBuffer.slice(idx + 1);
      const waiter = lineWaiters.shift();
      if (waiter) {
        waiter.resolve(line);
      } else {
        lines.push(line);
      }
      idx = stdoutBuffer.indexOf("\n");
    }
  });
  const exited = new Promise<{ code: null | number; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => {
      rejectAllWaiters(
        new Error(
          `fixture process exited before emitting the awaited line (code=${String(code)}, signal=${String(signal)}): ${stderrText.trim()}`
        )
      );
      resolve({ code, signal });
    });
  });
  child.once("error", (err) => {
    rejectAllWaiters(new Error(`fixture process failed to run: ${err.message}`));
  });
  function nextLine(): Promise<string> {
    if (lines.length > 0) {
      const line = lines.shift();
      assert.ok(line !== undefined, "a line just confirmed present in the buffer must be shiftable");
      return Promise.resolve(line);
    }
    if (childGone) {
      return Promise.reject(childGone);
    }
    return new Promise((resolve, reject) => lineWaiters.push({ reject, resolve }));
  }

  try {
    const readyLine = await nextLine();
    const ready = JSON.parse(readyLine) as { ready: true };
    assert.equal(ready.ready, true, `fixture did not report ready: ${readyLine}`);

    child.stdin.write(`${JSON.stringify(go)}\n`);
    child.stdin.end();

    const resultLine = await nextLine();
    const result = JSON.parse(resultLine) as Record<string, unknown>;
    // The child reports its own failures on this line and the parent must
    // not treat one as a pass. Its exit status carries nothing further:
    // the fixture writes this line BEFORE closing its servers, so it is
    // always still alive here and its exit code is not yet observable.
    assert.ok(!("error" in result), `fixture reported an error: ${JSON.stringify(result)}`);
    return result;
  } finally {
    // Kill rather than wait for a voluntary exit. Waiting unbounded would
    // hang this helper on exactly the wedged-close case the kill exists
    // for, and a bound would just be a timing constant. SIGKILL is safe:
    // the child's only remaining work is closing its own listeners, and
    // the assertions above have already read everything it reported.
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    // Do not return until the OS has actually reaped it — the caller
    // deletes the SQLite directory next, and a live child still holds
    // that file and its listening port.
    await exited;
  }
}
