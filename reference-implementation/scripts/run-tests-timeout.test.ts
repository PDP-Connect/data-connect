// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end proof that one hung test file is a failed file, not an aborted
 * run: the real runner executes a file the watchdog kills, still runs the file
 * after it, reports completed_files for both, and exits non-zero. The hung
 * file also leaves a SIGTERM-proof grandchild; the file after it proves that
 * grandchild is gone before it is admitted. The hung file's raw output is
 * never printed: locally its tail is in a 0600 file, on CI nowhere, under
 * either test isolation mode.
 *
 * The fixtures sit in a hidden scratch directory under scripts/. The runner
 * selects them by authority path, and no discovery walk descends into a
 * subdirectory, so no other runner picks them up.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { RUN_AUTHORITY_SCHEMA } from "./test-accounting/inventory.ts";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const runTestsPath = join(scriptsDir, "run-tests.ts");
const RESULT_PREFIX = "PDPP_TEST_ACCOUNTING_RESULT ";

function runRunner(args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<{ code: number | null; stderr: string; stdout: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", runTestsPath, ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stderr, stdout }));
  });
}

const SECRETS = [
  "SYNTHETIC-HUNG-SECRET",
  "SYNTHETIC-HUNG-MULTILINE-SECRET",
  "SYNTHETIC-PAD-SECRET",
  "SYNTHETIC-PEM-SECRET",
  "SYNTHETIC-FARBACK-SECRET",
];

// Output shapes that hid a secret from a redactor in past review rounds. The
// runner now prints none of this text, so every secret must be absent from
// everything it writes, and present only in the private file.
const HUNG_FILE = [
  'import { spawn } from "node:child_process";',
  'import { writeFileSync } from "node:fs";',
  'import test from "node:test";',
  'test("hang", () => {',
  '  const grandchild = spawn(process.execPath, ["-e", "process.on(\'SIGTERM\', () => {}); setInterval(() => {}, 1000);"], { stdio: "ignore" });',
  '  writeFileSync(new URL("./grandchild.pid", import.meta.url), String(grandchild.pid));',
  '  process.stderr.write("HUNG-FIXTURE-OUTPUT Authorization: Bearer SYNTHETIC-HUNG-SECRET\\n");',
  // A header whose value arrives on the next line after a pause.
  '  process.stderr.write("Authorization: Bearer\\n");',
  '  setTimeout(() => process.stderr.write("SYNTHETIC-HUNG-MULTILINE-SECRET\\n"), 700);',
  // A label, 3,000 spaces, then the value on the next line.
  '  process.stderr.write(`{"password":${" ".repeat(3000)}\\n"SYNTHETIC-PAD-SECRET"\\n}\\n\\n`);',
  '  process.stderr.write("-----BEGIN PRIVATE KEY-----\\nSYNTHETIC-PEM-SECRET\\n-----END PRIVATE KEY-----\\n\\n");',
  // A credential region that starts more than 16 lines before the end.
  '  process.stderr.write(`Authorization: Bearer\\n${("A".repeat(2040) + "\\n").repeat(20)}SYNTHETIC-FARBACK-SECRET\\n\\n`);',
  "  setInterval(() => {}, 1000);",
  "  return new Promise(() => {});",
  "});",
].join("\n");

const AFTER_FILE = [
  'import assert from "node:assert/strict";',
  'import { readFileSync } from "node:fs";',
  'import test from "node:test";',
  'test("after the hang, its grandchild is gone", () => {',
  '  const pid = Number(readFileSync(new URL("./grandchild.pid", import.meta.url), "utf8"));',
  '  assert.ok(pid > 0);',
  '  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });',
  "});",
].join("\n");

/**
 * Raw-tail files the runner left under `stateHome`: a 0700 root, one 0700
 * directory for the run, and one 0600 log per killed file.
 */
async function rawTailFiles(stateHome: string) {
  const root = join(stateHome, "pdpp-ri-test-diagnostics");
  const found: { dirMode: number; fileMode: number; path: string; rootMode: number; text: string }[] = [];
  let runs: string[];
  try {
    runs = await readdir(root);
  } catch {
    return found;
  }
  for (const run of runs) {
    for (const log of await readdir(join(root, run))) {
      const path = join(root, run, log);
      found.push({
        dirMode: (await stat(join(root, run))).mode & 0o777,
        fileMode: (await stat(path)).mode & 0o777,
        path,
        rootMode: (await stat(root)).mode & 0o777,
        text: await readFile(path, "utf8"),
      });
    }
  }
  return found;
}

