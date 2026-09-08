// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Regression guard for the consent-token-handoff-restart hang: a spawned
// child running test/security-consent-token-handoff.test.ts alone must exit
// within a bounded time. Without this guard, a reintroduced hang (e.g. a
// future restart-style subtest that starts two real-file SQLite servers in
// this SAME process, or spawns a child with `stdio: "inherit"` sharing this
// process's stderr fd) stalls every gate run that includes this file — see
// that file's "an exchange code survives a SQLite-backed server restart"
// subtest and the `runConsentHandoffRestartFixture` helper's doc comment
// for the full mechanism.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TARGET_FILE = join(__dirname, "security-consent-token-handoff.test.ts");
const EXIT_BUDGET_MS = 45_000;
// Grace period for the nested runner to deliver the child's "exit" event after
// the OS already reports the process gone.
const EXIT_EVENT_GRACE_MS = 2000;
// Node's test runner defaults to the "spec" reporter ("ℹ tests N") only when
// stdout is a TTY. In CI (and inside this repo's own scripts/run-tests.ts
// wrapper, which forces a custom accounting reporter for the file THIS test
// runs as, but not for the grandchild it spawns below), stdout isn't a TTY,
// so the grandchild falls back to the "tap" reporter's plain-text summary
// ("# tests N") instead. Match both so this guard doesn't silently break
// whichever one a given environment picks.
const TEST_RUNNER_SUMMARY_RE = /\n(?:ℹ|#) tests \d+\n/;
const TEST_RUNNER_PASS_RE = /\n(?:ℹ|#) pass \d+\n/;
const TEST_RUNNER_FAIL_RE = /\n(?:ℹ|#) fail [1-9]/;

test("security-consent-token-handoff.test.ts exits cleanly within budget as a spawned child", async () => {
  // NODE_TEST_CONTEXT is set by the `node --test` run this file itself
  // executes under. Left in the child's env, Node's own test runner treats
  // the nested `--test` invocation as a recursive call and skips running
  // the target file entirely (emitting "run() is being called recursively
  // within a test file. skipping running files." and exiting 0
  // immediately) — a silent false pass that would defeat this whole guard.
  const { NODE_TEST_CONTEXT: _omitted, ...childEnv } = process.env;
  const child = spawn(process.execPath, ["--import", "tsx", "--test", TARGET_FILE], {
    cwd: join(__dirname, ".."),
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  let exitCode: number | null = null;
  let exitSeen = false;
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  child.once("exit", (code) => {
    exitCode = code;
    exitSeen = true;
  });

  // Only a real process death counts as success. The hang this guard exists
  // to catch happens AFTER every assertion passes: the target prints its
  // full "tests N / pass N / fail 0" summary and only then fails to exit,
  // so treating that summary as the completion signal would resolve "did
  // not time out" while the child is still hung — the exact thing being
  // policed. The summary is collected for diagnostics only.
  //
  // `child`'s "exit" event is not trusted on its own either: this guard runs
  // nested inside ANOTHER `node --test` process, and exit-event delivery to
  // a nested `--test` parent can lag the child's actual process death (the
  // same class of runner quirk this whole file's fix works around). So poll
  // the OS directly with `process.kill(pid, 0)`, which throws ESRCH once the
  // process is really gone, and accept either signal.
  const childPid = child.pid;
  const processIsGone = () => {
    if (childPid === undefined) {
      return false;
    }
    try {
      process.kill(childPid, 0);
      return false;
    } catch {
      return true;
    }
  };

  let budgetTimer: NodeJS.Timeout | undefined;
  const timedOut = await Promise.race([
    new Promise<false>((resolve) => {
      const check = setInterval(() => {
        if (exitSeen || processIsGone()) {
          clearInterval(check);
          resolve(false);
        }
      }, 200);
    }),
    new Promise<true>((resolve) => {
      budgetTimer = setTimeout(() => resolve(true), EXIT_BUDGET_MS);
    }),
  ]);
  // Clear the losing branch's timer. Left referenced it holds this process's
  // event loop open for the full budget, so a passing run would stall the
  // gate for EXIT_BUDGET_MS — the very failure mode this file guards against.
  if (budgetTimer !== undefined) {
    clearTimeout(budgetTimer);
  }

  if (timedOut) {
    child.kill("SIGKILL");
  }
  assert.equal(
    timedOut,
    false,
    `child did not exit within ${EXIT_BUDGET_MS}ms — the process hung${
      TEST_RUNNER_SUMMARY_RE.test(stdout)
        ? " after its tests finished and its summary printed"
        : " before printing a summary"
    } (stdout tail: ${stdout.slice(-2000)})`
  );
  // The OS-level poll can observe process death a beat before the nested
  // runner delivers the "exit" event that carries the code, so give that
  // event a bounded grace period before asserting on `exitCode`.
  if (!exitSeen) {
    let graceTimer: NodeJS.Timeout | undefined;
    await Promise.race([
      new Promise<void>((resolve) => child.once("exit", () => resolve())),
      new Promise<void>((resolve) => {
        graceTimer = setTimeout(resolve, EXIT_EVENT_GRACE_MS);
      }),
    ]);
    if (graceTimer !== undefined) {
      clearTimeout(graceTimer);
    }
  }

  assert.match(stdout, TEST_RUNNER_PASS_RE, `child did not report a pass count; stdout tail: ${stdout.slice(-2000)}`);
  assert.doesNotMatch(stdout, TEST_RUNNER_FAIL_RE, `child reported failing tests; stdout tail: ${stdout.slice(-2000)}`);
  // Unconditional: wrapping this in `if (exitSeen)` would skip it precisely
  // in the hang case it exists to detect.
  assert.equal(exitCode, 0, `child did not exit 0 (exitCode=${exitCode}); stderr tail: ${stderr.slice(-2000)}`);
  child.kill("SIGKILL");
});
