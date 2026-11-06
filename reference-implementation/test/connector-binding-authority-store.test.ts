// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { closeDb, initDb } from "../server/db.ts";
import { closePostgresStorage, initPostgresStorage, withPostgresTransaction } from "../server/postgres-storage.ts";
import {
  BINDING_AUTHORITY_MAX_BYTES,
  type BindingAuthorityPut,
  BindingAuthorityStoreError,
  createConnectorBindingAuthorityStore,
} from "../server/stores/connector-binding-authority-store.ts";
import { bindingFixture, bindingQuery, seedBindingConnection } from "./helpers/binding-authority-fixture.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";

const POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);
let dir: string;
let path: string;
before(async () => {
  if (POSTGRES_URL) {
    await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
  } else {
    dir = mkdtempSync(join(tmpdir(), "binding-authority-"));
    path = join(dir, "snapshot.sqlite");
    initDb(path);
  }
});
after(async () => {
  if (POSTGRES_URL) {
    await closePostgresStorage();
  } else {
    closeDb();
    rmSync(dir, { force: true, recursive: true });
  }
});
const store = () => createConnectorBindingAuthorityStore();
const code = (expected: string) => (error: unknown) =>
  error instanceof BindingAuthorityStoreError && error.code === expected;
async function count(connectionId: string): Promise<number> {
  const rows = await bindingQuery(
    "SELECT COUNT(*) AS n FROM connector_binding_authority_runs WHERE connection_id = ?",
    [connectionId]
  );
  return Number(rows[0]?.n);
}

// 3.3.9/10/13: keep all trusted facts; weaker coverage is not upgraded by persistence.
test("full Root model roundtrips durably and canonical idempotence preserves first timestamp", async () => {
  await seedBindingConnection("roundtrip");
  const input = bindingFixture("roundtrip");
  await store().put(input);
  const first = await store().get(input);
  assert.ok(first);
  assert.deepEqual(first.record, input.record);
  assert.equal(first.recordVersion, 1);
  assert.ok(Object.isFrozen(first.record.instances[0]?.requestedDeclaration));
  assert.ok(Object.isFrozen(first.record.instances[0]?.channels[0]?.authorization));
  // Reverse every object's key order without dropping nested members (JSON replacer arrays would drop them).
  function reverse(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map(reverse);
    }
    if (typeof value === "object" && value !== null) {
      return Object.fromEntries(
        Object.entries(value)
          .reverse()
          .map(([key, item]) => [key, reverse(item)])
      );
    }
    return value;
  }
  const replay = { ...input, record: reverse(input.record) as BindingAuthorityPut["record"] };
  await bindingQuery("UPDATE connector_binding_authority_runs SET recorded_at = ? WHERE connection_id = ?", [
    "2020-01-01T00:00:00.000Z",
    input.connectionId,
  ]);
  await store().put(replay);
  const stored = await store().get(input);
  assert.equal(stored?.recordedAt, "2020-01-01T00:00:00.000Z");
  if (POSTGRES_URL) {
    await closePostgresStorage();
    await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
  } else {
    closeDb();
    initDb(path);
  }
  assert.deepEqual(await store().get(input), stored);
  assert.equal(await count(input.connectionId), 1);
});

test("unknown JSON metadata is retained without caller-owned aliases", async () => {
  await seedBindingConnection("aliases");
  const input = bindingFixture("aliases");
  const metadata = { explicitNull: null, nested: ["original"], unicode: { é: 2, é: 1 } };
  const record = { ...input.record, futureMetadata: metadata };
  const expected = JSON.parse(JSON.stringify(record)) as unknown;
  const pending = store().put({ ...input, record });
  metadata.nested[0] = "changed after call";
  await pending;
  const first = await store().get(input);
  const second = await store().get(input);
  assert.deepEqual(first?.record, expected);
  assert.notEqual(first?.record, second?.record);
  assert.ok(Object.isFrozen(first?.record));
});

test("conflicting replay is typed and cannot overwrite any original fact", async () => {
  await seedBindingConnection("conflict");
  const input = bindingFixture("conflict");
  await store().put(input);
  const first = await store().get(input);
  const changed = { ...input, record: { ...input.record, instances: [] } };
  await assert.rejects(store().put(changed), code("record_conflict"));
  await assert.rejects(
    store().put({ ...input, policyIdentity: "other", record: { ...input.record, policyIdentity: "other" } }),
    code("record_conflict")
  );
  assert.deepEqual(await store().get(input), first);
});

