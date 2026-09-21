// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `createOpenExternalUrlStore` only enqueues a request by appending to
 * `open-external-url-queue.json` under `PDPP_DATA_DIR` -- see
 * `../server/open-external-url-store.ts` for why this does not poll for an
 * ack, unlike `autostart-store.ts`.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createOpenExternalUrlStore } from "../server/open-external-url-store.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "open-external-url-store-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("enqueue writes the URL to the queue file and returns an id", async () => {
  await withTempDir(async dir => {
    const store = createOpenExternalUrlStore(dir);
    const request = await store.enqueue("https://example.com/docs");
    assert.equal(request.url, "https://example.com/docs");
    assert.equal(request.id, 1);

    const onDisk = JSON.parse(await readFile(join(dir, "open-external-url-queue.json"), "utf8"));
    assert.deepEqual(onDisk, { pending: [{ id: 1, url: "https://example.com/docs" }] });
  });
});

test("enqueue appends to an existing queue rather than overwriting it", async () => {
  await withTempDir(async dir => {
    const store = createOpenExternalUrlStore(dir);
    const first = await store.enqueue("https://a.example");
    const second = await store.enqueue("https://b.example");

    assert.equal(first.id, 1);
    assert.equal(second.id, 2);

    const onDisk = JSON.parse(await readFile(join(dir, "open-external-url-queue.json"), "utf8"));
    assert.deepEqual(onDisk.pending, [
      { id: 1, url: "https://a.example" },
      { id: 2, url: "https://b.example" },
    ]);
  });
});

test("enqueue tolerates a missing queue file (first request of a fresh install)", async () => {
  await withTempDir(async dir => {
    const store = createOpenExternalUrlStore(dir);
    const request = await store.enqueue("https://example.com");
    assert.equal(request.id, 1);
  });
});