for (const mode of [[], ["--test-isolation=none"]]) {
  for (const ci of [false, true]) {
    const label = `${mode.join(" ") || "default isolation"}, ${ci ? "CI=1" : "CI unset"}`;
    test(`a hung file is reported failed with structured fields only and the next file still runs (${label})`, async () => {
      const scratch = await mkdtemp(join(scriptsDir, ".ri-timeout-fixture-"));
      // Stands in for the run's TMPDIR, which test:scratch and test-sandbox own
      // and remove when the run ends: the raw tail must not go there.
      const tmp = await mkdtemp(join(tmpdir(), "ri-timeout-tmp-"));
      // Stands in for the per-user state directory, which outlives the run.
      const stateHome = await mkdtemp(join(tmpdir(), "ri-timeout-state-"));
      try {
        await mkdir(scratch, { recursive: true });
        await writeFile(join(scratch, "a-hang.test.mjs"), HUNG_FILE);
        await writeFile(join(scratch, "b-after.test.mjs"), AFTER_FILE);
        const base = scratch.slice(scriptsDir.length + 1);
        const files = [
          `reference-implementation/scripts/${base}/a-hang.test.mjs`,
          `reference-implementation/scripts/${base}/b-after.test.mjs`,
        ];
        const authorityPath = join(scratch, "authority.json");
        await writeFile(
          authorityPath,
          JSON.stringify({
            expires_at: "2099-01-01T00:00:00.000Z",
            files,
            nonce: "timeout-nonce",
            profile: "memory-default",
            run_id: "timeout-run",
            schema: RUN_AUTHORITY_SCHEMA,
            suite: "ri-default",
          })
        );

        const { code, stderr, stdout } = await runRunner(["--accounting-authority", authorityPath, ...mode], {
          ...process.env,
          CI: ci ? "1" : undefined,
          // Inside a node --test child this would make the nested runner's own
          // test children refuse to start ("run() called recursively").
          NODE_TEST_CONTEXT: undefined,
          PDPP_TEST_CONCURRENCY: "1",
          PDPP_TEST_FILE_HARD_TIMEOUT_MS: "60000",
          PDPP_TEST_FILE_TIMEOUT_MS: "2500",
          PDPP_TEST_PROFILE: "memory-default",
          TMPDIR: tmp,
          XDG_STATE_HOME: stateHome,
        });

        try {
          const shown = `${stdout}\n${stderr}`;
          assert.notEqual(code, 0, `a timed-out file must fail the run\n${stderr}`);
          for (const secret of SECRETS) {
            assert.doesNotMatch(shown, new RegExp(secret), `${secret} is in the runner's output`);
          }
          assert.doesNotMatch(shown, /HUNG-FIXTURE-OUTPUT/, "no raw output of the hung file is printed");
          assert.match(stdout, /TIMED OUT \(idle\) after 2500ms/, `the timeout is named\n${shown}`);
          assert.match(stdout, /==> .*a-hang\.test\.mjs/, "the hung file's header is kept");
          assert.match(stdout, /elapsed: \d+ms/);
          assert.match(stdout, /last test started: "hang"/, `the last started test is named\n${shown}`);
          const kept = await rawTailFiles(stateHome);
          assert.deepEqual(
            (await readdir(tmp)).filter((name) => name.startsWith("pdpp-")),
            [],
            "no raw tail is kept in the run's TMPDIR, which the sandbox removes"
          );
          if (ci) {
            assert.deepEqual(kept, [], "CI keeps no raw tail");
            assert.deepEqual(await readdir(stateHome), [], "CI creates no diagnostics directory");
            assert.doesNotMatch(shown, /raw output tail/, "CI prints no path");
          } else {
            assert.equal(kept.length, 1, `one raw tail for the one killed file, in the state directory\n${shown}`);
            const [raw] = kept;
            assert.equal(raw?.fileMode, 0o600);
            assert.equal(raw?.dirMode, 0o700);
            assert.equal(raw?.rootMode, 0o700);
            assert.ok(stdout.includes(`raw output tail: ${raw?.path}\n`), "the result names the file");
            assert.match(raw?.text ?? "", /"name":"hang"/, "the tail holds the reporter's events");
            if (mode.length > 0) {
              // Without isolation the test's own output reaches the child's stdio.
              // Includes strings, not match: a failed match would print the whole 64 KB.
              assert.ok(raw?.text.includes("HUNG-FIXTURE-OUTPUT"), "the marker is in the private file");
              assert.ok(raw?.text.includes("SYNTHETIC-HUNG-MULTILINE-SECRET"), "so is the secret");
            }
          }
          assert.match(stdout, /==> .*b-after\.test\.mjs/, "the file after the hang still ran");
          assert.match(stdout, /"name":"after the hang, its grandchild is gone"/, "the next file saw the grandchild gone");
          assert.doesNotMatch(stdout, /"type":"test:fail"/, "the next file passed");
          const line = stdout.split("\n").find((l) => l.startsWith(RESULT_PREFIX));
          assert.ok(line, `no accounting result line\n${shown}`);
          const result = JSON.parse(line.slice(RESULT_PREFIX.length));
          assert.equal(result.counts.planned_files, 2);
          assert.equal(result.counts.completed_files, 2, "both files' children exited");
          assert.equal(result.counts.failed_files, 1, `only the hung file fails\n${shown}`);
        } finally {
          try {
            const pid = Number(await readFile(join(scratch, "grandchild.pid"), "utf8"));
            process.kill(pid, "SIGKILL");
          } catch {
            // gone, as expected
          }
        }
      } finally {
        await rm(scratch, { force: true, recursive: true });
        await rm(tmp, { force: true, recursive: true });
        await rm(stateHome, { force: true, recursive: true });
      }
    });
  }
}

