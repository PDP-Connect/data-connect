// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireDirectoryLock } from "../server/connector-install/directory-lock.ts";
import {
  type ConnectorCatalogEntry,
  createConnectorInstallService,
  createFileConnectorInstallStore,
  inspectActiveConnector,
  resolveActiveConnectorPath,
} from "../server/connector-install/index.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { mountOwnerConnectorInstall } from "../server/routes/owner-connector-install.ts";

const digest = (letter: string) => `sha256:${letter.repeat(64)}`;
const UNEXPECTED_ROUTE_ERROR = /unexpected route error/;
function fixture(t: test.TestContext, options: { boundaryMs?: number; now?: () => number } = {}) {
  initDb(":memory:");
  const dataDir = mkdtempSync(join(tmpdir(), "connector-updates-"));
  t.after(() => {
    closeDb();
    rmSync(dataDir, { force: true, recursive: true });
  });
  let entries: ConnectorCatalogEntry[] = [
    {
      config_digest: digest("c"),
      connector_id: "github",
      connector_key: "github",
      digest: digest("a"),
      latest: true,
      version: "1.2.0",
    },
  ];
  const store = createFileConnectorInstallStore(dataDir);
  let failRegistration = false;
  let failDownload = false;
  let manifestExtra: Record<string, unknown> = {};
  const remake = () =>
    createConnectorInstallService({
      dataDir,
      store,
      updateRunBoundaryTimeoutMs: options.boundaryMs ?? 1,
      ...(options.now ? { updateNow: options.now } : {}),
      catalogLoader: async () => entries,
      installArtifact(root, entry) {
        if (failDownload) {
          throw new Error("injected integrity verification failure");
        }
        mkdirSync(join(root, "dist"), { recursive: true });
        mkdirSync(join(root, "profile"), { recursive: true });
        writeFileSync(join(root, "dist", "collection-profile.mjs"), "export default {};\n");
        writeFileSync(
          join(root, "profile", "collection-profile.json"),
          JSON.stringify({
            connector_id: entry.connector_id,
            connector_key: entry.connector_key,
            streams: [],
            version: entry.version,
            ...manifestExtra,
          })
        );
        writeFileSync(join(root, "provenance.json"), "{}");
      },
      registerManifest: (manifest) => {
        getDb()
          .prepare(
            "INSERT INTO connectors(connector_id, manifest) VALUES(?, ?) ON CONFLICT(connector_id) DO UPDATE SET manifest=excluded.manifest"
          )
          .run(String(manifest.connector_id), JSON.stringify(manifest));
        if (failRegistration) {
          throw new Error("injected registration failure after metadata write");
        }
        return Promise.resolve();
      },
    });
  const service = remake();
  const { updates } = service;
  assert.ok(updates);
  t.after(async () => {
    await service.updates?.settled();
  });
  return {
    dataDir,
    failDownload() {
      failDownload = true;
    },
    failRegistration() {
      failRegistration = true;
    },
    manifestExtra(value: Record<string, unknown>) {
      manifestExtra = value;
    },
    next(version = "1.3.0"): ConnectorCatalogEntry {
      const [current] = entries;
      assert.ok(current);
      return { ...current, digest: digest("b"), version };
    },
    remake,
    service,
    setEntries(next: ConnectorCatalogEntry[]) {
      entries = next;
    },
    store,
    updates,
  };
}

