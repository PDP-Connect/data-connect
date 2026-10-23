// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { chdir } from "node:process";
import { test } from "node:test";
import { parseArgs, resolveInspectionOptions } from "../bin/pdpp-local-collector.ts";
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

    assert.throws(
      () =>
        resolveCollectorQueuePath({
          connectorId: "claude_code",
          moduleUrl: modulePath(installRoot),
          sourceInstanceId: SOURCE_A,
          stateRoot,
          beforeMigrationReconcile: () => seedOutbox(canonicalPath, SOURCE_A, "concurrent-new-run"),
        }),
      (error: unknown) => error instanceof CollectorStateResolutionError && error.code === "legacy_state_conflict"
    );

    // The legacy writer was not retired: it still accepts work.
    seedOutbox(legacyPath, SOURCE_A, "legacy-write-after-abort");
    assert.deepEqual(outboxIds(legacyPath, SOURCE_A), ["legacy-write-after-abort", "pending-before-upgrade"]);
    // Neither side was merged into the other, and no snapshot or lock is left.
    assert.deepEqual(outboxIds(canonicalPath, SOURCE_A), ["concurrent-new-run"]);
    assert.deepEqual(
      readdirSync(dirname(canonicalPath)).filter((name) => /\.migration-|\.handoff\.lock$/.test(name)),
      []
    );

    // The conflict is not forgotten once the canonical file exists: the legacy backlog is
    // still reported rather than silently abandoned.
    assert.throws(
      () =>
        resolveCollectorQueuePath({
          connectorId: "claude_code",
          moduleUrl: modulePath(installRoot),
          sourceInstanceId: SOURCE_A,
          stateRoot,
        }),
      (error: unknown) => error instanceof CollectorStateResolutionError && error.code === "legacy_state_conflict"
    );
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

    assert.throws(
      resolve,
      (error: unknown) =>
        error instanceof CollectorStateResolutionError &&
        error.code === "legacy_state_conflict" &&
        error.message.includes(legacyPath) &&
        error.message.includes(canonicalPath)
    );
    assert.deepEqual(outboxIds(canonicalPath, SOURCE_A), ["unrelated-canonical-work"]);

    // Draining the legacy backlog (the operator's remedy, via --queue) clears the conflict.
    const legacyOutbox = new LocalDeviceOutbox({ path: legacyPath });
    try {
      const [claimed] = legacyOutbox.claimReady({ holder: "operator", leaseMs: 60_000, sourceInstanceId: SOURCE_A });
      assert.ok(claimed);
      legacyOutbox.acknowledge({ holder: "operator", id: claimed.id, leaseEpoch: claimed.lease_epoch });
    } finally {
      legacyOutbox.close();
    }
    assert.equal(resolve(), canonicalPath);
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
    assert.throws(
      () => resolveCollectorQueuePath(resolveInput(root, installRoot)),
      (error: unknown) => error instanceof CollectorStateResolutionError && error.code === "legacy_state_conflict"
    );
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

    assert.throws(
      () => resolveCollectorQueuePath(resolveInput(root, installRoot)),
      (error: unknown) =>
        error instanceof CollectorStateResolutionError &&
        error.code === "legacy_state_conflict" &&
        error.message.includes("left writable")
    );
    // Recovery returned the legacy store to service rather than abandoning it.
    seedOutbox(legacyPath, SOURCE_A, "legacy-write-after-recovery");
    assert.deepEqual(outboxIds(canonicalPath, SOURCE_A), ["competitor-B"]);

    // The operator's remedy (drain the legacy backlog) then clears the conflict.
    const legacyOutbox = new LocalDeviceOutbox({ path: legacyPath });
    try {
      for (const claimed of legacyOutbox.claimReady({
        holder: "operator",
        leaseMs: 60_000,
        limit: 10,
        sourceInstanceId: SOURCE_A,
      })) {
        legacyOutbox.acknowledge({ holder: "operator", id: claimed.id, leaseEpoch: claimed.lease_epoch });
      }
    } finally {
      legacyOutbox.close();
    }
    assert.equal(resolveCollectorQueuePath(resolveInput(root, installRoot)), canonicalPath);
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

test("superseded terminal history in a legacy store is not pending work", () => {
  withTempRoot("pdpp-durable-state-superseded-", (root) => {
    const installRoot = join(root, "npx-temp-package");
    const legacyPath = packageLegacyPath(installRoot, "collector-runner-queue.sqlite");
    const canonicalPath = canonicalCollectorQueuePath(resolveInput(root, installRoot));
    const terminal = (id: string, runId: string, boundary: string) => ({
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
    });
    const settle = (outbox: LocalDeviceOutbox, outcome: "acknowledge" | "deadLetter") => {
      const [claimed] = outbox.claimReady({ holder: "test", leaseMs: 60_000, sourceInstanceId: SOURCE_A });
      assert.ok(claimed);
      const lease = { holder: "test", id: claimed.id, leaseEpoch: claimed.lease_epoch };
      if (outcome === "acknowledge") {
        outbox.acknowledge(lease);
      } else {
        outbox.deadLetter({ ...lease, error: "400 invalid_request" });
      }
    };
    const legacy = new LocalDeviceOutbox({ path: legacyPath });
    try {
      legacy.enqueue(terminal("old-terminal", "run-old", "scope-1"));
      settle(legacy, "deadLetter");
      legacy.enqueue(terminal("new-terminal", "run-new", "scope-1"));
      settle(legacy, "acknowledge");
      assert.equal(
        legacy.retireDeadLetteredTerminalCommits({
          collectionBoundary: "scope-1",
          connectorId: "claude_code",
          connectorInstanceId: "cin-1",
          replacementId: "new-terminal",
          sourceInstanceId: SOURCE_A,
        }),
        1
      );
      assert.equal(legacy.get("old-terminal")?.status, "dead_letter", "superseded evidence is retained");
    } finally {
      legacy.close();
    }
    seedOutbox(canonicalPath, SOURCE_A, "canonical-work");

    assert.equal(resolveCollectorQueuePath(resolveInput(root, installRoot)), canonicalPath);

    // A dead-letter terminal commit that nothing superseded is still undelivered work.
    const reopened = new LocalDeviceOutbox({ path: legacyPath });
    try {
      reopened.enqueue(terminal("other-terminal", "run-other", "scope-2"));
      settle(reopened, "deadLetter");
    } finally {
      reopened.close();
    }
    assert.throws(
      () => resolveCollectorQueuePath(resolveInput(root, installRoot)),
      (error: unknown) => error instanceof CollectorStateResolutionError && error.code === "legacy_state_conflict"
    );
  });
});
