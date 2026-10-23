// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { chdir } from "node:process";
import { test } from "node:test";
// biome-ignore lint/correctness/noUnresolvedImports: Biome's Node module registry does not yet recognize node:sqlite; Node and tsc resolve the built-in module.
import { DatabaseSync } from "node:sqlite";
import {
  compactOutbox,
  parseArgs,
  pruneSentOutboxRows,
  resolveInspectionOptions,
} from "../bin/pdpp-local-collector.ts";
import {
  CollectorStateResolutionError,
  canonicalCollectorQueuePath,
  collectorStateDirectory,
  defaultCollectorStateRoot,
  resolveCollectorQueuePath,
} from "../src/durable-state.ts";
import { LocalDeviceOutbox } from "../src/runner.ts";

const SOURCE_A = "dsrc_test_a";
const SOURCE_B = "dsrc_test_b";
const MODULE_FILE = "durable-state.js";

function withTempRoot<T>(prefix: string, callback: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), prefix));
  try {
    return callback(root);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

/** Child migrators a test started and has not yet seen exit. */
const pausedChildren = new Set<ChildProcess>();

async function withTempRootAsync<T>(prefix: string, callback: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), prefix));
  try {
    return await callback(root);
  } finally {
    // A failed assertion must not leave a paused child waiting for a release.
    for (const child of pausedChildren) {
      child.kill("SIGKILL");
    }
    pausedChildren.clear();
    rmSync(root, { force: true, recursive: true });
  }
}

function modulePath(installRoot: string): string {
  return join(installRoot, "dist", "local-collector", "src", MODULE_FILE);
}

function packageLegacyPath(installRoot: string, name: string): string {
  return join(installRoot, "dist", "local-collector", ".pdpp-data", name);
}

function seedOutbox(path: string, sourceInstanceId: string, id = `test-${sourceInstanceId}-${path.length}`): void {
  const outbox = new LocalDeviceOutbox({ path });
  try {
    outbox.enqueue({
      id,
      kind: "record_batch",
      payload: { source: sourceInstanceId },
      sourceInstanceId,
    });
  } finally {
    outbox.close();
  }
}

function outboxIds(path: string, sourceInstanceId: string): string[] {
  const outbox = new LocalDeviceOutbox({ path });
  try {
    return outbox
      .list({ sourceInstanceId })
      .map((item) => item.id)
      .sort();
  } finally {
    outbox.close();
  }
}

function sourceSummary(path: string, sourceInstanceId: string): number {
  const outbox = new LocalDeviceOutbox({ path });
  try {
    return outbox.summary({ sourceInstanceId }).total;
  } finally {
    outbox.close();
  }
}

