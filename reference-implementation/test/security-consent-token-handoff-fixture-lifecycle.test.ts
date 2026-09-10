// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Lifecycle contract for the consent-handoff restart helper in
 * security-consent-token-handoff.test.ts.
 *
 * The helper spawns a child that owns a listening socket and an open
 * handle on a real SQLite file, and its caller deletes that file's
 * directory as soon as the helper returns. So the helper owes two things
 * on EVERY exit path, not just the happy one: no surviving child, and a
 * real diagnosis when the child cannot deliver. Without them a wedged or
 * crashed child either outlives the suite as an orphan holding a port and
 * a deleted database, or parks the runner on a promise nothing settles.
 *
 * These tests drive the real helper against fixtures that fail the way
 * production servers fail — dying before `ready`, and refusing to exit.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runConsentHandoffRestartFixture } from "./helpers/consent-handoff-restart-fixture.ts";

const DIES_BEFORE_READY_FIXTURE = fileURLToPath(
  new URL("./fixtures/consent-handoff-restart-lifecycle-dies-before-ready-fixture.mjs", import.meta.url)
);
const NEVER_EXITS_FIXTURE = fileURLToPath(
  new URL("./fixtures/consent-handoff-restart-lifecycle-never-exits-fixture.mjs", import.meta.url)
);

/**
 * Live PIDs of consent-handoff restart fixtures anywhere on this host,
 * with their parent PID. Matching on the fixture's own command line rather
 * than on "children of this process" is deliberate: the failure being
 * pinned is a child that outlives its parent, and such a child reparents
 * to init, so a parent-scoped count would miss exactly the case that
 * matters. It also keeps the count free of unrelated children the runner
 * may own.
 */
function liveFixtureProcesses(): Array<{ pid: string; ppid: string }> {
  const listed = execFileSync("ps", ["-eo", "pid=,ppid=,args="], { encoding: "utf8" });
  return listed
    .split("\n")
    .filter((line) => line.includes("consent-handoff-restart-") && line.includes("-fixture.mjs"))
    .map((line) => {
      const fields = line.trim().split(/\s+/);
      return { pid: fields[0] ?? "", ppid: fields[1] ?? "" };
    })
    .filter(({ pid }) => pid.length > 0)
    .filter(({ pid }) => {
      try {
        process.kill(Number(pid), 0);
        return true;
      } catch {
        return false;
      }
    });
}

await test("the consent-handoff restart helper's child lifecycle", async (t) => {
  // Fixtures already running before this file started — orphans another
  // worktree leaked, for instance. Excluded from the whole-file backstop
  // so it reports only what this file is responsible for.
  const preExisting = liveFixtureProcesses().map(({ pid }) => pid);

  await t.test("reports a child that dies before its ready line", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pdpp-consent-handoff-lifecycle-"));
    try {
      // Without an error/close handler this await never settles: the
      // helper parks on a promise no code path can resolve, which the
      // runner reports as a pending-promise cancellation of the whole
      // file rather than as this call failing.
      await assert.rejects(
        runConsentHandoffRestartFixture(
          join(directory, "pdpp.sqlite"),
          { code: "cex_unused", op: "exchange" },
          DIES_BEFORE_READY_FIXTURE
        ),
        (err: Error) => {
          assert.match(err.message, /exited before emitting the awaited line/);
          // The diagnosis must carry the child's real exit code, not just
          // "something went wrong".
          assert.match(err.message, /code=3/);
          return true;
        },
        "a child that exits before `ready` must fail this call with the child's exit code"
      );
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  await t.test("kills a child that will not exit on its own, and leaves nothing behind", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pdpp-consent-handoff-lifecycle-"));
    const before = liveFixtureProcesses().map(({ pid }) => pid);
    try {
      // This fixture answers `ready` and the go line, then holds a
      // referenced handle forever — a server whose close has wedged. The
      // helper must not return control while it is still running, because
      // the caller deletes the SQLite directory next.
      await runConsentHandoffRestartFixture(
        join(directory, "pdpp.sqlite"),
        { code: "cex_unused", op: "exchange" },
        NEVER_EXITS_FIXTURE
      );

      const leaked = liveFixtureProcesses().filter(({ pid }) => !before.includes(pid));
      assert.deepEqual(
        leaked,
        [],
        `the helper must not return while its child is still running; these survived: ${leaked.map(({ pid, ppid }) => `${pid} (ppid ${ppid})`).join(", ")}`
      );
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  await t.test("leaves no fixture process behind across the whole file", () => {
    // Whole-file backstop: whatever the subtests above spawned, the
    // process table must be back where it started. Host-wide by PID, so
    // it still catches a child that outlived its parent and reparented to
    // init — the shape of the orphans this contract exists to prevent.
    const survivors = liveFixtureProcesses().filter(({ pid }) => !preExisting.includes(pid));
    assert.deepEqual(
      survivors,
      [],
      `fixture processes survived this file: ${survivors.map(({ pid, ppid }) => `${pid} (ppid ${ppid})`).join(", ")}`
    );
  });
});
