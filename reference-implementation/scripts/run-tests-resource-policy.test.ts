// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { isDedicatedPostgresTestDatabaseName } from "../test/helpers/dedicated-postgres-test-url.ts";
import { deriveDedicatedPostgresDbNameForFile } from "./dedicated-postgres-db-name.ts";
import { createOwnedTestResource, type OwnedTestResource, settleAll } from "./owned-test-resource.ts";
import {
  isPostgresTemplateEligibleFilePath,
  POSTGRES_TEMPLATE_COLD_REQUIRED_FILES,
} from "./postgres-template-eligibility.ts";
import { needsOuterPostgresDatabase, needsPostgresRestoreDatabase } from "./run-tests-db-requirements.ts";

test("only reviewed files bypass outer allocation; restore remains separate", () => {
  assert.equal(needsOuterPostgresDatabase("test/backup-table-inventory.test.ts"), false);
  assert.equal(needsOuterPostgresDatabase("test/postgres-record-index-bootstrap.test.ts"), false);
  assert.equal(needsOuterPostgresDatabase("test/unknown-postgres.test.ts"), true);
  assert.equal(needsOuterPostgresDatabase("test/backup-table-inventory-postgres.test.ts"), true);
  assert.equal(needsPostgresRestoreDatabase("test/backup-table-inventory-postgres.test.ts"), true);
  assert.equal(needsPostgresRestoreDatabase("test/unknown-postgres.test.ts"), false);
  const file = "test/backup-table-inventory-postgres.test.ts";
  const fileName = file.split("/").pop() ?? file;
  const names = [
    deriveDedicatedPostgresDbNameForFile(file, "12345678", 1),
    deriveDedicatedPostgresDbNameForFile(`restore_${fileName}`, "12345678", 2),
    deriveDedicatedPostgresDbNameForFile(`restore_${fileName}`, "87654321", 2),
  ];
  const restoreName = names[1];
  assert.ok(restoreName);
  assert.equal(new Set(names).size, 3);
  assert.match(restoreName, /^pdpp_test_restore_/);
  assert.equal(isDedicatedPostgresTestDatabaseName(restoreName), true);
});

test("all 39 cold-required entries remain cold, including helper-owned bootstrap", () => {
  assert.equal(POSTGRES_TEMPLATE_COLD_REQUIRED_FILES.length, 39);
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

test("a created database is provisioned before its owned destroy runs", async () => {
  const registry = new Set<OwnedTestResource>();
  const operations: string[] = [];
  const resource = await createOwnedTestResource({
    registry,
    create: async (created) => {
      operations.push("CREATE DATABASE");
      created();
      return "url";
    },
    provision: async () => {
      operations.push("provision");
    },
    destroy: async () => {
      operations.push("DROP DATABASE");
    },
  });
  await resource.release();
  assert.deepEqual(operations, ["CREATE DATABASE", "provision", "DROP DATABASE"]);
});

test("failed rollback remains registered and can be retried", async () => {
  const registry = new Set<OwnedTestResource>();
  let drops = 0;
  const provisionError = new Error("provision failed");
  const dropError = new Error("drop unavailable");
  await assert.rejects(createOwnedTestResource({
    registry,
    create: async (created) => { created(); return "url"; },
    provision: async () => { throw provisionError; },
    destroy: async () => {
      if (++drops === 1) {
        throw dropError;
      }
    },
  }), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [provisionError, dropError]);
    return true;
  });
  assert.equal(registry.size, 1);
  await settleAll([...registry].map((resource) => resource.release()));
  assert.equal(drops, 2);
  assert.equal(registry.size, 0);
});

test("settleAll reports every rejected operation", async () => {
  const first = new Error("first failure");
  const second = new Error("second failure");
  await assert.rejects(settleAll([Promise.reject(first), Promise.reject(second)]), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [first, second]);
    return true;
  });
});

test("worker failure does not permit cleanup before another worker settles", async () => {
  let finish: () => void = () => {};
  const activeWorker = new Promise<void>((resolve) => { finish = resolve; });
  let cleanup = false;
  const draining = settleAll([Promise.reject(new Error("operation failed")), activeWorker])
    .finally(() => { cleanup = true; });
  draining.catch(() => {});
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(cleanup, false);
  finish();
  await assert.rejects(draining, AggregateError);
  assert.equal(cleanup, true);
});