test("platform state roots are independent of cwd and use the platform convention", () => {
  assert.equal(
    defaultCollectorStateRoot({
      env: { XDG_STATE_HOME: "/state/x" },
      home: "/home/tester",
      platform: "linux",
    }),
    "/state/x"
  );
  assert.equal(
    defaultCollectorStateRoot({ env: {}, home: "/home/tester", platform: "linux" }),
    "/home/tester/.local/state"
  );
  assert.equal(
    defaultCollectorStateRoot({ env: { XDG_STATE_HOME: "/state/x" }, home: "/Users/tester", platform: "darwin" }),
    "/Users/tester/Library/Application Support"
  );
  assert.equal(
    defaultCollectorStateRoot({
      env: { LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local" },
      home: "C:\\Users\\tester",
      platform: "win32",
    }),
    "C:\\Users\\tester\\AppData\\Local"
  );
  assert.equal(
    defaultCollectorStateRoot({ env: { XDG_STATE_HOME: "relative-state" }, home: "/home/tester", platform: "linux" }),
    "/home/tester/.local/state"
  );
});

test("source ids use injective filename segments", () => {
  const first = canonicalCollectorQueuePath({ sourceInstanceId: "a%b", stateRoot: "/state" });
  const second = canonicalCollectorQueuePath({ sourceInstanceId: "a_25b", stateRoot: "/state" });
  assert.notEqual(first, second);
  const pairFirst = canonicalCollectorQueuePath({ connectorId: "a-b", sourceInstanceId: "c", stateRoot: "/state" });
  const pairSecond = canonicalCollectorQueuePath({ connectorId: "a", sourceInstanceId: "b-c", stateRoot: "/state" });
  assert.notEqual(pairFirst, pairSecond);
});

test("explicit queue paths preserve valid path bytes", () => {
  const explicitPath = " /state/queue with spaces.sqlite ";
  assert.equal(
    resolveCollectorQueuePath({ configuredPath: explicitPath, configuredPathIsExplicit: true }),
    explicitPath
  );
});

test("explicit environment and profile queue paths preserve leading and trailing spaces", {
  concurrency: false,
}, () => {
  withTempRoot("pdpp-durable-state-whitespace-", (root) => {
    const profileDirectory = join(root, "profiles");
    const profileQueuePath = ` ${join(root, "profile queue.sqlite")} `;
    const environmentQueuePath = ` ${join(root, "environment queue.sqlite")} `;
    mkdirSync(profileDirectory, { recursive: true });
    writeFileSync(
      join(profileDirectory, "profile.env"),
      `PDPP_CONNECTION_ID=${SOURCE_A}\nPDPP_COLLECTOR_QUEUE="${profileQueuePath}"\n`
    );
    const previousProfileDirectory = process.env.PDPP_LOCAL_COLLECTOR_PROFILE_DIR;
    const previousQueuePath = process.env.PDPP_COLLECTOR_QUEUE;
    process.env.PDPP_LOCAL_COLLECTOR_PROFILE_DIR = profileDirectory;
    process.env.PDPP_COLLECTOR_QUEUE = environmentQueuePath;
    try {
      assert.equal(parseArgs(["status"]).queuePath, environmentQueuePath);
      delete process.env.PDPP_COLLECTOR_QUEUE;
      const options = resolveInspectionOptions(parseArgs(["status", "--source-instance-id", SOURCE_A]));
      assert.equal(options.queuePath, profileQueuePath);
    } finally {
      if (previousProfileDirectory === undefined) {
        delete process.env.PDPP_LOCAL_COLLECTOR_PROFILE_DIR;
      } else {
        process.env.PDPP_LOCAL_COLLECTOR_PROFILE_DIR = previousProfileDirectory;
      }
      if (previousQueuePath === undefined) {
        delete process.env.PDPP_COLLECTOR_QUEUE;
      } else {
        process.env.PDPP_COLLECTOR_QUEUE = previousQueuePath;
      }
    }
  });
});

test("whitespace-only environment and profile queue paths remain explicit instead of falling back", {
  concurrency: false,
}, () => {
  const previousProfileDirectory = process.env.PDPP_LOCAL_COLLECTOR_PROFILE_DIR;
  const previousQueuePath = process.env.PDPP_COLLECTOR_QUEUE;
  withTempRoot("pdpp-durable-state-whitespace-only-", (root) => {
    const profileDirectory = join(root, "profiles");
    mkdirSync(profileDirectory, { recursive: true });
    writeFileSync(
      join(profileDirectory, "profile.env"),
      `PDPP_CONNECTION_ID=${SOURCE_A}\nPDPP_COLLECTOR_QUEUE="   "\n`
    );
    process.env.PDPP_LOCAL_COLLECTOR_PROFILE_DIR = profileDirectory;
    process.env.PDPP_COLLECTOR_QUEUE = "   ";
    try {
      const fromEnvironment = parseArgs(["status"]);
      assert.equal(fromEnvironment.queuePath, "   ");
      assert.equal(fromEnvironment.queuePathExplicit, true);
      delete process.env.PDPP_COLLECTOR_QUEUE;
      const fromProfile = resolveInspectionOptions(parseArgs(["status", "--source-instance-id", SOURCE_A]));
      assert.equal(fromProfile.queuePath, "   ");
      assert.equal(fromProfile.queuePathExplicit, true);
    } finally {
      if (previousProfileDirectory === undefined) {
        delete process.env.PDPP_LOCAL_COLLECTOR_PROFILE_DIR;
      } else {
        process.env.PDPP_LOCAL_COLLECTOR_PROFILE_DIR = previousProfileDirectory;
      }
      if (previousQueuePath === undefined) {
        delete process.env.PDPP_COLLECTOR_QUEUE;
      } else {
        process.env.PDPP_COLLECTOR_QUEUE = previousQueuePath;
      }
    }
  });
});

test("the same source resolves to the same state across cwd and install roots", { concurrency: false }, () => {
  withTempRoot("pdpp-durable-state-stable-", (root) => {
    const stateRoot = join(root, "user-state");
    const cwdA = join(root, "worktree-a");
    const cwdB = join(root, "worktree-b");
    mkdirSync(cwdA, { recursive: true });
    mkdirSync(cwdB, { recursive: true });
    const installA = join(root, "npx-cache-a", "package");
    const installB = join(root, "global-node-modules", "package");
    const previousCwd = process.cwd();
    try {
      chdir(cwdA);
      const first = resolveCollectorQueuePath({
        connectorId: "claude_code",
        moduleUrl: modulePath(installA),
        sourceInstanceId: SOURCE_A,
        stateRoot,
      });
      chdir(cwdB);
      const second = resolveCollectorQueuePath({
        connectorId: "claude_code",
        moduleUrl: modulePath(installB),
        sourceInstanceId: SOURCE_A,
        stateRoot,
      });

      assert.equal(first, second);
      assert.equal(
        first,
        canonicalCollectorQueuePath({ connectorId: "claude_code", sourceInstanceId: SOURCE_A, stateRoot })
      );
      assert.ok(first.startsWith(collectorStateDirectory(stateRoot)));
      assert.ok(!first.startsWith(installA));
      assert.ok(!first.startsWith(installB));
      assert.ok(!first.startsWith(cwdA));
      assert.ok(!first.startsWith(cwdB));
      assert.notEqual(
        first,
        canonicalCollectorQueuePath({ connectorId: "claude_code", sourceInstanceId: SOURCE_B, stateRoot })
      );
    } finally {
      chdir(previousCwd);
    }
  });
});

test("an explicit queue path wins before legacy discovery, including ambiguous stores", () => {
  withTempRoot("pdpp-durable-state-explicit-", (root) => {
    const stateRoot = join(root, "user-state");
    const legacyA = join(root, "legacy-a");
    const legacyB = join(root, "legacy-b");
    const explicitPath = join(root, "operator-owned", "queue.sqlite");
    seedOutbox(join(legacyA, "a.sqlite"), SOURCE_A);
    seedOutbox(join(legacyB, "b.sqlite"), SOURCE_A);

    const resolved = resolveCollectorQueuePath({
      configuredPath: explicitPath,
      configuredPathIsExplicit: true,
      connectorId: "claude_code",
      legacyRoots: [legacyA, legacyB],
      sourceInstanceId: SOURCE_A,
      stateRoot,
    });

    assert.equal(resolved, explicitPath);
    assert.equal(
      existsSync(canonicalCollectorQueuePath({ connectorId: "claude_code", sourceInstanceId: SOURCE_A, stateRoot })),
      false
    );
    assert.equal(sourceSummary(join(legacyA, "a.sqlite"), SOURCE_A), 1);
    assert.equal(sourceSummary(join(legacyB, "b.sqlite"), SOURCE_A), 1);
  });
});

test("an explicit environment queue path remains ahead of a saved profile queue", { concurrency: false }, () => {
  withTempRoot("pdpp-durable-state-profile-precedence-", (root) => {
    const profileDirectory = join(root, "profiles");
    const profileQueuePath = join(root, "profile.sqlite");
    const explicitQueuePath = join(root, "explicit.sqlite");
    mkdirSync(profileDirectory, { recursive: true });
    writeFileSync(
      join(profileDirectory, "profile.env"),
      `PDPP_CONNECTION_ID=${SOURCE_A}\nPDPP_COLLECTOR_QUEUE=${profileQueuePath}\n`
    );
    const previousProfileDirectory = process.env.PDPP_LOCAL_COLLECTOR_PROFILE_DIR;
    const previousQueuePath = process.env.PDPP_COLLECTOR_QUEUE;
    process.env.PDPP_LOCAL_COLLECTOR_PROFILE_DIR = profileDirectory;
    process.env.PDPP_COLLECTOR_QUEUE = explicitQueuePath;
    try {
      for (const command of ["status", "doctor", "retry-dead-letters", "prune-sent", "compact"] as const) {
        const options = resolveInspectionOptions(parseArgs([command, "--source-instance-id", SOURCE_A]));
        assert.equal(options.queuePath, explicitQueuePath);
        assert.equal(options.queuePathExplicit, true);
      }
    } finally {
      if (previousProfileDirectory === undefined) {
        delete process.env.PDPP_LOCAL_COLLECTOR_PROFILE_DIR;
      } else {
        process.env.PDPP_LOCAL_COLLECTOR_PROFILE_DIR = previousProfileDirectory;
      }
      if (previousQueuePath === undefined) {
        delete process.env.PDPP_COLLECTOR_QUEUE;
      } else {
        process.env.PDPP_COLLECTOR_QUEUE = previousQueuePath;
      }
    }
  });
});

test("a unique legacy stable-state store remains discoverable in place and stays source-isolated", () => {
  withTempRoot("pdpp-durable-state-legacy-", (root) => {
    const stateRoot = join(root, "user-state");
    const stableDirectory = collectorStateDirectory(stateRoot);
    const legacyA = join(stableDirectory, "legacy-a.sqlite");
    const legacyB = join(stableDirectory, "legacy-b.sqlite");
    seedOutbox(legacyA, SOURCE_A);
    seedOutbox(legacyB, SOURCE_B);

    const resolvedA = resolveCollectorQueuePath({
      connectorId: "claude_code",
      moduleUrl: modulePath(join(root, "install")),
      sourceInstanceId: SOURCE_A,
      stateRoot,
    });
    const resolvedB = resolveCollectorQueuePath({
      connectorId: "codex",
      moduleUrl: modulePath(join(root, "install")),
      sourceInstanceId: SOURCE_B,
      stateRoot,
    });

    assert.equal(resolvedA, legacyA);
    assert.equal(resolvedB, legacyB);
    assert.equal(sourceSummary(resolvedA, SOURCE_A), 1);
    assert.equal(sourceSummary(resolvedB, SOURCE_B), 1);
    assert.equal(sourceSummary(resolvedA, SOURCE_B), 0);
    assert.equal(sourceSummary(resolvedB, SOURCE_A), 0);
  });
});

test("a unique package-local legacy store is handed off atomically without deleting the old pathname", () => {
  withTempRoot("pdpp-durable-state-migrate-", (root) => {
    const stateRoot = join(root, "user-state");
    const installRoot = join(root, "npx-temp-package");
    const legacyPath = packageLegacyPath(installRoot, "collector-runner-queue.sqlite");
    const canonicalPath = canonicalCollectorQueuePath({
      connectorId: "claude_code",
      sourceInstanceId: SOURCE_A,
      stateRoot,
    });
    seedOutbox(legacyPath, SOURCE_A);

    const resolved = resolveCollectorQueuePath({
      connectorId: "claude_code",
      moduleUrl: modulePath(installRoot),
      sourceInstanceId: SOURCE_A,
      stateRoot,
    });

    assert.equal(resolved, canonicalPath);
    assert.equal(existsSync(legacyPath), true);
    assert.equal(existsSync(canonicalPath), true);
    assert.equal(sourceSummary(legacyPath, SOURCE_A), 1);
    assert.equal(sourceSummary(canonicalPath, SOURCE_A), 1);
    assert.equal(readFileSync(canonicalPath, { encoding: "utf8" }).startsWith("SQLite format 3"), true);
  });
});

test("migration reconciles a legacy write that lands after the snapshot", () => {
  withTempRoot("pdpp-durable-state-reconcile-", (root) => {
    const stateRoot = join(root, "user-state");
    const installRoot = join(root, "npx-temp-package");
    const legacyPath = packageLegacyPath(installRoot, "collector-runner-queue.sqlite");
    const canonicalPath = canonicalCollectorQueuePath({
      connectorId: "claude_code",
      sourceInstanceId: SOURCE_A,
      stateRoot,
    });
    seedOutbox(legacyPath, SOURCE_A, "before-snapshot");

    const resolved = resolveCollectorQueuePath({
      connectorId: "claude_code",
      moduleUrl: modulePath(installRoot),
      sourceInstanceId: SOURCE_A,
      stateRoot,
      beforeMigrationReconcile: () => seedOutbox(legacyPath, SOURCE_A, "after-snapshot"),
    });

    assert.equal(resolved, canonicalPath);
    assert.equal(sourceSummary(canonicalPath, SOURCE_A), 2);
  });
});

test("migration retires a live WAL legacy writer before canonical installation", () => {
  withTempRoot("pdpp-durable-state-handoff-", (root) => {
    const stateRoot = join(root, "user-state");
    const installRoot = join(root, "npx-temp-package");
    const legacyPath = packageLegacyPath(installRoot, "collector-runner-queue.sqlite");
    const canonicalPath = canonicalCollectorQueuePath({
      connectorId: "claude_code",
      sourceInstanceId: SOURCE_A,
      stateRoot,
    });
    const liveLegacyWriter = new LocalDeviceOutbox({ path: legacyPath });
    liveLegacyWriter.enqueue({
      id: "before-handoff",
      kind: "record_batch",
      payload: { source: SOURCE_A },
      sourceInstanceId: SOURCE_A,
    });
    assert.equal(existsSync(`${legacyPath}-wal`), true);

    try {
      let canonicalWriter: LocalDeviceOutbox | undefined;
      const resolved = resolveCollectorQueuePath({
        connectorId: "claude_code",
        moduleUrl: modulePath(installRoot),
        sourceInstanceId: SOURCE_A,
        stateRoot,
        afterMigrationInstall: () => {
          canonicalWriter = new LocalDeviceOutbox({ path: canonicalPath });
          canonicalWriter.enqueue({
            id: "canonical-during-handoff",
            kind: "record_batch",
            payload: { source: SOURCE_A },
            sourceInstanceId: SOURCE_A,
          });
          assert.throws(() =>
            liveLegacyWriter.enqueue({
              id: "after-canonical-install",
              kind: "record_batch",
              payload: { source: SOURCE_A },
              sourceInstanceId: SOURCE_A,
            })
          );
        },
      });

      assert.equal(resolved, canonicalPath);
      assert.equal(sourceSummary(canonicalPath, SOURCE_A), 2);
      assert.equal(sourceSummary(legacyPath, SOURCE_A), 1);
      assert.notEqual(statSync(legacyPath).ino, statSync(canonicalPath).ino);
      canonicalWriter?.close();
    } finally {
      liveLegacyWriter.close();
    }
  });
});

test("restart completes a handoff after failure between retirement and canonical install", () => {
  withTempRoot("pdpp-durable-state-crash-restart-", (root) => {
    const stateRoot = join(root, "user-state");
    const installRoot = join(root, "npx-temp-package");
    const legacyPath = packageLegacyPath(installRoot, "collector-runner-queue.sqlite");
    const canonicalPath = canonicalCollectorQueuePath({
      connectorId: "claude_code",
      sourceInstanceId: SOURCE_A,
      stateRoot,
    });
    seedOutbox(legacyPath, SOURCE_A, "before-crash");

    assert.throws(() =>
      resolveCollectorQueuePath({
        connectorId: "claude_code",
        moduleUrl: modulePath(installRoot),
        sourceInstanceId: SOURCE_A,
        stateRoot,
        afterRetirementFence: () => {
          throw new Error("simulated crash after durable retirement");
        },
      })
    );
    assert.equal(existsSync(canonicalPath), false);
    assert.equal(existsSync(legacyPath), true);

    const restarted = resolveCollectorQueuePath({
      connectorId: "claude_code",
      moduleUrl: modulePath(installRoot),
      sourceInstanceId: SOURCE_A,
      stateRoot,
    });
    assert.equal(restarted, canonicalPath);
    assert.equal(sourceSummary(canonicalPath, SOURCE_A), 1);
    assert.equal(sourceSummary(legacyPath, SOURCE_A), 1);
  });
});

/**
 * Two writable scratch directories on different filesystems, or undefined when
 * the host offers only one. The cross-filesystem test needs real devices; a
 * mocked stat would not exercise the rename and VACUUM paths.
 */
function twoFilesystemRoots(): [string, string] | undefined {
  const created: Array<{ dev: number | bigint; root: string }> = [];
  const candidates = [tmpdir(), homedir(), "/dev/shm", process.env.XDG_RUNTIME_DIR, "/var/tmp"];
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    try {
      const root = mkdtempSync(join(candidate, "pdpp-durable-state-fs-"));
      created.push({ dev: statSync(root).dev, root });
    } catch {
      // An unwritable candidate is simply not a usable filesystem.
    }
  }
  const first = created[0];
  const second = first ? created.find((entry) => entry.dev !== first.dev) : undefined;
  for (const entry of created) {
    if (entry !== first && entry !== second) {
      rmSync(entry.root, { force: true, recursive: true });
    }
  }
  return first && second ? [first.root, second.root] : undefined;
}

test("migration succeeds when the legacy store and canonical state are on different filesystems", (t) => {
  const roots = twoFilesystemRoots();
  if (!roots) {
    t.skip("no second filesystem available");
    return;
  }
  const [legacyFilesystemRoot, stateFilesystemRoot] = roots;
  try {
    const installRoot = join(legacyFilesystemRoot, "npx-temp-package");
    const legacyPath = packageLegacyPath(installRoot, "collector-runner-queue.sqlite");
    seedOutbox(legacyPath, SOURCE_A, "pending-before-upgrade");
    assert.notEqual(statSync(installRoot).dev, statSync(stateFilesystemRoot).dev);

    const canonicalPath = canonicalCollectorQueuePath({
      connectorId: "claude_code",
      sourceInstanceId: SOURCE_A,
      stateRoot: stateFilesystemRoot,
    });
    const resolved = resolveCollectorQueuePath({
      connectorId: "claude_code",
      moduleUrl: modulePath(installRoot),
      sourceInstanceId: SOURCE_A,
      stateRoot: stateFilesystemRoot,
    });

    assert.equal(resolved, canonicalPath);
    assert.equal(existsSync(legacyPath), true);
    assert.deepEqual(outboxIds(canonicalPath, SOURCE_A), ["pending-before-upgrade"]);
    assert.deepEqual(outboxIds(legacyPath, SOURCE_A), ["pending-before-upgrade"]);
  } finally {
    rmSync(legacyFilesystemRoot, { force: true, recursive: true });
    rmSync(stateFilesystemRoot, { force: true, recursive: true });
  }
});