test("row update refuses a catalog downgrade instead of silently installing latest", async (t) => {
  const f = fixture(t);
  await f.service.install("github", digest("a"));
  f.setEntries([f.next("1.1.0")]);
  const handlers = new Map<string, (...args: any[]) => Promise<void>>();
  const app = {
    get(path: string, ...args: any[]) {
      handlers.set(path, args.at(-1));
      return app;
    },
    post(path: string, ...args: any[]) {
      handlers.set(path, args.at(-1));
      return app;
    },
  };
  let status = 200;
  let response: any;
  const res = {
    json(value: unknown) {
      response = value;
    },
    status(value: number) {
      status = value;
      return res;
    },
  };
  mountOwnerConnectorInstall(app, {
    handleError(_res, error) {
      status = (error as any).statusCode ?? 500;
      response = { error: (error as any).code };
    },
    pdppError(_res, code, error, message) {
      status = code;
      response = { error, message };
    },
    requireOwner: (() => {
      /* Guards are inspected in the route contract test. */
    }) as any,
    requireToken: (() => {
      /* Guards are inspected in the route contract test. */
    }) as any,
    service: f.service,
  });
  const updateHandler = handlers.get("/v1/owner/connector-install/update");
  assert.ok(updateHandler);
  await updateHandler({ body: { connector_id: "github" } }, res);
  assert.equal(status, 409, JSON.stringify(response));
  assert.equal((await f.store.getActive("github"))?.digest, digest("a"));
});

async function ready(f: ReturnType<typeof fixture>) {
  const created = f.updates.createPlan();
  await f.updates.settled();
  const plan = f.updates.getPlan(created.plan_id);
  assert.equal(plan.state, "ready", plan.error ?? "plan failed");
  return plan;
}
async function apply(f: ReturnType<typeof fixture>, planId: string, key = "request-a") {
  const created = await f.updates.createBatch({ idempotency_key: key, plan_id: planId });
  await f.updates.settled();
  return f.updates.getBatch(created.batch_id);
}

test("verified metadata creates an immutable exact-target manual plan with fifteen minute expiry", async (t) => {
  const f = fixture(t);
  const previous = await f.service.install("github", digest("a"));
  f.setEntries([f.next()]);
  const plan = await ready(f);
  assert.equal(plan.manual_count, 1);
  assert.equal(plan.review_count, 0);
  assert.equal(Date.parse(plan.expires_at) - Date.parse(plan.created_at), 900_000);
  assert.deepEqual(plan.items[0]?.installed, { digest: digest("a"), version: "1.2.0" });
  assert.deepEqual(plan.items[0]?.target, { digest: digest("b"), version: "1.3.0" });
  assert.equal(plan.items[0]?.auto_eligible, false);
  assert.ok(plan.items[0]?.reasons.includes("compatibility_not_declared"));
  assert.equal(JSON.stringify(plan).includes(f.dataDir), false);
  assert.equal((await f.store.getActive("github"))?.digest, previous.digest);
  const [first] = plan.items;
  assert.ok(first);
  first.target.digest = digest("d");
  assert.equal(f.updates.getPlan(plan.plan_id).items[0]?.target.digest, digest("b"));
  const batch = await apply(f, plan.plan_id);
  assert.equal(batch.state, "completed");
  assert.equal(batch.items[0]?.state, "succeeded");
  assert.equal((await f.store.getActive("github"))?.digest, digest("b"));
  assert.equal(existsSync(join(previous.root, "dist", "collection-profile.mjs")), true);
});

test("major, downgrade, republish and incomparable versions require review", async (t) => {
  const f = fixture(t);
  await f.service.install("github", digest("a"));
  for (const [index, version] of ["2.0.0", "1.1.0", "1.2.0", "banana", "1.3.0-beta.1"].entries()) {
    f.setEntries([{ ...f.next(version), digest: digest(String(index + 2)) }]);
    const plan = await ready(f);
    assert.equal(plan.manual_count, 0, version);
    assert.equal(plan.review_count, 1, version);
    if (version.includes("-beta")) {
      assert.ok(plan.items[0]?.reasons.includes("prerelease_version"));
    }
    await assert.rejects(
      f.updates.createBatch({
        idempotency_key: version,
        plan_id: plan.plan_id,
        selected_connector_ids: ["github"],
      }),
      { code: "review_required" }
    );
  }
});

