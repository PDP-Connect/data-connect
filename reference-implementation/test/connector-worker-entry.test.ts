// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  encodeWorkerDescriptor,
  readWorkerDescriptor,
  runConnectorWorkerEntry,
  validateWorkerDescriptor,
  WORKER_DESCRIPTOR_LIMIT,
  type WorkerLaunchDescriptor,
} from "../runtime/connector-worker-entry.ts";

const descriptor: WorkerLaunchDescriptor = {
  args: ["/connector/index.mjs"],
  cwd: "/connector",
  env: { TOKEN: "private" },
  version: 1,
};

function capture(stream: PassThrough): { chunks: Buffer[]; text: () => string } {
  const chunks: Buffer[] = [];
  stream.on("data", (chunk: Buffer) => {
    chunks.push(Buffer.from(chunk));
  });
  return { chunks, text: () => Buffer.concat(chunks).toString() };
}

test("descriptor parser preserves the first START in the same chunk at every byte split", async () => {
  const encoded = encodeWorkerDescriptor(descriptor);
  const start = Buffer.from('{"type":"START","secret":"opaque"}\n\u0000tail');
  await Promise.all(
    Array.from({ length: encoded.length + 1 }, async (_, split) => {
      const input = new PassThrough();
      const pending = readWorkerDescriptor(input);
      input.write(encoded.subarray(0, split));
      input.end(Buffer.concat([encoded.subarray(split), start]));
      assert.deepEqual(await pending, descriptor);
      const rest: Buffer[] = [];
      for await (const chunk of input) {
        rest.push(Buffer.from(chunk));
      }
      assert.deepEqual(Buffer.concat(rest), start);
    })
  );
});

test("descriptor refuses oversized, truncated, malformed, shell-like or injected environment", async () => {
  const oversized = Buffer.alloc(4);
  oversized.writeUInt32BE(WORKER_DESCRIPTOR_LIMIT + 1);
  await Promise.all(
    [oversized, Buffer.from([0, 0]), Buffer.from([0, 0, 0, 5, 123]), Buffer.from([0, 0, 0, 1, 120])].map(
      async (bytes) => {
        const input = new PassThrough();
        input.end(bytes);
        await assert.rejects(readWorkerDescriptor(input));
      }
    )
  );
  for (const value of [
    { ...descriptor, args: ["-e", "secret"] },
    { ...descriptor, args: ["/elsewhere/connector.mjs"] },
    { ...descriptor, cwd: "/connector/../host" },
    { ...descriptor, env: { NODE_OPTIONS: "--require=/evil" } },
    { ...descriptor, env: { LD_PRELOAD: "/evil" } },
    { ...descriptor, env: { TOKEN: "nul\0" } },
  ]) {
    assert.throws(() => validateWorkerDescriptor(value));
  }
});

test("trusted bootstrap spawns only after descriptor, seals env, forwards exact stdin/stdout/stderr and exit", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "worker-entry-"));
  t.after(() => rm(root, { recursive: true }));
  const entry = join(root, "connector.mjs");
  await writeFile(
    entry,
    `
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    process.stdout.write(Buffer.concat(chunks));
    process.stderr.write(JSON.stringify({ token: process.env.TOKEN, inherited: process.env.HOME ?? null, cwd: process.cwd() }));
    process.exitCode = 9;
  `
  );
  const input = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const out = capture(stdout);
  const err = capture(stderr);
  const signals = new EventEmitter();
  let spawns = 0;
  const completion = runConnectorWorkerEntry({
    input,
    nodePath: process.execPath,
    signals,
    spawnChild: (nodePath, d) => {
      spawns += 1;
      assert.equal(nodePath, process.execPath);
      assert.deepEqual(d.args, [entry]);
      return spawn(nodePath, [...d.args], {
        cwd: d.cwd,
        env: { ...d.env },
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
    },
    stderr,
    stdout,
  });
  const encoded = encodeWorkerDescriptor({ args: [entry], cwd: root, env: { TOKEN: "private" }, version: 1 });
  input.write(encoded.subarray(0, 5));
  await Promise.resolve();
  assert.equal(spawns, 0);
  const bytes = Buffer.from('{"type":"START"}\n\u0000\ufffd');
  input.end(Buffer.concat([encoded.subarray(5), bytes]));
  assert.equal(await completion, 9);
  assert.equal(spawns, 1);
  assert.deepEqual(Buffer.concat(out.chunks), bytes);
  assert.deepEqual(JSON.parse(err.text()), { cwd: root, inherited: null, token: "private" });
  assert.equal(signals.listenerCount("SIGTERM"), 0);
});

test("bootstrap forwards termination and waits for actual child closure", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "worker-termination-"));
  t.after(() => rm(root, { recursive: true }));
  const entry = join(root, "connector.mjs");
  await writeFile(entry, `process.stdout.write("ready"); setInterval(() => {}, 1000);`);
  const input = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const signals = new EventEmitter();
  const ready = once(stdout, "data");
  const completion = runConnectorWorkerEntry({ input, nodePath: process.execPath, signals, stderr, stdout });
  input.write(encodeWorkerDescriptor({ args: [entry], cwd: root, env: {}, version: 1 }));
  await ready;
  signals.emit("SIGTERM");
  assert.equal(await completion, 143);
  input.destroy();
  assert.equal(signals.listenerCount("SIGTERM"), 0);
});