test("live namespace guard rejects foreign writers and record namespace mismatches before mutation", async () => {
  await seedBindingConnection("namespace");
  const input = bindingFixture("namespace");
  await assert.rejects(store().put(bindingFixture("namespace", "run-shared", "other-owner")), code("namespace_denied"));
  await assert.rejects(store().put(bindingFixture("absent")), code("namespace_denied"));
  await Promise.all(
    (["ownerId", "connectionId", "runId", "policyIdentity"] as const).map(async (field) => {
      await assert.rejects(
        store().put({ ...input, record: { ...input.record, [field]: "mismatch" } }),
        code("record_invalid")
      );
    })
  );
  assert.equal(await count("namespace"), 0);
});

test("owner connection and run isolation includes transfer without exposing former payload", async () => {
  await seedBindingConnection("isolate-a");
  await seedBindingConnection("isolate-b");
  const input = bindingFixture("isolate-a");
  await store().put(input);
  assert.equal(await store().get({ ...input, ownerId: "other-owner" }), null);
  assert.equal(await store().get({ ...input, connectionId: "isolate-b" }), null);
  assert.equal(await store().get({ ...input, runId: "missing" }), null);
  await store().put(bindingFixture("isolate-b"));
  assert.deepEqual((await store().get(bindingFixture("isolate-b")))?.record, bindingFixture("isolate-b").record);
  await bindingQuery("UPDATE connector_instances SET owner_subject_id = ? WHERE connector_instance_id = ?", [
    "new-owner",
    "isolate-a",
  ]);
  assert.equal(await store().get(input), null);
  assert.equal(await store().get({ ...input, ownerId: "new-owner" }), null);
  await assert.rejects(store().put(input), code("namespace_denied"));
  await assert.rejects(store().put(bindingFixture("isolate-a", input.runId, "new-owner")), code("record_conflict"));
});

test("invalid non-JSON and oversized metadata mutate nothing and return bounded errors", async () => {
  await seedBindingConnection("invalid");
  const input = bindingFixture("invalid");
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  const bad = [
    undefined,
    Number.NaN,
    1n,
    () => 1,
    new Date(),
    cycle,
    new Array(2),
    {
      get unsafe() {
        throw new Error("fixture-secret-marker");
      },
    },
  ];
  await Promise.all(
    bad.map(async (metadata) => {
      const record = { ...input.record, metadata };
      await assert.rejects(store().put({ ...input, record }), code("record_invalid"));
    })
  );
  const record = { ...input.record, metadata: "x".repeat(BINDING_AUTHORITY_MAX_BYTES) };
  await assert.rejects(store().put({ ...input, record }), code("record_oversize"));
  const wide = {
    ...input.record,
    metadata: Array.from({ length: 4 }, () => "x".repeat(BINDING_AUTHORITY_MAX_BYTES / 3)),
  };
  await assert.rejects(store().put({ ...input, record: wide }), code("record_oversize"));
  const deep = Array.from({ length: 65 }).reduce<unknown>((nested) => ({ nested }), null);
  const deepRecord = { ...input.record, metadata: deep };
  await assert.rejects(store().put({ ...input, record: deepRecord }), code("record_invalid"));
  assert.equal(await count("invalid"), 0);
});

test("concurrent duplicate and conflicting puts retain one complete winner", async () => {
  await seedBindingConnection("concurrent");
  const input = bindingFixture("concurrent");
  await Promise.all(Array.from({ length: 6 }, () => store().put(input)));
  const first = await store().get(input);
  const outcomes = await Promise.allSettled([
    store().put(input),
    store().put({ ...input, record: { ...input.record, instances: [] } }),
  ]);
  assert.equal(outcomes[0]?.status, "fulfilled");
  assert.equal(outcomes[1]?.status, "rejected");
  if (outcomes[1]?.status === "rejected") {
    assert.ok(code("record_conflict")(outcomes[1].reason));
  }
  assert.deepEqual(await store().get(input), first);
  assert.equal(await count("concurrent"), 1);
  await seedBindingConnection("concurrent-first");
  const fresh = bindingFixture("concurrent-first");
  const changed = { ...fresh, record: { ...fresh.record, instances: [] } };
  const race = await Promise.allSettled([store().put(fresh), store().put(changed)]);
  assert.equal(race.filter((outcome) => outcome.status === "fulfilled").length, 1);
  const losers = race.filter((outcome) => outcome.status === "rejected");
  assert.equal(losers.length, 1);
  assert.ok(code("record_conflict")(losers[0]?.reason));
  const winner = race[0]?.status === "fulfilled" ? fresh : changed;
  assert.deepEqual((await store().get(fresh))?.record, winner.record);
  assert.equal(await count("concurrent-first"), 1);
});

test("connection deletion cascades and racing puts cannot resurrect a namespace", async () => {
  await seedBindingConnection("cascade");
  const input = bindingFixture("cascade");
  await store().put(input);
  const outcomes = await Promise.allSettled([
    bindingQuery("DELETE FROM connector_instances WHERE connector_instance_id = ?", ["cascade"]),
    store().put({ ...input, record: { ...input.record, runId: "racing" }, runId: "racing" }),
  ]);
  assert.equal(outcomes[0]?.status, "fulfilled");
  if (outcomes[1]?.status === "rejected") {
    assert.ok(code("namespace_denied")(outcomes[1].reason));
  }
  assert.equal(await count("cascade"), 0);
  assert.equal(await store().get(input), null);
});

