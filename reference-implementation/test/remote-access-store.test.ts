// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `createRemoteAccessConfigStore` persists `RemoteAccessConfig` to
 * `remote-access.json` under a given data directory. This is the file the
 * Tauri desktop supervisor also reads/writes at `PDPP_DATA_DIR` (see
 * `src-tauri/src/remote_access.rs`), so this store is the single persisted
 * source of truth for both the HTTP routes and the desktop restart path.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { offRemoteAccessConfig, type RemoteAccessConfig } from "../server/remote-access-config.ts";
import { createRemoteAccessConfigStore } from "../server/remote-access-store.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "remote-access-store-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("load returns the off config when no file exists yet", async () => {
  await withTempDir(async (dir) => {
    const store = createRemoteAccessConfigStore(dir);
    assert.deepEqual(await store.load(), offRemoteAccessConfig());
  });
});

test("save persists a valid public_url config and load reads it back", async () => {
  await withTempDir(async (dir) => {
    const store = createRemoteAccessConfigStore(dir);
    const config: RemoteAccessConfig = {
      fields: {
        PDPP_BIND_HOST: "127.0.0.1",
        PDPP_REFERENCE_ORIGIN: "https://vault.example.com",
        PDPP_TRUSTED_HOSTS: "vault.example.com",
        PDPP_TRUSTED_PROXIES: "",
      },
      posture: "public_url",
      provider: "user_supplied_origin",
      console_port: 4310,
    };

    const saved = await store.save(config);
    assert.deepEqual(saved, config);
    assert.deepEqual(await store.load(), config);

    const onDisk = JSON.parse(await readFile(join(dir, "remote-access.json"), "utf8"));
    assert.deepEqual(onDisk, config);
  });
});

test("save persists a config without a pinned port as console_port: null", async () => {
  await withTempDir(async (dir) => {
    const store = createRemoteAccessConfigStore(dir);
    const config: RemoteAccessConfig = {
      fields: {
        PDPP_BIND_HOST: "127.0.0.1",
        PDPP_REFERENCE_ORIGIN: "https://vault.example.com",
        PDPP_TRUSTED_HOSTS: "vault.example.com",
        PDPP_TRUSTED_PROXIES: "",
      },
      posture: "public_url",
      provider: "user_supplied_origin",
    };

    const saved = await store.save(config);
    assert.equal(saved.console_port, null);
    assert.equal((await store.load()).console_port, null);
  });
});

test("save rejects a config that fails validation and does not write the file", async () => {
  await withTempDir(async (dir) => {
    const store = createRemoteAccessConfigStore(dir);
    const invalid: RemoteAccessConfig = {
      fields: {
        PDPP_BIND_HOST: "127.0.0.1",
        PDPP_REFERENCE_ORIGIN: "http://vault.example.com",
        PDPP_TRUSTED_HOSTS: "vault.example.com",
        PDPP_TRUSTED_PROXIES: "",
      },
      posture: "public_url",
      provider: "user_supplied_origin",
    };

    await assert.rejects(store.save(invalid), /HTTPS/);
    await assert.rejects(readFile(join(dir, "remote-access.json"), "utf8"));
  });
});

test("save rejects the ngrok provider — this store only owns user_supplied_origin", async () => {
  await withTempDir(async (dir) => {
    const store = createRemoteAccessConfigStore(dir);
    const config = {
      fields: offRemoteAccessConfig().fields,
      posture: "public_url",
      provider: "ngrok",
    } as unknown as RemoteAccessConfig;

    await assert.rejects(store.save(config), /user_supplied_origin/);
  });
});

test("load surfaces a corrupted file as an error rather than a silent off default", async () => {
  await withTempDir(async (dir) => {
    const store = createRemoteAccessConfigStore(dir);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, "remote-access.json"), "not json", "utf8");
    await assert.rejects(store.load(), /Failed to parse/);
  });
});