test("major requires single-use consent for the exact reviewed digest", async (t) => {
  const f = fixture(t);
  await f.service.install("github", digest("a"));
  const reviewed = { ...f.next("2.0.0"), display_name: "GitHub" };
  f.setEntries([reviewed]);
  const plan = await ready(f);
  assert.equal(plan.items[0]?.display_name, "GitHub");
  assert.equal(plan.items[0]?.reasons.includes("major_version"), true);
  await assert.rejects(f.updates.createBatch({
    idempotency_key: "without-consent", plan_id: plan.plan_id, selected_connector_ids: ["github"],
  }), { code: "review_required" });
  assert.equal((await f.store.getActive("github"))?.digest, digest("a"));
  await assert.rejects(f.updates.issueConsent({
    connector_id: "github", plan_id: plan.plan_id, target_digest: digest("d"),
  }), { code: "review_required" });
  const { consent_token } = await f.updates.issueConsent({
    connector_id: "github", plan_id: plan.plan_id, target_digest: reviewed.digest,
  });
  f.setEntries([{ ...reviewed, digest: digest("d") }]);
  await assert.rejects(f.updates.createBatch({
    consent_token, idempotency_key: "changed", plan_id: plan.plan_id, selected_connector_ids: ["github"],
  }), { code: "plan_changed" });
  f.setEntries([reviewed]);
  const request = { consent_token, idempotency_key: "approved", plan_id: plan.plan_id, selected_connector_ids: ["github"] };
  const created = await f.updates.createBatch(request);
  await f.updates.settled();
  assert.equal(f.updates.getBatch(created.batch_id).items[0]?.state, "succeeded");
  assert.equal(f.updates.getBatch(created.batch_id).items[0]?.display_name, "GitHub");
  assert.equal((await f.store.getActive("github"))?.digest, reviewed.digest);
  assert.equal((await f.updates.createBatch(request)).batch_id, created.batch_id);
  await assert.rejects(f.updates.createBatch({ ...request, idempotency_key: "reuse" }), { code: "consent_used" });
});

test("verification failure cannot be overridden with review consent", async (t) => {
  const f = fixture(t);
  await f.service.install("github", digest("a"));
  f.setEntries([f.next("2.0.0")]);
  f.failDownload();
  const plan = await ready(f);
  assert.ok(plan.items[0]?.reasons.includes("verification_failed"));
  await assert.rejects(f.updates.issueConsent({
    connector_id: "github", plan_id: plan.plan_id, target_digest: digest("b"),
  }), { code: "review_required" });
});

test("changed catalog or installed snapshot rejects a plan without substituting latest", async (t) => {
  const f = fixture(t);
  await f.service.install("github", digest("a"));
  const target = f.next();
  f.setEntries([target]);
  const plan = await ready(f);
  f.setEntries([{ ...target, digest: digest("d"), version: "1.4.0" }]);
  await assert.rejects(f.updates.createBatch({ idempotency_key: "catalog", plan_id: plan.plan_id }), {
    code: "plan_changed",
    statusCode: 409,
  });
  f.setEntries([target]);
  const installed = await f.store.getActive("github");
  assert.ok(installed);
  await f.store.activate({ ...installed, activatedAt: "2026-10-21T00:00:00Z" });
  await assert.rejects(f.updates.createBatch({ idempotency_key: "installed", plan_id: plan.plan_id }), {
    code: "plan_changed",
    statusCode: 409,
  });
  assert.equal((await f.store.getActive("github"))?.digest, digest("a"));
});

test("idempotent retry returns durable original batch after completion and catalog movement", async (t) => {
  const f = fixture(t);
  await f.service.install("github", digest("a"));
  f.setEntries([f.next()]);
  const plan = await ready(f);
  const batch = await apply(f, plan.plan_id);
  f.setEntries([f.next("1.4.0")]);
  const retried = await f.updates.createBatch({ idempotency_key: "request-a", plan_id: plan.plan_id });
  assert.equal(retried.batch_id, batch.batch_id);
  const saved = JSON.parse(readFileSync(join(f.dataDir, "connector-updates", `batch-${batch.batch_id}.json`), "utf8"));
  assert.equal(saved.items[0].target.digest, digest("b"));
  assert.equal(saved.items[0].state, "succeeded");
});