test("a canonical queue created during migration aborts the handoff before the legacy writer is retired", () => {
  withTempRoot("pdpp-durable-state-concurrent-", (root) => {
    const stateRoot = join(root, "user-state");
    const installRoot = join(root, "npx-temp-package");
    const legacyPath = packageLegacyPath(installRoot, "collector-runner-queue.sqlite");
    const canonicalPath = canonicalCollectorQueuePath({
      connectorId: "claude_code",
      sourceInstanceId: SOURCE_A,
      stateRoot,
    });
    seedOutbox(legacyPath, SOURCE_A, "pending-before-upgrade");

    const first = captureStderr(() =>
      resolveCollectorQueuePath({
        connectorId: "claude_code",
        moduleUrl: modulePath(installRoot),
        sourceInstanceId: SOURCE_A,
        stateRoot,
        beforeMigrationReconcile: () => seedOutbox(canonicalPath, SOURCE_A, "concurrent-new-run"),
      })
    );
    assert.equal(first.result, canonicalPath);
    assertBacklogWarning(first.stderr, legacyPath, canonicalPath, 1);

    // The legacy writer was not retired: it still accepts work.
    seedOutbox(legacyPath, SOURCE_A, "legacy-write-after-abort");
    assert.deepEqual(outboxIds(legacyPath, SOURCE_A), ["legacy-write-after-abort", "pending-before-upgrade"]);
    // Neither side was merged into the other, and no snapshot or lock is left.
    assert.deepEqual(outboxIds(canonicalPath, SOURCE_A), ["concurrent-new-run"]);
    assert.deepEqual(
      readdirSync(dirname(canonicalPath)).filter((name) => /\.migration-|\.handoff\.lock$/.test(name)),
      []
    );

    // The backlog is not forgotten once the canonical file exists: every resolution warns.
    const second = captureStderr(() =>
      resolveCollectorQueuePath({
        connectorId: "claude_code",
        moduleUrl: modulePath(installRoot),
        sourceInstanceId: SOURCE_A,
        stateRoot,
      })
    );
    assert.equal(second.result, canonicalPath);
    assertBacklogWarning(second.stderr, legacyPath, canonicalPath, 2);
  });
});

test("a canonical queue with unrelated content is not treated as a completed migration", () => {
  withTempRoot("pdpp-durable-state-unrelated-canonical-", (root) => {
    const stateRoot = join(root, "user-state");
    const installRoot = join(root, "npx-temp-package");
    const legacyPath = packageLegacyPath(installRoot, "collector-runner-queue.sqlite");
    const canonicalPath = canonicalCollectorQueuePath({
      connectorId: "claude_code",
      sourceInstanceId: SOURCE_A,
      stateRoot,
    });
    seedOutbox(legacyPath, SOURCE_A, "pending-before-upgrade");
    seedOutbox(canonicalPath, SOURCE_A, "unrelated-canonical-work");
    const resolve = () =>
      resolveCollectorQueuePath({
        connectorId: "claude_code",
        moduleUrl: modulePath(installRoot),
        sourceInstanceId: SOURCE_A,
        stateRoot,
      });

    for (let attempt = 0; attempt < 2; attempt++) {
      const { result, stderr } = captureStderr(resolve);
      assert.equal(result, canonicalPath);
      assertBacklogWarning(stderr, legacyPath, canonicalPath, 1);
    }
    assert.deepEqual(outboxIds(canonicalPath, SOURCE_A), ["unrelated-canonical-work"]);
    assert.deepEqual(outboxIds(legacyPath, SOURCE_A), ["pending-before-upgrade"]);

    // Draining the legacy backlog (the operator's remedy, via --queue) silences the warning.
    deliverLegacyBacklog(legacyPath);
    const drained = captureStderr(resolve);
    assert.equal(drained.result, canonicalPath);
    assert.equal(drained.stderr, "");
  });
});

test("a canonical path is not handed out while a live process holds its handoff lock", () => {
  withTempRoot("pdpp-durable-state-lock-", (root) => {
    const stateRoot = join(root, "user-state");
    const canonicalPath = canonicalCollectorQueuePath({
      connectorId: "claude_code",
      sourceInstanceId: SOURCE_A,
      stateRoot,
    });
    mkdirSync(dirname(canonicalPath), { recursive: true });
    const lockPath = `${canonicalPath}.handoff.lock`;
    const resolve = () =>
      resolveCollectorQueuePath({
        connectorId: "claude_code",
        moduleUrl: modulePath(join(root, "other-install")),
        sourceInstanceId: SOURCE_A,
        stateRoot,
      });

    writeFileSync(lockPath, `${process.pid}\n`);
    assert.throws(
      resolve,
      (error: unknown) => error instanceof CollectorStateResolutionError && error.code === "legacy_state_conflict"
    );
    // A lock left by a dead process does not block.
    const exited = spawnSync(process.execPath, ["-e", ""]);
    writeFileSync(lockPath, `${exited.pid}\n`);
    assert.equal(resolve(), canonicalPath);
  });
});

test("a completed migration is recognised by its retirement fence, not treated as a conflict", () => {
  withTempRoot("pdpp-durable-state-completed-", (root) => {
    const stateRoot = join(root, "user-state");
    const installRoot = join(root, "npx-temp-package");
    const legacyPath = packageLegacyPath(installRoot, "collector-runner-queue.sqlite");
    seedOutbox(legacyPath, SOURCE_A, "pending-before-upgrade");
    const resolve = () =>
      resolveCollectorQueuePath({
        connectorId: "claude_code",
        moduleUrl: modulePath(installRoot),
        sourceInstanceId: SOURCE_A,
        stateRoot,
      });

    const first = resolve();
    seedOutbox(first, SOURCE_A, "post-migration-work");

    assert.equal(resolve(), first);
    assert.deepEqual(outboxIds(first, SOURCE_A), ["pending-before-upgrade", "post-migration-work"]);
  });
});

test("migration ignores an orphaned crash artifact and restart reuses the installed canonical copy", () => {
  withTempRoot("pdpp-durable-state-restart-", (root) => {
    const stateRoot = join(root, "user-state");
    const installRoot = join(root, "reaped-npx-package");
    const legacyPath = packageLegacyPath(installRoot, "collector-runner-queue.sqlite");
    const canonicalPath = canonicalCollectorQueuePath({ connectorId: "codex", sourceInstanceId: SOURCE_B, stateRoot });
    seedOutbox(legacyPath, SOURCE_B);
    mkdirSync(collectorStateDirectory(stateRoot), { recursive: true });
    const orphanedTemporaryPath = `${canonicalPath}.migration-crashed.tmp`;
    writeFileSync(orphanedTemporaryPath, "partial snapshot");

    const first = resolveCollectorQueuePath({
      connectorId: "codex",
      moduleUrl: modulePath(installRoot),
      sourceInstanceId: SOURCE_B,
      stateRoot,
    });
    const second = resolveCollectorQueuePath({
      connectorId: "codex",
      moduleUrl: modulePath(join(root, "new-install")),
      sourceInstanceId: SOURCE_B,
      stateRoot,
    });

    assert.equal(first, canonicalPath);
    assert.equal(second, canonicalPath);
    assert.equal(existsSync(orphanedTemporaryPath), true);
    assert.equal(existsSync(legacyPath), true);
    assert.equal(sourceSummary(canonicalPath, SOURCE_B), 1);
  });
});

test("multiple nonempty legacy stores fail closed, and an empty canonical file is not allowed to hide one", () => {
  withTempRoot("pdpp-durable-state-ambiguous-", (root) => {
    const stateRoot = join(root, "user-state");
    const installRoot = join(root, "package");
    const legacyA = packageLegacyPath(installRoot, "a.sqlite");
    const legacyB = packageLegacyPath(installRoot, "b.sqlite");
    seedOutbox(legacyA, SOURCE_A);
    seedOutbox(legacyB, SOURCE_A);

    assert.throws(
      () =>
        resolveCollectorQueuePath({
          connectorId: "claude_code",
          moduleUrl: modulePath(installRoot),
          sourceInstanceId: SOURCE_A,
          stateRoot,
        }),
      (error: unknown) => error instanceof CollectorStateResolutionError && error.code === "legacy_state_ambiguous"
    );
    assert.equal(existsSync(legacyA), true);
    assert.equal(existsSync(legacyB), true);

    const canonicalPath = canonicalCollectorQueuePath({
      connectorId: "claude_code",
      sourceInstanceId: SOURCE_A,
      stateRoot,
    });
    const emptyCanonical = new LocalDeviceOutbox({ path: canonicalPath });
    emptyCanonical.close();
    assert.throws(
      () =>
        resolveCollectorQueuePath({
          connectorId: "claude_code",
          moduleUrl: modulePath(installRoot),
          sourceInstanceId: SOURCE_A,
          stateRoot,
        }),
      (error: unknown) => error instanceof CollectorStateResolutionError && error.code === "legacy_state_ambiguous"
    );
    assert.equal(existsSync(canonicalPath), true);
    assert.equal(sourceSummary(legacyA, SOURCE_A), 1);
    assert.equal(sourceSummary(legacyB, SOURCE_A), 1);
  });
});

function resolveInput(root: string, installRoot: string) {
  return {
    connectorId: "claude_code",
    moduleUrl: modulePath(installRoot),
    sourceInstanceId: SOURCE_A,
    stateRoot: join(root, "user-state"),
  };
}

/**
 * Run a migration in a child process that dies right after the retirement fence
 * commits, having first let a competing creator open the canonical queue. A real
 * exit skips every catch block, so nothing in-process can tidy the fence.
 */
function killMigrationAfterFence(
  root: string,
  installRoot: string,
  canonicalPath: string,
  competitorRows: boolean
): void {
  const scriptPath = join(root, "kill-after-fence.mts");
  writeFileSync(
    scriptPath,
    `const [durableUrl, runnerUrl, args] = process.argv.slice(2);
const durable = await import(durableUrl);
const runner = await import(runnerUrl);
const input = JSON.parse(args);
durable.resolveCollectorQueuePath({
  connectorId: input.connectorId,
  moduleUrl: input.moduleUrl,
  sourceInstanceId: input.sourceInstanceId,
  stateRoot: input.stateRoot,
  afterRetirementFence: () => {
    const competitor = new runner.LocalDeviceOutbox({ path: input.canonicalPath });
    if (input.competitorRows) {
      competitor.enqueue({
        id: "competitor-B",
        kind: "record_batch",
        payload: {},
        sourceInstanceId: input.sourceInstanceId,
      });
    }
    competitor.close();
    process.exit(86);
  },
});
`
  );
  const result = spawnSync(
    process.execPath,
    [
      scriptPath,
      new URL("../src/durable-state.ts", import.meta.url).href,
      new URL("../src/runner.ts", import.meta.url).href,
      JSON.stringify({ ...resolveInput(root, installRoot), canonicalPath, competitorRows }),
    ],
    { encoding: "utf8" }
  );
  assert.equal(result.status, 86, result.stderr);
}

