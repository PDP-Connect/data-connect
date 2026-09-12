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
import { randomUUID } from "node:crypto";
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
 * Marks every fixture this file spawns, so the leak check can recognise its
 * own children and nothing else.
 *
 * The helper passes its `dbPath` straight through to the child's argv, so a
 * nonce in the temp-directory name reaches the process table without the
 * helper needing to know this contract exists.
 *
 * Unique per RUN, not per fixture script: the previous marker was the
 * fixture's own filename, which every caller of the helper shares. That also
 * matched `consent-handoff-restart-server-fixture.mjs` — the fixture spawned
 * by security-consent-token-handoff.test.ts, which the runner schedules
 * concurrently with this file. A healthy, fully-owned child of that other
 * test, alive for the ~3.5s of its SQLite-restart case, was reported here as
 * a process this file had leaked. Both leak assertions failed that way in CI
 * (run 34616515644: survivor 68785 under a live ppid 67626 — a parent that
 * had abandoned nothing).
 *
 * Snapshot-differencing did not save it. The check already excludes fixtures
 * seen before it started, so it only misfires on a neighbour that STARTS
 * inside the window — precisely the timing the runner produces, and why this
 * failed intermittently rather than every run.
 */
const RUN_MARKER = `pdpp-consent-handoff-lifecycle-${process.pid}-${randomUUID()}`;

function fixtureDirectory(): string {
  return mkdtempSync(join(tmpdir(), `${RUN_MARKER}-`));
}

/**
 * Live PIDs of the fixtures THIS RUN spawned, anywhere on this host, with
 * their parent PID. Matching on the child's command line rather than on
 * "children of this process" is deliberate: the failure being pinned is a
 * child that outlives its parent, and such a child reparents to init, so a
 * parent-scoped count would miss exactly the case that matters. Scoping that
 * host-wide scan by `RUN_MARKER` keeps it blind to other test files'
 * concurrent fixtures without giving up the reparented-orphan catch: a
 * leaked child keeps its argv, and so its marker, across reparenting.
 */
function liveFixtureProcesses(): Array<{ pid: string; ppid: string }> {
  // A full `ps -e` listing overruns execFileSync's 1 MiB default maxBuffer on
  // a busy workstation, and the overrun surfaces as a thrown ENOBUFS rather
  // than a short read — so the check dies instead of returning a verdict, and
  // reads as a broken contract rather than a host with many processes. The
  // listing is a few hundred KiB on CI and ~1 MiB here; 64 MiB is headroom
  // this scan will not reach.
  const listed = execFileSync("ps", ["-eo", "pid=,ppid=,args="], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return listed
    .split("\n")
    .filter((line) => line.includes("-fixture.mjs") && line.includes(RUN_MARKER))
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
  // Nothing carrying this run's marker can predate this run, so this is
  // empty on a healthy host. Kept as a guard rather than asserted away: if
  // the marker ever stops being unique, an inherited survivor surfaces here
  // instead of being blamed on whichever subtest happens to run next.
  const preExisting = liveFixtureProcesses().map(({ pid }) => pid);

  await t.test("reports a child that dies before its ready line", async () => {
    const directory = fixtureDirectory();
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
    const directory = fixtureDirectory();
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
