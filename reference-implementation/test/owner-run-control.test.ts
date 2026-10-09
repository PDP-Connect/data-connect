// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Owner-bearer run control (`GET /v1/owner/runs`,
 * `POST /v1/owner/runs/:runId/cancel`, `POST /v1/owner/runs/:runId/interaction`)
 * against a real server, a real spine, and a real connector child.
 *
 * Fixture: a connector that asks for an OTP code (`INTERACTION`) right after
 * START and finishes when it gets an answer. A run of it stays active until
 * someone answers or cancels it.
 *
 * Coverage:
 *   - the agent journey: bearer run-now (202 links to the bearer run routes),
 *     read the pending interaction, answer it, read the completed run;
 *   - parity: the bearer and cookie surfaces return the same ack, the same
 *     typed errors, the same run list, and the same audit event (only the
 *     actor differs);
 *   - parity: cancel returns the same ack and the same typed 404/409 on both;
 *   - the OTP answer never reaches the spine, the audit, or the server log;
 *   - a client (non-owner) bearer is rejected (403) and a request without a
 *     bearer is rejected (401) on every new route.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import pino from "pino";

import { listSpineEventsPage } from "../lib/spine.ts";
import { canonicalConnectorKey } from "../server/connector-key.ts";
import { startServer } from "../server/index.ts";
import { resolveRunControlActor, restoreRunPresentationForOwner } from "../server/routes/_run-control.ts";
import { buildRunCancelHandler } from "../server/routes/run-cancel.ts";
import { buildRunInteractionHandler } from "../server/routes/run-interaction.ts";
import { createSqliteConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";
import { TEST_PRE_REGISTERED_PUBLIC_CLIENTS } from "./fixtures/demo-clients.ts";
import { resolveCredentialFreeFixtureRunEnv } from "./helpers/credential-free-run-fixture.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, "..");
const OWNER_SUBJECT_ID = "owner_local";
const OWNER_CLIENT_ID = "cli_longview";
const NOW = "2026-10-07T00:00:00.000Z";
const CONNECTION_ID = "cin_owner_run_control";
const OTP_SECRET = "otp-418277-never-log";

interface CloseableServer {
  close: (callback?: (err?: Error) => void) => unknown;
  closeAllConnections: () => void;
}

type StartedServer = Awaited<ReturnType<typeof startServer>> & {
  asServer: CloseableServer;
  rsServer: CloseableServer;
  schedulerManager?: { stop?: () => void };
};

interface JsonResult {
  body: Record<string, unknown>;
  headers: Headers;
  status: number;
}

interface Harness {
  asUrl: string;
  connectorId: string;
  logText: () => string;
  rsUrl: string;
}

interface SpineEventLike {
  data?: Record<string, unknown> | null;
  event_type: string;
  [key: string]: unknown;
}

async function fetchJson(url: string, opts: RequestInit = {}): Promise<JsonResult> {
  const resp = await fetch(url, opts);
  const text = await resp.text();
  return {
    body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
    headers: resp.headers,
    status: resp.status,
  };
}

function postJson(url: string, body: unknown, headers: Record<string, string> = {}): Promise<JsonResult> {
  return fetchJson(url, {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", ...headers },
    method: "POST",
  });
}

// A connector that asks for an OTP code and completes once it is answered.
function writeOtpConnector(dir: string): string {
  const path = join(dir, "otp-connector.mjs");
  writeFileSync(
    path,
    `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, terminal: false });
let started = false;
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.type === 'START' && !started) {
    started = true;
    process.stdout.write(JSON.stringify({
      type: 'INTERACTION',
      request_id: 'int_otp_1',
      kind: 'otp',
      message: 'Enter the code we sent you.',
      schema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] },
      timeout_seconds: 60,
    }) + '\\n');
    return;
  }
  if (msg.type === 'INTERACTION_RESPONSE') {
    const status = msg.status === 'success' ? 'succeeded' : 'cancelled';
    process.stdout.write(JSON.stringify({ type: 'DONE', status, records_emitted: 0 }) + '\\n');
    rl.close();
    process.exit(status === 'succeeded' ? 0 : 1);
  }
});
`,
    "utf8"
  );
  return path;
}

async function withServer(fn: (harness: Harness) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-owner-run-control-"));
  const connectorPath = writeOtpConnector(dir);
  const logLines: string[] = [];
  const sink = new Writable({
    write(chunk, _encoding, done) {
      logLines.push(String(chunk));
      done();
    },
  });
  const server = (await startServer({
    asPort: 0,
    connectionScopedRunEnvResolver: resolveCredentialFreeFixtureRunEnv,
    connectorPathResolver: () => connectorPath,
    dbPath: ":memory:",
    logger: pino({ level: "trace" }, sink),
    ownerAuthPassword: "",
    preRegisteredPublicClients: TEST_PRE_REGISTERED_PUBLIC_CLIENTS,
    rsPort: 0,
  })) as StartedServer;
  const asUrl = `http://localhost:${server.asPort}`;
  try {
    const connectorId = await seedConnection(asUrl);
    await fn({ asUrl, connectorId, logText: () => logLines.join(""), rsUrl: `http://localhost:${server.rsPort}` });
  } finally {
    server.schedulerManager?.stop?.();
    server.asServer.closeAllConnections();
    server.rsServer.closeAllConnections();
    await Promise.allSettled([
      new Promise((resolve) => server.asServer.close(resolve)),
      new Promise((resolve) => server.rsServer.close(resolve)),
    ]);
    rmSync(dir, { force: true, recursive: true });
  }
}

// Registers the reference spotify manifest and one active connection for it.
async function seedConnection(asUrl: string): Promise<string> {
  const manifest = JSON.parse(
    readFileSync(join(REFERENCE_IMPL_DIR, "fixtures", "seed-manifests", "spotify.json"), "utf8")
  ) as { connector_id: string };
  const resp = await fetch(`${asUrl}/connectors`, {
    body: JSON.stringify(manifest),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(resp.status, 201);
  const connectorKey = canonicalConnectorKey(manifest.connector_id);
  assert.ok(connectorKey, "expected a canonical connector key");
  await createSqliteConnectorInstanceStore().upsert({
    connectorId: connectorKey,
    connectorInstanceId: CONNECTION_ID,
    createdAt: NOW,
    displayName: "Personal",
    ownerSubjectId: OWNER_SUBJECT_ID,
    sourceBinding: { account_hint: "personal" },
    sourceBindingKey: "personal",
    sourceKind: "account",
    status: "active",
    updatedAt: NOW,
  });
  return manifest.connector_id;
}

// Device-code exchange yields an owner-kind bearer (pdpp_token_kind: "owner").
async function issueOwnerToken(asUrl: string): Promise<string> {
  const device = (
    await fetchJson(`${asUrl}/oauth/device_authorization`, {
      body: new URLSearchParams({ client_id: OWNER_CLIENT_ID }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    })
  ).body as { user_code: string; device_code: string };
  await fetch(`${asUrl}/device/approve`, {
    body: new URLSearchParams({ subject_id: OWNER_SUBJECT_ID, user_code: device.user_code }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const tok = (
    await fetchJson(`${asUrl}/oauth/token`, {
      body: new URLSearchParams({
        client_id: OWNER_CLIENT_ID,
        device_code: device.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    })
  ).body as { access_token?: string };
  assert.ok(tok.access_token, "device exchange should issue an owner token");
  return tok.access_token;
}

// PAR + consent yields a grant-scoped client-kind bearer (pdpp_token_kind: "client").
async function issueClientToken(asUrl: string, connectorId: string): Promise<string> {
  const par = (
    await postJson(`${asUrl}/oauth/par`, {
      authorization_details: [
        {
          access_mode: "continuous",
          purpose_code: "https://pdpp.dev/purpose/analytics",
          purpose_description: "owner run control boundary test",
          source: { id: connectorId, kind: "connector" },
          streams: [{ fields: ["id"], instance_ids: [CONNECTION_ID], name: "top_artists" }],
          type: "https://pdpp.dev/data-access",
        },
      ],
      client_id: "longview",
    })
  ).body as { request_uri?: string };
  assert.ok(par.request_uri, "PAR should return a request_uri");
  const review = (
    await postJson(
      `${asUrl}/consent/review`,
      { request_uri: par.request_uri, subject_id: OWNER_SUBJECT_ID },
      { Accept: "application/json" }
    )
  ).body as { approval_review_revision?: string; request_uri?: string };
  assert.ok(review.approval_review_revision);
  const approved = (
    await postJson(
      `${asUrl}/consent/approve`,
      { approval_review_revision: review.approval_review_revision, request_uri: review.request_uri },
      { Accept: "application/json" }
    )
  ).body as { token?: string };
  assert.ok(approved.token, "consent approval should issue a client grant token");
  return approved.token;
}

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

// Starts a run of the seeded connection over the cookie surface.
async function startCookieRun(asUrl: string): Promise<string> {
  const started = await fetchJson(`${asUrl}/_ref/connections/${CONNECTION_ID}/run`, { method: "POST" });
  assert.equal(started.status, 202, `cookie run-now: ${JSON.stringify(started.body)}`);
  return started.body.run_id as string;
}

async function waitFor<T>(label: string, probe: () => Promise<T | null>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // biome-ignore lint/performance/noAwaitInLoops: Polling is sequential by design.
    const value = await probe();
    if (value !== null) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function timeline(url: string, headers: Record<string, string> = {}): Promise<SpineEventLike[]> {
  const page = await fetchJson(`${url}?limit=100`, { headers });
  return page.status === 200 ? (page.body.data as SpineEventLike[]) : [];
}

// Waits until the run asks for its OTP and returns the interaction id.
function waitForPendingInteraction(asUrl: string, runId: string): Promise<string> {
  return waitFor(`pending interaction on ${runId}`, async () => {
    const events = await timeline(`${asUrl}/_ref/runs/${runId}/timeline`);
    const required = events.find((event) => event.event_type === "run.interaction_required");
    const completed = events.some((event) => event.event_type === "run.interaction_completed");
    return required && !completed ? (required.interaction_id as string) : null;
  });
}

function waitForRunStatus(url: string, headers: Record<string, string>, status: string): Promise<JsonResult> {
  return waitFor(`run status ${status} at ${url}`, async () => {
    const run = await fetchJson(url, { headers });
    return run.body.status === status ? run : null;
  });
}

// Ends a run so it does not outlive its test, and waits for its terminal
// status. A run still blocked on its OTP is ended by cancelling the
// interaction. A run that already ended (for example after a cancel, which can
// finish the run before its interaction resolves) has nothing pending, so the
// interaction cancel may get a typed 404/409 instead of a 202.
async function endRun(asUrl: string, runId: string, interactionId: string): Promise<JsonResult> {
  const cancelled = await postJson(`${asUrl}/_ref/runs/${runId}/interaction`, {
    interaction_id: interactionId,
    status: "cancelled",
  });
  assert.ok([202, 404, 409].includes(cancelled.status), JSON.stringify(cancelled.body));
  return await waitFor(`terminal status for ${runId}`, async () => {
    const run = await fetchJson(`${asUrl}/_ref/runs/${runId}`);
    return run.body.status === "active" ? null : run;
  });
}

function waitForTimelineEvent(asUrl: string, runId: string, eventType: string): Promise<SpineEventLike> {
  return waitFor(`${eventType} on ${runId}`, async () => {
    const events = await timeline(`${asUrl}/_ref/runs/${runId}/timeline`);
    return events.find((event) => event.event_type === eventType) ?? null;
  });
}

// Audit events carry a trace id the route also returns in a response header.
function auditEventFor(result: JsonResult, eventType: string): SpineEventLike {
  const traceId = result.headers.get("PDPP-Reference-Trace-Id");
  assert.ok(traceId, "a run control response carries its audit trace id");
  const events = listSpineEventsPage("trace", traceId, { limit: 20 }).events as unknown as SpineEventLike[];
  const event = events.find((entry) => entry.event_type === eventType);
  assert.ok(event, `expected a ${eventType} audit event on ${traceId}`);
  return event;
}

// The audit fields that legitimately differ between the two surfaces.
function auditWithoutActor(event: SpineEventLike): Record<string, unknown> {
  const {
    actor_id: _actorId,
    actor_kind: _actorKind,
    auth_token_kind: _authTokenKind,
    client_id: _clientId,
    client_name: _clientName,
    run_id: _runId,
    ...rest
  } = event.data ?? {};
  return { event_type: event.event_type, object_type: event.object_type, status: event.status, ...rest };
}

function withoutRequestId(body: Record<string, unknown>): Record<string, unknown> {
  const { request_id: _requestId, ...error } = body.error as Record<string, unknown>;
  return { ...body, error };
}

function withoutRunIds(body: Record<string, unknown>): Record<string, unknown> {
  const { run_id: _runId, ...rest } = body;
  return rest;
}

test("agent journey: bearer run-now links to the run, then the agent answers the OTP and sees it complete", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const auth = bearer(await issueOwnerToken(asUrl));

    const started = await postJson(`${rsUrl}/v1/owner/connections/${CONNECTION_ID}/run`, {}, auth);
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const runId = started.body.run_id as string;
    assert.deepEqual(started.body.links, {
      run: `/v1/owner/runs/${runId}`,
      timeline: `/v1/owner/runs/${runId}/timeline`,
    });

    const links = started.body.links as { run: string; timeline: string };
    const interactionId = await waitFor("bearer-visible pending interaction", async () => {
      const events = await timeline(`${rsUrl}${links.timeline}`, auth);
      const required = events.find((event) => event.event_type === "run.interaction_required");
      return required ? (required.interaction_id as string) : null;
    });

    const answered = await postJson(
      `${rsUrl}/v1/owner/runs/${runId}/interaction`,
      { data: { code: OTP_SECRET }, interaction_id: interactionId, status: "success" },
      auth
    );
    assert.equal(answered.status, 202, JSON.stringify(answered.body));
    assert.deepEqual(answered.body, {
      interaction_id: interactionId,
      object: "run_interaction_ack",
      run_id: runId,
      status: "success",
    });

    const completed = await waitForRunStatus(`${rsUrl}${links.run}`, auth, "completed");
    assert.equal(completed.status, 200);

    const listed = await fetchJson(`${rsUrl}/v1/owner/runs?limit=10`, { headers: auth });
    assert.equal(listed.status, 200);
    const runIds = (listed.body.data as { run_id: string }[]).map((row) => row.run_id);
    assert.ok(runIds.includes(runId), "the bearer run list includes the agent's run");
  });
});

test("parity: answering an interaction returns the same ack, errors, and audit on both surfaces; the OTP is never written", async () => {
  await withServer(async ({ asUrl, logText, rsUrl }) => {
    const auth = bearer(await issueOwnerToken(asUrl));

    const cookieRun = await startCookieRun(asUrl);
    const cookieInteraction = await waitForPendingInteraction(asUrl, cookieRun);
    const cookieAck = await postJson(`${asUrl}/_ref/runs/${cookieRun}/interaction`, {
      data: { code: OTP_SECRET },
      interaction_id: cookieInteraction,
      status: "success",
    });
    await waitForRunStatus(`${asUrl}/_ref/runs/${cookieRun}`, {}, "completed");

    const bearerRun = await startCookieRun(asUrl);
    const bearerInteraction = await waitForPendingInteraction(asUrl, bearerRun);

    // Typed validation errors match before the valid answer lands.
    for (const invalid of [
      { status: "success" },
      { interaction_id: bearerInteraction, status: "maybe" },
      { data: ["not", "an", "object"], interaction_id: bearerInteraction, status: "success" },
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: Requests are compared pairwise and in order.
      const viaBearer = await postJson(`${rsUrl}/v1/owner/runs/${bearerRun}/interaction`, invalid, auth);
      const viaCookie = await postJson(`${asUrl}/_ref/runs/${bearerRun}/interaction`, invalid);
      assert.equal(viaBearer.status, 400);
      assert.equal(viaCookie.status, 400);
      assert.deepEqual(withoutRequestId(viaBearer.body), withoutRequestId(viaCookie.body));
    }
    const staleViaBearer = await postJson(
      `${rsUrl}/v1/owner/runs/${bearerRun}/interaction`,
      { interaction_id: "int_stale", status: "success" },
      auth
    );
    const staleViaCookie = await postJson(`${asUrl}/_ref/runs/${bearerRun}/interaction`, {
      interaction_id: "int_stale",
      status: "success",
    });
    assert.equal(staleViaBearer.status, 409);
    assert.deepEqual(withoutRequestId(staleViaBearer.body), withoutRequestId(staleViaCookie.body));

    const bearerAck = await postJson(
      `${rsUrl}/v1/owner/runs/${bearerRun}/interaction`,
      { data: { code: OTP_SECRET }, interaction_id: bearerInteraction, status: "success" },
      auth
    );
    await waitForRunStatus(`${asUrl}/_ref/runs/${bearerRun}`, {}, "completed");

    assert.equal(cookieAck.status, 202);
    assert.equal(bearerAck.status, 202);
    assert.deepEqual(withoutRunIds(bearerAck.body), withoutRunIds(cookieAck.body));

    const cookieAudit = auditEventFor(cookieAck, "owner.run.interaction_answer");
    const bearerAudit = auditEventFor(bearerAck, "owner.run.interaction_answer");
    assert.equal(cookieAudit.data?.actor_kind, "owner_session");
    assert.equal(bearerAudit.data?.actor_kind, "owner_agent");
    assert.equal(bearerAudit.data?.client_id, OWNER_CLIENT_ID);
    assert.deepEqual(auditWithoutActor(bearerAudit), auditWithoutActor(cookieAudit));
    assert.deepEqual(auditWithoutActor(bearerAudit), {
      event_type: "owner.run.interaction_answer",
      has_data: true,
      interaction_id: "int_otp_1",
      interaction_status: "success",
      object_type: "run",
      operation: "answer_interaction",
      outcome: "succeeded",
      status: "succeeded",
      target_resource: "run",
    });

    for (const runId of [cookieRun, bearerRun]) {
      // biome-ignore lint/performance/noAwaitInLoops: Each run is checked in turn.
      const events = await timeline(`${asUrl}/_ref/runs/${runId}/timeline`);
      assert.ok(events.length > 0);
      assert.ok(!JSON.stringify(events).includes(OTP_SECRET), "the OTP never reaches the run timeline");
    }
    for (const audit of [cookieAudit, bearerAudit]) {
      assert.ok(!JSON.stringify(audit).includes(OTP_SECRET), "the OTP never reaches the audit event");
    }
    assert.ok(logText().length > 0, "the capturing logger saw the requests");
    assert.ok(!logText().includes(OTP_SECRET), "the OTP never reaches the server log");
  });
});

test("parity: cancel returns the same ack and the same typed 404/409 on both surfaces", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const auth = bearer(await issueOwnerToken(asUrl));

    // The cancel acknowledgement is what this test compares. Whether the run
    // has already reached `run.cancelled` when the ack returns is runtime
    // timing, so each run is then ended with `endRun`, which works either way.
    const cookieRun = await startCookieRun(asUrl);
    const cookieInteraction = await waitForPendingInteraction(asUrl, cookieRun);
    const cookieAck = await fetchJson(`${asUrl}/_ref/runs/${cookieRun}/cancel`, { method: "POST" });
    await waitForTimelineEvent(asUrl, cookieRun, "run.cancel_requested");
    await endRun(asUrl, cookieRun, cookieInteraction);

    const bearerRun = await startCookieRun(asUrl);
    const bearerInteraction = await waitForPendingInteraction(asUrl, bearerRun);
    const bearerAck = await fetchJson(`${rsUrl}/v1/owner/runs/${bearerRun}/cancel`, {
      headers: auth,
      method: "POST",
    });
    await waitForTimelineEvent(asUrl, bearerRun, "run.cancel_requested");
    await endRun(asUrl, bearerRun, bearerInteraction);
    const bearerStatus = await fetchJson(`${rsUrl}/v1/owner/runs/${bearerRun}`, { headers: auth });
    assert.equal(bearerStatus.body.status, "cancelled");

    assert.equal(cookieAck.status, 202, JSON.stringify(cookieAck.body));
    assert.equal(bearerAck.status, 202, JSON.stringify(bearerAck.body));
    assert.deepEqual(bearerAck.body, { object: "run_cancel_ack", run_id: bearerRun, status: "cancel_requested" });
    assert.deepEqual(withoutRunIds(bearerAck.body), withoutRunIds(cookieAck.body));
    assert.deepEqual(
      auditWithoutActor(auditEventFor(bearerAck, "owner.run.cancel")),
      auditWithoutActor(auditEventFor(cookieAck, "owner.run.cancel"))
    );

    // A finished run is 409 run_already_terminal; an unknown one is 404 no_active_run.
    for (const [runId, status] of [
      [bearerRun, 409],
      ["run_never_existed", 404],
    ] as const) {
      // biome-ignore lint/performance/noAwaitInLoops: Requests are compared pairwise and in order.
      const viaBearer = await fetchJson(`${rsUrl}/v1/owner/runs/${runId}/cancel`, { headers: auth, method: "POST" });
      const viaCookie = await fetchJson(`${asUrl}/_ref/runs/${runId}/cancel`, { method: "POST" });
      assert.equal(viaBearer.status, status);
      assert.equal(viaCookie.status, status);
      assert.deepEqual(withoutRequestId(viaBearer.body), withoutRequestId(viaCookie.body));
      assert.equal(auditEventFor(viaBearer, "owner.run.cancel").status, "failed");
    }
  });
});

test("parity: bearer and cookie run lists return the same body", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const auth = bearer(await issueOwnerToken(asUrl));
    const runId = await startCookieRun(asUrl);
    const interactionId = await waitForPendingInteraction(asUrl, runId);

    for (const query of ["limit=10", "limit=10&connector_id=spotify", "status=active"]) {
      // biome-ignore lint/performance/noAwaitInLoops: Requests are compared pairwise and in order.
      const viaBearer = await fetchJson(`${rsUrl}/v1/owner/runs?${query}`, { headers: auth });
      const viaCookie = await fetchJson(`${asUrl}/_ref/runs?${query}`);
      assert.equal(viaBearer.status, 200);
      assert.deepEqual(viaBearer.body, viaCookie.body, `run list parity for ${query}`);
    }
    const all = await fetchJson(`${rsUrl}/v1/owner/runs?limit=10`, { headers: auth });
    assert.equal(all.body.object, "list");
    assert.ok((all.body.data as { run_id: string }[]).some((row) => row.run_id === runId));

    await endRun(asUrl, runId, interactionId);
  });
});

test("a client (non-owner) bearer and a missing bearer cannot reach the run control routes", async () => {
  await withServer(async ({ asUrl, connectorId, rsUrl }) => {
    const client = bearer(await issueClientToken(asUrl, connectorId));
    const runId = await startCookieRun(asUrl);
    const interactionId = await waitForPendingInteraction(asUrl, runId);
    const answer = { data: { code: OTP_SECRET }, interaction_id: interactionId, status: "success" };

    const attempts: [string, RequestInit][] = [
      [`${rsUrl}/v1/owner/runs`, {}],
      [`${rsUrl}/v1/owner/runs/${runId}/cancel`, { method: "POST" }],
      [
        `${rsUrl}/v1/owner/runs/${runId}/interaction`,
        { body: JSON.stringify(answer), headers: { "Content-Type": "application/json" }, method: "POST" },
      ],
    ];
    for (const [url, init] of attempts) {
      // biome-ignore lint/performance/noAwaitInLoops: Each route is probed in turn.
      const asClient = await fetchJson(url, { ...init, headers: { ...(init.headers ?? {}), ...client } });
      assert.equal(asClient.status, 403, `client bearer must be rejected at ${url}`);
      assert.equal((asClient.body.error as { code: string }).code, "permission_error");
      const anonymous = await fetchJson(url, init);
      assert.equal(anonymous.status, 401, `missing bearer must be rejected at ${url}`);
    }

    // The run is untouched: still active and waiting on the same interaction,
    // with no cancel requested.
    assert.equal(await waitForPendingInteraction(asUrl, runId), interactionId);
    const run = await fetchJson(`${asUrl}/_ref/runs/${runId}`);
    assert.equal(run.body.status, "active");
    const events = await timeline(`${asUrl}/_ref/runs/${runId}/timeline`);
    assert.ok(!events.some((event) => event.event_type === "run.cancel_requested"));

    await endRun(asUrl, runId, interactionId);
  });
});

test("cancel rejects a mismatched owner before active presentation cleanup", async () => {
  const actor = resolveRunControlActor("owner_bearer", {
    tokenInfo: { pdpp_token_kind: "owner", subject_id: "another_owner" },
  }, OWNER_SUBJECT_ID);
  const presentation = { active: true };
  let cleanupCalls = 0;
  await assert.rejects(
    restoreRunPresentationForOwner("run_presented", OWNER_SUBJECT_ID, actor.ownerSubjectId, async () => {
      cleanupCalls += 1;
      presentation.active = false;
    }),
    { code: "run_owner_mismatch", http_status: 403 }
  );
  assert.equal(cleanupCalls, 0);
  assert.equal(presentation.active, true);
});

async function assertRejectingAuditPreservesOutcome(
  route: "cancel" | "interaction",
  controllerRejects: boolean
): Promise<void> {
  for (const surface of ["owner_session", "owner_bearer"] as const) {
    const originalError = Object.assign(new Error("controller rejected"), {
      code: "run_owner_mismatch",
      http_status: 403,
    });
    const handledErrors: unknown[] = [];
    const auditEvents: Record<string, unknown>[] = [];
    const warnings: unknown[] = [];
    let mutations = 0;
    let statusCode = 0;
    let responseBody: unknown;
    const res = {
      json(body: unknown) {
        responseBody = body;
        return res;
      },
      status(code: number) {
        statusCode = code;
        return res;
      },
    };
    const ctx = {
      controller: {
        cancelRun: async (runId: string, ownerSubjectId: string) => {
          mutations += 1;
          assert.equal(ownerSubjectId, OWNER_SUBJECT_ID);
          if (controllerRejects) {
            throw originalError;
          }
          return { run_id: runId, status: "cancel_requested" };
        },
        getActiveRunOwnerSubjectId: () => OWNER_SUBJECT_ID,
        respondToInteraction: async (
          _runId: string,
          input: { readonly data?: Record<string, unknown> | null | undefined }
        ) => {
          mutations += 1;
          assert.equal(input.data?.code, OTP_SECRET);
          if (controllerRejects) {
            throw originalError;
          }
          return { status: "resolved" };
        },
      },
      createTraceContext: () => ({ request_id: "req_audit", scenario_id: "scenario_audit", trace_id: "trace_audit" }),
      emitSpineEvent: async (event: Record<string, unknown>) => {
        auditEvents.push(event);
        // An emitter error can itself contain secrets; do not log its text.
        throw new Error(OTP_SECRET);
      },
      ensureRequestId: () => "req_audit",
      handleError: (_res: unknown, err: unknown) => {
        handledErrors.push(err);
        res.status(403).json({ error: { code: originalError.code } });
      },
      logger: {
        warn: (obj: Record<string, unknown>, msg: string) => {
          warnings.push({ ...obj, msg });
        },
      },
      ownerSubjectId: OWNER_SUBJECT_ID,
      pdppError: () => assert.fail("unexpected typed rejection"),
      setReferenceTraceId: () => undefined,
    };
    const handler = route === "cancel"
      ? buildRunCancelHandler(ctx, surface)
      : buildRunInteractionHandler(ctx, surface);
    // biome-ignore lint/performance/noAwaitInLoops: Both auth surfaces exercise the same handler independently.
    await handler({
      body: { data: { code: OTP_SECRET }, interaction_id: "int_audit", status: "success" },
      ownerSession: { sub: OWNER_SUBJECT_ID },
      params: { runId: "run_audit" },
      tokenInfo: { pdpp_token_kind: "owner", subject_id: OWNER_SUBJECT_ID },
    }, res);
    assert.equal(mutations, 1);
    assert.equal(auditEvents.length, 1, "audit failure is not retried as a mutation failure");
    assert.equal(auditEvents[0]?.status, controllerRejects ? "failed" : "succeeded");
    assert.deepEqual(handledErrors, controllerRejects ? [originalError] : []);
    if (controllerRejects) {
      assert.equal(handledErrors[0], originalError, "handleError receives the original error");
      assert.equal(statusCode, 403);
      assert.deepEqual(responseBody, { error: { code: "run_owner_mismatch" } });
    } else {
      assert.equal(statusCode, 202);
      assert.deepEqual(responseBody, route === "cancel"
        ? { object: "run_cancel_ack", run_id: "run_audit", status: "cancel_requested" }
        : { interaction_id: "int_audit", object: "run_interaction_ack", run_id: "run_audit", status: "resolved" });
    }
    assert.deepEqual(warnings, [{
      msg: "run_control_audit_failed",
      operation: route === "cancel" ? "cancel_run" : "answer_interaction",
      outcome: controllerRejects ? "failed" : "succeeded",
    }]);
    assert.ok(!JSON.stringify({ auditEvents, responseBody, warnings }).includes(OTP_SECRET));
  }
}

test("cancel preserves success when audit emission rejects", async () => {
  await assertRejectingAuditPreservesOutcome("cancel", false);
});

test("cancel preserves the controller error when failure audit emission rejects", async () => {
  await assertRejectingAuditPreservesOutcome("cancel", true);
});

test("interaction preserves success when audit emission rejects", async () => {
  await assertRejectingAuditPreservesOutcome("interaction", false);
});

test("interaction preserves the controller error when failure audit emission rejects", async () => {
  await assertRejectingAuditPreservesOutcome("interaction", true);
});