test("a migration that loses publication to a competing creator lifts its fence and keeps the legacy backlog", () => {
  withTempRoot("pdpp-durable-state-lost-publication-", (root) => {
    const installRoot = join(root, "npx-temp-package");
    const legacyPath = packageLegacyPath(installRoot, "collector-runner-queue.sqlite");
    const canonicalPath = canonicalCollectorQueuePath(resolveInput(root, installRoot));
    seedOutbox(legacyPath, SOURCE_A, "pending-A");

    assert.throws(() =>
      resolveCollectorQueuePath({
        ...resolveInput(root, installRoot),
        afterRetirementFence: () => {
          seedOutbox(canonicalPath, SOURCE_A, "competitor-B");
          throw new Error("simulated failure after the fence and the competitor's canonical queue");
        },
      })
    );

    // The failed attempt did not publish, so the legacy writer must be live again.
    seedOutbox(legacyPath, SOURCE_A, "legacy-write-after-failure");
    const { result, stderr } = captureStderr(() => resolveCollectorQueuePath(resolveInput(root, installRoot)));
    assert.equal(result, canonicalPath);
    assertBacklogWarning(stderr, legacyPath, canonicalPath, 2);
    assert.deepEqual(outboxIds(legacyPath, SOURCE_A), ["legacy-write-after-failure", "pending-A"]);
  });
});

test("a fence left by a killed migration does not prove the canonical queue holds the legacy backlog", () => {
  withTempRoot("pdpp-durable-state-unproven-fence-", (root) => {
    const installRoot = join(root, "npx-temp-package");
    const legacyPath = packageLegacyPath(installRoot, "collector-runner-queue.sqlite");
    const canonicalPath = canonicalCollectorQueuePath(resolveInput(root, installRoot));
    seedOutbox(legacyPath, SOURCE_A, "pending-A");

    killMigrationAfterFence(root, installRoot, canonicalPath, true);
    assert.throws(
      () => seedOutbox(legacyPath, SOURCE_A, "while-fenced"),
      /retired/,
      "the killed migration left the fence in place"
    );

    const recovered = captureStderr(() => resolveCollectorQueuePath(resolveInput(root, installRoot)));
    assert.equal(recovered.result, canonicalPath);
    assertBacklogWarning(recovered.stderr, legacyPath, canonicalPath, 1);
    // Recovery returned the legacy store to service rather than abandoning it.
    seedOutbox(legacyPath, SOURCE_A, "legacy-write-after-recovery");
    assert.deepEqual(outboxIds(canonicalPath, SOURCE_A), ["competitor-B"]);

    // The operator's remedy (drain the legacy backlog) then silences the warning.
    deliverLegacyBacklog(legacyPath);
    const drained = captureStderr(() => resolveCollectorQueuePath(resolveInput(root, installRoot)));
    assert.equal(drained.result, canonicalPath);
    assert.equal(drained.stderr, "");
  });
});

test("a fence left by a killed migration is lifted when the competing canonical queue is empty", () => {
  withTempRoot("pdpp-durable-state-unproven-fence-empty-", (root) => {
    const installRoot = join(root, "npx-temp-package");
    const legacyPath = packageLegacyPath(installRoot, "collector-runner-queue.sqlite");
    const canonicalPath = canonicalCollectorQueuePath(resolveInput(root, installRoot));
    seedOutbox(legacyPath, SOURCE_A, "pending-A");

    killMigrationAfterFence(root, installRoot, canonicalPath, false);
    assert.throws(
      () => resolveCollectorQueuePath(resolveInput(root, installRoot)),
      (error: unknown) => error instanceof CollectorStateResolutionError && error.code === "legacy_state_ambiguous"
    );
    // --queue <legacy> is the advertised remedy, so the legacy store must accept work.
    seedOutbox(legacyPath, SOURCE_A, "legacy-write-after-recovery");
    assert.deepEqual(outboxIds(legacyPath, SOURCE_A), ["legacy-write-after-recovery", "pending-A"]);
  });
});

test("a correctly completed migration keeps its fence across restarts", () => {
  withTempRoot("pdpp-durable-state-proven-fence-", (root) => {
    const installRoot = join(root, "npx-temp-package");
    const legacyPath = packageLegacyPath(installRoot, "collector-runner-queue.sqlite");
    seedOutbox(legacyPath, SOURCE_A, "pending-A");

    const canonicalPath = resolveCollectorQueuePath(resolveInput(root, installRoot));
    assert.equal(resolveCollectorQueuePath(resolveInput(root, installRoot)), canonicalPath);
    assert.equal(resolveCollectorQueuePath(resolveInput(root, installRoot)), canonicalPath);

    assert.throws(() => seedOutbox(legacyPath, SOURCE_A, "late-legacy-write"), "the legacy store stays retired");
    assert.deepEqual(outboxIds(canonicalPath, SOURCE_A), ["pending-A"]);
  });
});

test("a filesystem without hard links fails the migration closed instead of replacing a canonical queue", () => {
  withTempRoot("pdpp-durable-state-no-hard-links-", (root) => {
    const installRoot = join(root, "npx-temp-package");
    const legacyPath = packageLegacyPath(installRoot, "collector-runner-queue.sqlite");
    const canonicalPath = canonicalCollectorQueuePath(resolveInput(root, installRoot));
    seedOutbox(legacyPath, SOURCE_A, "pending-A");

    assert.throws(
      () =>
        resolveCollectorQueuePath({
          ...resolveInput(root, installRoot),
          linkFile: () => {
            throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
          },
        }),
      (error: unknown) =>
        error instanceof CollectorStateResolutionError &&
        error.code === "legacy_state_migration_failed" &&
        error.message.includes("hard links") &&
        error.message.includes(legacyPath)
    );

    // Nothing was published by any fallback, and the legacy writer is live.
    assert.equal(existsSync(canonicalPath), false);
    seedOutbox(legacyPath, SOURCE_A, "legacy-write-after-failure");
    assert.deepEqual(
      readdirSync(dirname(canonicalPath)).filter((name) => /\.migration-|\.handoff\.lock$/.test(name)),
      []
    );

    // A filesystem that can link later completes the same migration.
    const resolved = resolveCollectorQueuePath(resolveInput(root, installRoot));
    assert.equal(resolved, canonicalPath);
    assert.deepEqual(outboxIds(canonicalPath, SOURCE_A), ["legacy-write-after-failure", "pending-A"]);
  });
});

function terminalCommit(id: string, runId: string, boundary: string) {
  return {
    id,
    kind: "terminal_run_commit" as const,
    payload: {
      collection_boundary: boundary,
      commit_id: id,
      connector_id: "claude_code",
      connector_instance_id: "cin-1",
      run_id: runId,
      state_delta: {},
      terminal_facts: [],
      version: 1,
    },
    sourceInstanceId: SOURCE_A,
  };
}

/** Claim the next ready row and either acknowledge it or dead-letter it. */
function settleNextRow(outbox: LocalDeviceOutbox, outcome: "acknowledge" | "deadLetter"): void {
  const [claimed] = outbox.claimReady({ holder: "test", leaseMs: 60_000, sourceInstanceId: SOURCE_A });
  assert.ok(claimed);
  const lease = { holder: "test", id: claimed.id, leaseEpoch: claimed.lease_epoch };
  if (outcome === "acknowledge") {
    outbox.acknowledge(lease);
  } else {
    outbox.deadLetter({ ...lease, error: "400 invalid_request" });
  }
}

/** A dead-letter terminal commit retired by an acknowledged replacement: history, not work. */
function seedSupersededTerminalHistory(path: string): void {
  const outbox = new LocalDeviceOutbox({ path });
  try {
    outbox.enqueue(terminalCommit("old-terminal", "run-old", "scope-1"));
    settleNextRow(outbox, "deadLetter");
    outbox.enqueue(terminalCommit("new-terminal", "run-new", "scope-1"));
    settleNextRow(outbox, "acknowledge");
    assert.equal(
      outbox.retireDeadLetteredTerminalCommits({
        collectionBoundary: "scope-1",
        connectorId: "claude_code",
        connectorInstanceId: "cin-1",
        replacementId: "new-terminal",
        sourceInstanceId: SOURCE_A,
      }),
      1
    );
    assert.equal(outbox.get("old-terminal")?.status, "dead_letter", "superseded evidence is retained");
  } finally {
    outbox.close();
  }
}

test("superseded terminal history in a legacy store is not pending work", () => {
  withTempRoot("pdpp-durable-state-superseded-", (root) => {
    const installRoot = join(root, "npx-temp-package");
    const legacyPath = packageLegacyPath(installRoot, "collector-runner-queue.sqlite");
    const canonicalPath = canonicalCollectorQueuePath(resolveInput(root, installRoot));
    seedSupersededTerminalHistory(legacyPath);
    seedOutbox(canonicalPath, SOURCE_A, "canonical-work");

    assert.equal(resolveCollectorQueuePath(resolveInput(root, installRoot)), canonicalPath);

    // A dead-letter terminal commit that nothing superseded is still undelivered work.
    const reopened = new LocalDeviceOutbox({ path: legacyPath });
    try {
      reopened.enqueue(terminalCommit("other-terminal", "run-other", "scope-2"));
      settleNextRow(reopened, "deadLetter");
    } finally {
      reopened.close();
    }
    const { result, stderr } = captureStderr(() => resolveCollectorQueuePath(resolveInput(root, installRoot)));
    assert.equal(result, canonicalPath);
    assertBacklogWarning(stderr, legacyPath, canonicalPath, 1);
  });
});

function assertLegacyWritable(legacyPath: string): void {
  // A retired source rejects writes through the trigger fence.
  seedOutbox(legacyPath, SOURCE_A, "legacy-write-after-race");
}

/** Run `fn` while capturing what it writes to stderr. */
function captureStderr<T>(fn: () => T): { result: T; stderr: string } {
  const original = process.stderr.write;
  let stderr = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    return { result: fn(), stderr };
  } finally {
    process.stderr.write = original;
  }
}

/** Assert the backlog warning names both paths, the pending count and the --queue remedy. */
function assertBacklogWarning(stderr: string, legacyPath: string, canonicalPath: string, pending: number): void {
  assert.ok(stderr.includes("warning:"), `a warning is written: ${stderr}`);
  assert.ok(stderr.includes(legacyPath), "warning names the legacy path");
  assert.ok(stderr.includes(canonicalPath), "warning names the canonical path");
  assert.ok(stderr.includes(`${pending} pending row(s)`), `warning counts ${pending} pending rows: ${stderr}`);
  assert.ok(stderr.includes(`--queue ${legacyPath}`), "warning says --queue delivers them");
}

