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
    };

    const saved = await store.save(config);
    assert.deepEqual(saved, config);
    assert.deepEqual(await store.load(), config);

    const onDisk = JSON.parse(await readFile(join(dir, "remote-access.json"), "utf8"));
    assert.deepEqual(onDisk, config);
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

test("save rejects an ngrok config with no endpoint mode", async () => {
  await withTempDir(async (dir) => {
    const store = createRemoteAccessConfigStore(dir);
    const config = {
      fields: offRemoteAccessConfig().fields,
      posture: "public_url",
      provider: "ngrok",
    } as unknown as RemoteAccessConfig;

    await assert.rejects(store.save(config), /endpoint mode/);
  });
});

test("save persists a valid ngrok config with empty reachability fields", async () => {
  await withTempDir(async (dir) => {
    const store = createRemoteAccessConfigStore(dir);
    const config: RemoteAccessConfig = {
      fields: offRemoteAccessConfig().fields,
      ngrok: { endpoint_mode: "https_edge_termination", reserved_domain: null },
      posture: "public_url",
      provider: "ngrok",
    };

    const saved = await store.save(config);
    assert.equal(saved.provider, "ngrok");
    assert.equal(saved.fields.PDPP_REFERENCE_ORIGIN, null);

    const loaded = await store.load();
    assert.deepEqual(loaded, saved);
  });
});

test("load reads back a tunnel_error the Tauri supervisor wrote to the same file", async () => {
  // Simulates `apply_ngrok_tunnel_outcome` (src-tauri/src/unified.rs) writing
  // a failed tunnel start directly to remote-access.json -- the store must
  // read that field back rather than silently dropping it as unknown.
  await withTempDir(async (dir) => {
    const store = createRemoteAccessConfigStore(dir);
    const { writeFile } = await import("node:fs/promises");
    const config: RemoteAccessConfig = {
      fields: offRemoteAccessConfig().fields,
      ngrok: { endpoint_mode: "tls_passthrough", reserved_domain: null },
      posture: "public_url",
      provider: "ngrok",
      tunnel_error: "ngrok TLS endpoint failed: ERR_NGROK_312",
    };
    await writeFile(join(dir, "remote-access.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");

    const loaded = await store.load();
    assert.equal(loaded.tunnel_error, "ngrok TLS endpoint failed: ERR_NGROK_312");
  });
});

test("save drops a stale tunnel_error when the owner submits a fresh ngrok config", async () => {
  await withTempDir(async (dir) => {
    const store = createRemoteAccessConfigStore(dir);
    const { writeFile } = await import("node:fs/promises");
    const failed: RemoteAccessConfig = {
      fields: offRemoteAccessConfig().fields,
      ngrok: { endpoint_mode: "tls_passthrough", reserved_domain: null },
      posture: "public_url",
      provider: "ngrok",
      tunnel_error: "ngrok TLS endpoint failed: ERR_NGROK_312",
    };
    await writeFile(join(dir, "remote-access.json"), `${JSON.stringify(failed, null, 2)}\n`, "utf8");

    const resubmitted: RemoteAccessConfig = {
      fields: offRemoteAccessConfig().fields,
      ngrok: { endpoint_mode: "https_edge_termination", reserved_domain: null },
      posture: "public_url",
      provider: "ngrok",
    };
    const saved = await store.save(resubmitted);
    assert.equal(saved.tunnel_error, null);
    assert.equal((await store.load()).tunnel_error, null);
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
