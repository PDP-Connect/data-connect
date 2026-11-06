// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, watch } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BrowserSurfaceLeaseManager, DEFAULT_NEKO_PRIORITY_RANKS } from "@opendatalabs/remote-surface/leases";
import { BINDING_CONTROL_PREFIX, NekoBindingControlClient, postBindingControl } from "../runtime/binding-control.ts";
import { composeConnectorChildEnvironment } from "../runtime/connector-child-environment.ts";
import { canonicalConnectorKey } from "../server/connector-key.ts";
import { closeDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";
import {
  createNekoSurfaceAllocatorHttpHandler,
  type DockerEngineRequestInit,
  type DockerEngineTransport,
  NekoSurfaceAllocatorService,
} from "../server/neko-surface-allocator-server.ts";
import { closePostgresStorage, initPostgresStorage } from "../server/postgres-storage.ts";
import { createRequestConnectorInstanceStore } from "../server/request-store-factories.ts";
import {
  type AccessPolicyProposal,
  createConnectorBindingAccessPolicyStore,
} from "../server/stores/connector-binding-access-policy-store.ts";
import { createConnectorBindingAuthorityStore } from "../server/stores/connector-binding-authority-store.ts";
import { admitOwnerRunConnection } from "../server/stores/connector-instance-store.ts";
import { createSchedulerStore } from "../server/stores/scheduler-store.ts";
import { TEST_PRE_REGISTERED_PUBLIC_CLIENTS } from "./fixtures/demo-clients.ts";
import { bindingFixture, bindingQuery, seedBindingConnection } from "./helpers/binding-authority-fixture.ts";
import { approveClientGrant, issueOwnerToken } from "./helpers/binding-owner-auth.ts";
import { closeHttpServer as close, closeTestServer } from "./helpers/close-test-server.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";
import { withFixtureSourceDeclaration } from "./helpers/fixture-source-declaration.ts";

const PG = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);
const AT = "fictional-allocator-private-token-r24";
const RT = "fictional-authorizer-private-token-r24";
const IMAGE = `sha256:${"a".repeat(64)}`;
const START_RE = /^\/containers\/([^/]+)\/start$/;
const INSPECT_RE = /^\/containers\/([^/]+)\/json$/;
class Engine implements DockerEngineTransport {
  containers = new Map<string, { body: Record<string, unknown>; running: boolean }>();
  imageUnavailable: () => boolean = () => false;
  createdAt = "2026-11-03T00:00:00Z";
  starts = 0;
  stops = 0;
  beforeStop: (signal?: AbortSignal) => Promise<void> = async () => undefined;
  created = 0;
  startError: unknown;
  network = "fictional-network-one";
  afterStart: () => Promise<void> = async () => undefined;
  beforeStart: () => Promise<void> = async () => undefined;
  beforeInspect: () => Promise<void> = async () => undefined;
  async requestJson(path: string, init: DockerEngineRequestInit = {}): Promise<unknown> {
    if (path.startsWith("/images/")) {
      if (this.imageUnavailable()) {
        throw new Error("fictional-pruned-image");
      }
      return { Id: IMAGE };
    }
    if (path.startsWith("/networks/")) {
      return { Driver: "bridge", Id: this.network, Internal: false };
    }
    if (path === "/containers/json") {
      return [...this.containers].map(([Id, e]) => ({
        Id,
        Labels: e.body.Labels,
        Names: ["/fictional"],
        Ports: [],
        State: "created",
      }));
    }
    if (path === "/containers/create") {
      this.created += 1;
      const Id = `fictional-container-${this.created}`;
      this.containers.set(Id, { body: structuredClone(init.body) as Record<string, unknown>, running: false });
      return { Id };
    }
    const inspect = path.match(INSPECT_RE);
    if (inspect?.[1]) {
      await this.beforeInspect();
      const e = this.containers.get(inspect[1]);
      assert.ok(e);
      const b = e.body;
      return {
        Config: { Env: b.Env, Healthcheck: b.Healthcheck, Hostname: b.Hostname, Labels: b.Labels },
        Created: this.createdAt,
        HostConfig: b.HostConfig,
        Id: inspect[1],
        Image: IMAGE,
        Mounts: [{ Source: (b.HostConfig as { Binds: string[] }).Binds[0], Type: "bind" }],
        Name: "/fictional",
        NetworkSettings: {
          Networks: { "fixture-network": { NetworkID: this.network } },
          Ports: (b.HostConfig as { PortBindings: unknown }).PortBindings,
        },
        State: { Running: e.running, Status: e.running ? "running" : "created" },
      };
    }
    if (START_RE.test(path)) {
      try {
        await this.beforeStart();
      } catch (error) {
        this.startError = error;
        throw error;
      }
      this.starts += 1;
      const id = path.match(START_RE)?.[1];
      const container = id ? this.containers.get(id) : undefined;
      assert.ok(container);
      container.running = true;
      await this.afterStart();
      return null;
    }
    if (path.endsWith("/stop")) {
      await this.beforeStop(init.signal);
      const e = this.containers.get(path.split("/")[2] ?? "");
      assert.ok(e);
      this.stops += 1;
      e.running = false;
      return null;
    }
    if (init.method === "DELETE") {
      this.containers.delete(path.split("/")[2] ?? "");
      return null;
    }
    throw new Error("synthetic-private-config-marker");
  }
}
async function listen(s: Server): Promise<string> {
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  const a = s.address();
  assert.ok(a && typeof a !== "string");
  return `http://127.0.0.1:${a.port}`;
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
test("authenticated two-service owner confirmation commits exact authority before Engine start", async (t) => {
  if (PG) {
    await initPostgresStorage({ backend: "postgres", databaseUrl: PG });
  }
  const root = await mkdtemp(join(tmpdir(), "binding-r24-"));
  await chmod(root, 0o700);
  const engine = new Engine();
  const http = createServer();
  const url = await listen(http);
  const app = await startServer({
    asPort: 0,
    autoEnrollEligibleSchedules: false,
    dbPath: ":memory:",
    ownerAuthPassword: "",
    preRegisteredPublicClients: TEST_PRE_REGISTERED_PUBLIC_CLIENTS,
    quiet: true,
    rsPort: 0,
    storageBackend: PG ? "postgres" : "sqlite",
    ...(PG ? { databaseUrl: PG } : {}),
    browserBindingAdmission: {
      allocator: { credential: AT, timeoutMs: 30_000, url },
      credential: RT,
      policyIdentity: "operator-policy-fixture-r24",
    },
  });
  const rs = `http://127.0.0.1:${app.rsPort}`;
  const target = { credential: AT, timeoutMs: 30_000, url };
  let allocatorClockOffset = 0;
  const service = new NekoSurfaceAllocatorService({
    bindingControl: { authorizer: { credential: RT, timeoutMs: 30_000, url: rs }, credential: AT },
    cdpBaseUrlTemplate: "http://unused.test/{surface_id}",
    deploymentId: "fixture-r24",
    docker: engine,
    image: "fixture-image",
    network: "fixture-network",
    now: () => new Date(Date.now() + allocatorClockOffset),
    profileOwnerGid: process.getgid?.() ?? 0,
    profileOwnerUid: process.getuid?.() ?? 0,
    profileRoot: root,
    streamBaseUrlTemplate: "http://unused.test/{surface_id}",
    webrtcHostPortEnd: 59_099,
    webrtcHostPortStart: 59_000,
  });
  const allocatorHandler = createNekoSurfaceAllocatorHttpHandler(service);
  let activationFinished = Promise.resolve();
  let activationClosed = gate();
  http.on("request", (req, res) => {
    const pending = allocatorHandler(req, res);
    if (req.url === `${BINDING_CONTROL_PREFIX}/activate`) {
      activationFinished = pending;
      activationClosed = gate();
      res.once("close", activationClosed.release);
    }
  });
  const bridge = app.bindingAdmission;
  assert.ok(bridge);
  const owner = await issueOwnerToken(`http://127.0.0.1:${app.asPort}`);
  const foreign = await issueOwnerToken(`http://127.0.0.1:${app.asPort}`, "foreign-owner");
  const request = (path: string, token?: string, body?: unknown) =>
    fetch(`${rs}${path}`, {
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      method: body === undefined ? "GET" : "POST",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const callbackBodies: string[] = [];
  app.rsServer.prependListener("request", (req) => {
    if (req.url?.startsWith(`${BINDING_CONTROL_PREFIX}/`) && req.headers.authorization === `Bearer ${RT}`) {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => callbackBodies.push(Buffer.concat(chunks).toString("utf8")));
    }
  });
  const admittedRuns = new Map<string, string>();
  let seq = 0;
  const prepare = async (suffix: string, existing?: string) => {
    const connection = existing ?? `journey-${suffix}`;
    if (!existing) {
      await seedBindingConnection(connection);
    }
    const manifest = withFixtureSourceDeclaration({
      connector_key: "binding-fixture-connector",
      display_name: "Fictional browser",
      protocol_version: "0.1.0",
      runtime_requirements: { bindings: { browser: { required: true }, filesystem: { required: false } } },
      streams: [
        {
          name: "items",
          primary_key: ["id"],
          schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
          selection: { fields: true, resources: true },
          semantics: "append_only",
        },
      ],
      version: "1",
    });
    await bindingQuery("UPDATE connectors SET manifest = ? WHERE connector_id = ?", [
      JSON.stringify(manifest),
      "binding-fixture-connector",
    ]);
    seq += 1;
    const runId = `run-${seq}`;
    const store = createSchedulerStore();
    const previous = admittedRuns.get(connection);
    if (previous) {
      await store.deleteActiveRun(connection, previous);
    }
    assert.equal(
      await store.upsertActiveRun({
        connector_id: "binding-fixture-connector",
        connector_instance_id: connection,
        run_generation: seq,
        run_id: runId,
        scenario_id: "fictional-r24",
        started_at: new Date().toISOString(),
        trace_id: `trace-${seq}`,
      }),
      true
    );
    admittedRuns.set(connection, runId);
    const deadline = Date.now() + 25_000;
    return {
      ...(await bridge.prepareRun({
        connectionId: connection,
        deadline,
        policyExpiresAt: Date.now() + 600_000,
        runId,
      })),
      connection,
      deadline,
      runId,
    };
  };
  const confirm = async (p: AccessPolicyProposal) => {
    const acknowledgments = p.snapshot.instances.flatMap((i) =>
      i.availability === "prepared"
        ? i.channels.map((c) => ({
            accessIdentity: i.accessIdentity,
            accessRevision: i.accessRevision,
            channel: c.name,
            coverage: c.coverage,
            instanceKey: i.instanceKey,
          }))
        : []
    );
    const r = await request(
      `/v1/owner/connections/${p.snapshot.connectionId}/binding-access-policy/proposals/${p.proposalId}/confirm`,
      owner,
      { acknowledgments, baseEpoch: p.baseEpoch, revision: p.revision, snapshotDigest: p.snapshotDigest }
    );
    assert.equal(r.status, 200, await r.text());
  };
  try {
    await t.test("service authentication rejects anonymous, wrong and owner credentials", async () => {
      await [undefined, "wrong-token", owner].reduce(async (previous, token) => {
        await previous;
        const r = await fetch(`${url}${BINDING_CONTROL_PREFIX}/prepare`, {
          body: JSON.stringify({ approved: true, ownerId: "owner_local" }),
          headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          method: "POST",
        });
        assert.equal(r.status, 401);
        assert.equal((await request(`${BINDING_CONTROL_PREFIX}/authorize`, token, { approved: true })).status, 401);
      }, Promise.resolve());
      assert.equal(engine.containers.size, 0);
    });
    await t.test("control parse and payload errors are bounded and private", async () => {
      const marker = "synthetic-private-config-marker";
      await Promise.all(
        [rs, url].map(async (endpoint) => {
          const token = endpoint === rs ? RT : AT;
          const response = await fetch(`${endpoint}${BINDING_CONTROL_PREFIX}/authorize`, {
            body: `${marker}{`,
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            method: "POST",
          });
          assert.ok(response.status >= 400);
          const message = await response.text();
          assert.equal(message.includes(marker), false);
          assert.equal(message.includes(token), false);
        })
      );
    });
    await t.test("real grant token remains forbidden for owner decisions and runtime control", async () => {
      const manifest = JSON.parse(
        readFileSync(new URL("../fixtures/seed-manifests/spotify.json", import.meta.url), "utf8")
      ) as { connector_id: string; streams: { name: string }[] };
      const as = `http://127.0.0.1:${app.asPort}`;
      assert.equal(
        (
          await fetch(`${as}/connectors`, {
            body: JSON.stringify(manifest),
            headers: { "Content-Type": "application/json" },
            method: "POST",
          })
        ).status,
        201
      );
      const connectorId = canonicalConnectorKey(manifest.connector_id);
      assert.ok(connectorId);
      const namespace = await admitOwnerRunConnection({
        connectorId,
        connectorInstanceStore: createRequestConnectorInstanceStore(),
        ownerSubjectId: "owner_local",
      });
      const [stream] = manifest.streams;
      assert.ok(stream);
      const token = await approveClientGrant(as, manifest.connector_id, stream.name, namespace.connectorInstanceId);
      assert.equal(
        (await request(`/v1/owner/connections/${namespace.connectorInstanceId}/binding-access-policy`, token)).status,
        403
      );
      assert.equal((await request(`${BINDING_CONTROL_PREFIX}/authorize`, token, { approved: true })).status, 401);
      assert.equal(
        (
          await fetch(`${url}${BINDING_CONTROL_PREFIX}/prepare`, {
            body: "{}",
            headers: { Authorization: `Bearer ${token}` },
            method: "POST",
          })
        ).status,
        401
      );
    });
    await t.test("fresh owner policy and durable all-instance record precede start", async () => {
      const p = await prepare("positive");
      const path = `/v1/owner/connections/${p.connection}/binding-access-policy`;
      assert.equal((await request(path)).status, 401);
      assert.equal((await request(path, foreign)).status, 404);
      const displayed = await request(path, owner);
      assert.equal(displayed.status, 200);
      assert.deepEqual(
        ((await displayed.json()) as { proposal: AccessPolicyProposal }).proposal.snapshot,
        p.proposal.snapshot
      );
      await confirm(p.proposal);
      await Promise.all(
        [
          { ...p.reservation, reservationId: "replayed-reservation" },
          { ...p.reservation, scope: { ...p.reservation.scope, ownerId: "foreign-owner" } },
        ].map(async (changed) => {
          const denied = await request(`${BINDING_CONTROL_PREFIX}/authorize`, RT, {
            deadline: p.deadline,
            reservation: changed,
            runId: p.runId,
          });
          assert.equal(denied.status, 409);
          assert.equal(engine.starts, 0);
        })
      );
      assert.equal(
        (
          await request(`${BINDING_CONTROL_PREFIX}/authorize`, undefined, {
            deadline: p.deadline,
            reservation: p.reservation,
            runId: p.runId,
          })
        ).status,
        401
      );
      const [active] = await bindingQuery(
        "SELECT run_generation FROM controller_active_runs WHERE connector_instance_id = ? AND run_id = ?",
        [p.connection, p.runId]
      );
      assert.ok(active);
      await bindingQuery(
        "UPDATE controller_active_runs SET run_generation = run_generation + 1 WHERE connector_instance_id = ? AND run_id = ?",
        [p.connection, p.runId]
      );
      await assert.rejects(bridge.activateRun(p.connection, p));
      await bindingQuery(
        "UPDATE controller_active_runs SET run_generation = ? WHERE connector_instance_id = ? AND run_id = ?",
        [Number(active.run_generation), p.connection, p.runId]
      );
      engine.beforeStart = async () => {
        const stored = await createConnectorBindingAuthorityStore().get({
          connectionId: p.connection,
          ownerId: "owner_local",
          runId: p.runId,
        });
        assert.ok(stored, "durable writer must precede start dispatch");
        assert.equal(stored.policyIdentity, p.proposal.snapshot.policyIdentity);
        assert.equal(stored.record.instances.length, 2);
        const browser = stored.record.instances.find((i) => i.kind === "browser");
        assert.ok(browser);
        assert.deepEqual(JSON.parse(browser.handleIdentity ?? "null"), {
          reservationId: p.reservation.reservationId,
          runAdmissionGeneration: Number(active.run_generation),
          ...p.reservation.resource,
        });
        assert.ok(browser.channels.every((c) => c.coverage === "not_observable" && c.weakerCoverageAuthorized));
      };
      try {
        await bridge.activateRun(p.connection, p);
      } catch (error) {
        throw engine.startError ?? error;
      }
      assert.equal(engine.starts, 1);
      engine.beforeStart = async () => undefined;
    });
    await t.test("ownership transfer refuses admission and invalidates the old confirmation", async () => {
      const p = await prepare("ownership");
      await confirm(p.proposal);
      await bindingQuery(
        "UPDATE connector_instances SET owner_subject_id = 'foreign-owner' WHERE connector_instance_id = ?",
        [p.connection]
      );
      await assert.rejects(bridge.activateRun(p.connection, p));
      assert.equal(engine.starts, 1);
      await bindingQuery(
        "UPDATE connector_instances SET owner_subject_id = 'owner_local' WHERE connector_instance_id = ?",
        [p.connection]
      );
      assert.deepEqual(await createConnectorBindingAccessPolicyStore().resolve(p.proposal.snapshot), []);
    });
    await t.test("missing approval prevents start", async () => {
      const p = await prepare("missing");
      await assert.rejects(bridge.activateRun(p.connection, p));
      assert.equal(engine.starts, 1);
    });
    await t.test("wrong run replay prevents start", async () => {
      const p = await prepare("replay");
      await confirm(p.proposal);
      await assert.rejects(
        new NekoBindingControlClient(target).activate(p.reservation, { deadline: p.deadline, runId: "forged-run" })
      );
      assert.equal(engine.starts, 1);
    });
    await t.test("withdrawal during post-record resource revalidation prevents start", async () => {
      const p = await prepare("pause");
      await confirm(p.proposal);
      const arrived = gate();
      const resume = gate();
      let paused = false;
      engine.beforeInspect = async () => {
        if (
          !paused &&
          (await createConnectorBindingAuthorityStore().get({
            connectionId: p.connection,
            ownerId: "owner_local",
            runId: p.runId,
          }))
        ) {
          paused = true;
          arrived.release();
          await resume.promise;
        }
      };
      const activation = bridge.activateRun(p.connection, p);
      await Promise.race([
        arrived.promise,
        activation.then(
          () => assert.fail("resource pause must follow durable record"),
          () => assert.fail("authority must commit before resource revalidation")
        ),
      ]);
      const policies = createConnectorBindingAccessPolicyStore();
      const state = await policies.read(p.proposal.snapshot);
      await policies.decide(
        {
          ...p.proposal.snapshot,
          baseEpoch: state.epoch,
          proposalId: p.proposal.proposalId,
          revision: p.proposal.revision,
          snapshotDigest: p.proposal.snapshotDigest,
        },
        "withdraw"
      );
      resume.release();
      await assert.rejects(activation);
      engine.beforeInspect = async () => undefined;
      assert.equal(paused, true);
      assert.equal(engine.starts, 1);
    });
    await t.test("actual immutable writer failure prevents start", async () => {
      const p = await prepare("writer-failure");
      await confirm(p.proposal);
      await createConnectorBindingAuthorityStore().put(bindingFixture(p.connection, p.runId));
      await assert.rejects(bridge.activateRun(p.connection, p));
      assert.equal(engine.starts, 1);
    });
    await t.test("actual database write error prevents start without private error reflection", async () => {
      const p = await prepare("storage-error");
      await confirm(p.proposal);
      if (PG) {
        await bindingQuery(`CREATE FUNCTION r24_refuse_authority() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
          IF NEW.connection_id = 'journey-storage-error' THEN RAISE EXCEPTION 'synthetic-private-storage-marker'; END IF;
          RETURN NEW; END $$`);
        await bindingQuery(
          "CREATE TRIGGER r24_refuse_authority BEFORE INSERT ON connector_binding_authority_runs FOR EACH ROW EXECUTE FUNCTION r24_refuse_authority()"
        );
      } else {
        await bindingQuery(
          "CREATE TRIGGER r24_refuse_authority BEFORE INSERT ON connector_binding_authority_runs WHEN NEW.connection_id = 'journey-storage-error' BEGIN SELECT RAISE(ABORT, 'synthetic-private-storage-marker'); END"
        );
      }
      try {
        await assert.rejects(
          bridge.activateRun(p.connection, p),
          (error: Error) => error.message === "Browser binding control refused"
        );
        assert.equal(
          await createConnectorBindingAuthorityStore().get({
            connectionId: p.connection,
            ownerId: "owner_local",
            runId: p.runId,
          }),
          null
        );
        assert.equal(engine.starts, 1);
      } finally {
        await bindingQuery(
          PG
            ? "DROP TRIGGER r24_refuse_authority ON connector_binding_authority_runs"
            : "DROP TRIGGER r24_refuse_authority"
        );
        if (PG) {
          await bindingQuery("DROP FUNCTION r24_refuse_authority()");
        }
      }
    });
    await t.test("changed actual network after confirmation prevents start", async () => {
      const p = await prepare("network-change");
      await confirm(p.proposal);
      engine.network = "changed-network";
      try {
        await assert.rejects(bridge.activateRun(p.connection, p));
        assert.equal(engine.starts, 1);
      } finally {
        engine.network = "fictional-network-one";
      }
    });
    await t.test("cancel during post-record pause prevents later start", async () => {
      const p = await prepare("cancel");
      await confirm(p.proposal);
      const arrived = gate();
      const resume = gate();
      let paused = false;
      engine.beforeInspect = async () => {
        if (
          !paused &&
          (await createConnectorBindingAuthorityStore().get({
            connectionId: p.connection,
            ownerId: "owner_local",
            runId: p.runId,
          }))
        ) {
          paused = true;
          arrived.release();
          await resume.promise;
        }
      };
      const activation = bridge.activateRun(p.connection, p);
      await Promise.race([
        arrived.promise,
        activation.then(
          () => assert.fail("pause missing"),
          () => assert.fail("record missing")
        ),
      ]);
      await bridge.cancelRun(p.connection, p.runId, p.deadline);
      resume.release();
      await assert.rejects(activation);
      engine.beforeInspect = async () => undefined;
      assert.equal(engine.starts, 1);
    });
    await t.test("HTTP cancellation during authority pause cannot start later", async () => {
      const p = await prepare("http-cancel");
      await confirm(p.proposal);
      const arrived = gate();
      const resume = gate();
      let paused = false;
      engine.beforeInspect = async () => {
        if (
          !paused &&
          (await createConnectorBindingAuthorityStore().get({
            connectionId: p.connection,
            ownerId: "owner_local",
            runId: p.runId,
          }))
        ) {
          paused = true;
          arrived.release();
          await resume.promise;
        }
      };
      const abort = new AbortController();
      const pending = fetch(`${url}${BINDING_CONTROL_PREFIX}/activate`, {
        body: JSON.stringify({
          deadline: p.deadline,
          reservationId: p.reservation.reservationId,
          runId: p.runId,
          scope: p.reservation.scope,
        }),
        headers: { Authorization: `Bearer ${AT}`, "Content-Type": "application/json" },
        method: "POST",
        signal: abort.signal,
      });
      await Promise.race([arrived.promise, pending.then(() => assert.fail("pause missing"))]);
      abort.abort();
      await assert.rejects(pending);
      await activationClosed.promise;
      resume.release();
      await activationFinished;
      engine.beforeInspect = async () => undefined;
      assert.equal(engine.starts, 1);
    });
    await t.test("resource change after durable callback prevents start", async () => {
      const p = await prepare("late-resource");
      await confirm(p.proposal);
      const arrived = gate();
      const resume = gate();
      let paused = false;
      engine.beforeInspect = async () => {
        if (
          !paused &&
          (await createConnectorBindingAuthorityStore().get({
            connectionId: p.connection,
            ownerId: "owner_local",
            runId: p.runId,
          }))
        ) {
          paused = true;
          arrived.release();
          await resume.promise;
        }
      };
      const activation = bridge.activateRun(p.connection, p);
      await Promise.race([
        arrived.promise,
        activation.then(
          () => assert.fail("pause missing"),
          () => assert.fail("record missing")
        ),
      ]);
      engine.network = "late-resource-change";
      resume.release();
      try {
        await assert.rejects(activation);
        assert.equal(engine.starts, 1);
      } finally {
        engine.beforeInspect = async () => undefined;
        engine.network = "fictional-network-one";
      }
    });
    await t.test("unsupported required resources, constraints and features refuse before create", async () => {
      const p = await prepare("unsupported");
      await confirm(p.proposal);
      await bridge.cancelRun(p.connection, p.runId, p.deadline);
      const manifest = (
        await bindingQuery("SELECT manifest FROM connectors WHERE connector_id = ?", ["binding-fixture-connector"])
      )[0]?.manifest;
      const original = typeof manifest === "string" ? JSON.parse(manifest) : manifest;
      await [
        { browser: { required: true }, filesystem: { required: true } },
        { browser: { constraints: { navigate: ["example.com"] }, required: true } },
        { browser: { features: ["cookie_read"], required: true } },
      ].reduce(async (previous, binding) => {
        await previous;
        const parsed = structuredClone(original);
        parsed.runtime_requirements.bindings = binding;
        await bindingQuery("UPDATE connectors SET manifest = ? WHERE connector_id = ?", [
          JSON.stringify(parsed),
          "binding-fixture-connector",
        ]);
        const count = engine.containers.size;
        await assert.rejects(
          bridge.prepareRun({
            connectionId: p.connection,
            deadline: p.deadline,
            policyExpiresAt: Date.now() + 1000,
            runId: p.runId,
          })
        );
        assert.equal(engine.containers.size, count);
        assert.equal(engine.starts, 1);
      }, Promise.resolve());
      await bindingQuery("UPDATE connectors SET manifest = ? WHERE connector_id = ?", [
        JSON.stringify(original),
        "binding-fixture-connector",
      ]);
      await assert.rejects(
        bridge.prepareRun({
          connectionId: p.connection,
          deadline: p.deadline,
          policyExpiresAt: Date.now() - 1,
          runId: p.runId,
        })
      );
    });
    await t.test("expiry during post-record pause prevents later start", async () => {
      const p = await prepare("expiry");
      await confirm(p.proposal);
      const arrived = gate();
      const resume = gate();
      let paused = false;
      engine.beforeInspect = async () => {
        if (
          !paused &&
          (await createConnectorBindingAuthorityStore().get({
            connectionId: p.connection,
            ownerId: "owner_local",
            runId: p.runId,
          }))
        ) {
          paused = true;
          arrived.release();
          await resume.promise;
        }
      };
      const activation = bridge.activateRun(p.connection, p);
      await Promise.race([
        arrived.promise,
        activation.then(
          () => assert.fail("pause missing"),
          () => assert.fail("record missing")
        ),
      ]);
      allocatorClockOffset = 600_000;
      resume.release();
      try {
        await assert.rejects(activation);
        assert.equal(engine.starts, 1);
      } finally {
        allocatorClockOffset = 0;
        engine.beforeInspect = async () => undefined;
      }
    });
    await t.test("changed access requires another exact proposal", async () => {
      const p = await prepare("changed");
      await confirm(p.proposal);
      await bridge.cancelRun(p.connection, p.runId, p.deadline);
      engine.network = "new-approved-access-network";
      try {
        const next = await prepare("changed-next", p.connection);
        assert.notEqual(next.proposal.proposalId, p.proposal.proposalId);
        assert.notEqual(next.reservation.access.revision, p.reservation.access.revision);
        assert.equal((await createConnectorBindingAccessPolicyStore().resolve(next.proposal.snapshot)).length, 0);
        await assert.rejects(bridge.activateRun(next.connection, next));
        assert.equal(engine.starts, 1);
      } finally {
        engine.network = "fictional-network-one";
      }
    });
    await t.test("profile nlink changes preserve access; another reservation reuses approval", async () => {
      const p = await prepare("reuse");
      await confirm(p.proposal);
      const mount = [...engine.containers.values()].find(
        (e) =>
          (e.body.Labels as Record<string, string>)["org.pdpp.reference.neko.reservation"] ===
          p.reservation.reservationId
      );
      assert.ok(mount);
      const profile = (mount.body.HostConfig as { Binds: string[] }).Binds[0]?.split(":")[0];
      assert.ok(profile);
      await mkdir(join(profile, "harmless-content"));
      assert.equal(
        (await new NekoBindingControlClient(target).read(p.reservation.reservationId, p.reservation.scope, p.deadline))
          .access.revision,
        p.reservation.access.revision
      );
      await bridge.cancelRun(p.connection, p.runId, p.deadline);
      const next = await prepare("second", p.connection);
      assert.equal(
        next.proposal.proposalId,
        p.proposal.proposalId,
        "ephemeral generation must not change policy equality"
      );
      assert.notEqual(next.reservation.reservationId, p.reservation.reservationId);
      assert.notEqual(next.reservation.resource.containerId, p.reservation.resource.containerId);
      assert.notEqual(next.reservation.resource.generation, p.reservation.resource.generation);
      await bridge.activateRun(next.connection, next);
      assert.equal(engine.starts, 2);
    });
    await t.test(
      "owned cleanup rejects foreign replacement; survives expiry, owner transfer, image prune and missing profile",
      async () => {
        const p = await prepare("owned-stop");
        await confirm(p.proposal);
        await bridge.activateRun(p.connection, p);
        const client = new NekoBindingControlClient(target);
        const oldStops = engine.stops;
        await assert.rejects(
          client.stop(
            { ...p.reservation, scope: { ...p.reservation.scope, ownerId: "foreign-owner" } },
            Date.now() + 10_000
          )
        );
        engine.createdAt = "2026-11-03T00:00:01Z";
        await assert.rejects(client.stop(p.reservation, Date.now() + 10_000));
        assert.equal(engine.stops, oldStops, "replacement generation must never be stopped");
        engine.createdAt = "2026-11-03T00:00:00Z";
        // Keep the replacement refusal independent from the access-reducing
        // cleanup availability oracle; no replacement is adopted.
        const next = await prepare("owned-expired-stop");
        await confirm(next.proposal);
        await bridge.activateRun(next.connection, next);
        const entry = engine.containers.get(next.reservation.resource.containerId);
        assert.ok(entry);
        const [bind] = (entry.body.HostConfig as { Binds: string[] }).Binds;
        assert.ok(bind);
        const [profile] = bind.split(":");
        assert.ok(profile);
        await rm(profile, { recursive: true });
        await bindingQuery("UPDATE connector_instances SET owner_subject_id = ? WHERE connector_instance_id = ?", [
          "foreign-owner",
          next.connection,
        ]);
        allocatorClockOffset = 700_000;
        engine.imageUnavailable = () => true;
        try {
          await client.stop(next.reservation, Date.now() + 10_000);
          assert.equal(engine.containers.has(next.reservation.resource.containerId), false);
          assert.equal(engine.stops, oldStops + 1);
        } finally {
          allocatorClockOffset = 0;
          engine.imageUnavailable = () => false;
        }
      }
    );
    await t.test("exact model replay: startup elapses after dispatch before accepted start settles", async () => {
      const preparedRun = await prepare("model-lifetime-r28");
      await confirm(preparedRun.proposal);
      const { now } = Date;
      engine.afterStart = () => {
        Date.now = () => now() + 31_000;
        return Promise.resolve();
      };
      try {
        await assert.rejects(bridge.activateRun(preparedRun.connection, preparedRun));
        const observed = await bridge.statusRun(preparedRun.connection, preparedRun.runId);
        assert.equal(
          observed.container_id,
          preparedRun.reservation.resource.containerId,
          "active grant remains observable after startup transport expires"
        );
      } finally {
        Date.now = now;
        engine.afterStart = async () => undefined;
        await bridge.stopRun(preparedRun.connection, preparedRun.runId, now() + 10_000);
      }
    });
    assert.ok(callbackBodies.length >= 2);
    for (const body of callbackBodies) {
      assert.equal(body.includes(AT), false);
      assert.equal(body.includes(RT), false);
      assert.equal(body.includes(owner), false);
    }
    for (const entry of engine.containers.values()) {
      assert.equal(JSON.stringify(entry.body.Env).includes(AT), false);
      assert.equal(JSON.stringify(entry.body.Env).includes(RT), false);
    }
  } finally {
    await close(http);
    await closeTestServer(app);
    if (PG) {
      await closePostgresStorage();
    }
    closeDb();
    await rm(root, { force: true, recursive: true });
  }
});
test("fixed-target bounded transport refuses redirects, malformed and hung responses", async () => {
  let leaked = false;
  const sink = createServer((_req, res) => {
    leaked = true;
    res.end("{}");
  });
  const sinkUrl = await listen(sink);
  const release = gate();
  const arrived = gate();
  let mode = "redirect";
  const server = createServer(async (_req, res) => {
    if (mode === "redirect") {
      res.writeHead(307, { Location: sinkUrl });
      res.end();
    } else if (mode === "empty") {
      res.end("{}");
    } else if (mode === "oversized") {
      res.end("x".repeat(131_073));
    } else if (mode === "malformed") {
      res.end("synthetic-private-config-marker");
    } else {
      arrived.release();
      await release.promise;
      res.end("{}");
    }
  });
  const url = await listen(server);
  try {
    await ["redirect", "malformed", "oversized", "hung"].reduce(async (previous, m) => {
      await previous;
      mode = m;
      const pending = postBindingControl({ credential: RT, timeoutMs: 50, url }, "authorize", {}, Date.now() + 1000);
      if (mode === "hung") {
        await arrived.promise;
      }
      await assert.rejects(pending, (error: Error) => error.message === "Browser binding control refused");
    }, Promise.resolve());
    mode = "empty";
    const client = new NekoBindingControlClient({ credential: AT, timeoutMs: 1000, url });
    await assert.rejects(
      client.prepare(
        {
          connectionId: "fictional",
          connectorId: "fictional",
          expiresAt: Date.now() + 1000,
          instanceKey: "browser",
          ownerId: "fictional",
          requestedOrigins: [],
        },
        Date.now() + 1000
      )
    );
    assert.equal(leaked, false);
    release.release();
    for (const invalid of ["https://user:private@invalid.test", `${url}/wrong`, `${url}?secret=bad`]) {
      assert.throws(() => new NekoBindingControlClient({ credential: AT, timeoutMs: 50, url: invalid }));
    }
  } finally {
    release.release();
    await close(server);
    await close(sink);
  }
});
test("actual child environment builder excludes runtime service credentials", () => {
  const env = composeConnectorChildEnvironment({
    connectionEnv: null,
    connectorId: "fictional",
    explicitRunEnv: { PDPP_BINDING_ALLOCATOR_TOKEN: AT, pdpp_binding_authorizer_token: RT },
    manifest: {},
    sourceEnv: { PDPP_BINDING_ALLOCATOR_TOKEN: AT, PDPP_BINDING_AUTHORIZER_TOKEN: RT },
  });
  assert.equal(JSON.stringify(env).includes(AT), false);
  assert.equal(JSON.stringify(env).includes(RT), false);
  for (const sourceKey of ["PDPP_BINDING_ALLOCATOR_TOKEN", "pdpp_binding_authorizer_token"]) {
    assert.throws(() =>
      composeConnectorChildEnvironment({
        approvedBindings: [
          {
            connectorId: "fictional",
            logicalKey: "need",
            source: { key: sourceKey, kind: "process_env" },
            targetKey: "RENAMED_LEAK",
          },
        ],
        connectorId: "fictional",
        explicitRunEnv: {},
        manifest: { runtime_requirements: { environment_variables: ["need"] } },
        sourceEnv: { [sourceKey]: RT },
      })
    );
  }
});

test("unconfigured app and allocator expose no binding control routes", async () => {
  if (PG) {
    await initPostgresStorage({ backend: "postgres", databaseUrl: PG });
  }
  const app = await startServer({
    asPort: 0,
    autoEnrollEligibleSchedules: false,
    dbPath: ":memory:",
    ownerAuthPassword: "",
    quiet: true,
    rsPort: 0,
    storageBackend: PG ? "postgres" : "sqlite",
    ...(PG ? { databaseUrl: PG } : {}),
  });
  const service = new NekoSurfaceAllocatorService({
    cdpBaseUrlTemplate: "http://unused.test/{surface_id}",
    deploymentId: "fictional-closed",
    docker: new Engine(),
    image: "fictional",
    network: "fictional",
    profileRoot: "/fictional-never-opened",
    streamBaseUrlTemplate: "http://unused.test/{surface_id}",
    webrtcHostPortEnd: 59_001,
    webrtcHostPortStart: 59_000,
  });
  const http = createServer(createNekoSurfaceAllocatorHttpHandler(service));
  const url = await listen(http);
  try {
    assert.equal(app.bindingAdmission, undefined);
    const endpoints = [`http://127.0.0.1:${app.rsPort}`, url];
    await Promise.all(
      endpoints.map(async (endpoint) => {
        assert.equal(
          (
            await fetch(`${endpoint}${BINDING_CONTROL_PREFIX}/authorize`, {
              body: "{}",
              headers: { Authorization: `Bearer ${RT}`, "Content-Type": "application/json" },
              method: "POST",
            })
          ).status,
          404
        );
      })
    );
  } finally {
    await close(http);
    await closeTestServer(app);
    if (PG) {
      await closePostgresStorage();
    }
    closeDb();
  }
});

test("protected createController.runNow proposes, confirms, fences a real child and stops before reuse", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "binding-sync-r26-"));
  await chmod(root, 0o700);
  const childPath = join(root, "child.cjs");
  const childResult = join(root, "child-result.json");
  const holdChild = join(root, "hold-child");
  writeFileSync(
    childPath,
    `#!/usr/bin/env node
const fs = require('node:fs');
process.stdin.resume();
process.stdin.once('data', () => {
  fs.writeFileSync(${JSON.stringify(childResult)}, JSON.stringify({ pid: process.pid, cdp: process.env.PDPP_BROWSER_SURFACE_REMOTE_CDP_URL, env: Object.keys(process.env).filter(k => /BROWSER|CDP|SURFACE/.test(k)) }));
  if (fs.existsSync(${JSON.stringify(holdChild)})) { setInterval(() => {}, 1000); return; }
  process.stdout.write(JSON.stringify({type:'DONE',status:'succeeded',records_emitted:0})+'\\n');
  process.stdout.end(() => process.exit(0));
});
`
  );
  await chmod(childPath, 0o700);
  const ready = createServer((_req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ Browser: "Chrome/fictional", webSocketDebuggerUrl: "ws://127.0.0.1:1/fictional" }));
  });
  const readyUrl = await listen(ready);
  const http = createServer();
  const url = await listen(http);
  const engine = new Engine();
  const manager = new BrowserSurfaceLeaseManager({
    config: {
      defaultPriorityClass: "interactive",
      idleTtlMs: 600_000,
      leaseWaitTimeoutMs: 30_000,
      managedConnectors: new Set(["binding-fixture-connector"]),
      priorityRanks: DEFAULT_NEKO_PRIORITY_RANKS,
      surfaceCap: 1,
      surfaceMode: "dynamic",
    },
  });
  const expiry = Date.now() + 600_000;
  let probes = 0;
  let probeHook: () => Promise<void> = async () => undefined;
  const app = await startServer({
    asPort: 0,
    autoEnrollEligibleSchedules: false,
    dbPath: ":memory:",
    ownerAuthPassword: "",
    preRegisteredPublicClients: TEST_PRE_REGISTERED_PUBLIC_CLIENTS,
    quiet: true,
    rsPort: 0,
    storageBackend: PG ? "postgres" : "sqlite",
    ...(PG ? { databaseUrl: PG } : {}),
    browserBindingAdmission: {
      allocator: { credential: AT, timeoutMs: 3000, url },
      credential: RT,
      policyIdentity: "r26-fixture",
      syncLifecycle: { policyExpiresAt: expiry },
    },
    browserSurfaceLeaseManager: manager,
    browserSurfaceReadinessProbe: {
      probe: async (surface) => {
        probes += 1;
        assert.equal(surface.health, "ready");
        assert.ok([...engine.containers.values()].some((e) => e.running));
        await probeHook();
        return { ok: true, pageTargetCount: 1 };
      },
    },
    connectorPathResolver: () => childPath,
  });
  const rs = `http://127.0.0.1:${app.rsPort}`;
  const service = new NekoSurfaceAllocatorService({
    bindingControl: { authorizer: { credential: RT, timeoutMs: 30_000, url: rs }, credential: AT },
    cdpBaseUrlTemplate: readyUrl,
    deploymentId: "fictional-r26",
    docker: engine,
    image: "fixture-image",
    network: "fixture-network",
    profileOwnerGid: process.getgid?.() ?? 0,
    profileOwnerUid: process.getuid?.() ?? 0,
    profileRoot: root,
    streamBaseUrlTemplate: readyUrl,
    webrtcHostPortEnd: 59_099,
    webrtcHostPortStart: 59_000,
  });
  let refuseDisposal = false;
  const protectedHandler = createNekoSurfaceAllocatorHttpHandler(service);
  http.on("request", (req, res) => {
    if (refuseDisposal && req.url === `${BINDING_CONTROL_PREFIX}/dispose`) {
      res.writeHead(409);
      res.end("{}");
      return;
    }
    return protectedHandler(req, res);
  });
  t.after(async () => {
    await app.controller.drainActiveRuns(1000);
    await close(http);
    await close(ready);
    await closeTestServer(app);
    if (PG) {
      await closePostgresStorage();
    }
    closeDb();
    await rm(root, { force: true, recursive: true });
  });
  const connectionId = "actual-sync-r26";
  await seedBindingConnection(connectionId);
  const manifest = withFixtureSourceDeclaration({
    connector_key: "binding-fixture-connector",
    display_name: "Fictional browser",
    protocol_version: "0.1.0",
    runtime_requirements: { bindings: { browser: { required: true } } },
    streams: [
      {
        name: "items",
        primary_key: ["id"],
        schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
        selection: { fields: true, resources: true },
        semantics: "append_only",
      },
    ],
    version: "1",
  });
  await bindingQuery("UPDATE connectors SET manifest = ? WHERE connector_id = ?", [
    JSON.stringify(manifest),
    "binding-fixture-connector",
  ]);
  const owner = await issueOwnerToken(`http://127.0.0.1:${app.asPort}`);
  const run = (runId: string) =>
    app.controller.runNow("binding-fixture-connector", {
      connectorInstanceId: connectionId,
      manifest,
      ownerSubjectId: "owner_local",
      ownerToken: owner,
      rsUrl: rs,
      runId,
    });
  const createsBeforeManifestMismatch = engine.created;
  await assert.rejects(
    app.controller.runNow("binding-fixture-connector", {
      connectorInstanceId: connectionId,
      manifest: { ...manifest, version: "fictional-mismatch" },
      ownerSubjectId: "owner_local",
      ownerToken: owner,
      rsUrl: rs,
      runId: "actual-manifest-mismatch-r26",
    })
  );
  assert.equal(engine.created, createsBeforeManifestMismatch);
  const pending = await run("actual-pending-r26");
  assert.equal(pending.status, "owner_action_required");
  assert.equal(pending.owner_action?.connectionId, connectionId);
  assert.equal(existsSync(childResult), false, "approval required must not spawn a child");
  assert.equal(engine.starts, 0);
  assert.equal(engine.containers.size, 0, "stopped proposal resource is cleaned");
  assert.deepEqual(
    await bindingQuery("SELECT run_id FROM controller_active_runs WHERE connector_instance_id = ?", [connectionId]),
    []
  );
  const policyUrl = `${rs}/v1/owner/connections/${connectionId}/binding-access-policy`;
  const state = (await (await fetch(policyUrl, { headers: { Authorization: `Bearer ${owner}` } })).json()) as {
    proposal: AccessPolicyProposal;
  };
  const p = state.proposal;
  assert.equal(p.proposalId, pending.owner_action?.proposalId);
  const response = await fetch(`${policyUrl}/proposals/${p.proposalId}/confirm`, {
    body: JSON.stringify({
      acknowledgments: p.snapshot.instances.flatMap((i) =>
        i.channels.map((c) => ({
          accessIdentity: i.accessIdentity,
          accessRevision: i.accessRevision,
          channel: c.name,
          coverage: c.coverage,
          instanceKey: i.instanceKey,
        }))
      ),
      baseEpoch: p.baseEpoch,
      revision: p.revision,
      snapshotDigest: p.snapshotDigest,
    }),
    headers: { Authorization: `Bearer ${owner}`, "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(response.status, 200, await response.text());
  let initialApproved: unknown;
  engine.beforeStart = async () => {
    const active = await bindingQuery("SELECT run_id FROM controller_active_runs WHERE connector_instance_id = ?", [
      connectionId,
    ]);
    assert.equal(active[0]?.run_id, "actual-approved-r26");
    const authority = await createConnectorBindingAuthorityStore().get({
      connectionId,
      ownerId: "owner_local",
      runId: "actual-approved-r26",
    });
    initialApproved = authority;
    assert.ok(authority, "real controller bookkeeping and durable authority precede Engine start");
    assert.equal(existsSync(childResult), false);
  };
  const started = await run("actual-approved-r26");
  assert.equal(started.status, "started");
  await app.controller.drainActiveRuns(5000);
  assert.equal(existsSync(childResult), true, "real runtime fixture child spawned");
  assert.equal(JSON.parse(readFileSync(childResult, "utf8")).cdp, readyUrl);
  assert.ok(probes > 0);
  assert.equal(engine.starts, 1);
  assert.equal(engine.stops, 1);
  assert.equal(engine.containers.size, 0, "normal release cannot leave a reusable live browser");
  assert.equal(manager.listSurfaces().length, 0);
  assert.equal(service.retainedBindingReservationCount, 0, "durable cleanup retires exact remote reservation metadata");
  const finalApproved = await createConnectorBindingAuthorityStore().get({
    connectionId,
    ownerId: "owner_local",
    runId: "actual-approved-r26",
  });
  assert.deepEqual(finalApproved, initialApproved, "append-only cleanup must preserve initial authority bytes");

  engine.beforeStart = async () => undefined;

  await t.test("active lifetime outlives startup budget and owner cancellation reaps running child", async () => {
    await rm(childResult, { force: true });
    writeFileSync(holdChild, "hold");
    const runId = "actual-active-lifetime-r28";
    try {
      assert.equal((await run(runId)).status, "started");
      if (!existsSync(childResult)) {
        for await (const event of watch(root, { signal: AbortSignal.timeout(2000) })) {
          if (event.filename === "child-result.json" && existsSync(childResult)) {
            break;
          }
        }
      }
      assert.ok(existsSync(childResult), "real child must report running");
      const { pid } = JSON.parse(readFileSync(childResult, "utf8"));
      process.kill(pid, 0);
      const { now } = Date;
      try {
        Date.now = () => now() + 31_000;
        const surface = await app.bindingAdmission?.statusRun(connectionId, runId);
        assert.equal(surface?.health, "ready", "active status must survive startup deadline");
      } finally {
        Date.now = now;
      }
      const lifetimePolicies = createConnectorBindingAccessPolicyStore();
      const policyHead = await lifetimePolicies.read({ connectionId, ownerId: "owner_local" });
      const { active } = policyHead;
      assert.ok(active);
      await lifetimePolicies.decide(
        {
          baseEpoch: policyHead.epoch,
          connectionId,
          ownerId: "owner_local",
          proposalId: active.proposalId,
          revision: active.revision,
          snapshotDigest: active.snapshotDigest,
        },
        "withdraw"
      );
      assert.equal(
        (await app.bindingAdmission?.statusRun(connectionId, runId))?.health,
        "ready",
        "withdrawal governs future authorization, not active resource revocation"
      );
      await assert.rejects(app.bindingAdmission?.statusRun(connectionId, runId, true) ?? Promise.resolve());
      await assert.rejects(app.controller.cancelRun(runId, "foreign-owner"));
      const { now: beforeExpiry } = Date;
      try {
        Date.now = () => expiry + 1;
        await assert.rejects(app.bindingAdmission?.statusRun(connectionId, runId) ?? Promise.resolve());
        assert.equal((await app.controller.cancelRun(runId, "owner_local")).status, "cancel_requested");
      } finally {
        Date.now = beforeExpiry;
      }
      // A separate explicit fixture confirmation restores future authorization.
      const head = await lifetimePolicies.read({ connectionId, ownerId: "owner_local" });
      const next = await lifetimePolicies.propose({
        baseEpoch: head.epoch,
        baseRevision: head.revision,
        provenance: {},
        snapshot: active.snapshot,
      });
      await lifetimePolicies.decide(
        {
          baseEpoch: next.baseEpoch,
          connectionId,
          ownerId: "owner_local",
          proposalId: next.proposalId,
          revision: next.revision,
          snapshotDigest: next.snapshotDigest,
        },
        "confirm",
        active.acknowledgments ?? []
      );
      await app.controller.drainActiveRuns(5000);
      assert.throws(() => process.kill(pid, 0), "cancelled child must be reaped");
      assert.equal(engine.containers.size, 0, "physical owned stop/removal is independent of child exit");
      assert.equal(manager.listSurfaces().length, 0);
      assert.equal(
        service.retainedBindingReservationCount,
        0,
        "durable cleanup retires exact remote reservation metadata"
      );
    } finally {
      await rm(holdChild, { force: true });
      await app.controller.cancelRun(runId, "owner_local").catch(() => undefined);
      await app.controller.drainActiveRuns(5000);
    }
  });

  const lifecycleUrl = (runId: string) => `${rs}/v1/owner/connections/${connectionId}/runs/${runId}/binding-lifecycle`;
  const readLifecycle = async (runId: string) => {
    const lifecycleResponse = await fetch(lifecycleUrl(runId), { headers: { Authorization: `Bearer ${owner}` } });
    assert.equal(lifecycleResponse.status, 200);
    const body = (await lifecycleResponse.json()) as { lifecycle: string; events: { lifecycle: string }[] };
    const facts = await bindingQuery(
      "SELECT status, data_json FROM spine_events WHERE run_id = ? AND event_type = 'run.browser_binding_cleanup' ORDER BY event_seq",
      [runId]
    );
    assert.deepEqual(
      body.events.map((event) => event.lifecycle),
      facts.map((fact) => fact.status),
      "owner lifecycle projects append-only cleanup facts at this barrier"
    );

    assert.equal(JSON.stringify(body).includes(readyUrl), false);
    assert.equal(JSON.stringify(body).includes(AT), false);
    assert.equal(JSON.stringify(body).includes("private-engine"), false);
    return body;
  };
  assert.equal((await readLifecycle("actual-approved-r26")).lifecycle, "stopped");
  assert.equal((await fetch(lifecycleUrl("actual-approved-r26"))).status, 401);
  const grantManifest = JSON.parse(
    readFileSync(new URL("../fixtures/seed-manifests/spotify.json", import.meta.url), "utf8")
  ) as { connector_id: string; streams: { name: string }[] };
  const grantAs = `http://127.0.0.1:${app.asPort}`;
  assert.equal(
    (
      await fetch(`${grantAs}/connectors`, {
        body: JSON.stringify(grantManifest),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      })
    ).status,
    201
  );
  const grantConnector = canonicalConnectorKey(grantManifest.connector_id);
  assert.ok(grantConnector);
  const grantNamespace = await admitOwnerRunConnection({
    connectorId: grantConnector,
    connectorInstanceStore: createRequestConnectorInstanceStore(),
    ownerSubjectId: "owner_local",
  });
  const [grantStream] = grantManifest.streams;
  assert.ok(grantStream);
  const grantToken = await approveClientGrant(
    grantAs,
    grantManifest.connector_id,
    grantStream.name,
    grantNamespace.connectorInstanceId
  );
  assert.equal(
    (await fetch(lifecycleUrl("actual-approved-r26"), { headers: { Authorization: `Bearer ${grantToken}` } })).status,
    403
  );
  await seedBindingConnection("same-run-other-connection-r28");
  await createConnectorBindingAuthorityStore().put(
    bindingFixture("same-run-other-connection-r28", "actual-approved-r26")
  );
  const isolated = await fetch(
    `${rs}/v1/owner/connections/same-run-other-connection-r28/runs/actual-approved-r26/binding-lifecycle`,
    { headers: { Authorization: `Bearer ${owner}` } }
  );
  assert.equal(isolated.status, 200);
  assert.deepEqual(
    ((await isolated.json()) as { events: unknown[] }).events,
    [],
    "same run ID cannot import another connection's stopped events"
  );

  const foreign = await issueOwnerToken(`http://127.0.0.1:${app.asPort}`, "foreign-owner");
  assert.equal(
    (await fetch(lifecycleUrl("actual-approved-r26"), { headers: { Authorization: `Bearer ${foreign}` } })).status,
    404
  );

  await t.test("accepted start late reply cannot publish after owner cancellation", async () => {
    await rm(childResult, { force: true });
    const accepted = gate();
    const reply = gate();
    engine.afterStart = async () => {
      accepted.release();
      await reply.promise;
    };
    const runId = "actual-late-start-r28";
    const pendingLateRun = run(runId);
    const observed = Promise.allSettled([pendingLateRun]);
    try {
      await accepted.promise;
      assert.ok([...engine.containers.values()].some((e) => e.running));
      const cancelling = app.controller.cancelRun(runId, "owner_local");
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(existsSync(childResult), false);
      assert.ok(
        manager.listLeases().some((lease) => lease.run_id === runId),
        "in-flight activation retains its lease fence"
      );
      reply.release();
      await cancelling;
      await observed;
      assert.equal(existsSync(childResult), false);
      assert.equal(engine.containers.size, 0);
      assert.equal((await readLifecycle(runId)).lifecycle, "stopped");
    } finally {
      reply.release();
      engine.afterStart = async () => undefined;
      await observed;
    }
  });

  await t.test("unchanged access reuses confirmation; delayed actual stop blocks a new run", async () => {
    await rm(childResult, { force: true });
    const stopping = gate();
    const allowStop = gate();
    engine.beforeStop = async () => {
      stopping.release();
      await allowStop.promise;
    };
    const reused = await run("actual-reused-r26");
    assert.equal(reused.status, "started");
    await stopping.promise;
    const draining = app.controller.drainActiveRuns(5000);
    try {
      assert.ok([...engine.containers.values()].some((e) => e.running));
      assert.equal((await readLifecycle("actual-reused-r26")).lifecycle, "cleanup_requested");
      await assert.rejects(
        run("unsafe-reuse-r26"),
        (e: unknown) => e instanceof Error && e.message.includes("active run")
      );
    } finally {
      allowStop.release();
    }
    await draining;
    engine.beforeStop = async () => undefined;
    assert.equal(engine.containers.size, 0);
    assert.equal(manager.listSurfaces().length, 0);
    assert.equal(
      service.retainedBindingReservationCount,
      0,
      "durable cleanup retires exact remote reservation metadata"
    );
  });

  await t.test("metadata disposal outage preserves durable closure and permits exact metadata replay", async () => {
    refuseDisposal = true;
    const runId = "actual-disposal-outage-r28";
    try {
      assert.equal((await run(runId)).status, "started");
      await app.controller.drainActiveRuns(5000);
      assert.equal(engine.containers.size, 0);
      assert.equal(manager.listSurfaces().length, 0);
      assert.equal((await readLifecycle(runId)).lifecycle, "stopped");
      assert.equal(service.retainedBindingReservationCount, 1);
      const facts = await bindingQuery(
        "SELECT status FROM spine_events WHERE run_id = ? AND event_type = 'run.browser_binding_retirement'",
        [runId]
      );
      assert.equal(facts[0]?.status, "metadata_retained");
      const stored = await createConnectorBindingAuthorityStore().get({ connectionId, ownerId: "owner_local", runId });
      const handle = stored?.record.instances.find((instance) => instance.kind === "browser")?.handleIdentity;
      assert.ok(handle);
      const { reservationId } = JSON.parse(handle);
      refuseDisposal = false;
      await postBindingControl(
        { credential: AT, timeoutMs: 3000, url },
        "dispose",
        {
          deadline: Date.now() + 3000,
          reservationId,
          scope: {
            connectionId,
            connectorId: "binding-fixture-connector",
            instanceKey: "browser",
            ownerId: "owner_local",
          },
        },
        Date.now() + 3000
      );
      assert.equal(service.retainedBindingReservationCount, 0);
    } finally {
      refuseDisposal = false;
    }
  });

  await t.test("cancel while start is in flight; duplicate start refused; final desired stop wins", async () => {
    await rm(childResult, { force: true });
    const starting = gate();
    const allowStart = gate();
    engine.beforeStart = async () => {
      starting.release();
      await allowStart.promise;
    };
    const pendingRun = run("actual-cancel-start-r26");
    const completed = pendingRun.then((result) => assert.equal(result.status, "surface_failed"));
    await starting.promise;
    const [entry] = [...engine.containers.entries()];
    assert.ok(entry);
    const reservationId = (entry[1].body.Labels as Record<string, string>)["org.pdpp.reference.neko.reservation"];
    const duplicate = await fetch(`${url}${BINDING_CONTROL_PREFIX}/activate`, {
      body: JSON.stringify({
        deadline: Date.now() + 10_000,
        reservationId,
        runId: "actual-cancel-start-r26",
        scope: {
          connectionId,
          connectorId: "binding-fixture-connector",
          instanceKey: "browser",
          ownerId: "owner_local",
        },
      }),
      headers: { Authorization: `Bearer ${AT}`, "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(duplicate.status, 409);
    const cancelled = app.controller.cancelRun("actual-cancel-start-r26", "owner_local");
    allowStart.release();
    assert.equal((await cancelled).status, "cancel_requested");
    await completed;
    engine.beforeStart = async () => undefined;
    assert.equal(existsSync(childResult), false);
    assert.equal(engine.containers.size, 0);
  });

  await t.test("cancel during readiness refuses stale ready handoff and closes the active generation", async () => {
    const probing = gate();
    const allowProbe = gate();
    probeHook = async () => {
      probing.release();
      await allowProbe.promise;
    };
    const pendingRun = run("actual-cancel-ready-r26");
    const rejected = assert.rejects(pendingRun);
    await probing.promise;
    await app.controller.cancelRun("actual-cancel-ready-r26", "owner_local");
    allowProbe.release();
    await rejected;
    probeHook = async () => undefined;
    assert.equal(existsSync(childResult), false);
    assert.equal(engine.containers.size, 0);
  });

  await t.test("readiness failure after activation closes before release and redacts endpoint errors", async () => {
    probeHook = () => Promise.reject(new Error(`${readyUrl} private-readiness-marker`));
    try {
      const failed = await run("actual-readiness-failed-r26");
      assert.equal(failed.status, "surface_failed");
      assert.equal(existsSync(childResult), false);
      assert.equal(engine.containers.size, 0);
      const events = await bindingQuery("SELECT data_json FROM spine_events WHERE run_id = ?", [
        "actual-readiness-failed-r26",
      ]);
      assert.equal(JSON.stringify(events).includes(readyUrl), false);
      assert.equal(JSON.stringify(events).includes("private-readiness-marker"), false);
    } finally {
      probeHook = async () => undefined;
    }
  });

  await t.test("pre-spawn current generation guard refuses a replacement after controller readiness", async () => {
    // First gate sees the live generation; the trusted runtime gate must read
    // it again after launch preparation, immediately before actual spawn.
    let statusCalls = 0;
    const admission = app.bindingAdmission;
    assert.ok(admission);
    const { statusRun: readStatus } = admission;
    admission.statusRun = async (...args) => {
      statusCalls += 1;
      const surface = await readStatus(...args);
      if (statusCalls === 4) {
        return { ...surface, browser_generation_hash: "replacement-generation" };
      }
      return surface;
    };
    try {
      const handle = await run("actual-fenced-r26");
      assert.equal(handle.status, "started");
      await app.controller.drainActiveRuns(5000);
      assert.equal(existsSync(childResult), false, "stale generation cannot spawn the child");
      assert.equal(statusCalls, 4, "final runtime pre-spawn status must execute");
      assert.equal(engine.containers.size, 0);
    } finally {
      admission.statusRun = readStatus;
    }
  });

  await t.test("changed access needs fresh confirmation through actual runNow", async () => {
    engine.network = "changed-actual-network-r26";
    const changed = await run("actual-changed-r26");
    assert.equal(changed.status, "owner_action_required");
    assert.notEqual(changed.owner_action?.proposalId, p.proposalId);
    assert.equal(existsSync(childResult), false);
    assert.equal(engine.containers.size, 0);
    engine.network = "fictional-network-one";
  });

  await t.test("required network refuses typed placement before create or child spawn", async () => {
    const unsupported = structuredClone(manifest);
    unsupported.runtime_requirements.bindings = {
      browser: { required: true },
      network: { required: true },
    } as typeof unsupported.runtime_requirements.bindings;
    await bindingQuery("UPDATE connectors SET manifest = ? WHERE connector_id = ?", [
      JSON.stringify(unsupported),
      "binding-fixture-connector",
    ]);
    const { created } = engine;
    const result = await app.controller.runNow("binding-fixture-connector", {
      connectorInstanceId: connectionId,
      manifest: unsupported,
      ownerSubjectId: "owner_local",
      ownerToken: owner,
      rsUrl: rs,
      runId: "actual-unsupported-r26",
    });
    assert.equal(result.status, "placement_refused");
    assert.equal(result.placement_failure?.instanceKey, "network");
    const networkOnly = { ...unsupported, runtime_requirements: { bindings: { network: { required: true } } } };
    await bindingQuery("UPDATE connectors SET manifest = ? WHERE connector_id = ?", [
      JSON.stringify(networkOnly),
      "binding-fixture-connector",
    ]);
    const only = await app.controller.runNow("binding-fixture-connector", {
      connectorInstanceId: connectionId,
      manifest: networkOnly,
      ownerSubjectId: "owner_local",
      ownerToken: owner,
      rsUrl: rs,
      runId: "network-only-r28",
    });
    assert.equal(only.status, "placement_refused");
    assert.equal(only.placement_failure?.instanceKey, "network");

    assert.equal(engine.created, created);
    assert.equal(existsSync(childResult), false);
    await bindingQuery("UPDATE connectors SET manifest = ? WHERE connector_id = ?", [
      JSON.stringify(manifest),
      "binding-fixture-connector",
    ]);
  });

  await t.test("hung Engine stop obeys actual signal and explicit owner reconciliation", async () => {
    const stopping = gate();
    const unblock = gate();
    engine.beforeStop = async (signal) => {
      stopping.release();
      assert.ok(signal, "protected Engine cleanup must receive a deadline signal");
      await Promise.race([
        unblock.promise,
        new Promise<void>((_resolve, reject) => {
          if (signal.aborted) {
            reject(signal.reason);
            return;
          }
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
      ]);
    };
    const runId = "actual-hung-stop-r28";
    try {
      assert.equal((await run(runId)).status, "started");
      await stopping.promise;
      assert.equal((await readLifecycle(runId)).lifecycle, "cleanup_requested");
      await app.controller.drainActiveRuns(5000);
      assert.equal((await readLifecycle(runId)).lifecycle, "cleanup_unverified");
      await assert.rejects(run("hung-reuse-r28"));
      await assert.rejects(app.controller.cancelRun(runId, "foreign-owner"));
      await assert.rejects(app.controller.cancelRun(runId, "owner_local"));
      unblock.release();
      engine.beforeStop = async () => undefined;
      await app.controller.cancelRun(runId, "owner_local");
      assert.equal(engine.containers.size, 0);
      assert.equal((await readLifecycle(runId)).lifecycle, "stopped");
    } finally {
      unblock.release();
      engine.beforeStop = async () => undefined;
    }
  });

  await t.test("withdrawal after prepare returns a valid new owner action, not credential repair", async () => {
    await rm(childResult, { force: true });
    const admission = app.bindingAdmission;
    assert.ok(admission);
    const { prepareRun: original } = admission;
    const policies = createConnectorBindingAccessPolicyStore();
    admission.prepareRun = async (...args) => {
      const prepared = await original(...args);
      const withdrawalState = await policies.read({ connectionId, ownerId: "owner_local" });
      const { active } = withdrawalState;
      assert.ok(active);
      await policies.decide(
        {
          baseEpoch: withdrawalState.epoch,
          connectionId,
          ownerId: "owner_local",
          proposalId: active.proposalId,
          revision: active.revision,
          snapshotDigest: active.snapshotDigest,
        },
        "withdraw"
      );
      return prepared;
    };
    const { starts } = engine;
    try {
      const outcome = await run("actual-withdraw-r28");
      assert.equal(outcome.status, "owner_action_required");
      const withdrawalState = await policies.read({ connectionId, ownerId: "owner_local" });
      assert.equal(withdrawalState.proposal?.status, "proposed");
      assert.equal(outcome.owner_action?.proposalId, withdrawalState.proposal?.proposalId);
      assert.notEqual(outcome.owner_action?.proposalId, p.proposalId);
      assert.equal(engine.starts, starts);
      assert.equal(existsSync(childResult), false);
      assert.equal(engine.containers.size, 0);
    } finally {
      admission.prepareRun = original;
    }
  });

  await t.test("stop failure is cleanup-unverified and prevents new run despite terminal child result", async () => {
    // Restore the original confirmed access after the changed-access proposal.
    const policyState = await createConnectorBindingAccessPolicyStore().read({ connectionId, ownerId: "owner_local" });
    if (policyState.proposal && policyState.proposal.status === "proposed") {
      await createConnectorBindingAccessPolicyStore().decide(
        {
          baseEpoch: policyState.proposal.baseEpoch,
          connectionId,
          ownerId: "owner_local",
          proposalId: policyState.proposal.proposalId,
          revision: policyState.proposal.revision,
          snapshotDigest: policyState.proposal.snapshotDigest,
        },
        "reject"
      );
    }
    // A new proposal is expected after rejection; configuration is not consent.
    const pendingStopPolicy = await run("actual-stop-policy-r26");
    if (pendingStopPolicy.status === "owner_action_required") {
      const st = await createConnectorBindingAccessPolicyStore().read({ connectionId, ownerId: "owner_local" });
      const q = st.proposal;
      assert.ok(q);
      const confirmed = await fetch(`${policyUrl}/proposals/${q.proposalId}/confirm`, {
        body: JSON.stringify({
          acknowledgments: q.snapshot.instances.flatMap((i) =>
            i.channels.map((c) => ({
              accessIdentity: i.accessIdentity,
              accessRevision: i.accessRevision,
              channel: c.name,
              coverage: c.coverage,
              instanceKey: i.instanceKey,
            }))
          ),
          baseEpoch: q.baseEpoch,
          revision: q.revision,
          snapshotDigest: q.snapshotDigest,
        }),
        headers: { Authorization: `Bearer ${owner}`, "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(confirmed.status, 200, await confirmed.text());
    } else {
      await app.controller.drainActiveRuns(5000);
      await rm(childResult, { force: true });
    }
    engine.beforeStop = () => Promise.reject(new Error("private-engine-stop-marker"));
    assert.equal((await run("actual-unverified-r26")).status, "started");
    await app.controller.drainActiveRuns(5000);
    const events = await bindingQuery(
      "SELECT status, data_json FROM spine_events WHERE event_type = 'run.browser_binding_cleanup' AND run_id = ? ORDER BY event_seq DESC",
      ["actual-unverified-r26"]
    );
    assert.equal(events[0]?.status, "cleanup_unverified");
    assert.equal(JSON.stringify(events).includes("private-engine-stop-marker"), false);
    await assert.rejects(
      run("actual-refuse-uncertain-r26"),
      (e: unknown) => e instanceof Error && e.message.includes("active run")
    );
    assert.ok(
      [...engine.containers.values()].some((e) => e.running),
      "failed stop cannot be called verified closure"
    );
    assert.equal((await readLifecycle("actual-unverified-r26")).lifecycle, "cleanup_unverified");
    await assert.rejects(app.controller.cancelRun("actual-unverified-r26", "foreign-owner"));
    await assert.rejects(app.controller.cancelRun("actual-unverified-r26", "owner_local"));
    assert.equal((await readLifecycle("actual-unverified-r26")).lifecycle, "cleanup_unverified");
    engine.beforeStop = async () => undefined;
    assert.equal((await app.controller.cancelRun("actual-unverified-r26", "owner_local")).status, "cancel_requested");
    assert.equal(engine.containers.size, 0);
    assert.equal(manager.listSurfaces().length, 0);
    assert.equal(
      service.retainedBindingReservationCount,
      0,
      "durable cleanup retires exact remote reservation metadata"
    );
    assert.equal((await readLifecycle("actual-unverified-r26")).lifecycle, "stopped");
  });

  await t.test(
    "accepted start lost acknowledgement retains an unverified fence after stopped observation",
    async () => {
      await rm(childResult, { force: true });
      const { starts } = engine;
      engine.afterStart = () => Promise.reject(new Error("private-engine-lost-ack"));
      try {
        await assert.rejects(run("actual-lost-start-r28"));
        assert.equal(engine.starts, starts + 1, "Engine accepted start before losing its acknowledgement");
        assert.equal(existsSync(childResult), false);
        assert.equal((await readLifecycle("actual-lost-start-r28")).lifecycle, "cleanup_unverified");
        await assert.rejects(run("lost-ack-reuse-r28"));
        assert.equal(
          manager.listLeases().some((lease) => lease.run_id === "actual-lost-start-r28"),
          true
        );
        assert.equal(
          [...engine.containers.values()].every((resource) => !resource.running),
          true,
          "stopped observation alone must not release ambiguity fence"
        );
      } finally {
        engine.afterStart = async () => undefined;
      }
    }
  );

  const cleanup = await bindingQuery(
    "SELECT status, data_json FROM spine_events WHERE event_type = 'run.browser_binding_cleanup' AND run_id = ? ORDER BY event_seq DESC",
    ["actual-approved-r26"]
  );
  assert.equal(cleanup[0]?.status, "stopped");
  assert.equal(JSON.stringify(cleanup).includes(readyUrl), false);
});