/** Deliver every ready legacy row the way the operator's `--queue <legacy>` run would. */
function deliverLegacyBacklog(legacyPath: string): void {
  const legacyOutbox = new LocalDeviceOutbox({ path: legacyPath });
  try {
    for (const claimed of legacyOutbox.claimReady({
      holder: "operator",
      leaseMs: 60_000,
      limit: 100,
      sourceInstanceId: SOURCE_A,
    })) {
      legacyOutbox.acknowledge({ holder: "operator", id: claimed.id, leaseEpoch: claimed.lease_epoch });
    }
  } finally {
    legacyOutbox.close();
  }
}

/**
 * Shared checks for a canonical queue that exists next to a legacy backlog: the
 * canonical path is returned, nothing is merged or fenced, every resolution warns
 * while rows remain, and delivering them silences the warning.
 */
function assertKeepsRunningOnCanonical(
  root: string,
  installRoot: string,
  legacyPath: string,
  canonicalPath: string,
  legacyIdsBefore: string[]
): void {
  const resolve = () => resolveCollectorQueuePath(resolveInput(root, installRoot));
  const pending = legacyIdsBefore.length;

  // Legacy rows survive and the legacy store is not fenced.
  assert.deepEqual(outboxIds(legacyPath, SOURCE_A), legacyIdsBefore);
  seedOutbox(legacyPath, SOURCE_A, "legacy-write-after-resolve");
  const legacyIds = [...legacyIdsBefore, "legacy-write-after-resolve"].sort();
  assert.deepEqual(outboxIds(legacyPath, SOURCE_A), legacyIds);
  assert.deepEqual(
    readdirSync(dirname(canonicalPath)).filter((name) => /\.migration-|\.handoff\.lock$/.test(name)),
    []
  );

  // Every resolution returns the canonical path and warns again.
  for (let attempt = 0; attempt < 2; attempt++) {
    const { result, stderr } = captureStderr(resolve);
    assert.equal(result, canonicalPath);
    assertBacklogWarning(stderr, legacyPath, canonicalPath, pending + 1);
  }

  // Once the legacy pending rows are delivered, resolution is silent.
  deliverLegacyBacklog(legacyPath);
  const { result, stderr } = captureStderr(resolve);
  assert.equal(result, canonicalPath);
  assert.equal(stderr, "");
}

// Ported from #584 ("keep the legacy queue writable when a canonical queue already
// exists"), improved: the warning repeats on every resolution while the legacy
// store still has pending rows.
for (const [label, hookName] of [
  ["before reconcile", "beforeMigrationReconcile"],
  ["after the retirement fence commits", "afterRetirementFence"],
] as const) {
  test(`a canonical queue that appears mid-migration (${label}) keeps the collector on the canonical queue and warns while the legacy backlog remains`, () => {
    withTempRoot("pdpp-durable-state-race-", (root) => {
      const installRoot = join(root, "npx-temp-package");
      const legacyPath = packageLegacyPath(installRoot, "collector-runner-queue.sqlite");
      const canonicalPath = canonicalCollectorQueuePath(resolveInput(root, installRoot));
      seedOutbox(legacyPath, SOURCE_A, "legacy-pending");

      const { result, stderr } = captureStderr(() =>
        resolveCollectorQueuePath({
          ...resolveInput(root, installRoot),
          [hookName]: () => seedOutbox(canonicalPath, SOURCE_A, "canonical-from-other-process"),
        })
      );

      assert.equal(result, canonicalPath);
      assertBacklogWarning(stderr, legacyPath, canonicalPath, 1);
      assert.deepEqual(outboxIds(canonicalPath, SOURCE_A), ["canonical-from-other-process"]);
      assertKeepsRunningOnCanonical(root, installRoot, legacyPath, canonicalPath, ["legacy-pending"]);
      assert.deepEqual(outboxIds(canonicalPath, SOURCE_A), ["canonical-from-other-process"]);
    });
  });
}

test("a fence left by a crashed attempt is lifted, then a canonical queue that appears keeps the collector on it with a warning", () => {
  withTempRoot("pdpp-durable-state-stale-fence-", (root) => {
    const installRoot = join(root, "npx-temp-package");
    const legacyPath = packageLegacyPath(installRoot, "collector-runner-queue.sqlite");
    const canonicalPath = canonicalCollectorQueuePath(resolveInput(root, installRoot));
    seedOutbox(legacyPath, SOURCE_A, "legacy-pending");
    assert.throws(() =>
      resolveCollectorQueuePath({
        ...resolveInput(root, installRoot),
        afterRetirementFence: () => {
          throw new Error("simulated crash after durable retirement");
        },
      })
    );

    // The crashed attempt cleaned up its own fence.
    assertLegacyWritable(legacyPath);

    const { result, stderr } = captureStderr(() =>
      resolveCollectorQueuePath({
        ...resolveInput(root, installRoot),
        beforeMigrationReconcile: () => seedOutbox(canonicalPath, SOURCE_A, "canonical-from-other-process"),
      })
    );
    assert.equal(result, canonicalPath);
    assertBacklogWarning(stderr, legacyPath, canonicalPath, 2);
    assertKeepsRunningOnCanonical(root, installRoot, legacyPath, canonicalPath, [
      "legacy-pending",
      "legacy-write-after-race",
    ]);
    assert.deepEqual(outboxIds(canonicalPath, SOURCE_A), ["canonical-from-other-process"]);
  });
});

function migrationMarkers(path: string): string[] {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db
      .prepare("SELECT migration_id FROM pdpp_migration_marker WHERE source_instance_id = ?")
      .all(SOURCE_A)
      .map((row) => String(row.migration_id));
  } finally {
    db.close();
  }
}

test("a migrated queue whose rows were all delivered and pruned is still recognised as migrated", () => {
  withTempRoot("pdpp-durable-state-pruned-", (root) => {
    const installRoot = join(root, "npx-temp-package");
    const legacyPath = packageLegacyPath(installRoot, "collector-runner-queue.sqlite");
    seedOutbox(legacyPath, SOURCE_A, "pending-A");

    const canonicalPath = resolveCollectorQueuePath(resolveInput(root, installRoot));
    const [marker] = migrationMarkers(canonicalPath);
    assert.ok(marker);

    // Ordinary operation: every upload succeeds, then the sent rows are pruned
    // and the file is compacted.
    // Acknowledge under a past clock so the sent rows are older than the prune
    // cutoff deterministically rather than by elapsed milliseconds.
    const claimer = new LocalDeviceOutbox({ path: canonicalPath });
    const acknowledger = new LocalDeviceOutbox({
      clock: () => new Date("2020-01-01T00:00:00.000Z"),
      path: canonicalPath,
    });
    try {
      for (const claimed of claimer.claimReady({
        holder: "collector",
        leaseMs: 60_000,
        limit: 10,
        sourceInstanceId: SOURCE_A,
      })) {
        acknowledger.acknowledge({ holder: "collector", id: claimed.id, leaseEpoch: claimed.lease_epoch });
      }
    } finally {
      claimer.close();
      acknowledger.close();
    }
    const pruned = pruneSentOutboxRows(
      parseArgs([
        "prune-sent",
        "--queue",
        canonicalPath,
        "--connection-id",
        SOURCE_A,
        "--older-than-days",
        "0",
        "--apply",
      ])
    );
    assert.equal(pruned.pruned, 1);
    const compacted = compactOutbox(
      parseArgs(["compact", "--queue", canonicalPath, "--connection-id", SOURCE_A, "--apply"])
    );
    assert.equal(compacted.refused, false);
    assert.deepEqual(outboxIds(canonicalPath, SOURCE_A), []);
    assert.deepEqual(migrationMarkers(canonicalPath), [marker], "prune-sent and compact keep the marker");

    assert.equal(resolveCollectorQueuePath(resolveInput(root, installRoot)), canonicalPath);
  });
});

test("an empty canonical queue without a matching migration marker still fails closed", () => {
  withTempRoot("pdpp-durable-state-empty-unmarked-", (root) => {
    const installRoot = join(root, "npx-temp-package");
    const legacyPath = packageLegacyPath(installRoot, "collector-runner-queue.sqlite");
    const canonicalPath = canonicalCollectorQueuePath(resolveInput(root, installRoot));
    seedOutbox(legacyPath, SOURCE_A, "pending-A");
    new LocalDeviceOutbox({ path: canonicalPath }).close();
    const ambiguous = (error: unknown) =>
      error instanceof CollectorStateResolutionError && error.code === "legacy_state_ambiguous";

    assert.throws(() => resolveCollectorQueuePath(resolveInput(root, installRoot)), ambiguous);

    // A marker that belongs to some other attempt proves nothing either.
    const db = new DatabaseSync(canonicalPath);
    try {
      db.exec(
        `CREATE TABLE pdpp_migration_marker (source_instance_id TEXT PRIMARY KEY, migration_id TEXT NOT NULL);
         INSERT INTO pdpp_migration_marker VALUES ('${SOURCE_A}', 'some-other-attempt')`
      );
    } finally {
      db.close();
    }
    assert.throws(() => resolveCollectorQueuePath(resolveInput(root, installRoot)), ambiguous);
    assert.deepEqual(outboxIds(legacyPath, SOURCE_A), ["pending-A"]);
  });
});

/** Requests that name a different canonical destination for the same source and legacy store. */
const DIFFERENT_DESTINATIONS = [
  { name: "another connector id", change: () => ({ connectorId: "codex" }) },
  { name: "another state root", change: (root: string) => ({ stateRoot: join(root, "other-state") }) },
] as const;

function isConflict(error: unknown): boolean {
  return error instanceof CollectorStateResolutionError && error.code === "legacy_state_conflict";
}

