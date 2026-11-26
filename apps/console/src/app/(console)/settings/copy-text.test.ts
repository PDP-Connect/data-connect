// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
// The one copy helper every settings copy button uses.
import assert from "node:assert/strict";
import test from "node:test";
import { copyFailureLine, copyText } from "./copy-text.ts";

async function withNavigator<T>(value: unknown, run: () => Promise<T>): Promise<T> {
  const before = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { value, configurable: true });
  try {
    return await run();
  } finally {
    if (before) Object.defineProperty(globalThis, "navigator", before);
    else Reflect.deleteProperty(globalThis, "navigator");
  }
}

test("copyText returns copied after the write resolves, with the text it was given", async () => {
  const written: string[] = [];
  const outcome = await withNavigator({ clipboard: { writeText: async (value: string) => void written.push(value) } }, () => copyText("abc"));
  assert.equal(outcome, "copied");
  assert.deepEqual(written, ["abc"]);
});

test("copyText waits for the write: it is not copied until the write settles", async () => {
  let settle!: () => void;
  const pending = new Promise<void>((resolve) => (settle = resolve));
  await withNavigator({ clipboard: { writeText: () => pending } }, async () => {
    let outcome: string | null = null;
    const copying = copyText("abc").then((value) => (outcome = value));
    await Promise.resolve();
    assert.equal(outcome, null);
    settle();
    await copying;
    assert.equal(outcome, "copied");
  });
});

test("copyText returns failed when the write rejects, and never throws", async () => {
  const outcome = await withNavigator({ clipboard: { writeText: async () => Promise.reject(new Error("denied")) } }, () => copyText("abc"));
  assert.equal(outcome, "failed");
});

test("copyText returns failed when the write throws before returning a promise", async () => {
  const outcome = await withNavigator(
    { clipboard: { writeText: () => { throw new Error("denied"); } } },
    () => copyText("abc")
  );
  assert.equal(outcome, "failed");
});

test("copyText returns unavailable with no clipboard, or no navigator at all", async () => {
  assert.equal(await withNavigator({}, () => copyText("abc")), "unavailable");
  assert.equal(await withNavigator(undefined, () => copyText("abc")), "unavailable");
});

test("copyText returns unavailable, and does not throw, when reading the clipboard throws", async () => {
  const locked = {
    get clipboard(): never {
      throw new Error("blocked");
    },
  };
  assert.equal(await withNavigator(locked, () => copyText("abc")), "unavailable");
});

test("only a copy that did not happen has a failure line, and the two failures differ", () => {
  assert.equal(copyFailureLine("copied"), null);
  const unavailable = copyFailureLine("unavailable");
  const failed = copyFailureLine("failed");
  assert.match(unavailable ?? "", /clipboard unavailable/i);
  assert.match(failed ?? "", /couldn.t copy/i);
  assert.notEqual(unavailable, failed);
});
