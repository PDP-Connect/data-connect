// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Acceptance test for host-wide admission (ledger DCR-79): two concurrent runs
// of the vendored test-sandbox with one slot must not run at the same time.
// The second waits for the slot, and both run inside the agent-tests.slice
// hierarchy. The runs use a private slot directory and a private child slice
// (agent-tests-admission<pid>.slice, which systemd nests directly under
// agent-tests.slice), so the test neither takes the host's real slots nor
// rewrites the shared slice's limits. Without cgroup enforcement (no systemd
// user manager, as on hosted CI) or without host-wide slots (no flock) it is
// skipped.

import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const sandbox = join(scriptsDir, "..", "..", "scripts", "test-sandbox", "test-sandbox");
const slice = `agent-tests-admission${process.pid}`;

/**
 * The environment with every test-sandbox and test-receipt variable removed
 * (so the runs are not nested in this run's sandbox) and no user config file.
 */
function freshEnvironment(stateDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("TEST_SANDBOX_") && !key.startsWith("TEST_RECEIPT_")) {
      env[key] = value;
    }
  }
  env.TEST_SANDBOX_CONFIG = "/dev/null";
  env.TEST_SANDBOX_STATE_DIR = stateDir;
  env.TEST_SANDBOX_ISOLATE = "cgroup";
  env.TEST_SANDBOX_SLICE = slice;
  return env;
}

/**
 * Stop this run's private slice and revert the runtime limits the tool set on it. Each call is bounded and its
 * errors are ignored: a slice that was never created has nothing to stop, and cleanup must not hang a test.
 */
function releasePrivateSlice(): void {
  for (const verb of ["stop", "revert"]) {
    spawnSync("systemctl", ["--user", verb, `${slice}.slice`], { timeout: 10_000 });
  }
}

/**
 * Skip unless the vendored tool reports cgroup enforcement and a host-wide slot here. Enforcement is chosen
 * before the scope launches, so a probe that did not finish cleanly says nothing about this host.
 */
function cgroupEnforcementUnavailable(): string | false {
  if (process.platform !== "linux") {
    return "test-sandbox admission needs Linux";
  }
  const stateDir = mkdtempSync(join(scriptsDir, ".sandbox-admission-probe-"));
  try {
    const probe = spawnSync(sandbox, ["--slots", "1", "--timeout", "30", "--", "true"], {
      encoding: "utf8",
      env: freshEnvironment(stateDir),
      timeout: 60_000,
    });
    if (probe.status !== 0) {
      return `test-sandbox probe exited with ${probe.status ?? probe.signal}, not 0`;
    }
    const receipt = probe.stderr
      .split("\n")
      .filter((line) => line.startsWith('{"tool":"test-sandbox"'))
      .pop();
    if (!receipt) {
      return "test-sandbox probe wrote no receipt";
    }
    const { exit, enforcement, slot, notes = [] } = JSON.parse(receipt) as {
      exit?: number;
      enforcement?: string;
      slot?: number;
      notes?: string[];
    };
    if (exit !== 0) {
      return `test-sandbox probe receipt reports exit ${exit ?? "unknown"}, not 0`;
    }
    if (!enforcement?.includes("cgroup")) {
      return `test-sandbox has no cgroup enforcement here (enforcement: ${enforcement ?? "unknown"}), as on hosted CI`;
    }
    const noSlotNote = notes.find((note) => note.includes("host-wide slots not enforced"));
    if (noSlotNote) {
      return `test-sandbox does not enforce host-wide slots here (receipt note: "${noSlotNote}")`;
    }
    if (slot === undefined || !Number.isInteger(slot) || slot < 1) {
      return `test-sandbox took no host-wide slot here (slot: ${slot ?? "unknown"})`;
    }
    return false;
  } finally {
    // The probe sets runtime limits on the slice and starts its scope there, even when it then skips.
    releasePrivateSlice();
    rmSync(stateDir, { force: true, recursive: true });
  }
}

interface SandboxRun {
  child: ChildProcess;
  exited: Promise<number | null>;
  stderr: () => string;
}

/** Run `script` in a one-slot sandbox; the work directory is passed as $1, never spliced into the script. */
function runSandboxed(env: NodeJS.ProcessEnv, work: string, script: string): SandboxRun {
  const child = spawn(sandbox, ["--slots", "1", "--timeout", "60", "--", "sh", "-c", script, "sh", work], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code));
  });
  return { child, exited, stderr: () => stderr };
}

async function until(condition: () => boolean, what: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test(
  "two one-slot test-sandbox runs do not overlap, and both run under agent-tests.slice",
  { skip: cgroupEnforcementUnavailable() },
  async () => {
    // Under the scripts directory, not /tmp: the sandbox gives each run a private /tmp.
    const work = mkdtempSync(join(scriptsDir, ".sandbox-admission-"));
    const runs: SandboxRun[] = [];
    try {
      const env = freshEnvironment(join(work, "slots"));
      const file = (name: string) => join(work, name);
      // First holds the slot until the test releases it.
      runs.push(
        runSandboxed(
          env,
          work,
          'cat /proc/self/cgroup > "$1/first.cgroup"; touch "$1/first.started"; while [ ! -e "$1/release" ]; do sleep 0.05; done; touch "$1/first.done"'
        )
      );
      const [first] = runs;
      await until(() => existsSync(file("first.started")), "the first run to start");
      runs.push(
        runSandboxed(
          env,
          work,
          'test -e "$1/first.done" || echo overlap > "$1/second.overlap"; cat /proc/self/cgroup > "$1/second.cgroup"; touch "$1/second.started"'
        )
      );
      const second = runs[1];
      assert.ok(first && second);
      await until(() => second.stderr().includes("waiting for a test slot"), "the second run to report that it waits");
      assert.equal(existsSync(file("second.started")), false, "the second run must not start while the first holds the slot");
      writeFileSync(file("release"), "");
      assert.equal(await first.exited, 0, "the first run exits cleanly");
      assert.equal(await second.exited, 0, `the second run exits cleanly\n${second.stderr()}`);
      assert.equal(existsSync(file("second.overlap")), false, "the second run started before the first finished");
      for (const name of ["first.cgroup", "second.cgroup"]) {
        const cgroup = readFileSync(file(name), "utf8");
        assert.match(cgroup, /\/agent-tests\.slice\//, `${name} shows the shared agent-tests.slice`);
        assert.match(cgroup, new RegExp(`/${slice}\\.slice/`), `${name} shows this test's child slice`);
      }
    } finally {
      // On a failed assertion, stop any run still holding or waiting for the slot before removing its files.
      writeFileSync(join(work, "release"), "");
      for (const run of runs) {
        if (run.child.exitCode === null && run.child.signalCode === null) {
          run.child.kill("SIGTERM");
        }
      }
      await Promise.allSettled(runs.map((run) => run.exited));
      releasePrivateSlice();
      rmSync(work, { force: true, recursive: true });
    }
  }
);