test("corrupt version and payload fail closed without including stored content", async () => {
  await seedBindingConnection("corrupt");
  const input = bindingFixture("corrupt");
  await store().put(input);
  const original = JSON.stringify(input.record);
  await [
    "fixture-secret-marker{",
    JSON.stringify({ ...input.record, ownerId: "fixture-secret-marker" }),
    JSON.stringify({ ...input.record, instances: [{}] }),
  ].reduce(async (previous, payload) => {
    await previous;
    await bindingQuery("UPDATE connector_binding_authority_runs SET payload_json = ? WHERE connection_id = ?", [
      payload,
      "corrupt",
    ]);
    await assert.rejects(
      store().get(input),
      (error: unknown) => code("record_invalid")(error) && !(error as Error).message.includes("fixture-secret-marker")
    );
  }, Promise.resolve());
  await bindingQuery(
    "UPDATE connector_binding_authority_runs SET payload_json = ?, record_version = 2 WHERE connection_id = ?",
    [original, "corrupt"]
  );
  await assert.rejects(store().get(input), code("version_unsupported"));
  await assert.rejects(store().put(input), code("version_unsupported"));
});

test("namespace gate precedes payload load even when the hidden row is corrupt", async () => {
  await seedBindingConnection("gate-first");
  const input = bindingFixture("gate-first");
  await store().put(input);
  await bindingQuery("UPDATE connector_binding_authority_runs SET payload_json = ? WHERE connection_id = ?", [
    "fixture-secret-marker{",
    "gate-first",
  ]);
  assert.equal(await store().get({ ...input, ownerId: "foreign" }), null);
  await assert.rejects(store().get(input), code("record_invalid"));
});

test("transaction failure rolls back publication and parent locks exclude ownership changes", async () => {
  await seedBindingConnection("transaction-fault");
  const input = bindingFixture("transaction-fault");
  if (POSTGRES_URL) {
    await bindingQuery(
      "CREATE FUNCTION binding_insert_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture-secret-marker'; END $$"
    );
    await bindingQuery(
      "CREATE TRIGGER binding_insert_fault BEFORE INSERT ON connector_binding_authority_runs FOR EACH ROW EXECUTE FUNCTION binding_insert_fault()"
    );
  } else {
    await bindingQuery(
      "CREATE TRIGGER binding_insert_fault BEFORE INSERT ON connector_binding_authority_runs BEGIN SELECT RAISE(ABORT, 'fixture-secret-marker'); END"
    );
  }
  try {
    await assert.rejects(
      store().put(input),
      (error: unknown) => code("storage_error")(error) && !(error as Error).message.includes("fixture-secret-marker")
    );
    assert.equal(await count("transaction-fault"), 0);
  } finally {
    if (POSTGRES_URL) {
      await bindingQuery("DROP TRIGGER binding_insert_fault ON connector_binding_authority_runs");
      await bindingQuery("DROP FUNCTION binding_insert_fault()");
    } else {
      await bindingQuery("DROP TRIGGER binding_insert_fault");
    }
  }
  await store().put(input);
  assert.deepEqual((await store().get(input))?.record, input.record);
  if (!POSTGRES_URL) {
    return;
  }
  await seedBindingConnection("locked-transfer");
  let unlock: () => void = () => {
    throw new Error("barrier not initialized");
  };
  let locked: () => void = () => {
    throw new Error("barrier not initialized");
  };
  const barrier = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const release = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  let holderPid = 0;
  const transfer = withPostgresTransaction(async (client) => {
    const pid = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
    holderPid = pid.rows[0]?.pid ?? 0;
    await client.query(
      "UPDATE connector_instances SET owner_subject_id = 'new-owner' WHERE connector_instance_id = 'locked-transfer'"
    );
    locked();
    await release;
  });
  await barrier;
  const pending = store().put(bindingFixture("locked-transfer"));
  const start = performance.now();
  async function waitForLock(): Promise<void> {
    const [state] = await bindingQuery(
      "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND ? = ANY(pg_blocking_pids(pid))) AS waiting",
      [holderPid]
    );
    if (state?.waiting) {
      return;
    }
    assert.ok(performance.now() - start < 5000, "put must block on the live connection lock before ownership changes");
    await new Promise<void>((resolve) => setImmediate(resolve));
    return waitForLock();
  }
  try {
    await waitForLock();
  } finally {
    unlock();
    await transfer;
  }
  await assert.rejects(pending, code("namespace_denied"));
  assert.equal(await count("locked-transfer"), 0);
});
