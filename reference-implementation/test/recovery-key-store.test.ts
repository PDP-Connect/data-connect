// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Coverage for the RS-side half of the recovery-export.json file protocol
 * (server/recovery-key-store.ts). A real Tauri watcher answering the file is
 * exercised only by src-tauri/src/commands/recovery_key.rs's own Rust tests
 * (no Rust process runs here) -- this file fakes "the watcher" by writing the
 * expected answer directly, the same way owner-remote-access-route.test.ts
 * fakes the transport rather than a real HTTP server.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createRecoveryKeyStore } from "../server/recovery-key-store.ts";

const RECOVERY_EXPORT_FILE = "recovery-export.json";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "recovery-key-store-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("requestExport resolves with the code once the watcher answers", async () => {
  await withTempDir(async (dir) => {
    const store = createRecoveryKeyStore(dir, { pollIntervalMs: 10, pollTimeoutMs: 2_000 });
    const path = join(dir, RECOVERY_EXPORT_FILE);

    const exportPromise = store.requestExport();

    // Simulate the Tauri watcher: wait for the request to land, then answer it.
    let requestId = 0;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      const content = await readFile(path, "utf8").catch(() => "{}");
      const parsed = JSON.parse(content || "{}") as { requestId?: number };
      if (parsed.requestId) {
        requestId = parsed.requestId;
        break;
      }
    }
    assert.ok(requestId > 0, "watcher never observed a request");
    await writeFile(
      path,
      JSON.stringify({ appliedRequestId: requestId, code: "AB12-CD34", error: null, requestId }),
      "utf8"
    );

    const code = await exportPromise;
    assert.equal(code, "AB12-CD34");
  });
});

test("requestExport clears the code field from disk after reading it", async () => {
  await withTempDir(async (dir) => {
    const store = createRecoveryKeyStore(dir, { pollIntervalMs: 10, pollTimeoutMs: 2_000 });
    const path = join(dir, RECOVERY_EXPORT_FILE);

    const exportPromise = store.requestExport();
    for (let attempt = 0; attempt < 50; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      const content = await readFile(path, "utf8").catch(() => "{}");
      const parsed = JSON.parse(content || "{}") as { requestId?: number };
      if (parsed.requestId) {
        await writeFile(
          path,
          JSON.stringify({
            appliedRequestId: parsed.requestId,
            code: "SECRET-PLAINTEXT-CODE",
            error: null,
            requestId: parsed.requestId,
          }),
          "utf8"
        );
        break;
      }
    }
    await exportPromise;

    // Give the store's own post-read write a moment to land.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const finalContent = await readFile(path, "utf8");
    const finalState = JSON.parse(finalContent) as { code: string | null };
    assert.equal(finalState.code, null, "plaintext code must not linger on disk after the round trip");
  });
});

test("requestExport propagates a refusal error without treating it as a code", async () => {
  await withTempDir(async (dir) => {
    const store = createRecoveryKeyStore(dir, { pollIntervalMs: 10, pollTimeoutMs: 2_000 });
    const path = join(dir, RECOVERY_EXPORT_FILE);

    const exportPromise = store.requestExport();
    for (let attempt = 0; attempt < 50; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      const content = await readFile(path, "utf8").catch(() => "{}");
      const parsed = JSON.parse(content || "{}") as { requestId?: number };
      if (parsed.requestId) {
        await writeFile(
          path,
          JSON.stringify({
            appliedRequestId: parsed.requestId,
            code: null,
            error: "No encrypted vault exists yet.",
            requestId: parsed.requestId,
          }),
          "utf8"
        );
        break;
      }
    }

    await assert.rejects(exportPromise, /No encrypted vault exists yet/);
  });
});

test("requestExport times out cleanly when nothing answers the request", async () => {
  await withTempDir(async (dir) => {
    const store = createRecoveryKeyStore(dir, { pollIntervalMs: 10, pollTimeoutMs: 100 });
    await assert.rejects(store.requestExport(), /Timed out/);
  });
});