test("expired plan rejects activation", async (t) => {
  let now = Date.parse("2026-10-21T00:00:00Z");
  const f = fixture(t, { now: () => now });
  await f.service.install("github", digest("a"));
  f.setEntries([f.next()]);
  const plan = await ready(f);
  now += 900_000;
  await assert.rejects(f.updates.createBatch({ idempotency_key: "expired", plan_id: plan.plan_id }), {
    code: "plan_changed",
  });
});

test("failed verification and changed access declarations are withheld", async (t) => {
  const f = fixture(t);
  await f.service.install("github", digest("a"));
  f.setEntries([f.next()]);
  f.manifestExtra({ capabilities: { network: ["new.example"] } });
  const review = await ready(f);
  assert.equal(review.review_count, 1);
  assert.deepEqual(review.items[0]?.manifest_diff.changed_fields, ["capabilities"]);
  assert.deepEqual(review.items[0]?.manifest_diff.added_fields, ["capabilities"]);
  f.failDownload();
  f.setEntries([{ ...f.next(), digest: digest("e") }]);
  const blocked = await ready(f);
  assert.equal(blocked.manual_count, 0);
  assert.ok(blocked.items[0]?.reasons.includes("verification_failed"));
  assert.equal((await f.store.getActive("github"))?.digest, digest("a"));
});

test("registration failure after metadata mutation reports recovery_required and fences dispatch", async (t) => {
  const f = fixture(t);
  await f.service.install("github", digest("a"));
  f.setEntries([f.next()]);
  const plan = await ready(f);
  f.failRegistration();
  const batch = await apply(f, plan.plan_id);
  assert.equal(batch.state, "completed_with_issues");
  assert.equal(batch.items[0]?.state, "recovery_required");
  assert.equal(batch.items[0]?.error?.code, "recovery_required");
  assert.equal((await f.store.getActive("github"))?.digest, digest("a"));
  const registered = getDb()
    .prepare("SELECT manifest FROM connectors WHERE connector_id='github'")
    .get<{ manifest: string }>();
  assert.ok(registered);
  assert.equal(JSON.parse(registered.manifest).version, "1.3.0");
  assert.equal((await inspectActiveConnector(f.store, "github")).status, "invalid");
  await assert.rejects(resolveActiveConnectorPath(f.store, "github"), { code: "recovery_required" });
});

test("activation fault after pointer write never reports success", async (t) => {
  const f = fixture(t);
  await f.service.install("github", digest("a"));
  f.setEntries([f.next()]);
  const plan = await ready(f);
  const { activate } = f.store;
  f.store.activate = async (record) => {
    await activate(record);
    if (record.digest === digest("b")) {
      throw new Error("injected activation write failure");
    }
  };
  const batch = await apply(f, plan.plan_id);
  assert.equal(batch.items[0]?.state, "recovery_required");
  assert.equal((await inspectActiveConnector(f.store, "github")).status, "invalid");
});

test("active run defers activation while retaining its old artifact and liveness row", async (t) => {
  const f = fixture(t);
  const previous = await f.service.install("github", digest("a"));
  f.setEntries([f.next()]);
  const plan = await ready(f);
  getDb()
    .prepare(
      "INSERT INTO controller_active_runs(connector_instance_id,connector_id,run_id,trace_id,scenario_id,started_at) VALUES(?,?,?,?,?,?)"
    )
    .run("cin_active", "github", "run_active", "trace_active", "collect", new Date().toISOString());
  const batch = await apply(f, plan.plan_id);
  assert.equal(batch.items[0]?.state, "deferred");
  assert.equal(batch.items[0]?.retry_eligible, true);
  assert.equal((await f.store.getActive("github"))?.digest, previous.digest);
  assert.equal(existsSync(join(previous.root, "dist", "collection-profile.mjs")), true);
  assert.ok(getDb().prepare("SELECT 1 FROM controller_active_runs WHERE run_id='run_active'").get());
});

