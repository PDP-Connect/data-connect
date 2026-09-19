// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `createAppConfigStore` persists `AppConfig` to `~/.dataconnect/config.json`
 * -- the SAME file `src-tauri/src/commands/file_ops.rs`'s `get_app_config`/
 * `set_app_config` Tauri commands read and write. Unlike
 * `remote-access-store.ts`, this store's path is fixed to the user's home
 * directory, independent of `PDPP_DATA_DIR` -- so these tests point
 * `homedir()` at a temp directory via `HOME`/`USERPROFILE` rather than taking
 * a `dataDir` constructor argument. `resolveConfigPath()` runs inside
 * `createAppConfigStore()`, not at module import time, so overriding `HOME`
 * before each `createAppConfigStore()` call is sufficient -- no need to
 * re-import the module per test.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createAppConfigStore } from "../server/app-config-store.ts";

async function withTempHome(fn: (homeDir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "app-config-store-home-"));
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  try {
    await fn(dir);
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = originalUserProfile;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

test("load returns the AppConfig::default()-equivalent when no file exists yet", async () => {
  await withTempHome(async () => {
    const store = createAppConfigStore();
    assert.deepEqual(await store.load(), {
      closeToTray: true,
      selfHostedUrl: null,
      serverMode: "cloud",
      startMinimized: false,
      storageProvider: "local",
    });
  });
});

test("save persists a config and load reads it back from ~/.dataconnect/config.json", async () => {
  await withTempHome(async (homeDir) => {
    const store = createAppConfigStore();
    const config = {
      closeToTray: false,
      selfHostedUrl: "https://self-hosted.example.com",
      serverMode: "self_hosted",
      startMinimized: true,
      storageProvider: "cloud",
    };

    const saved = await store.save(config);
    assert.deepEqual(saved, config);
    assert.deepEqual(await store.load(), config);

    const onDisk = JSON.parse(await readFile(join(homeDir, ".dataconnect", "config.json"), "utf8"));
    assert.deepEqual(onDisk, config);
  });
});

test("load surfaces a corrupted file as an error rather than a silent default", async () => {
  await withTempHome(async (homeDir) => {
    const configDir = join(homeDir, ".dataconnect");
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, "config.json"), "not json", "utf8");

    const store = createAppConfigStore();
    await assert.rejects(store.load(), /Failed to parse/);
  });
});