for (const destination of DIFFERENT_DESTINATIONS) {
  for (const competitorExists of [true, false]) {
    test(`a completed migration's fence is not lifted by a request with ${destination.name} (competing queue: ${competitorExists})`, () => {
      withTempRoot("pdpp-durable-state-foreign-fence-", (root) => {
        const installRoot = join(root, "npx-temp-package");
        const legacyPath = packageLegacyPath(installRoot, "collector-runner-queue.sqlite");
        const base = resolveInput(root, installRoot);
        const other = { ...base, ...destination.change(root) };
        const otherPath = canonicalCollectorQueuePath(other);
        seedOutbox(legacyPath, SOURCE_A, "pending-A");
        const canonicalPath = resolveCollectorQueuePath(base);
        if (competitorExists) {
          seedOutbox(otherPath, SOURCE_A, "competitor-B");
        }

        // Either refusal is safe; when the request is judged against the fence, the
        // error names both destinations. Another connector's queue in the same state
        // directory can instead make the request ambiguous before the fence is read.
        assert.throws(
          () => resolveCollectorQueuePath(other),
          (error: unknown) =>
            error instanceof CollectorStateResolutionError &&
            (error.code === "legacy_state_ambiguous" ||
              (error.code === "legacy_state_conflict" &&
                error.message.includes(canonicalPath) &&
                error.message.includes(otherPath)))
        );

        // The fence still points at the live destination: the legacy store stays retired.
        assert.throws(() => seedOutbox(legacyPath, SOURCE_A, "late-legacy-write"), /retired/);
        assert.equal(resolveCollectorQueuePath(base), canonicalPath);
        assert.deepEqual(outboxIds(canonicalPath, SOURCE_A), ["pending-A"]);
      });
    });

    test(`an in-flight migration's fence is not lifted by a request with ${destination.name} (competing queue: ${competitorExists})`, () => {
      withTempRoot("pdpp-durable-state-foreign-in-flight-", (root) => {
        const installRoot = join(root, "npx-temp-package");
        const legacyPath = packageLegacyPath(installRoot, "collector-runner-queue.sqlite");
        const base = resolveInput(root, installRoot);
        const other = { ...base, ...destination.change(root) };
        const otherPath = canonicalCollectorQueuePath(other);
        seedOutbox(legacyPath, SOURCE_A, "pending-A");

        let concurrentOutcome: unknown = "resolved";
        const canonicalPath = resolveCollectorQueuePath({
          ...base,
          afterRetirementFence: () => {
            if (competitorExists) {
              seedOutbox(otherPath, SOURCE_A, "competitor-B");
            }
            try {
              concurrentOutcome = resolveCollectorQueuePath(other);
            } catch (error) {
              concurrentOutcome = error;
            }
          },
        });

        assert.ok(
          isConflict(concurrentOutcome),
          `the concurrent request was refused, got ${String(concurrentOutcome)}`
        );
        assert.equal(existsSync(canonicalPath), true);
        assert.throws(() => seedOutbox(legacyPath, SOURCE_A, "late-legacy-write"), /retired/);
        assert.deepEqual(outboxIds(canonicalPath, SOURCE_A), ["pending-A"]);
        if (!competitorExists) {
          assert.equal(existsSync(otherPath), false, "no second snapshot was published");
        }
      });
    });
  }
}

test("an empty canonical queue does not block a legacy store whose work is all delivered", () => {
  withTempRoot("pdpp-durable-state-empty-drained-", (root) => {
    const installRoot = join(root, "npx-temp-package");
    const legacyPath = packageLegacyPath(installRoot, "collector-runner-queue.sqlite");
    const canonicalPath = canonicalCollectorQueuePath(resolveInput(root, installRoot));
    seedOutbox(legacyPath, SOURCE_A, "delivered-A");
    const legacy = new LocalDeviceOutbox({ path: legacyPath });
    try {
      settleNextRow(legacy, "acknowledge");
    } finally {
      legacy.close();
    }
    new LocalDeviceOutbox({ path: canonicalPath }).close();

    assert.equal(resolveCollectorQueuePath(resolveInput(root, installRoot)), canonicalPath);
  });
});

test("an empty canonical queue does not block a legacy store holding only superseded terminal history", () => {
  withTempRoot("pdpp-durable-state-empty-superseded-", (root) => {
    const installRoot = join(root, "npx-temp-package");
    const legacyPath = packageLegacyPath(installRoot, "collector-runner-queue.sqlite");
    const canonicalPath = canonicalCollectorQueuePath(resolveInput(root, installRoot));
    seedSupersededTerminalHistory(legacyPath);
    new LocalDeviceOutbox({ path: canonicalPath }).close();

    assert.equal(resolveCollectorQueuePath(resolveInput(root, installRoot)), canonicalPath);
  });
});

function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function waitUntil(predicate: () => boolean, milliseconds: number): boolean {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    sleepSync(10);
  }
  return predicate();
}

/** The destinations recorded by retirement fences in a legacy store. */
function fenceDestinations(legacyPath: string): string[] {
  const db = new DatabaseSync(legacyPath, { readOnly: true });
  try {
    return db
      .prepare("SELECT canonical_path FROM pdpp_legacy_retirements WHERE source_instance_id = ?")
      .all(SOURCE_A)
      .map((row) => String(row.canonical_path));
  } finally {
    db.close();
  }
}

interface PausedMigration {
  /** Let the paused migration publish, and wait for its process to exit. */
  finish(): Promise<void>;
}

/**
 * Start a real migrator in a child process that stops right after its retirement
 * fence commits (holding its handoff lock) until released. Returns once the child
 * is paused, so the parent can schedule work against a genuinely in-flight owner.
 */
function startPausedMigration(root: string, input: ReturnType<typeof resolveInput>, name: string): PausedMigration {
  const readyPath = join(root, `${name}.ready`);
  const goPath = join(root, `${name}.go`);
  const scriptPath = join(root, `${name}.mts`);
  writeFileSync(
    scriptPath,
    `import { existsSync, writeFileSync } from "node:fs";
const [durableUrl, args] = process.argv.slice(2);
const durable = await import(durableUrl);
const input = JSON.parse(args);
try {
  durable.resolveCollectorQueuePath({
    connectorId: input.connectorId,
    moduleUrl: input.moduleUrl,
    sourceInstanceId: input.sourceInstanceId,
    stateRoot: input.stateRoot,
    afterRetirementFence: () => {
      writeFileSync(input.readyPath, "ready");
      while (!existsSync(input.goPath)) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    },
  });
} catch (error) {
  console.error(String(error));
  process.exit(1);
}
`
  );
  const child = spawn(
    process.execPath,
    [
      scriptPath,
      new URL("../src/durable-state.ts", import.meta.url).href,
      JSON.stringify({ ...input, goPath, readyPath }),
    ],
    { stdio: ["ignore", "ignore", "pipe"] }
  );
  pausedChildren.add(child);
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const exited = new Promise<number | null>((resolve) =>
    child.on("exit", (code) => {
      pausedChildren.delete(child);
      resolve(code);
    })
  );
  const paused = waitUntil(() => existsSync(readyPath) || child.exitCode !== null, 10_000) && existsSync(readyPath);
  assert.equal(paused, true, `the child migrator never paused after its fence: ${stderr}`);
  return {
    async finish() {
      writeFileSync(goPath, "go");
      assert.equal(await exited, 0, stderr);
    },
  };
}

for (const destination of DIFFERENT_DESTINATIONS) {
  test(`a migration cannot replace the fence of a migration with ${destination.name} that completed before it reconciled`, () => {
    withTempRoot("pdpp-durable-state-race-completed-", (root) => {
      const installRoot = join(root, "npx-temp-package");
      const legacyPath = packageLegacyPath(installRoot, "collector-runner-queue.sqlite");
      const base = resolveInput(root, installRoot);
      const other = { ...base, ...destination.change(root) };
      const canonicalPath = canonicalCollectorQueuePath(base);
      const otherPath = canonicalCollectorQueuePath(other);
      seedOutbox(legacyPath, SOURCE_A, "pending-A");

      // The other destination migrates the same legacy store after this attempt's
      // snapshot but before it takes the legacy write lock.
      let otherResolved: string | undefined;
      assert.throws(
        () =>
          resolveCollectorQueuePath({
            ...base,
            beforeMigrationReconcile: () => {
              otherResolved = resolveCollectorQueuePath(other);
            },
          }),
        (error: unknown) =>
          isConflict(error) &&
          (error as Error).message.includes(canonicalPath) &&
          (error as Error).message.includes(otherPath)
      );

      assert.equal(otherResolved, otherPath);
      assert.equal(existsSync(canonicalPath), false, "the losing attempt published nothing");
      assert.deepEqual(fenceDestinations(legacyPath), [otherPath]);
      assert.throws(() => seedOutbox(legacyPath, SOURCE_A, "late-legacy-write"), /retired/);
      assert.deepEqual(outboxIds(otherPath, SOURCE_A), ["pending-A"]);
    });
  });

  test(`a migration cannot replace the fence of an in-flight migration with ${destination.name} that began before it reconciled`, async () => {
    await withTempRootAsync("pdpp-durable-state-race-in-flight-", async (root) => {
      const installRoot = join(root, "npx-temp-package");
      const legacyPath = packageLegacyPath(installRoot, "collector-runner-queue.sqlite");
      const base = resolveInput(root, installRoot);
      const other = { ...base, ...destination.change(root) };
      const canonicalPath = canonicalCollectorQueuePath(base);
      const otherPath = canonicalCollectorQueuePath(other);
      seedOutbox(legacyPath, SOURCE_A, "pending-A");

      let paused: PausedMigration | undefined;
      assert.throws(
        () =>
          resolveCollectorQueuePath({
            ...base,
            beforeMigrationReconcile: () => {
              paused = startPausedMigration(root, other, "other");
            },
          }),
        (error: unknown) =>
          isConflict(error) &&
          (error as Error).message.includes(canonicalPath) &&
          (error as Error).message.includes(otherPath)
      );
      assert.ok(paused);
      assert.deepEqual(fenceDestinations(legacyPath), [otherPath], "the in-flight owner's fence survives");

      await paused.finish();
      assert.equal(existsSync(canonicalPath), false);
      assert.deepEqual(fenceDestinations(legacyPath), [otherPath]);
      assert.throws(() => seedOutbox(legacyPath, SOURCE_A, "late-legacy-write"), /retired/);
      assert.deepEqual(outboxIds(otherPath, SOURCE_A), ["pending-A"]);
    });
  });

  test(`recovery cannot lift a fence between observing no marker and no lock while a migration with ${destination.name} publishes`, async () => {
    await withTempRootAsync("pdpp-durable-state-race-marker-lock-", async (root) => {
      const installRoot = join(root, "npx-temp-package");
      const legacyPath = packageLegacyPath(installRoot, "collector-runner-queue.sqlite");
      const owner = resolveInput(root, installRoot);
      const requester = { ...owner, ...destination.change(root) };
      const ownerPath = canonicalCollectorQueuePath(owner);
      const requesterPath = canonicalCollectorQueuePath(requester);
      seedOutbox(legacyPath, SOURCE_A, "pending-A");
      const paused = startPausedMigration(root, owner, "owner");
      new LocalDeviceOutbox({ path: requesterPath }).close();

      // The owner is told to publish after the requester has looked for the
      // owner's marker and before it looks at the owner's lock.
      let betweenChecks = 0;
      assert.throws(
        () =>
          resolveCollectorQueuePath({
            ...requester,
            betweenFenceMarkerAndLockChecks: () => {
              betweenChecks += 1;
              writeFileSync(join(root, "owner.go"), "go");
              // Give the owner time to publish and release its handoff lock.
              waitUntil(() => existsSync(ownerPath) && !existsSync(`${ownerPath}.handoff.lock`), 500);
            },
          }),
        isConflict
      );
      assert.ok(betweenChecks > 0, "the interleaving point was reached");

      await paused.finish();
      assert.equal(existsSync(ownerPath), true);
      assert.deepEqual(fenceDestinations(legacyPath), [ownerPath], "the published owner stays fenced");
      assert.throws(() => seedOutbox(legacyPath, SOURCE_A, "late-legacy-write"), /retired/);
      assert.deepEqual(outboxIds(ownerPath, SOURCE_A), ["pending-A"]);
    });
  });
}

