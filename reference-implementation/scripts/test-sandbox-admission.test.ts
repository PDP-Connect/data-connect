// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Acceptance test for host-wide admission (ledger DCR-79): two concurrent runs
// of the vendored test-sandbox with one slot must not run at the same time.
// The second waits for the slot, and both run inside the shared
// agent-tests.slice cgroup. The test uses a private slot directory, so it does
// not take or wait for the host's real slots. It needs a systemd user manager
// (systemd-run --user); without one, as on hosted CI, it is skipped.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const sandbox = join(scriptsDir, "..", "..", "scripts", "test-sandbox", "test-sandbox");

/** The environment with every test-sandbox and test-receipt variable removed, so the runs are not nested. */
function freshEnvironment(stateDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("TEST_SANDBOX_") && !key.startsWith("TEST_RECEIPT_")) {
      env[key] = value;
    }
  }
  env.TEST_SANDBOX_STATE_DIR = stateDir;
  env.TEST_SANDBOX_ISOLATE = "cgroup";
  return env;
}

function systemdUserUnavailable(): string | false {
  if (process.platform !== "linux") {
    return "test-sandbox admission needs Linux";
  }
  const probe = spawnSync("systemd-run", ["--user", "--scope", "--quiet", "true"], { encoding: "utf8", timeout: 10_000 });
  return probe.status === 0 ? false : "no systemd user manager (systemd-run --user unavailable, as on hosted CI)";
}

function runSandboxed(env: NodeJS.ProcessEnv, script: string) {
  const child = spawn(sandbox, ["--slots", "1", "--timeout", "60", "--", "sh", "-c", script], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code));
  });
  return { exited, stderr: () => stderr };
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
  { skip: systemdUserUnavailable() },
  async () => {
    // Under the scripts directory, not /tmp: the sandbox gives each run a private /tmp.
    const work = mkdtempSync(join(scriptsDir, ".sandbox-admission-"));
    try {
      const env = freshEnvironment(join(work, "slots"));
      const file = (name: string) => join(work, name);
      // First holds the slot until the test releases it.
      const first = runSandboxed(
        env,
        `cat /proc/self/cgroup > '${file("first.cgroup")}'; touch '${file("first.started")}'; while [ ! -e '${file("release")}' ]; do sleep 0.05; done; touch '${file("first.done")}'`
      );
      await until(() => existsSync(file("first.started")), "the first run to start");
      const second = runSandboxed(
        env,
        `test -e '${file("first.done")}' || echo overlap > '${file("second.overlap")}'; cat /proc/self/cgroup > '${file("second.cgroup")}'; touch '${file("second.started")}'`
      );
      await until(() => second.stderr().includes("waiting for a test slot"), "the second run to report that it waits");
      assert.equal(existsSync(file("second.started")), false, "the second run must not start while the first holds the slot");
      writeFileSync(file("release"), "");
      assert.equal(await first.exited, 0, "the first run exits cleanly");
      assert.equal(await second.exited, 0, `the second run exits cleanly\n${second.stderr()}`);
      assert.equal(existsSync(file("second.overlap")), false, "the second run started before the first finished");
      for (const name of ["first.cgroup", "second.cgroup"]) {
        assert.match(readFileSync(file(name), "utf8"), /agent-tests\.slice/, `${name} shows the shared slice`);
      }
    } finally {
      rmSync(work, { force: true, recursive: true });
    }
  }
);
