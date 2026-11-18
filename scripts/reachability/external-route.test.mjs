// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createServiceVerifier } from "@tnunamak/gozar";
import { createTestingGozar, fakeRegistry } from "@tnunamak/gozar/testing";
import { createOwnerHttpFixture } from "./owner-http-fixture.mjs";
import { setupApproval } from "./journey-support.mjs";

test("an unknown owner-kept route binds consent and recovery to the recorded subject", async (t) => {
  const root = await mkdtemp(join(process.env.TEST_TMPDIR ?? join(homedir(), ".tmp"), "ex-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const id = `fixture-${randomUUID()}`;
  const origin = "https://owner.fixture.invalid";
  const disclosure = { revision: "fixture", text: "Keep the owner's existing relay.", links: [] };
  const registry = await fakeRegistry({
    id, dir: join(root, "registry"), kinds: ["session"], reach: "internet",
    setupActions: [{ id: "endpoint", kind: "provide-value", label: "HTTPS address", valueFormat: "https-origin", digest: "fixture-endpoint", disclosure }],
  });
  const folder = join(registry.root, "providers", id);
  const definitionPath = join(folder, "definition.json");
  const definition = JSON.parse(await readFile(definitionPath, "utf8"));
  definition.adapter.ownership = "external-owned";
  await writeFile(definitionPath, JSON.stringify(definition));
  await rename(join(folder, "index.mjs"), join(folder, "base.mjs"));
  await writeFile(join(folder, "index.mjs"), `
    import base from './base.mjs';
    export default {
      ...base,
      async detect(ctx) {
        const missing = (await ctx.configuration(null))?.endpoint ? [] : this.configurationActions();
        return { state: missing.length ? 'action-required' : 'ready', facts: { detected: true, setupNeeded: missing.length > 0, missing } };
      },
      async plan(ctx, request) {
        const plan = await base.plan(ctx, request);
        const configured = (await ctx.configuration(null)).endpoint;
        return { ...plan, origin: request.origin ?? configured, effects: [], cleanup: { kind: 'external-owned' } };
      },
    };
  `);
  const verify = createServiceVerifier();
  const appBytes = randomUUID();
  const app = createServer((req, res) => { if (!verify(req, res)) res.end(appBytes); }).listen(0, "127.0.0.1");
  await once(app, "listening");
  t.after(() => new Promise(resolve => app.close(resolve)));
  const target = `127.0.0.1:${app.address().port}`;
  const relay = createServer(async (req, res) => {
    const reply = await fetch(`http://${target}${req.url}`, { headers: req.headers });
    res.writeHead(reply.status, Object.fromEntries(reply.headers));
    res.end(Buffer.from(await reply.arrayBuffer()));
  }).listen(0, "127.0.0.1");
  await once(relay, "listening");
  t.after(() => new Promise(resolve => relay.close(resolve)));
  const relayUrl = `http://127.0.0.1:${relay.address().port}`;
  const observed = [];
  const identity = { instanceId: randomUUID(), bootId: randomUUID() };
  const harness = await createTestingGozar({
    ...registry, identity,
    effects: [
      { kind: "network", operation: "fetch", handle: async ({ url, headers }) => {
        const requested = new URL(url);
        assert.ok([origin, `http://${target}`].includes(requested.origin));
        const response = await fetch(`${requested.origin === origin ? relayUrl : `http://${target}`}${requested.pathname}${requested.search}`, { headers });
        const bytes = Buffer.from(await response.arrayBuffer());
        observed.push({ origin: requested.origin, bytes: bytes.length });
        return { status: response.status, headers: Object.fromEntries(response.headers), chunks: [{ data: bytes.toString("base64"), delayMs: 0 }] };
      } },
    ],
  });
  t.after(() => harness.close());
  const dispatched = [];
  const gozar = { ...harness.gozar, expose: request => {
    const { usage, intent, origin, target } = request;
    dispatched.push({ usage, intent, origin, target });
    return harness.gozar.expose(request);
  } };
  const home = join(root, "gozar");
  await mkdir(home, {mode: 0o700});
  const query = { schemaVersion: 1, home, owner: "fixture-owner", target,
    requirements: { reach: "this-device", transport: "any", payloadAccess: "allow-provider", address: "any", setup: "allow", protocols: [] } };
  const open = async (owner = query.owner) => {
    const client = await createOwnerHttpFixture(gozar, {...query, owner}, root, appBytes, identity, {});
    t.after(() => client.close());
    return client;
  };
  const api = await open();
  const [provider] = (await api.call("/catalog")).providers;
  assert.equal(provider.availability.attached.state, "unsupported");
  const draft = await api.call("/drafts", { providerId: id, expectedRevision: provider.configuration.revision });
  const path = `/drafts/${draft.draftId}`;
  const [action] = draft.configuration.actions;
  const applied = await api.call(`${path}/actions/${action.id}`, { expectedRevision: draft.configuration.revision, value: origin, approval: setupApproval(action) });
  await api.call(`${path}/commit`, { expectedRevision: applied.revision });
  const inadmissible = await api.request(`${path}/review`, { usage: "attached" });
  assert.equal(inadmissible.error?.code, "setup_required");
  const review = await api.call(`${path}/review`, { usage: "session" });
  assert.deepEqual({ ...review.candidate.consent.scope.query, ownership: review.candidate.ownership }, {
    usage: {kind: "session", lifetimeMs: 60000}, reach: "internet", transport: "https", target, expectedOrigin: origin, ownership: "external-owned",
  });
  const operation = await api.call("/operations", {
    reviewId: review.id, kind: "route", consentFactsDigest: review.candidate.consentFactsDigest, acknowledgeDisconnect: true,
  });
  const reconcile = `/operations/${operation.operationId}/reconcile`;
  let record;
  for (let attempt = 0; attempt < 200; attempt++) {
    record = await api.operations.read(operation.operationId);
    if (record.stage !== "applying") break;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  assert.equal(record.stage, "settled", JSON.stringify({ code: record.failureCode, dispatched, diagnostics: api.diagnostics }));
  assert.deepEqual(dispatched, [{ usage: { kind: "session", lifetimeMs: 60000 }, intent: "create", origin, target }]);
  assert.ok(observed.some(row => row.origin === origin && row.bytes > 0));
  const { handle } = record;
  assert.equal(handle.kind, "external");
  const resumed = await open();
  const foreign = await open("different-owner");
  const refused = await foreign.request(reconcile, { action: "stop", acknowledgeDisconnect: true });
  assert.equal(refused.error?.code, "operation_recovery_unauthorized");
  assert.equal((await api.operations.read(operation.operationId)).stopTombstone, false);
  const recovered = await resumed.call(reconcile, { action: "check" });
  assert.deepEqual(recovered.handle, handle);
  assert.equal(recovered.ownership, "external-owned");
  const journalPath = join(root, "host-operations", `${operation.operationId}.json`);
  // Model a response lost before the host could persist Gozar's returned handle.
  await writeFile(journalPath, JSON.stringify({ ...record, handle: null }));
  const retained = await open();
  const wrongTarget = { ...record.intent, target: "127.0.0.1:1" };
  await writeFile(journalPath, JSON.stringify({ ...record, handle: null, intent: wrongTarget }));
  const mismatch = await retained.request(reconcile, { action: "stop", acknowledgeDisconnect: true });
  assert.equal(mismatch.error?.code, "operation_recovery_unauthorized");
  assert.equal((await api.operations.read(operation.operationId)).stopTombstone, false);
  await writeFile(journalPath, JSON.stringify({ ...record, handle: null }));
  const rediscovered = await retained.call(reconcile, { action: "check" });
  assert.deepEqual(rediscovered.handle, handle);
  assert.equal(rediscovered.operationId, operation.operationId);
  await writeFile(journalPath, JSON.stringify({ ...record, handle: null }));
  const stopped = await retained.call(reconcile, { action: "stop", acknowledgeDisconnect: true });
  assert.equal(stopped.cleanup.state, "confirmed");
  assert.equal(stopped.published, null);
  const replayed = await (await open()).call(reconcile, { action: "check" });
  assert.equal(replayed.cleanup.state, "confirmed");
  assert.equal(await (await fetch(relayUrl)).text(), appBytes);
});