/**
 * Seed a fence exactly as origin/main (v0.7.55, npm-v2.5.1) wrote it: the table
 * has no migration_id column. Copied from `installRetirementFence` there.
 */
function seedMainFence(legacyPath: string, sourceInstanceId: string, canonicalPath: string): void {
  const db = new DatabaseSync(legacyPath);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS pdpp_legacy_retirements (
        source_instance_id TEXT PRIMARY KEY,
        canonical_path TEXT NOT NULL,
        retired_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TRIGGER IF NOT EXISTS pdpp_retire_outbox_insert
        BEFORE INSERT ON local_device_outbox
        WHEN EXISTS (SELECT 1 FROM pdpp_legacy_retirements WHERE source_instance_id = NEW.source_instance_id)
        BEGIN SELECT RAISE(ABORT, 'legacy collector state retired; use canonical path'); END;
      CREATE TRIGGER IF NOT EXISTS pdpp_retire_outbox_update
        BEFORE UPDATE ON local_device_outbox
        WHEN EXISTS (SELECT 1 FROM pdpp_legacy_retirements WHERE source_instance_id = OLD.source_instance_id OR source_instance_id = NEW.source_instance_id)
        BEGIN SELECT RAISE(ABORT, 'legacy collector state retired; use canonical path'); END;
      CREATE TRIGGER IF NOT EXISTS pdpp_retire_outbox_delete
        BEFORE DELETE ON local_device_outbox
        WHEN EXISTS (SELECT 1 FROM pdpp_legacy_retirements WHERE source_instance_id = OLD.source_instance_id)
        BEGIN SELECT RAISE(ABORT, 'legacy collector state retired; use canonical path'); END;
    `);
    db.prepare("INSERT INTO pdpp_legacy_retirements (source_instance_id, canonical_path) VALUES (?, ?)").run(
      sourceInstanceId,
      canonicalPath
    );
  } finally {
    db.close();
  }
}

/** A store origin/main already migrated: delivered canonical queue, frozen legacy copy with a fence. */
function seedMainMigratedStore(root: string, installRoot: string) {
  const legacyPath = packageLegacyPath(installRoot, "collector-runner-queue.sqlite");
  const base = resolveInput(root, installRoot);
  const canonicalPath = canonicalCollectorQueuePath(base);
  seedOutbox(legacyPath, SOURCE_A, "pending-A");
  mkdirSync(dirname(canonicalPath), { recursive: true });
  const legacy = new DatabaseSync(legacyPath, { readOnly: true });
  try {
    legacy.exec(`VACUUM INTO '${canonicalPath.replaceAll("'", "''")}'`);
  } finally {
    legacy.close();
  }
  const canonical = new LocalDeviceOutbox({ path: canonicalPath });
  try {
    for (const claimed of canonical.claimReady({
      holder: "main",
      leaseMs: 60_000,
      limit: 10,
      sourceInstanceId: SOURCE_A,
    })) {
      canonical.acknowledge({
        holder: "main",
        id: claimed.id,
        leaseEpoch: claimed.lease_epoch,
      });
    }
  } finally {
    canonical.close();
  }
  seedMainFence(legacyPath, SOURCE_A, canonicalPath);
  return { base, canonicalPath, legacyPath };
}

test("a store migrated by origin/main (fence without migration id) keeps resolving to its canonical queue", () => {
  withTempRoot("pdpp-durable-state-main-fence-", (root) => {
    const installRoot = join(root, "npx-temp-package");
    const { base, canonicalPath, legacyPath } = seedMainMigratedStore(root, installRoot);

    for (let restart = 0; restart < 3; restart += 1) {
      assert.equal(resolveCollectorQueuePath(base), canonicalPath);
    }
    assert.deepEqual(fenceDestinations(legacyPath), [canonicalPath], "the fence stays intact");
    assert.throws(() => seedOutbox(legacyPath, SOURCE_A, "late-legacy-write"), /retired/);
  });
});

for (const competitorExists of [true, false]) {
  test(`a fence without migration id is never taken over for another destination (competing queue: ${competitorExists})`, () => {
    withTempRoot("pdpp-durable-state-main-fence-foreign-", (root) => {
      const installRoot = join(root, "npx-temp-package");
      const { base, canonicalPath, legacyPath } = seedMainMigratedStore(root, installRoot);
      const other = { ...base, stateRoot: join(root, "other-state") };
      const otherPath = canonicalCollectorQueuePath(other);
      if (competitorExists) {
        seedOutbox(otherPath, SOURCE_A, "competitor-B");
      }

      assert.throws(() => resolveCollectorQueuePath(other), isConflict);

      assert.equal(existsSync(otherPath), competitorExists, "no second snapshot was published");
      assert.deepEqual(fenceDestinations(legacyPath), [canonicalPath]);
      assert.throws(() => seedOutbox(legacyPath, SOURCE_A, "late-legacy-write"), /retired/);
      assert.equal(resolveCollectorQueuePath(base), canonicalPath);
    });
  });
}

test("a fence without migration id whose destination is missing is not lifted, and only its own destination may retry", () => {
  withTempRoot("pdpp-durable-state-main-fence-orphan-", (root) => {
    const installRoot = join(root, "npx-temp-package");
    const legacyPath = packageLegacyPath(installRoot, "collector-runner-queue.sqlite");
    const base = resolveInput(root, installRoot);
    const canonicalPath = canonicalCollectorQueuePath(base);
    const other = { ...base, stateRoot: join(root, "other-state") };
    seedOutbox(legacyPath, SOURCE_A, "pending-A");
    seedMainFence(legacyPath, SOURCE_A, canonicalPath);

    assert.throws(() => resolveCollectorQueuePath(other), isConflict);
    assert.deepEqual(fenceDestinations(legacyPath), [canonicalPath]);
    assert.throws(() => seedOutbox(legacyPath, SOURCE_A, "late-legacy-write"), /retired/);

    // main crashed between its fence and its install: the same destination finishes the handoff.
    assert.equal(resolveCollectorQueuePath(base), canonicalPath);
    assert.deepEqual(outboxIds(canonicalPath, SOURCE_A), ["pending-A"]);
    assert.equal(resolveCollectorQueuePath(base), canonicalPath);
  });
});

test("a failure after publication does not send the operator back to the fenced legacy store", () => {
  withTempRoot("pdpp-durable-state-post-publish-failure-", (root) => {
    const installRoot = join(root, "npx-temp-package");
    const legacyPath = packageLegacyPath(installRoot, "collector-runner-queue.sqlite");
    const canonicalPath = canonicalCollectorQueuePath(resolveInput(root, installRoot));
    seedOutbox(legacyPath, SOURCE_A, "pending-A");

    assert.throws(
      () =>
        resolveCollectorQueuePath({
          ...resolveInput(root, installRoot),
          afterMigrationInstall: () => {
            throw new Error("simulated failure after publication");
          },
        }),
      (error: unknown) =>
        error instanceof CollectorStateResolutionError &&
        error.code === "legacy_state_migration_failed" &&
        !error.message.includes(`--queue ${legacyPath}`) &&
        error.message.includes(canonicalPath)
    );
    assert.equal(resolveCollectorQueuePath(resolveInput(root, installRoot)), canonicalPath);
  });
});

test("publication re-checks the fence under the write lock and publishes nothing for a replaced fence", () => {
  withTempRoot("pdpp-durable-state-publish-recheck-", (root) => {
    const installRoot = join(root, "npx-temp-package");
    const legacyPath = packageLegacyPath(installRoot, "collector-runner-queue.sqlite");
    const canonicalPath = canonicalCollectorQueuePath(resolveInput(root, installRoot));
    seedOutbox(legacyPath, SOURCE_A, "pending-A");

    assert.throws(
      () =>
        resolveCollectorQueuePath({
          ...resolveInput(root, installRoot),
          afterRetirementFence: () => {
            const db = new DatabaseSync(legacyPath);
            try {
              db.prepare("UPDATE pdpp_legacy_retirements SET migration_id = ? WHERE source_instance_id = ?").run(
                "someone-else",
                SOURCE_A
              );
            } finally {
              db.close();
            }
          },
        }),
      isConflict
    );
    assert.equal(existsSync(canonicalPath), false, "nothing was published");
  });
});

test("the legacy write lock is held from the publish re-check through link", () => {
  withTempRoot("pdpp-durable-state-publish-window-", (root) => {
    const installRoot = join(root, "npx-temp-package");
    const legacyPath = packageLegacyPath(installRoot, "collector-runner-queue.sqlite");
    seedOutbox(legacyPath, SOURCE_A, "pending-A");

    let probed = false;
    resolveCollectorQueuePath({
      ...resolveInput(root, installRoot),
      betweenPublishRecheckAndLink: () => {
        probed = true;
        // Fence install, settleFence and every other fence decision begin with this.
        const other = new DatabaseSync(legacyPath);
        try {
          other.exec("PRAGMA busy_timeout = 0");
          assert.throws(() => other.exec("BEGIN IMMEDIATE"), /locked|busy/i);
        } finally {
          other.close();
        }
      },
    });
    assert.equal(probed, true);
  });
});

function readableBootId(): string | undefined {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

const LINUX_ONLY = {
  skip: (!existsSync("/proc/self/stat") || readableBootId() === undefined) && "needs /proc and a readable boot_id",
} as const;

function procStartTime(pid: number | "self"): string {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] as string;
}

function lockCase(name: string, contents: string | undefined, expectLive: boolean, backdate = true): void {
  test(`a handoff lock that is ${name} is ${expectLive ? "live" : "dead"}`, () => {
    withTempRoot("pdpp-durable-state-lock-owner-", (root) => {
      const stateRoot = join(root, "user-state");
      const input = {
        connectorId: "claude_code",
        moduleUrl: modulePath(join(root, "other-install")),
        sourceInstanceId: SOURCE_A,
        stateRoot,
      };
      const canonicalPath = canonicalCollectorQueuePath(input);
      mkdirSync(dirname(canonicalPath), { recursive: true });
      const lockPath = `${canonicalPath}.handoff.lock`;
      writeFileSync(lockPath, contents ?? "");
      if (backdate) {
        const old = new Date(Date.now() - 60_000);
        utimesSync(lockPath, old, old);
      }
      if (expectLive) {
        assert.throws(() => resolveCollectorQueuePath(input), isConflict);
      } else {
        assert.equal(resolveCollectorQueuePath(input), canonicalPath);
      }
    });
  });
}

