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
  BindingAccessPolicyError,
  createConnectorBindingAccessPolicyStore,
  type PreparedBindingAccess,
} from "../server/stores/connector-binding-access-policy-store.ts";
import {
  createPostgresConnectorInstanceConfigStore,
  createSqliteConnectorInstanceConfigStore,
} from "../server/stores/connector-instance-config-store.ts";
import { policyAction, preparedAccess, weakAck } from "./helpers/binding-access-policy-fixture.ts";
import { bindingQuery, seedBindingConnection } from "./helpers/binding-authority-fixture.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";

const POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);
let dir: string;
let path: string;
let clock = 1_800_000_000_000;
const store = () => createConnectorBindingAccessPolicyStore(() => clock);
const code = (expected: string) => (error: unknown) =>
  error instanceof BindingAccessPolicyError && error.code === expected;
before(async () => {
  if (POSTGRES_URL) {
    await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
  } else {
    dir = mkdtempSync(join(tmpdir(), "binding-access-"));
    path = join(dir, "policy.sqlite");
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
async function propose(connectionId: string) {
  const snapshot = preparedAccess(connectionId);
  const state = await store().read(snapshot);
  return store().propose({
    baseEpoch: state.epoch,
    baseRevision: state.revision,
    provenance: { metadata: { full: [true, null, 4] }, source: "trusted-fixture-prepare" },
    snapshot,
  });
}

test("absent and proposed policy cannot authorize; explicit exact confirmation yields only acknowledged channels and survives reopen", async () => {
  await seedBindingConnection("policy-roundtrip");
  const snapshot = preparedAccess("policy-roundtrip");
  assert.deepEqual(await store().resolve(snapshot), []);
  const proposal = await propose(snapshot.connectionId);
  assert.deepEqual(await store().resolve(snapshot), []);
  const confirmed = await store().decide(policyAction(proposal), "confirm", weakAck(snapshot));
  const authorizations = await store().resolve(snapshot);
  assert.deepEqual(authorizations, [
    {
      accessIdentity: "fixture-prepared-files",
      accessRevision: "3",
      channel: "filesystem.inputs",
      connectionId: snapshot.connectionId,
      expiresAt: snapshot.expiresAt,
      instanceKey: "files",
      ownerId: snapshot.ownerId,
      policyIdentity: snapshot.policyIdentity,
      revoked: false,
    },
  ]);
  const replay = await store().decide(policyAction(proposal), "confirm", weakAck(snapshot));
  assert.equal(replay.confirmedAt, confirmed.confirmedAt);
  if (POSTGRES_URL) {
    await closePostgresStorage();
    await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
  } else {
    closeDb();
    initDb(path);
  }
  const state = await store().read(snapshot, proposal.proposalId);
  assert.deepEqual(state.active, confirmed);
  assert.deepEqual(state.proposal?.snapshot, snapshot);
  assert.deepEqual(state.proposal?.provenance, proposal.provenance);
  assert.deepEqual(await store().resolve(snapshot), authorizations);
});

test("wrong digest, revision, owner and acknowledgments refuse without changing proposal or pointer", async () => {
  await seedBindingConnection("policy-invalid");
  const proposal = await propose("policy-invalid");
  const action = policyAction(proposal);
  await assert.rejects(
    store().decide({ ...action, snapshotDigest: "a".repeat(64) }, "confirm", weakAck(proposal.snapshot)),
    code("conflict")
  );
  await assert.rejects(store().decide({ ...action, revision: 99 }, "confirm", []), code("conflict"));
  await assert.rejects(store().decide({ ...action, ownerId: "foreign" }, "confirm", []), code("not_found"));
  await Promise.all(
    [
      { instanceKey: "other" },
      { channel: "other" },
      { accessIdentity: "other" },
      { accessRevision: "4" },
      { coverage: "not_observable" },
      { channel: "fixture.enforced", coverage: "enforced" },
    ].map(async (patch) => {
      await assert.rejects(
        store().decide(action, "confirm", [{ ...weakAck(proposal.snapshot)[0], ...patch }] as Parameters<
          ReturnType<typeof store>["decide"]
        >[2]),
        code("invalid")
      );
    })
  );
  assert.equal((await store().read(proposal.snapshot)).proposal?.status, "proposed");
  assert.equal((await store().read(proposal.snapshot)).epoch, 0);
  assert.deepEqual(await store().resolve(proposal.snapshot), []);
});

test("same identities with changed preparation facts never resolve an authorization", async () => {
  await seedBindingConnection("policy-facts");
  const proposal = await propose("policy-facts");
  await store().decide(policyAction(proposal), "confirm", weakAck(proposal.snapshot));
  const original = proposal.snapshot;
  const changes: PreparedBindingAccess[] = [
    { ...original, ownerId: "foreign" },
    { ...original, connectionId: "absent" },
    { ...original, policyIdentity: "changed" },
    { ...original, expiresAt: original.expiresAt + 1 },
    ...[
      { accessRevision: "4" },
      { accessIdentity: "reused" },
      { instanceKey: "other" },
      { kind: "network" },
      { mechanism: "different" },
      { mechanismVersion: "3" },
      { requestedDeclaration: { changed: true } },
      { effectiveReach: { inputs: ["/fixture/wider"] } },
      { effectiveConstraints: { outputs: ["/fixture/wider"] } },
      { remainingAmbientAccess: ["changed ambient"] },
      { channels: [{ coverage: "enforced", name: "filesystem.inputs" }] },
      { availability: "unavailable" },
      { purpose: "changed purpose" },
    ].map((patch) => ({ ...original, instances: [{ ...original.instances[0], ...patch }] }) as PreparedBindingAccess),
  ];
  await Promise.all(
    changes.map(async (changed) => {
      assert.deepEqual(await store().resolve(changed), [], JSON.stringify(changed));
    })
  );
  assert.equal((await store().resolve(original)).length, 1);
});

test("two proposals at one epoch: concurrent competing confirmations have one winner; loser cannot replace it", async () => {
  await seedBindingConnection("policy-race");
  const first = await propose("policy-race");
  const second = await propose("policy-race");
  const outcomes = await Promise.allSettled(
    [first, second].map((proposal) => store().decide(policyAction(proposal), "confirm", weakAck(proposal.snapshot)))
  );
  assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 1);
  const state = await store().read(first.snapshot);
  assert.equal(state.epoch, 1);
  assert.ok(state.active);
  const loser = state.active.proposalId === first.proposalId ? second : first;
  await assert.rejects(
    store().decide({ ...policyAction(loser), baseEpoch: state.epoch }, "confirm", weakAck(loser.snapshot)),
    code("stale")
  );
  assert.equal((await store().read(first.snapshot, loser.proposalId)).proposal?.status, "superseded");
  assert.equal((await store().read(first.snapshot)).active?.proposalId, state.active.proposalId);
});

test("rejection is terminal, withdrawal prevents future resolution, expiry cannot confer access, replay does not resurrect", async () => {
  await seedBindingConnection("policy-terminal");
  const rejected = await propose("policy-terminal");
  await store().decide(policyAction(rejected), "reject");
  assert.equal((await store().decide(policyAction(rejected), "reject")).status, "rejected");
  await assert.rejects(store().decide(policyAction(rejected), "confirm", weakAck(rejected.snapshot)), code("stale"));
  assert.deepEqual(await store().resolve(rejected.snapshot), []);
  const proposal = await propose("policy-terminal");
  const confirmed = await store().decide(policyAction(proposal), "confirm", weakAck(proposal.snapshot));
  const state = await store().read(proposal.snapshot);
  const withdraw = { ...policyAction(proposal), baseEpoch: state.epoch };
  await store().decide(withdraw, "withdraw");
  assert.equal((await store().decide(withdraw, "withdraw")).confirmedAt, confirmed.confirmedAt);
  assert.deepEqual(await store().resolve(proposal.snapshot), []);
  await assert.rejects(store().decide(policyAction(proposal), "confirm", weakAck(proposal.snapshot)), code("stale"));
  const expiring = await propose("policy-terminal");
  await store().decide(policyAction(expiring), "confirm", weakAck(expiring.snapshot));
  clock = expiring.snapshot.expiresAt;
  assert.deepEqual(await store().resolve(expiring.snapshot), []);
  clock = 1_800_000_000_000;
});

test("unavailable/unsupported preparation cannot be approved into a grant or enforcement", async () => {
  await Promise.all(
    (["unsupported", "unavailable", "denied"] as const).map(async (availability) => {
      await seedBindingConnection(`policy-${availability}`);
      const snapshot = preparedAccess(`policy-${availability}`);
      const unavailable = { ...snapshot, instances: snapshot.instances.map((item) => ({ ...item, availability })) };
      const proposal = await store().propose({ baseEpoch: 0, baseRevision: 0, provenance: {}, snapshot: unavailable });
      await assert.rejects(store().decide(policyAction(proposal), "confirm", weakAck(snapshot)), code("invalid"));
      await store().decide(policyAction(proposal), "confirm", []);
      assert.deepEqual(await store().resolve(unavailable), []);
      assert.equal((await store().read(snapshot)).active?.snapshot.instances[0]?.availability, availability);
    })
  );
});

test("live transfer hides prior payload from both owners, transfer back cannot revive approvals, deletion cascades", async () => {
  await seedBindingConnection("policy-transfer");
  const proposal = await propose("policy-transfer");
  await store().decide(policyAction(proposal), "confirm", weakAck(proposal.snapshot));
  await bindingQuery("UPDATE connector_instances SET owner_subject_id = ? WHERE connector_instance_id = ?", [
    "new-owner",
    "policy-transfer",
  ]);
  await assert.rejects(store().read(proposal.snapshot, proposal.proposalId), code("not_found"));
  await assert.rejects(
    store().read({ ...proposal.snapshot, ownerId: "new-owner" }, proposal.proposalId),
    code("not_found")
  );
  assert.equal((await store().read({ ...proposal.snapshot, ownerId: "new-owner" })).proposal, null);
  await bindingQuery("UPDATE connector_instances SET owner_subject_id = ? WHERE connector_instance_id = ?", [
    "owner_local",
    "policy-transfer",
  ]);
  assert.deepEqual(await store().resolve(proposal.snapshot), []);
  assert.equal((await store().read(proposal.snapshot, proposal.proposalId)).proposal?.status, "withdrawn");
  await assert.rejects(store().decide(policyAction(proposal), "confirm", weakAck(proposal.snapshot)), code("stale"));
  await bindingQuery("DELETE FROM connector_instances WHERE connector_instance_id = ?", ["policy-transfer"]);
  assert.deepEqual(await store().resolve(proposal.snapshot), []);
  const rows = await bindingQuery(
    "SELECT COUNT(*) AS n FROM connector_binding_access_policies WHERE connection_id = ?",
    ["policy-transfer"]
  );
  assert.equal(Number(rows[0]?.n), 0);
});

test("prepared payload is copied before waiting; non-JSON and nonfinite expiry are refused without writes", async () => {
  await seedBindingConnection("policy-bounds");
  const snapshot = preparedAccess("policy-bounds");
  await Promise.all(
    [Number.POSITIVE_INFINITY, Number.NaN, clock].map(async (expiresAt) => {
      await assert.rejects(
        store().propose({ baseEpoch: 0, baseRevision: 0, provenance: {}, snapshot: { ...snapshot, expiresAt } }),
        code("invalid")
      );
    })
  );
  const poison = {
    get secret() {
      throw new Error("fixture-private-marker");
    },
  };
  await assert.rejects(
    store().propose({ baseEpoch: 0, baseRevision: 0, provenance: poison, snapshot }),
    code("invalid")
  );
  const mutable = JSON.parse(JSON.stringify(snapshot)) as { policyIdentity: string } & PreparedBindingAccess;
  const waiting = store().propose({ baseEpoch: 0, baseRevision: 0, provenance: {}, snapshot: mutable });
  mutable.policyIdentity = "changed-after-call";
  const proposal = await waiting;
  assert.equal(proposal.snapshot.policyIdentity, snapshot.policyIdentity);
  await assert.rejects(store().propose({ baseEpoch: 0, baseRevision: 0, provenance: {}, snapshot }), code("stale"));
});

test("proposal captures baseRevision before its PostgreSQL transaction lock wait", () =>
  assertCapturedProposalBase("baseRevision"));
test("proposal captures baseEpoch before its PostgreSQL transaction lock wait", () =>
  assertCapturedProposalBase("baseEpoch"));

async function assertCapturedProposalBase(field: "baseRevision" | "baseEpoch"): Promise<void> {
  const connectionId = `policy-captured-${field}`;
  await seedBindingConnection(connectionId);
  const snapshot = preparedAccess(connectionId);
  const first = await store().propose({ baseEpoch: 0, baseRevision: 0, provenance: {}, snapshot });
  if (field === "baseEpoch") {
    await store().decide(policyAction(first), "confirm", weakAck(snapshot));
  }
  const initialState = await store().read(snapshot);
  const input = { baseEpoch: 0, baseRevision: field === "baseEpoch" ? 1 : 0, provenance: {}, snapshot };
  if (POSTGRES_URL) {
    let release: () => void = () => undefined;
    let locked: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let holderPid = 0;
    const holder = withPostgresTransaction(async (client) => {
      const pid = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      holderPid = pid.rows[0]?.pid ?? 0;
      await client.query(
        "SELECT connector_instance_id FROM connector_instances WHERE connector_instance_id = $1 FOR UPDATE",
        [connectionId]
      );
      locked();
      await gate;
    });
    await ready;
    const pending = store().propose(input);
    const refused = assert.rejects(pending, code("stale"));
    try {
      // PostgreSQL itself must report this request waiting before the caller mutates its input.
      await waitForPolicyLock(holderPid);
      input[field] = 1;
    } finally {
      release();
      await holder;
    }
    await refused;
  } else {
    const pending = store().propose(input);
    input[field] = 1;
    await assert.rejects(pending, code("stale"));
  }
  const finalState = await store().read(snapshot);
  assert.equal(finalState.revision, initialState.revision, "caller mutation must not append another proposal");
  assert.equal(finalState.epoch, initialState.epoch);
  assert.equal(finalState.active?.proposalId, initialState.active?.proposalId);
}

test("collection_scope confirmation and transport config activation never authorize binding access", async () => {
  await seedBindingConnection("policy-configs");
  const configs = POSTGRES_URL
    ? createPostgresConnectorInstanceConfigStore()
    : createSqliteConnectorInstanceConfigStore();
  await bindingQuery("UPDATE connectors SET connector_id = connector_id WHERE connector_id = ?", [
    "binding-fixture-connector",
  ]);
  await bindingQuery(
    "INSERT INTO connectors(connector_id, manifest, created_at) VALUES (?, '{}', ?) ON CONFLICT DO NOTHING",
    ["slack", "2026-11-03T00:00:00.000Z"]
  );
  await bindingQuery("UPDATE connector_instances SET connector_id = ? WHERE connector_instance_id = ?", [
    "slack",
    "policy-configs",
  ]);
  const snapshot = preparedAccess("policy-configs");
  const provenance = {
    isExplicit: true,
    origin: "owner" as const,
    setAt: "2026-11-03T00:00:00.000Z",
    setBy: "owner_local",
    sourceOfChange: "fixture config choice",
  };
  const scope = await configs.propose({
    baseEpoch: 1,
    baseRevision: 0,
    config: { CHANNEL_ALLOWLIST: ["fixture-channel"] },
    connectorInstanceId: snapshot.connectionId,
    provenance,
  });
  assert.equal(scope.optionKind, "collection_scope");
  await configs.confirm({
    authenticatedOwnerSubjectId: snapshot.ownerId,
    confirmedAt: provenance.setAt,
    connectorInstanceId: snapshot.connectionId,
    revision: scope.revision,
  });
  assert.deepEqual(await store().resolve(snapshot), []);
  const pointer = await configs.getCurrentPointer(snapshot.connectionId);
  assert.ok(pointer);
  const transport = await configs.propose({
    baseEpoch: pointer.storageEpoch,
    baseRevision: pointer.activeRevision,
    config: { SKIP_FILES: true },
    connectorInstanceId: snapshot.connectionId,
    provenance,
  });
  assert.equal(transport.optionKind, "transport");
  assert.equal(transport.status, "active");
  assert.deepEqual(await store().resolve(snapshot), []);
});

test("connection transactions serialize confirmation with live transfer and delete", async () => {
  await Promise.all(
    (["transfer", "delete"] as const).map(async (operation) => {
      await seedBindingConnection(`policy-lock-${operation}`);
      const proposal = await propose(`policy-lock-${operation}`);
      if (!POSTGRES_URL) {
        if (operation === "transfer") {
          await bindingQuery("UPDATE connector_instances SET owner_subject_id = ? WHERE connector_instance_id = ?", [
            "new-owner",
            proposal.snapshot.connectionId,
          ]);
        } else {
          await bindingQuery("DELETE FROM connector_instances WHERE connector_instance_id = ?", [
            proposal.snapshot.connectionId,
          ]);
        }
        await assert.rejects(
          store().decide(policyAction(proposal), "confirm", weakAck(proposal.snapshot)),
          code("not_found")
        );
        assert.deepEqual(await store().resolve(proposal.snapshot), []);
        return;
      }
      let release: () => void = () => undefined;
      let locked: () => void = () => undefined;
      const ready = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let holderPid = 0;
      const holder = withPostgresTransaction(async (client) => {
        const pid = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        holderPid = pid.rows[0]?.pid ?? 0;
        await client.query(
          "SELECT connector_instance_id FROM connector_instances WHERE connector_instance_id = $1 FOR UPDATE",
          [proposal.snapshot.connectionId]
        );
        locked();
        await gate;
        if (operation === "transfer") {
          await client.query(
            "UPDATE connector_instances SET owner_subject_id = 'new-owner' WHERE connector_instance_id = $1",
            [proposal.snapshot.connectionId]
          );
        } else {
          await client.query("DELETE FROM connector_instances WHERE connector_instance_id = $1", [
            proposal.snapshot.connectionId,
          ]);
        }
      });
      await ready;
      const confirming = store().decide(policyAction(proposal), "confirm", weakAck(proposal.snapshot));
      // Attach rejection handling before releasing the competing transaction.
      const refused = assert.rejects(confirming, code("not_found"));
      try {
        await waitForPolicyLock(holderPid);
      } finally {
        release();
        await holder;
      }
      await refused;
      assert.deepEqual(await store().resolve(proposal.snapshot), []);
    })
  );
});

test("model counterexample replay: prepare, change facts, confirm stored description, resolve changed access", async () => {
  await seedBindingConnection("policy-model-exact");
  const proposal = await propose("policy-model-exact");
  const changed = {
    ...proposal.snapshot,
    instances: proposal.snapshot.instances.map((item) => ({
      ...item,
      effectiveReach: { inputs: ["/fixture/changed-before-confirmation"] },
    })),
  };
  await store().decide(policyAction(proposal), "confirm", weakAck(proposal.snapshot));
  assert.deepEqual(await store().resolve(changed), []);
  assert.equal((await store().resolve(proposal.snapshot)).length, 1);
});

async function waitForPolicyLock(holderPid: number, started = performance.now()): Promise<void> {
  const [state] = await bindingQuery(
    "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND ? = ANY(pg_blocking_pids(pid))) AS waiting",
    [holderPid]
  );
  if (state?.waiting) {
    return;
  }
  assert.ok(performance.now() - started < 5000, "confirmation must wait on the locked live connection row");
  await new Promise<void>((resolve) => setImmediate(resolve));
  return waitForPolicyLock(holderPid, started);
}

test("decision failure rolls back status and active pointer atomically without leaking database errors", async () => {
  await seedBindingConnection("policy-rollback");
  const proposal = await propose("policy-rollback");
  if (POSTGRES_URL) {
    await bindingQuery(
      "CREATE FUNCTION binding_policy_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture-private-database-marker'; END $$"
    );
    await bindingQuery(
      "CREATE TRIGGER binding_policy_fault BEFORE UPDATE ON connector_binding_access_heads FOR EACH ROW EXECUTE FUNCTION binding_policy_fault()"
    );
  } else {
    await bindingQuery(
      "CREATE TRIGGER binding_policy_fault BEFORE UPDATE ON connector_binding_access_heads BEGIN SELECT RAISE(ABORT, 'fixture-private-database-marker'); END"
    );
  }
  try {
    await assert.rejects(
      store().decide(policyAction(proposal), "confirm", weakAck(proposal.snapshot)),
      (error: unknown) =>
        code("storage_error")(error) && !(error as Error).message.includes("fixture-private-database-marker")
    );
    const state = await store().read(proposal.snapshot, proposal.proposalId);
    assert.equal(state.epoch, 0);
    assert.equal(state.active, null);
    assert.equal(state.proposal?.status, "proposed");
    assert.equal(state.proposal?.confirmedAt, null);
    assert.deepEqual(await store().resolve(proposal.snapshot), []);
  } finally {
    if (POSTGRES_URL) {
      await bindingQuery("DROP TRIGGER binding_policy_fault ON connector_binding_access_heads");
      await bindingQuery("DROP FUNCTION binding_policy_fault()");
    } else {
      await bindingQuery("DROP TRIGGER binding_policy_fault");
    }
  }
  await store().decide(policyAction(proposal), "confirm", weakAck(proposal.snapshot));
  assert.equal((await store().resolve(proposal.snapshot)).length, 1);
});

// Real SQLite/PG transaction oracle: fault at resource insert must undo authority insert.
test("resource intent r41: atomic issue/replay, rollback, deletion survival and old receipt generation fence", async () => {
  const { bindingResourceReference } = await import("../runtime/binding-resource-reference.ts");
  const { createConnectorBindingResourceStore } = await import("../server/stores/connector-binding-resource-store.ts");
  const { createConnectorBindingAuthorityStore } = await import(
    "../server/stores/connector-binding-authority-store.ts"
  );
  const { decideBindingAuthority } = await import("../runtime/binding-authority.ts");
  const { reconcileProtectedBrowserResources } = await import("../server/protected-browser-recovery.ts");
  await seedBindingConnection("resource-r41");
  const snapshot: PreparedBindingAccess = {
    ...preparedAccess("resource-r41"),
    instances: [
      {
        ...preparedAccess("resource-r41").instances[0]!,
        instanceKey: "browser",
        kind: "browser",
        requestedDeclaration: { kind: "browser", required: true },
        channels: [
          { name: "browser.navigate", coverage: "not_observable" },
          { name: "browser.connect", coverage: "not_observable" },
        ],
      },
    ],
  };
  const policies = store();
  const proposal = await policies.propose({ snapshot, provenance: {}, baseEpoch: 0, baseRevision: 0 });
  const ack = ["browser.navigate", "browser.connect"].map((channel) => ({
    instanceKey: "browser",
    channel,
    coverage: "not_observable" as const,
    accessIdentity: snapshot.instances[0]!.accessIdentity,
    accessRevision: snapshot.instances[0]!.accessRevision,
  }));
  await policies.decide(policyAction(proposal), "confirm", ack);
  const reference = bindingResourceReference({
    version: 1,
    allocatorId: "fictional",
    deploymentId: "fictional",
    bindingScopeIdentity: "fictional",
    profileIdentity: "fictional-stable-profile",
    ownerId: snapshot.ownerId,
    connectionId: snapshot.connectionId,
    connectorId: "binding-fixture-connector",
    instanceKey: "browser",
    runId: "fixture-run-1",
    runGeneration: 1,
    reservationId: "fictional",
    containerId: "a".repeat(64),
    generation: "fictional-created",
    configurationRevision: "fictional-config",
  });
  assert.equal(Object.isFrozen(reference), true);
  assert.throws(() => bindingResourceReference({ ...reference, extra: true }));
  assert.throws(() => bindingResourceReference({ ...reference, containerId: "mutable-container-name" }));
  let getterCalled = false;
  const accessor = { ...reference };
  Object.defineProperty(accessor, "containerId", {
    enumerable: true,
    get() {
      getterCalled = true;
      return reference.containerId;
    },
  });
  assert.throws(() => bindingResourceReference(accessor));
  assert.equal(getterCalled, false);
  const recordFor = (resource: typeof reference) =>
    decideBindingAuthority({
      connectionId: snapshot.connectionId,
      ownerId: snapshot.ownerId,
      policyIdentity: snapshot.policyIdentity,
      runId: resource.runId,
      now: clock,
      accessIdentityByInstance: {
        browser: { identity: snapshot.instances[0]!.accessIdentity, revision: snapshot.instances[0]!.accessRevision },
      },
      instances: [
        {
          key: "browser",
          kind: "browser",
          interface: "browser@1",
          required: true,
          declaration: { kind: "browser", required: true },
        },
      ],
      resolutions: [
        {
          instanceKey: "browser",
          lifecycle: "granted",
          channels: {
            "browser.navigate": { coverage: "not_observable" },
            "browser.connect": { coverage: "not_observable" },
          },
          handleIdentity: JSON.stringify({ ...resource, runAdmissionGeneration: resource.runGeneration }),
        },
      ],
      weakerCoverageAuthorizations: ack.map((a) => ({
        ...a,
        ownerId: snapshot.ownerId,
        connectionId: snapshot.connectionId,
        expiresAt: snapshot.expiresAt,
        policyIdentity: snapshot.policyIdentity,
        revoked: false,
      })),
    }).record;
  const input = { snapshot, expectedAcknowledgments: ack, record: recordFor(reference), resource: reference };
  const first = await policies.issueRunAuthority(input);
  assert.equal((await policies.issueRunAuthority(input)).intentId, first.intentId);
  const resources = createConnectorBindingResourceStore();
  assert.equal((await resources.listUnresolved()).length, 1);
  const nextRef = bindingResourceReference({
    ...reference,
    runId: "fixture-run-2",
    runGeneration: 2,
    containerId: "b".repeat(64),
  });
  await assert.rejects(policies.issueRunAuthority({ ...input, resource: nextRef, record: recordFor(nextRef) }));
  assert.equal(
    await createConnectorBindingAuthorityStore().get({ ...snapshot, runId: nextRef.runId }),
    null,
    "failed profile claim rolls authority back"
  );
  const receipt = { version: 1 as const, reference, disposition: "removed" as const };
  const lost = await reconcileProtectedBrowserResources({
    store: resources,
    deadline: Date.now() + 5000,
    allocator: {
      recoverStoppedResource: async () => {
        throw new Error("fixture transport unavailable");
      },
    },
  });
  assert.equal(lost[0]?.status, "binding_cleanup_unverified");
  assert.equal((await resources.listUnresolved()).length, 1);
  await resources.retire(first.intentId, receipt);
  const second = await policies.issueRunAuthority({ ...input, resource: nextRef, record: recordFor(nextRef) });
  await assert.rejects(resources.retire(second.intentId, receipt));
  await resources.retire(first.intentId, receipt);
  assert.equal((await resources.listUnresolved())[0]?.intentId, second.intentId);
  const state = await policies.read(snapshot);
  await policies.decide({ ...policyAction(proposal), baseEpoch: state.epoch }, "withdraw");
  await assert.rejects(policies.issueRunAuthority({ ...input, resource: nextRef, record: recordFor(nextRef) }));
  await bindingQuery("DELETE FROM connector_instances WHERE connector_instance_id = ?", [snapshot.connectionId]);
  assert.equal(
    (await resources.listUnresolved())[0]?.intentId,
    second.intentId,
    "connection deletion cannot erase debt"
  );
  const order: string[] = [];
  const result = await reconcileProtectedBrowserResources({
    store: {
      listUnresolved: () => resources.listUnresolved(),
      retire: async (id, proof) => {
        await resources.retire(id, proof);
        order.push("committed");
      },
    },
    deadline: Date.now() + 5000,
    allocator: {
      recoverStoppedResource: async (ref) => ({ version: 1, reference: ref, disposition: "removed" }),
      releaseRecoveredResource: async () => {
        assert.deepEqual(order, ["committed"]);
        order.push("released");
      },
    },
  });
  assert.equal(result[0]?.status, "removed");
  assert.deepEqual(order, ["committed", "released"]);
  assert.equal((await resources.listUnresolved()).length, 0);
});
