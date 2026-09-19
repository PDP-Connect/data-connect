// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `createAutostartStore` is a request/ack protocol, not direct persistence:
 * `requestChange` writes a desired-state request to `autostart.json` under
 * `PDPP_DATA_DIR` and polls for `src-tauri/src/unified.rs::
 * spawn_autostart_watcher` to apply it and write back the result. These
 * tests simulate the watcher directly (writing `appliedRequestId`/`enabled`
 * to the file) rather than running the real Tauri process, mirroring how
 * `remote-access-store.test.ts` exercises the store in isolation from the
 * Rust side.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createAutostartStore } from "../server/autostart-store.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "autostart-store-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("load throws honestly when the desktop app has not seeded the state file yet", async () => {
  await withTempDir(async dir => {
    const store = createAutostartStore(dir);
    await assert.rejects(store.load(), /not available yet/);
  });
});

test("load reads back whatever the desktop app last wrote", async () => {
  await withTempDir(async dir => {
    await writeFile(
      join(dir, "autostart.json"),
      JSON.stringify({
        appliedRequestId: 0,
        desiredEnabled: true,
        enabled: true,
        error: null,
        requestId: 0,
      }),
      "utf8"
    );
    const store = createAutostartStore(dir);
    assert.deepEqual(await store.load(), {
      appliedRequestId: 0,
      desiredEnabled: true,
      enabled: true,
      error: null,
      requestId: 0,
    });
  });
});

test("requestChange writes a bumped requestId and resolves once the watcher applies it", async () => {
  await withTempDir(async dir => {
    const path = join(dir, "autostart.json");
    await writeFile(
      path,
      JSON.stringify({
        appliedRequestId: 0,
        desiredEnabled: false,
        enabled: false,
        error: null,
        requestId: 0,
      }),
      "utf8"
    );
    const store = createAutostartStore(dir);

    // Simulate the Rust watcher applying the request shortly after it lands.
    const applyAfterWrite = (async () => {
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        const current = JSON.parse(await readFile(path, "utf8"));
        if (current.requestId === 1) {
          await writeFile(
            path,
            JSON.stringify({ ...current, appliedRequestId: 1, enabled: true, error: null }),
            "utf8"
          );
          return;
        }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      throw new Error("watcher simulation never observed requestId 1");
    })();

    const [result] = await Promise.all([store.requestChange(true), applyAfterWrite]);
    assert.deepEqual(result, {
      appliedRequestId: 1,
      desiredEnabled: true,
      enabled: true,
      error: null,
      requestId: 1,
    });
  });
});

test("requestChange throws if the watcher never applies the request", async () => {
  await withTempDir(async dir => {
    const store = createAutostartStore(dir);
    await assert.rejects(store.requestChange(true), /was not applied/);
  });
});
