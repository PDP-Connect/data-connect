// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { resolveRunConnectorOptions } from "./connector-run-config.ts";

const instance = "synthetic-instance";
const blocked = (reason: string) => ({ code: "connector_run_config_blocked", reason });

test("store read failure blocks instead of substituting manifest defaults", async () => {
  await assert.rejects(resolveRunConnectorOptions({
    connectorInstanceId: instance,
    store: { getActiveRevision: async () => { throw new Error("synthetic read failure"); } },
  }), blocked("store_unreadable"));
});

test("malformed active options block instead of substituting manifest defaults", async () => {
  await assert.rejects(resolveRunConnectorOptions({
    connectorInstanceId: instance,
    store: { getActiveRevision: async () => ({config: ["synthetic-not-an-object"]}) as never },
  }), blocked("invalid_active_config"));
});

test("missing instance identity blocks before a store read", async () => {
  let reads = 0;
  await assert.rejects(resolveRunConnectorOptions({
    connectorInstanceId: "  ",
    store: { getActiveRevision: async () => { reads++; return null; } },
  }), blocked("missing_instance_identity"));
  assert.equal(reads, 0);
});

test("only a successful no-active answer returns the default sentinel", async () => {
  assert.equal(await resolveRunConnectorOptions({
    connectorInstanceId: instance, store: { getActiveRevision: async () => null },
  }), null);
  const config = {};
  assert.equal(await resolveRunConnectorOptions({
    connectorInstanceId: instance,
    store: { getActiveRevision: async () => ({config, revision: 1}) as never },
  }), config);
});
