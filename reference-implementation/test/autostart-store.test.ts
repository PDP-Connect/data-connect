// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createAutostartStore } from "../server/autostart-store.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "autostart-store-"));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

async function commands(dir: string): Promise<Array<{ commandId: string; desiredEnabled: boolean }>> {
  const path = join(dir, "autostart-commands");
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const names = await readdir(path).catch(() => []);
    if (names.filter(name => name.endsWith(".json")).length >= 2) {
      return Promise.all(names.filter(name => name.endsWith(".json"))
        .map(async name => JSON.parse(await readFile(join(path, name), "utf8"))));
    }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error("two commands were not written");
}

async function answer(dir: string, commandId: string, desiredEnabled: boolean, enabled = desiredEnabled,
  error: string | null = null): Promise<void> {
  const path = join(dir, "autostart-results");
  await mkdir(path, { recursive: true });
  await writeFile(join(path, commandId + ".json"), JSON.stringify({
    commandId, kind: "set_autostart_enabled", desiredEnabled,
    status: error ? "failed" : "succeeded", enabled, error,
    startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
  }));
}

test("load reports unavailable until native observed state is seeded", async () => {
  await withTempDir(async dir => {
    const store = createAutostartStore(dir);
    await assert.rejects(store.load(), /not available yet/);
    await writeFile(join(dir, "autostart-state.json"), JSON.stringify({
      enabled: false, error: null, observedAt: new Date().toISOString(), revision: "one",
    }));
    assert.deepEqual(await store.load(), { enabled: false, error: null, pending: false });
  });
});

test("opposite concurrent commands only resolve from their own results", async () => {
  await withTempDir(async dir => {
    const store = createAutostartStore(dir, () => undefined, { pollIntervalMs: 5, timeoutMs: 500 });
    const first = store.requestChange(true);
    const second = store.requestChange(false);
    const written = await commands(dir);
    assert.equal(new Set(written.map(command => command.commandId)).size, 2);
    const yes = written.find(command => command.desiredEnabled)!;
    const no = written.find(command => !command.desiredEnabled)!;
    await answer(dir, no.commandId, false);
    assert.deepEqual(await second, { enabled: false, error: null, pending: false });
    const firstState = await Promise.race([first.then(() => "resolved"), new Promise(resolve => setTimeout(() => resolve("pending"), 30))]);
    assert.equal(firstState, "pending", "B's result must not satisfy A");
    await answer(dir, yes.commandId, true);
    assert.deepEqual(await first, { enabled: true, error: null, pending: false });
  });
});

test("stale result cannot satisfy a new request and timeout leaves its command", async () => {
  await withTempDir(async dir => {
    const store = createAutostartStore(dir, () => undefined, { pollIntervalMs: 5, timeoutMs: 50 });
    await answer(dir, "ast_AAAAAAAAAAAAAAAAAAAAAA", true);
    await assert.rejects(store.requestChange(true), /was not applied/);
    assert.equal((await readdir(join(dir, "autostart-commands"))).length, 1);
  });
});

test("failed native result is rejected for that command", async () => {
  await withTempDir(async dir => {
    const store = createAutostartStore(dir, () => undefined, { pollIntervalMs: 5, timeoutMs: 500 });
    const request = store.requestChange(true);
    const path = join(dir, "autostart-commands");
    let commandId = "";
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const files = await readdir(path).catch(() => []);
      if (files.length) { commandId = files[0]!.replace(".json", ""); break; }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.ok(commandId);
    await answer(dir, commandId, true, false, "permission denied");
    await assert.rejects(request, /permission denied/);
  });
});
