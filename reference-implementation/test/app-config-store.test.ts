// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AppConfigConflict, createAppConfigStore } from "../server/app-config-store.ts";

async function withTempHome(fn: (homeDir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "app-config-store-home-"));
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  try { await fn(dir); } finally {
    if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = originalUserProfile;
    await rm(dir, { recursive: true, force: true });
  }
}

test("absent file returns default plus revision without writing", async () => {
  await withTempHome(async home => {
    const store = createAppConfigStore();
    const first = await store.loadEnvelope();
    assert.equal(first.config.closeToTray, true);
    assert.equal(first.config.startMinimized, false);
    assert.match(first.revision, /^[a-f0-9]{64}$/);
    await assert.rejects(readFile(join(home, ".dataconnect", "config.json")), { code: "ENOENT" });
  });
});

test("malformed shape is rejected rather than cast", async () => {
  await withTempHome(async home => {
    const path = join(home, ".dataconnect", "config.json");
    await mkdir(join(home, ".dataconnect"));
    await writeFile(path, JSON.stringify({ storageProvider: "local" }));
    await assert.rejects(createAppConfigStore().loadEnvelope(), /Invalid app configuration/);
    await writeFile(path, JSON.stringify({ storageProvider: "local", serverMode: "cloud", selfHostedUrl: null,
      closeToTray: true, startMinimized: false, unexpected: true }));
    await assert.rejects(createAppConfigStore().loadEnvelope(), /Invalid app configuration/);
  });
});

test("two same-revision patches serialize: conflict, reload, preserve unrelated field", async () => {
  await withTempHome(async home => {
    const firstStore = createAppConfigStore();
    const secondStore = createAppConfigStore();
    const initial = await firstStore.loadEnvelope();
    const first = firstStore.patchField({ field: "startMinimized", value: true }, initial.revision);
    const second = secondStore.patchField({ field: "closeToTray", value: false }, initial.revision);
    const settled = await Promise.allSettled([first, second]);
    assert.equal(settled.filter(result => result.status === "fulfilled").length, 1);
    const rejected = settled.find(result => result.status === "rejected") as PromiseRejectedResult;
    assert.ok(rejected.reason instanceof AppConfigConflict);
    const current = await firstStore.loadEnvelope();
    const patched = await firstStore.patchField({ field: "closeToTray", value: false }, current.revision);
    assert.equal(patched.config.closeToTray, false);
    assert.equal(patched.config.startMinimized, true);
    assert.equal(JSON.parse(await readFile(join(home, ".dataconnect", "config.json"), "utf8")).startMinimized, true);
  });
});

test("full stale save rejects and leaves the new config unchanged", async () => {
  await withTempHome(async () => {
    const store = createAppConfigStore();
    const initial = await store.loadEnvelope();
    await store.patchField({ field: "startMinimized", value: true }, initial.revision);
    await assert.rejects(store.saveIfMatch({ ...initial.config, closeToTray: false }, initial.revision),
      error => error instanceof AppConfigConflict && error.current.config.startMinimized === true);
    assert.equal((await store.load()).closeToTray, true);
  });
});