test("concurrent retries share one batch and another request cannot reuse the key", async (t) => {
  const f = fixture(t);
  await f.service.install("github", digest("a"));
  f.setEntries([f.next()]);
  const plan = await ready(f);
  const request = { idempotency_key: "concurrent", plan_id: plan.plan_id };
  const [first, second] = await Promise.all([f.updates.createBatch(request), f.updates.createBatch(request)]);
  assert.equal(first.batch_id, second.batch_id);
  await f.updates.settled();
  await assert.rejects(f.updates.createBatch({ ...request, selected_connector_ids: [] }), {
    code: "idempotency_conflict",
  });
});

test("restart retains receipts and fences an interrupted publication without replay", async (t) => {
  const f = fixture(t);
  await f.service.install("github", digest("a"));
  f.setEntries([f.next()]);
  const plan = await ready(f);
  const batch = await apply(f, plan.plan_id);
  const saved = { ...batch, items: batch.items.map((item) => ({ ...item, state: "activating" })), state: "running" };
  writeFileSync(join(f.dataDir, "connector-updates", `batch-${batch.batch_id}.json`), JSON.stringify(saved));
  const restarted = f.remake();
  const { updates } = restarted;
  assert.ok(updates);
  await updates.settled();
  assert.equal(updates.getBatch(batch.batch_id).items[0]?.state, "recovery_required");
  await assert.rejects(resolveActiveConnectorPath(f.store, "github"), { code: "recovery_required" });
  const duplicate = await updates.createBatch({ idempotency_key: "request-a", plan_id: plan.plan_id });
  assert.equal(duplicate.batch_id, batch.batch_id);
});

test("partial batch continues another connector after registration failure", async (t) => {
  const f = fixture(t);
  const github = f.next("1.2.0");
  f.setEntries([
    { ...github, digest: digest("a") },
    { ...github, connector_id: "gitlab", connector_key: "gitlab", digest: digest("d") },
  ]);
  await f.service.install("github", digest("a"));
  await f.service.install("gitlab", digest("d"));
  f.setEntries([
    { ...github, version: "1.3.0" },
    { ...github, connector_id: "gitlab", connector_key: "gitlab", digest: digest("e"), version: "1.3.0" },
  ]);
  const plan = await ready(f);
  assert.equal(plan.manual_count, 2);
  const { activate } = f.store;
  f.store.activate = async (record) => {
    if (record.connectorId === "github" && record.digest === digest("b")) {
      throw new Error("injected github failure");
    }
    await activate(record);
  };
  const batch = await apply(f, plan.plan_id);
  assert.equal(batch.state, "completed_with_issues");
  assert.equal(batch.items.find((item) => item.connector_id === "github")?.state, "recovery_required");
  assert.equal(batch.items.find((item) => item.connector_id === "gitlab")?.state, "succeeded");
});

