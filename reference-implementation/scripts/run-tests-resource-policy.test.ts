// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createOwnedTestResource, drainTestWorkers, type OwnedTestResource } from "./owned-test-resource.ts";
import { needsOuterPostgresDatabase, needsPostgresRestoreDatabase } from "./run-tests-db-requirements.ts";
import {
  POSTGRES_TEMPLATE_COLD_REQUIRED_FILES,
  isPostgresTemplateEligibleFilePath,
} from "./postgres-template-eligibility.ts";
import { deriveDedicatedPostgresDbNameForFile } from "./dedicated-postgres-db-name.ts";

test("only reviewed files bypass outer allocation; restore remains separate", () => {
  assert.equal(needsOuterPostgresDatabase("test/backup-table-inventory.test.ts"), false);
  assert.equal(needsOuterPostgresDatabase("test/postgres-record-index-bootstrap.test.ts"), false);
  assert.equal(needsOuterPostgresDatabase("test/unknown-postgres.test.ts"), true);
  assert.equal(needsOuterPostgresDatabase("test/backup-table-inventory-postgres.test.ts"), true);
  assert.equal(needsPostgresRestoreDatabase("test/backup-table-inventory-postgres.test.ts"), true);
  assert.equal(needsPostgresRestoreDatabase("test/unknown-postgres.test.ts"), false);
  const file = "test/backup-table-inventory-postgres.test.ts";
  const names = [
    deriveDedicatedPostgresDbNameForFile(file, "12345678", 1),
    deriveDedicatedPostgresDbNameForFile(file + ".restore", "12345678", 2),
    deriveDedicatedPostgresDbNameForFile(file + ".restore", "87654321", 2),
  ];
  assert.equal(new Set(names).size, 3);
});

test("all 37 cold-required entries remain cold, including helper-owned bootstrap", () => {
  assert.equal(POSTGRES_TEMPLATE_COLD_REQUIRED_FILES.length, 37);
  for (const file of POSTGRES_TEMPLATE_COLD_REQUIRED_FILES) {
    assert.equal(isPostgresTemplateEligibleFilePath(file), false, file);
  }
  assert.equal(isPostgresTemplateEligibleFilePath("test/unknown-postgres.test.ts"), false);
});

test("ownership is registered before provisioning and concurrent release drops once", async () => {
  const registry = new Set<OwnedTestResource>();
  let drops = 0;
  const resource = await createOwnedTestResource({
    registry,
    create: async (created) => { created(); return "url"; },
    provision: async () => { assert.equal(registry.size, 1); },
    destroy: async () => { drops++; },
  });
  await Promise.all([resource.release(), resource.release(), resource.release()]);
  assert.equal(drops, 1);
  assert.equal(registry.size, 0);
});

test("sentinel failure rolls back before returning the original failure", async () => {
  const registry = new Set<OwnedTestResource>();
  const fault = new Error("sentinel failure");
  let drops = 0;
  await assert.rejects(createOwnedTestResource({
    registry,
    create: async (created) => { created(); return "url"; },
    provision: async () => { throw fault; },
    destroy: async () => { drops++; },
  }), (error) => error === fault);
  assert.equal(drops, 1);
  assert.equal(registry.size, 0);
});

test("failure after CREATE but before helper return still rolls back", async () => {
  const registry = new Set<OwnedTestResource>();
  let drops = 0;
  await assert.rejects(createOwnedTestResource({
    registry,
    create: async (created) => { created(); throw new Error("unlock/end failed"); },
    provision: async () => { assert.fail("must not provision"); },
    destroy: async () => { drops++; },
  }), /unlock\/end failed/);
  assert.equal(drops, 1);
  assert.equal(registry.size, 0);
});

test("name collision never grants ownership or drops a foreign resource", async () => {
  const registry = new Set<OwnedTestResource>();
  await assert.rejects(createOwnedTestResource({
    registry,
    create: async () => { throw new Error("database already exists"); },
    provision: async () => { assert.fail("must not provision"); },
    destroy: async () => { assert.fail("must not drop"); },
  }), /already exists/);
  assert.equal(registry.size, 0);
});

test("the runner creates a file database before its owned cleanup can drop it", async () => {
  const runnerPath = join(dirname(fileURLToPath(import.meta.url)), "run-tests.ts");
  const runner = await readFile(runnerPath, "utf8");
  const allocationStart = runner.indexOf("async function allocateTestDb");
  const allocationEnd = runner.indexOf("interface NodeTestResult", allocationStart);
  assert.notEqual(allocationStart, -1);
  assert.notEqual(allocationEnd, -1);
  const allocation = runner.slice(allocationStart, allocationEnd);
  const createIndex = allocation.indexOf("CREATE DATABASE");
  const dropIndex = allocation.indexOf("DROP DATABASE");
  assert.notEqual(createIndex, -1);
  assert.notEqual(dropIndex, -1);
  assert.ok(createIndex < dropIndex, "the runner must never pre-drop a same-named database");
});

test("failed rollback remains registered and can be retried", async () => {
  const registry = new Set<OwnedTestResource>();
  let drops = 0;
  await assert.rejects(createOwnedTestResource({
    registry,
    create: async (created) => { created(); return "url"; },
    provision: async () => { throw new Error("provision failed"); },
    destroy: async () => { if (++drops === 1) throw new Error("drop unavailable"); },
  }), AggregateError);
  assert.equal(registry.size, 1);
  await drainTestWorkers([...registry].map((resource) => resource.release()));
  assert.equal(drops, 2);
  assert.equal(registry.size, 0);
});

test("worker failure does not permit cleanup before another worker settles", async () => {
  let finish: () => void = () => {};
  const activeWorker = new Promise<void>((resolve) => { finish = resolve; });
  let cleanup = false;
  const draining = drainTestWorkers([Promise.reject(new Error("worker failed")), activeWorker])
    .finally(() => { cleanup = true; });
  draining.catch(() => {});
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(cleanup, false);
  finish();
  await assert.rejects(draining, AggregateError);
  assert.equal(cleanup, true);
});