lockCase("empty and old", "", false);
lockCase("empty and just created (owner may still be writing)", "", true, false);
lockCase("garbled", "not-a-pid\n", false);
lockCase("a process group id", "0\n", false);
lockCase("a negative pid", "-1\n", false);
lockCase("a pid with trailing garbage", `${process.pid}abc\n`, false);
lockCase("this process with only a pid", `${process.pid}\n`, true);
if (!LINUX_ONLY.skip) {
  const identity = { boot: readableBootId() as string, start: procStartTime("self") };
  lockCase(
    "this process with its recorded identity",
    `${process.pid}\nstart=${identity.start}\nboot=${identity.boot}\n`,
    true
  );
  lockCase("a reused pid (start time differs)", `${process.pid}\nstart=1\nboot=${identity.boot}\n`, false);
  lockCase(
    "from another boot",
    `${process.pid}\nstart=${identity.start}\nboot=00000000-0000-0000-0000-000000000000\n`,
    false
  );
  // Pid 1 is not ours to signal (EPERM) unless we are root; either way its real start time plus one is a mismatch.
  lockCase("pid 1 with a mismatched start time", `1\nstart=${Number(procStartTime(1)) + 1}\n`, false);
}

test("a migration takes over a handoff lock with an unreadable owner", () => {
  withTempRoot("pdpp-durable-state-garbled-lock-migration-", (root) => {
    const installRoot = join(root, "npx-temp-package");
    const legacyPath = packageLegacyPath(installRoot, "collector-runner-queue.sqlite");
    const canonicalPath = canonicalCollectorQueuePath(resolveInput(root, installRoot));
    seedOutbox(legacyPath, SOURCE_A, "pending-A");
    mkdirSync(dirname(canonicalPath), { recursive: true });
    writeFileSync(`${canonicalPath}.handoff.lock`, "garbage");

    assert.equal(resolveCollectorQueuePath(resolveInput(root, installRoot)), canonicalPath);
    assert.equal(existsSync(`${canonicalPath}.handoff.lock`), false);
  });
});

for (const fenceKind of ["migration id", "no migration id (origin/main)"] as const) {
  test(`start-up does not take the legacy write lock to confirm a proven fence with ${fenceKind}`, () => {
    withTempRoot("pdpp-durable-state-readonly-proof-", (root) => {
      const installRoot = join(root, "npx-temp-package");
      let base = resolveInput(root, installRoot);
      let canonicalPath: string;
      let legacyPath: string;
      if (fenceKind === "migration id") {
        legacyPath = packageLegacyPath(installRoot, "collector-runner-queue.sqlite");
        seedOutbox(legacyPath, SOURCE_A, "pending-A");
        canonicalPath = resolveCollectorQueuePath(base);
      } else {
        ({ base, canonicalPath, legacyPath } = seedMainMigratedStore(root, installRoot));
      }

      // Another writer holds the legacy write lock; a write-locking check would wait out its timeout.
      const holder = new DatabaseSync(legacyPath);
      try {
        holder.exec("BEGIN IMMEDIATE");
        const started = Date.now();
        assert.equal(resolveCollectorQueuePath(base), canonicalPath);
        assert.ok(Date.now() - started < 2000, "resolution did not wait for the legacy write lock");
      } finally {
        holder.close();
      }
    });
  });
}

/** Seed `legacyPath` with one pending row and an id-less (origin/main) fence to a destination that does not exist. */
function seedOrphanFenceStore(root: string, installRoot: string) {
  const legacyPath = packageLegacyPath(installRoot, "collector-runner-queue.sqlite");
  const base = resolveInput(root, installRoot);
  const recordedPath = canonicalCollectorQueuePath(base);
  const other = { ...base, stateRoot: join(root, "other-state") };
  const otherPath = canonicalCollectorQueuePath(other);
  seedOutbox(legacyPath, SOURCE_A, "pending-A");
  seedMainFence(legacyPath, SOURCE_A, recordedPath);
  return { base, legacyPath, other, otherPath, recordedPath };
}

function isOrphanFenceError(error: unknown, recordedPath: string): boolean {
  return (
    isConflict(error) &&
    (error as Error).message.includes("older release") &&
    !(error as Error).message.includes(`--queue ${recordedPath}`)
  );
}

test("an id-less fence to a missing path is reported as an orphan, not as advice to create that path", () => {
  withTempRoot("pdpp-durable-state-orphan-reconcile-", (root) => {
    const { legacyPath, other, otherPath, recordedPath } = seedOrphanFenceStore(root, join(root, "npx-temp-package"));

    assert.throws(
      () => resolveCollectorQueuePath(other),
      (error: unknown) => isOrphanFenceError(error, recordedPath)
    );
    assert.equal(existsSync(otherPath), false, "no snapshot was published");
    assert.equal(existsSync(recordedPath), false, "the recorded path was not created");
    assert.deepEqual(fenceDestinations(legacyPath), [recordedPath], "the fence row survives");
    assert.throws(() => seedOutbox(legacyPath, SOURCE_A, "late-legacy-write"), /retired/);
  });
});

test("an orphan fence found while the requested queue exists blocks a pending backlog and keeps the fence", () => {
  withTempRoot("pdpp-durable-state-orphan-settle-", (root) => {
    const { legacyPath, other, otherPath, recordedPath } = seedOrphanFenceStore(root, join(root, "npx-temp-package"));
    seedOutbox(otherPath, SOURCE_A, "competitor-B");

    assert.throws(
      () => resolveCollectorQueuePath(other),
      (error: unknown) => isOrphanFenceError(error, recordedPath)
    );
    assert.deepEqual(fenceDestinations(legacyPath), [recordedPath], "the fence row survives");
    assert.throws(() => seedOutbox(legacyPath, SOURCE_A, "late-legacy-write"), /retired/);
    assert.equal(existsSync(recordedPath), false);
  });
});

test("an orphan fence over a fully delivered legacy store does not block the requested queue", () => {
  withTempRoot("pdpp-durable-state-orphan-delivered-", (root) => {
    const { legacyPath, other, otherPath, recordedPath } = seedOrphanFenceStore(root, join(root, "npx-temp-package"));
    seedOutbox(otherPath, SOURCE_A, "competitor-B");
    // Deliver the legacy row. The fence's triggers block updates, so drop them for the seed.
    const db = new DatabaseSync(legacyPath);
    try {
      db.exec("DROP TRIGGER pdpp_retire_outbox_update");
      db.exec("UPDATE local_device_outbox SET status = 'succeeded'");
    } finally {
      db.close();
    }

    assert.equal(resolveCollectorQueuePath(other), otherPath);
    assert.deepEqual(fenceDestinations(legacyPath), [recordedPath], "the fence is neither lifted nor trusted");
  });
});

test("an unreadable recorded destination is reported as unreadable state, not a raw SQLite error", () => {
  withTempRoot("pdpp-durable-state-unreadable-fence-target-", (root) => {
    const { legacyPath, other, otherPath, recordedPath } = seedOrphanFenceStore(root, join(root, "npx-temp-package"));
    seedOutbox(otherPath, SOURCE_A, "competitor-B");
    const db = new DatabaseSync(legacyPath);
    try {
      db.exec("ALTER TABLE pdpp_legacy_retirements ADD COLUMN migration_id TEXT");
      db.prepare("UPDATE pdpp_legacy_retirements SET migration_id = 'some-attempt'").run();
    } finally {
      db.close();
    }
    mkdirSync(dirname(recordedPath), { recursive: true });
    writeFileSync(recordedPath, "this is not a database, and it is long enough to be read as a header ".repeat(20));

    assert.throws(
      () => resolveCollectorQueuePath(other),
      (error: unknown) => error instanceof CollectorStateResolutionError && error.code === "legacy_state_unreadable"
    );
  });
});

test("a held handoff lock is reported as a handoff in progress, without advice to select the legacy store", () => {
  withTempRoot("pdpp-durable-state-lock-held-message-", (root) => {
    const installRoot = join(root, "npx-temp-package");
    const legacyPath = packageLegacyPath(installRoot, "collector-runner-queue.sqlite");
    const base = resolveInput(root, installRoot);
    const canonicalPath = canonicalCollectorQueuePath(base);
    seedOutbox(legacyPath, SOURCE_A, "pending-A");
    mkdirSync(dirname(canonicalPath), { recursive: true });
    writeFileSync(`${canonicalPath}.handoff.lock`, `${process.pid}\n`);

    assert.throws(
      () => resolveCollectorQueuePath(base),
      (error: unknown) =>
        isConflict(error) &&
        (error as Error).message.includes("in progress") &&
        !(error as Error).message.includes("--queue")
    );
    assert.equal(existsSync(canonicalPath), false);
  });
});

test("the legacy write lock is held through the link call itself", () => {
  withTempRoot("pdpp-durable-state-link-window-", (root) => {
    const installRoot = join(root, "npx-temp-package");
    const legacyPath = packageLegacyPath(installRoot, "collector-runner-queue.sqlite");
    seedOutbox(legacyPath, SOURCE_A, "pending-A");

    let probed = false;
    resolveCollectorQueuePath({
      ...resolveInput(root, installRoot),
      linkFile: (existingPath, newPath) => {
        probed = true;
        const other = new DatabaseSync(legacyPath);
        try {
          other.exec("PRAGMA busy_timeout = 0");
          assert.throws(() => other.exec("BEGIN IMMEDIATE"), /locked|busy/i);
        } finally {
          other.close();
        }
        linkSync(existingPath, newPath);
      },
    });
    assert.equal(probed, true);
  });
});

test("the lock file the code writes records this process's real identity", { ...LINUX_ONLY }, () => {
  withTempRoot("pdpp-durable-state-real-lock-file-", (root) => {
    const installRoot = join(root, "npx-temp-package");
    const legacyPath = packageLegacyPath(installRoot, "collector-runner-queue.sqlite");
    const base = resolveInput(root, installRoot);
    const canonicalPath = canonicalCollectorQueuePath(base);
    seedOutbox(legacyPath, SOURCE_A, "pending-A");

    let lockText: string | undefined;
    resolveCollectorQueuePath({
      ...base,
      beforeMigrationReconcile: () => {
        lockText = readFileSync(`${canonicalPath}.handoff.lock`, "utf8");
      },
    });
    assert.deepEqual(lockText?.trim().split("\n"), [
      String(process.pid),
      `start=${procStartTime("self")}`,
      `boot=${readableBootId()}`,
    ]);
  });
});

test("a failure after the link keeps the fence: publication is recorded before it is settled", () => {
  withTempRoot("pdpp-durable-state-published-before-settle-", (root) => {
    const installRoot = join(root, "npx-temp-package");
    const legacyPath = packageLegacyPath(installRoot, "collector-runner-queue.sqlite");
    const base = resolveInput(root, installRoot);
    const canonicalPath = canonicalCollectorQueuePath(base);
    seedOutbox(legacyPath, SOURCE_A, "pending-A");

    assert.throws(
      () =>
        resolveCollectorQueuePath({
          ...base,
          // Link, then make the canonical name vanish so the later chmod throws.
          linkFile: (existingPath, newPath) => {
            linkSync(existingPath, newPath);
            rmSync(newPath);
          },
        }),
      (error: unknown) =>
        error instanceof CollectorStateResolutionError &&
        error.code === "legacy_state_migration_failed" &&
        !error.message.includes(`--queue ${legacyPath}`)
    );
    assert.deepEqual(fenceDestinations(legacyPath), [canonicalPath], "the fence was not lifted");
    assert.throws(() => seedOutbox(legacyPath, SOURCE_A, "late-legacy-write"), /retired/);
  });
});