test("owner plan/apply/status journey uses guarded routes and rejects automatic triggers", async (t) => {
  const f = fixture(t);
  await f.service.install("github", digest("a"));
  f.setEntries([f.next()]);
  const routes = new Map<string, any[]>();
  const app = {
    get(path: string, ...args: any[]) {
      routes.set(`GET ${path}`, args);
      return app;
    },
    post(path: string, ...args: any[]) {
      routes.set(`POST ${path}`, args);
      return app;
    },
  };
  const requireToken = () => undefined;
  const requireOwner = () => undefined;
  mountOwnerConnectorInstall(app, {
    handleError(_response, error) {
      throw error;
    },
    pdppError() {
      throw new Error("unexpected route error");
    },
    requireOwner,
    requireToken,
    service: f.service,
  });
  const call = async (route: string, body?: Record<string, unknown>, params?: Record<string, string>) => {
    let status = 200;
    let payload: any;
    const response = {
      json(value: unknown) {
        payload = value;
      },
      status(code: number) {
        status = code;
        return response;
      },
    };
    const handlers = routes.get(route);
    assert.ok(handlers);
    assert.equal(handlers[0], requireToken);
    assert.equal(handlers[1], requireOwner);
    await handlers.at(-1)({ body, params }, response);
    return { payload, status };
  };
  const created = await call("POST /v1/owner/connector-updates/plans");
  assert.equal(created.status, 202);
  assert.ok(created.payload.data.status_url.endsWith(created.payload.data.plan_id));
  await f.updates.settled();
  const plan = await call("GET /v1/owner/connector-updates/plans/:id", undefined, { id: created.payload.data.plan_id });
  assert.equal(plan.payload.data.state, "ready");
  const batch = await call("POST /v1/owner/connector-updates/batches", {
    idempotency_key: "route",
    plan_id: created.payload.data.plan_id,
  });
  assert.equal(batch.status, 202);
  await f.updates.settled();
  const result = await call("GET /v1/owner/connector-updates/batches/:id", undefined, {
    id: batch.payload.data.batch_id,
  });
  assert.equal(result.payload.data.state, "completed");
  assert.equal(result.payload.data.items[0].target.digest, digest("b"));
  f.setEntries([{ ...f.next("2.0.0"), digest: digest("d") }]);
  const major = await call("POST /v1/owner/connector-updates/plans");
  await f.updates.settled();
  const reviewed = await call("GET /v1/owner/connector-updates/plans/:id", undefined, { id: major.payload.data.plan_id });
  assert.equal(reviewed.payload.data.items[0].review_required, true);
  const consent = await call(
    "POST /v1/owner/connector-updates/plans/:id/consents",
    { connector_id: "github", target_digest: digest("d") },
    { id: major.payload.data.plan_id }
  );
  assert.equal(consent.status, 201);
  const majorBatch = await call("POST /v1/owner/connector-updates/batches", {
    consent_token: consent.payload.data.consent_token,
    idempotency_key: "route-major",
    plan_id: major.payload.data.plan_id,
    selected_connector_ids: ["github"],
  });
  assert.equal(majorBatch.status, 202);
  await f.updates.settled();
  assert.equal(f.updates.getBatch(majorBatch.payload.data.batch_id).items[0]?.state, "succeeded");
  await assert.rejects(
    call("POST /v1/owner/connector-updates/batches", {
      idempotency_key: "automatic",
      plan_id: created.payload.data.plan_id,
      trigger: "automatic",
    }),
    UNEXPECTED_ROUTE_ERROR
  );
});

test("prepared artifact corruption fails before publication and leaves old dispatch available", async (t) => {
  const f = fixture(t);
  await f.service.install("github", digest("a"));
  f.setEntries([f.next()]);
  const plan = await ready(f);
  writeFileSync(join(f.dataDir, "connectors", "github", digest("b"), "dist", "collection-profile.mjs"), "corrupt");
  const batch = await apply(f, plan.plan_id);
  assert.equal(batch.items[0]?.state, "failed");
  assert.equal(batch.items[0]?.error?.code, "verification_failed");
  assert.equal((await inspectActiveConnector(f.store, "github")).status, "active");
  assert.equal((await f.store.getActive("github"))?.digest, digest("a"));
});

test("competing installer defers publication and keeps old dispatch available", async (t) => {
  const f = fixture(t);
  await f.service.install("github", digest("a"));
  f.setEntries([f.next()]);
  const plan = await ready(f);
  const lock = acquireDirectoryLock(f.dataDir, ".connector-install.lock", "held by test");
  try {
    const batch = await apply(f, plan.plan_id);
    assert.equal(batch.items[0]?.state, "deferred");
    assert.equal(batch.items[0]?.error?.code, "connector_install_busy");
    assert.equal(batch.items[0]?.retry_eligible, true);
    assert.equal((await inspectActiveConnector(f.store, "github")).status, "active");
    assert.equal((await f.store.getActive("github"))?.digest, digest("a"));
  } finally {
    lock.release();
  }
});
