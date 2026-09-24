// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createRecoveryKeyStore } from "../server/recovery-key-store.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "recovery-key-store-"));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

async function waitCommands(dir: string, count: number): Promise<string[]> {
  const path = join(dir, "recovery-export-commands");
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const names = await readdir(path).catch(() => []);
    if (names.length >= count) return names.map(name => name.replace(".json", ""));
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error("commands were not written");
}

async function result(dir: string, commandId: string, code: string | null, expiresAt = new Date(Date.now() + 120_000),
  status = "succeeded"): Promise<void> {
  const path = join(dir, "recovery-export-results");
  await mkdir(path, { recursive: true });
  const temporary = join(path, commandId + ".tmp");
  await writeFile(temporary, JSON.stringify({
    commandId, status, code, error: status === "failed" ? "No encrypted vault exists yet." : null,
    createdAt: new Date().toISOString(), expiresAt: expiresAt.toISOString(), consumedAt: null,
  }), { mode: 0o600 });
  await rename(temporary, join(path, commandId + ".json"));
}

test("concurrent exports have distinct 0600 commands and consume their own results once", async () => {
  await withTempDir(async dir => {
    const store = createRecoveryKeyStore(dir, { pollIntervalMs: 5, pollTimeoutMs: 500 });
    const first = store.requestExport();
    const second = store.requestExport();
    const ids = await waitCommands(dir, 2);
    assert.equal(new Set(ids).size, 2);
    for (const id of ids) {
      const mode = (await stat(join(dir, "recovery-export-commands", id + ".json"))).mode & 0o777;
      assert.equal(mode, 0o600);
    }
    await result(dir, ids[1]!, "CODE-B");
    await result(dir, ids[0]!, "CODE-A");
    const codes = await Promise.all([first, second]);
    assert.deepEqual(codes.sort(), ["CODE-A", "CODE-B"]);
    assert.deepEqual(await readdir(join(dir, "recovery-export-results")), []);
    assert.deepEqual(await readdir(join(dir, "recovery-export-commands")), []);
  });
});

test("mismatched result id is ignored, then matching result succeeds", async () => {
  await withTempDir(async dir => {
    const store = createRecoveryKeyStore(dir, { pollIntervalMs: 5, pollTimeoutMs: 500 });
    const request = store.requestExport();
    const [id] = await waitCommands(dir, 1);
    const path = join(dir, "recovery-export-results", id + ".json");
    await result(dir, "rky_AAAAAAAAAAAAAAAAAAAAAA", "WRONG");
    await mkdir(join(dir, "recovery-export-results"), { recursive: true });
    const temporary = path + ".tmp";
    await writeFile(temporary, JSON.stringify({
      commandId: "rky_AAAAAAAAAAAAAAAAAAAAAA", status: "succeeded", code: "WRONG", error: null,
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 120_000).toISOString(), consumedAt: null,
    }));
    await rename(temporary, path);
    const settled = await Promise.race([request.then(() => "resolved"), new Promise(resolve => setTimeout(() => resolve("pending"), 30))]);
    assert.equal(settled, "pending");
    await result(dir, id!, "RIGHT");
    assert.equal(await request, "RIGHT");
  });
});

test("expired result is rejected and cleaned; consumed response cannot replay after restart", async () => {
  await withTempDir(async dir => {
    const store = createRecoveryKeyStore(dir, { pollIntervalMs: 5, pollTimeoutMs: 300 });
    const request = store.requestExport();
    const [id] = await waitCommands(dir, 1);
    await result(dir, id!, "OLD", new Date(Date.now() - 1000));
    await assert.rejects(request, /expired/);
    await assert.rejects(stat(join(dir, "recovery-export-results", id + ".json")), { code: "ENOENT" });
    const restarted = createRecoveryKeyStore(dir, { pollIntervalMs: 5, pollTimeoutMs: 50 });
    await assert.rejects(restarted.requestExport(), /Timed out/);
  });
});

test("native failure propagates without returning secret material", async () => {
  await withTempDir(async dir => {
    const store = createRecoveryKeyStore(dir, { pollIntervalMs: 5, pollTimeoutMs: 500 });
    const request = store.requestExport();
    const [id] = await waitCommands(dir, 1);
    await result(dir, id!, null, new Date(Date.now() + 120_000), "failed");
    await assert.rejects(request, /No encrypted vault exists yet/);
  });
});

test("timeout withdraws its command so a late watcher cannot mint an orphaned secret", async () => {
  await withTempDir(async dir => {
    const store = createRecoveryKeyStore(dir, { pollIntervalMs: 5, pollTimeoutMs: 40 });
    await assert.rejects(store.requestExport(), /Timed out/);
    assert.deepEqual(await readdir(join(dir, "recovery-export-commands")), []);
  });
});
