// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
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
    await writeFile(join(dir, "autostart-state.json"), JSON.stringify({
      enabled: false, error: null, observedAt: new Date().toISOString(), revision: "one",
    }));
    const request = store.requestChange(true);
    const path = join(dir, "autostart-commands");
    let commandId = "";
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const files = await readdir(path).catch(() => []);
      if (files.length) { commandId = files[0]!.replace(".json", ""); break; }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.ok(commandId);
    assert.equal((await store.load()).pending, true);
    await answer(dir, commandId, true, false, "permission denied");
    await assert.rejects(request, /permission denied/);
    assert.equal((await store.load()).pending, false);
  });
});

type ResultFields = {
  commandId: string; kind: string; desiredEnabled: boolean;
  status: string; enabled: boolean; error: string | null;
};

const malformedResults: Array<[string, (valid: ResultFields) => string]> = [
  ["invalid JSON", () => "{"],
  ["non-object JSON", () => JSON.stringify([])],
  ["wrong command ID", valid => JSON.stringify({ ...valid, commandId: "ast_" + "A".repeat(22) })],
  ["wrong kind", valid => JSON.stringify({ ...valid, kind: "query_autostart_enabled" })],
  ["wrong desired value", valid => JSON.stringify({ ...valid, desiredEnabled: false })],
  ["non-terminal status", valid => JSON.stringify({ ...valid, status: "running" })],
  ["invalid enabled type", valid => JSON.stringify({ ...valid, enabled: "true" })],
  ["invalid error type", valid => JSON.stringify({ ...valid, error: 42 })],
];

async function seedObservedState(dir: string): Promise<void> {
  await writeFile(join(dir, "autostart-state.json"), JSON.stringify({
    enabled: false, error: null, observedAt: new Date().toISOString(), revision: "synthetic",
  }));
}

function writeMatchingPath(dir: string, body: (valid: ResultFields) => string): void {
  const names = readdirSync(join(dir, "autostart-commands")).filter(name => name.endsWith(".json"));
  assert.equal(names.length, 1);
  const name = names[0]!;
  const path = join(dir, "autostart-results");
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, name), body({
    commandId: name.slice(0, -5), kind: "set_autostart_enabled", desiredEnabled: true,
    status: "succeeded", enabled: true, error: null,
  }));
}

test("matching-path malformed results leave the current command pending", async t => {
  for (const [name, body] of malformedResults) {
    await t.test(name, async () => {
      await withTempDir(async dir => {
        await seedObservedState(dir);
        let published!: () => void;
        const ready = new Promise<void>(resolve => { published = resolve; });
        // Install the invalid result synchronously at publication, before the first poll.
        const store = createAutostartStore(dir, () => {
          writeMatchingPath(dir, body);
          published();
        }, { pollIntervalMs: 5, timeoutMs: 100 });
        const timedOut = assert.rejects(store.requestChange(true), /was not applied/);
        const initial = await Promise.race([
          ready.then(() => store.load()),
          timedOut.then(() => { throw new Error("command not published"); }),
        ]);
        await timedOut;
        assert.equal(initial.pending, true);
        assert.equal((await store.load()).pending, true);
      });
    });
  }
});

test("matching terminal results replace unrecognized results for the current command", async t => {
  for (const failed of [false, true]) {
    await t.test(failed ? "failure" : "success", async () => {
      await withTempDir(async dir => {
        await seedObservedState(dir);
        let published!: () => void;
        const ready = new Promise<void>(resolve => { published = resolve; });
        const store = createAutostartStore(dir, () => {
          writeMatchingPath(dir, () => "{");
          published();
        }, { pollIntervalMs: 5, timeoutMs: 1000 });
        const request = store.requestChange(true);
        const settled = failed ? assert.rejects(request, /synthetic denial/) :
          request.then(result => assert.deepEqual(result, { enabled: true, error: null, pending: false }));
        await Promise.race([ready, settled.then(() => { throw new Error("command not published"); })]);
        assert.equal((await store.load()).pending, true);
        writeMatchingPath(dir, valid => JSON.stringify(failed ?
          { ...valid, status: "failed", enabled: false, error: "synthetic denial" } : valid));
        await settled;
        assert.equal((await store.load()).pending, false);
      });
    });
  }
});

test("unanswered commands stop counting as pending at ten minutes", async t => {
  await withTempDir(async dir => {
    await seedObservedState(dir);
    const createdAt = Date.parse("2026-11-21T00:00:00.000Z");
    let now = createdAt + 599_999;
    t.mock.method(Date, "now", () => now);
    const commandId = "ast_" + "B".repeat(22);
    const path = join(dir, "autostart-commands");
    await mkdir(path);
    await writeFile(join(path, commandId + ".json"), JSON.stringify({
      commandId, kind: "set_autostart_enabled", desiredEnabled: true,
      createdAt: new Date(createdAt).toISOString(), status: "accepted",
    }));
    const store = createAutostartStore(dir);
    assert.equal((await store.load()).pending, true);
    now += 1;
    assert.equal((await store.load()).pending, false);
  });
});