// The reporter swallows a test's own output. A healthy test that only logs
// must still count as progress, or the idle watchdog kills it.
const LOGGING_FILE = [
  'import test from "node:test";',
  'test("logs every 300 ms and finishes after 4.5 s", async () => {',
  '  const timer = setInterval(() => process.stderr.write("still working\\n"), 300);',
  "  await new Promise((resolve) => setTimeout(resolve, 4500));",
  "  clearInterval(timer);",
  "});",
].join("\n");

test("a test that logs but takes longer than the idle budget is not killed (default isolation)", async () => {
  const scratch = await mkdtemp(join(scriptsDir, ".ri-timeout-fixture-"));
  const stateHome = await mkdtemp(join(tmpdir(), "ri-timeout-state-"));
  try {
    await writeFile(join(scratch, "logging.test.mjs"), LOGGING_FILE);
    const base = scratch.slice(scriptsDir.length + 1);
    const authorityPath = join(scratch, "authority.json");
    await writeFile(
      authorityPath,
      JSON.stringify({
        expires_at: "2099-01-01T00:00:00.000Z",
        files: [`reference-implementation/scripts/${base}/logging.test.mjs`],
        nonce: "progress-nonce",
        profile: "memory-default",
        run_id: "progress-run",
        schema: RUN_AUTHORITY_SCHEMA,
        suite: "ri-default",
      })
    );
    const { stderr, stdout } = await runRunner(["--accounting-authority", authorityPath], {
      ...process.env,
      CI: undefined,
      NODE_TEST_CONTEXT: undefined,
      PDPP_TEST_CONCURRENCY: "1",
      PDPP_TEST_FILE_HARD_TIMEOUT_MS: "60000",
      PDPP_TEST_FILE_TIMEOUT_MS: "2500",
      PDPP_TEST_PROFILE: "memory-default",
      XDG_STATE_HOME: stateHome,
    });
    const shown = `${stdout}\n${stderr}`;
    assert.doesNotMatch(stdout, /TIMED OUT/, `the logging test was killed as idle\n${shown}`);
    assert.match(stdout, /"type":"test:pass".*"logs every 300 ms/);
    // The exit code is not the oracle: a one-file authority run is a complete
    // suite, so named-skip finalization fails it for the skips it did not run.
    const line = stdout.split("\n").find((l) => l.startsWith(RESULT_PREFIX));
    assert.ok(line, `no accounting result line\n${shown}`);
    const { counts } = JSON.parse(line.slice(RESULT_PREFIX.length));
    assert.deepEqual(
      { failed: counts.failed, failed_files: counts.failed_files, passed: counts.passed },
      { failed: 0, failed_files: 0, passed: 1 },
      shown
    );
    assert.doesNotMatch(shown, /still working/, "the test's own output is still not printed");
    assert.doesNotMatch(stdout, /"type":"test:(progress|running)"/, "a file that exits prints only terminal events");
  } finally {
    await rm(scratch, { force: true, recursive: true });
    await rm(stateHome, { force: true, recursive: true });
  }
});
