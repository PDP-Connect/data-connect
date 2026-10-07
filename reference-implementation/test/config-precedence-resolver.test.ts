// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { createConfigPrecedenceResolver } from "../server/stores/config-precedence-resolver.ts";

function storeOf(values: Record<string, string | null>) {
  return (key: string): Promise<string | null> =>
    Promise.resolve(Object.hasOwn(values, key) ? (values[key] ?? null) : null);
}

test("store value wins even when the env var is still present", async () => {
  const resolver = createConfigPrecedenceResolver({
    env: { INSTANCE_NAME: "env-supplied-name" },
    getStoredValue: storeOf({ instance_name: "owner-set-name" }),
  });
  const resolved = await resolver({ envAlias: "INSTANCE_NAME", key: "instance_name" });
  assert.equal(resolved, "owner-set-name");
});

test("env is consulted as a fallback only while the store has no value for the key", async () => {
  const resolver = createConfigPrecedenceResolver({
    env: { INSTANCE_NAME: "env-supplied-name" },
    getStoredValue: storeOf({}),
  });
  const resolved = await resolver({ envAlias: "INSTANCE_NAME", key: "instance_name" });
  assert.equal(resolved, "env-supplied-name");
});

test("env is consulted again once a previously-stored value is cleared", async () => {
  const values: Record<string, string | null> = { instance_name: "owner-set-name" };
  const resolver = createConfigPrecedenceResolver({
    env: { INSTANCE_NAME: "env-supplied-name" },
    getStoredValue: storeOf(values),
  });
  assert.equal(await resolver({ envAlias: "INSTANCE_NAME", key: "instance_name" }), "owner-set-name");

  // Simulates the owner clearing the stored value (e.g. a store delete) --
  // the store now reports unset for this key.
  delete values.instance_name;
  assert.equal(await resolver({ envAlias: "INSTANCE_NAME", key: "instance_name" }), "env-supplied-name");
});

test("a platform-owned key always resolves from env, even when the store has a value", async () => {
  const resolver = createConfigPrecedenceResolver({
    env: { AS_PORT: "9001" },
    getStoredValue: storeOf({ AS_PORT: "store-should-never-win-here" }),
    platformOwnedKeys: ["AS_PORT"],
  });
  const resolved = await resolver({ envAlias: "AS_PORT", key: "AS_PORT" });
  assert.equal(resolved, "9001");
});

test("a platform-owned key never calls into the store at all", async () => {
  let storeCalls = 0;
  const resolver = createConfigPrecedenceResolver({
    env: { PORT: "8080" },
    getStoredValue: (key: string) => {
      storeCalls += 1;
      return Promise.resolve(key === "PORT" ? "should-be-unreachable" : null);
    },
    platformOwnedKeys: ["PORT"],
  });
  const resolved = await resolver({ envAlias: "PORT", key: "PORT" });
  assert.equal(resolved, "8080");
  assert.equal(storeCalls, 0, "platform-owned keys must not touch the store");
});

test("a non-platform-owned key is unaffected by an unrelated entry on the exception list", async () => {
  const resolver = createConfigPrecedenceResolver({
    env: { INSTANCE_NAME: "env-supplied-name" },
    getStoredValue: storeOf({ instance_name: "owner-set-name" }),
    platformOwnedKeys: ["PORT", "AS_PORT", "RS_PORT"],
  });
  const resolved = await resolver({ envAlias: "INSTANCE_NAME", key: "instance_name" });
  assert.equal(resolved, "owner-set-name");
});

test("no envAlias means no env fallback at all, even if the store has nothing", async () => {
  const resolver = createConfigPrecedenceResolver({
    env: { SOME_UNRELATED_ENV: "irrelevant" },
    getStoredValue: storeOf({}),
  });
  const resolved = await resolver({ key: "unaliased_key" });
  assert.equal(resolved, null);
});

test("a blank env value normalizes to null just like an absent one", async () => {
  const resolver = createConfigPrecedenceResolver({
    env: { INSTANCE_NAME: "   " },
    getStoredValue: storeOf({}),
  });
  const resolved = await resolver({ envAlias: "INSTANCE_NAME", key: "instance_name" });
  assert.equal(resolved, null);
});

test("returns null when neither the store nor the env alias has a value", async () => {
  const resolver = createConfigPrecedenceResolver({
    env: {},
    getStoredValue: storeOf({}),
  });
  const resolved = await resolver({ envAlias: "INSTANCE_NAME", key: "instance_name" });
  assert.equal(resolved, null);
});
