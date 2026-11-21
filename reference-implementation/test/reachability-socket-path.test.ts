// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { requireUsableSocketHome } from "../server/reachability/desktop-host.ts";
import { ReachabilityOperations } from "../server/reachability/operations.ts";
import { publicReachabilityError } from "../server/routes/owner-reachability.ts";

const SOCKET_TAIL = "/resolver-0123456789ab.sock";

test("Gozar home must leave room for its resolver socket inside the AF_UNIX limit", () => {
  const ok = "/".padEnd(103 - SOCKET_TAIL.length, "a");
  assert.equal(Buffer.byteLength(ok + SOCKET_TAIL), 103);
  assert.doesNotThrow(() => requireUsableSocketHome(ok));
  assert.throws(() => requireUsableSocketHome(`${ok}a`), { code: "host_path_too_long" });
  // A typical Linux profile with the real app layout is fine.
  assert.doesNotThrow(() => requireUsableSocketHome("/home/tnunamak/.local/share/dev.dataconnect/unified/reachability"));
  // The failing walk profile (131-byte socket path) is rejected, with a public code.
  const long = `/home/tnunamak/.tmp/pr679-walk/profile-pkg-1794981390/.local/share/dev.dataconnect/unified/reachability`;
  assert.equal(Buffer.byteLength(long + SOCKET_TAIL) > 103, true);
  assert.throws(() => requireUsableSocketHome(long), (error: unknown) => {
    assert.equal(publicReachabilityError(error).code, "host_path_too_long");
    return true;
  });
});

test("a masked apply failure is logged with its original class and message", async (t) => {
  const parent = process.env.TEST_TMPDIR ?? join(homedir(), ".tmp");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(parent, "rso-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lines: string[] = [];
  const original = console.error;
  console.error = (line: unknown) => { lines.push(String(line)); };
  t.after(() => { console.error = original; });
  const operations = new ReachabilityOperations(root);
  const { operationId } = await operations.start("start", null, async () => {
    throw Object.assign(new Error("listen EINVAL resolver.sock"), { code: "internal_error" });
  });
  for (let i = 0; i < 50 && (await operations.read(operationId)).stage === "applying"; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const record = await operations.read(operationId);
  assert.equal(record.failureCode, "reachability_unavailable");
  assert.equal(lines.some(line => line.includes(operationId) && line.includes("code=internal_error") && line.includes("listen EINVAL")), true);
});

async function waitSettled(operations: ReachabilityOperations, operationId: string) {
  for (let i = 0; i < 100 && (await operations.read(operationId)).stage === "applying"; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return operations.read(operationId);
}

test("a failed settlement write keeps the handle the effect returned", async (t) => {
  const parent = process.env.TEST_TMPDIR ?? join(homedir(), ".tmp");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(parent, "rso-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const original = console.error;
  console.error = () => {};
  t.after(() => { console.error = original; });
  const operations = new ReachabilityOperations(root);
  // Only the settled record fails; the intent and fallback records succeed.
  const journal = operations as unknown as { write(record: { stage: string }): Promise<void> };
  const realWrite = journal.write.bind(operations);
  journal.write = async (record) => {
    if (record.stage === "settled") throw Object.assign(new Error("EIO"), { code: "EIO" });
    return realWrite(record);
  };
  const handle = { id: "h-exact" } as never;
  const { operationId } = await operations.start("start", null, async () => ({ handle } as never));
  const record = await waitSettled(operations, operationId);
  assert.deepEqual(record.handle, handle);
  assert.equal(record.stage, "unknown-possibly-live");
  assert.equal(record.failureCode, "reachability_unavailable");
});

test("a thrown partial route handle is journaled", async (t) => {
  const parent = process.env.TEST_TMPDIR ?? join(homedir(), ".tmp");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(parent, "rso-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const original = console.error;
  console.error = () => {};
  t.after(() => { console.error = original; });
  const operations = new ReachabilityOperations(root);
  const handle = { id: "h-partial" } as never;
  const { operationId } = await operations.start("start", null, async () => {
    throw Object.assign(new Error("verify failed"), { code: "verification_failed", route: { handle } });
  });
  const record = await waitSettled(operations, operationId);
  assert.deepEqual(record.handle, handle);
  assert.equal(record.failureCode, "verification_failed");
  assert.equal(record.stage, "unknown-possibly-live");
});

test("a nullish thrown value still journals an uncertain failure", async (t) => {
  const parent = process.env.TEST_TMPDIR ?? join(homedir(), ".tmp");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(parent, "rso-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const original = console.error;
  console.error = () => {};
  t.after(() => { console.error = original; });
  const operations = new ReachabilityOperations(root);
  const { operationId } = await operations.start("start", null, async () => {
    // biome-ignore lint/style/useThrowOnlyError: nullish throw is the case under test
    throw undefined;
  });
  const record = await waitSettled(operations, operationId);
  assert.equal(record.stage, "unknown-possibly-live");
  assert.equal(record.failureCode, "reachability_unavailable");
});
