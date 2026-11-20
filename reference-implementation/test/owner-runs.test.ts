// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Owner-bearer run reads (`GET /v1/owner/runs/:runId` and `/timeline`) and the
 * diagnostics `last_run` failure summary, against a real server and real spine.
 *
 * Fixture: a run that the runtime failed with `connector_protocol_violation`
 * (the connector emitted DONE while an interaction was pending). The general
 * executor stores that reason in run_history `terminal_reason` and leaves
 * `failure_reason` null, so a projection that reads only the run-history row
 * reports `failure_reason: null`.
 *
 * Coverage:
 *   - the owner bearer reads the run's status, terminal reason, and failure
 *     summary;
 *   - parity: the bearer and cookie surfaces return the same body (only
 *     `links` differ) and the same timeline envelope for the same run;
 *   - parity: both return the same typed 404 for an unknown run;
 *   - a request without a bearer is rejected (401);
 *   - an active non-owner client bearer is rejected on both run reads (403);
 *   - diagnostics `last_run` carries the same failure summary as the run read.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { emitSpineEvent } from "../lib/spine.ts";
import { canonicalConnectorKey } from "../server/connector-key.ts";
import { startServer } from "../server/index.ts";
import { createSqliteConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";
import { TEST_PRE_REGISTERED_PUBLIC_CLIENTS } from "./fixtures/demo-clients.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, "..");
const OWNER_SUBJECT_ID = "owner_local";
const OWNER_CLIENT_ID = "cli_longview";
const NOW = "2026-10-07T00:00:00.000Z";
const CONNECTION_ID = "cin_owner_runs_chase";
const RUN_ID = "run_owner_runs_protocol_violation";
const FAILURE_MESSAGE = "Connector emitted DONE while waiting for INTERACTION_RESPONSE";

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
  status: number;
}

async function fetchJson(url: string, opts: RequestInit = {}): Promise<JsonResult> {
  const resp = await fetch(url, opts);
  const text = await resp.text();
  return { body: text ? (JSON.parse(text) as Record<string, unknown>) : {}, status: resp.status };
}

async function withServer(fn: (ctx: { asUrl: string; rsUrl: string }) => Promise<void>): Promise<void> {
  const server = (await startServer({
    asPort: 0,
    dbPath: ":memory:",
    ownerAuthPassword: "",
    preRegisteredPublicClients: TEST_PRE_REGISTERED_PUBLIC_CLIENTS,
    quiet: true,
    rsPort: 0,
  })) as StartedServer;
  try {
    await fn({ asUrl: `http://localhost:${server.asPort}`, rsUrl: `http://localhost:${server.rsPort}` });
  } finally {
    server.schedulerManager?.stop?.();
    server.asServer.closeAllConnections();
    server.rsServer.closeAllConnections();
    await Promise.allSettled([
      new Promise((resolve) => server.asServer.close(resolve)),
      new Promise((resolve) => server.rsServer.close(resolve)),
    ]);
  }
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

// Consent approval yields an active client-kind bearer, not an owner bearer.
async function issueClientToken(asUrl: string, connectorId: string): Promise<string> {
  const postJson = (url: string, body: Record<string, unknown>): Promise<JsonResult> =>
    fetchJson(url, {
      body: JSON.stringify(body),
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      method: "POST",
    });
  const par = (
    await postJson(`${asUrl}/oauth/par`, {
      authorization_details: [
        {
          access_mode: "continuous",
          purpose_code: "https://pdpp.dev/purpose/analytics",
          purpose_description: "owner run read boundary test",
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
    await postJson(`${asUrl}/consent/review`, {
      request_uri: par.request_uri,
      subject_id: OWNER_SUBJECT_ID,
    })
  ).body as { approval_review_revision?: string; request_uri?: string };
  assert.ok(review.approval_review_revision);
  const approved = (
    await postJson(`${asUrl}/consent/approve`, {
      approval_review_revision: review.approval_review_revision,
      request_uri: review.request_uri,
    })
  ).body as { token?: string };
  assert.ok(approved.token, "consent approval should issue a client grant token");
  return approved.token;
}

// Registers a reference connector and one active connection for it; returns
// the canonical connector key the run events are stamped with.
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
  return connectorKey;
}

// The runtime's terminal shape for a protocol violation: `reason` plus the
// runtime-authored `failure_message` / `failure_origin`, no connector error.
async function seedProtocolViolationRun(connectorId: string): Promise<void> {
  const common = {
    actor_id: connectorId,
    actor_type: "runtime",
    object_id: RUN_ID,
    object_type: "run",
    run_id: RUN_ID,
  };
  const identity = {
    connection_id: CONNECTION_ID,
    connector_instance_id: CONNECTION_ID,
    source: { id: connectorId, kind: "connector" },
  };
  await emitSpineEvent({
    ...common,
    data: { ...identity, boot_epoch: "boot-owner-runs", seq: 1, trigger_kind: "manual" },
    event_id: `evt_${RUN_ID}_started`,
    event_type: "run.started",
    occurred_at: "2026-10-07T00:00:01.000Z",
    status: "started",
  });
  await emitSpineEvent({
    ...common,
    data: {
      ...identity,
      failure_message: FAILURE_MESSAGE,
      failure_origin: "runtime",
      reason: "connector_protocol_violation",
    },
    event_id: `evt_${RUN_ID}_failed`,
    event_type: "run.failed",
    occurred_at: "2026-10-07T00:00:02.000Z",
    status: "failed",
  });
}

function withoutLinks(body: Record<string, unknown>): Record<string, unknown> {
  const { links: _links, ...rest } = body;
  return rest;
}

// Error envelopes carry a per-request id; everything else must match.
function withoutRequestId(body: Record<string, unknown>): Record<string, unknown> {
  const { request_id: _requestId, ...error } = body.error as Record<string, unknown>;
  return { ...body, error };
}

test("owner bearer reads a failed run's status and failure summary", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    await seedProtocolViolationRun(await seedConnection(asUrl));
    const token = await issueOwnerToken(asUrl);

    const { body, status } = await fetchJson(`${rsUrl}/v1/owner/runs/${RUN_ID}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(status, 200);
    assert.equal(body.object, "run_status");
    assert.equal(body.status, "failed");
    assert.equal(body.terminal_reason, "connector_protocol_violation");
    assert.deepEqual(body.failure, {
      connector_error_message: null,
      message: FAILURE_MESSAGE,
      origin: "runtime",
      reason: "connector_protocol_violation",
    });
    assert.deepEqual(body.links, { timeline: `/v1/owner/runs/${RUN_ID}/timeline` });
  });
});

test("parity: bearer and cookie surfaces return the same run body and timeline", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    await seedProtocolViolationRun(await seedConnection(asUrl));
    const auth = { headers: { Authorization: `Bearer ${await issueOwnerToken(asUrl)}` } };

    const bearerRun = await fetchJson(`${rsUrl}/v1/owner/runs/${RUN_ID}`, auth);
    const cookieRun = await fetchJson(`${asUrl}/_ref/runs/${RUN_ID}`);
    assert.equal(bearerRun.status, 200);
    assert.equal(cookieRun.status, 200);
    assert.deepEqual(withoutLinks(bearerRun.body), withoutLinks(cookieRun.body));
    assert.deepEqual(cookieRun.body.links, { timeline: `/_ref/runs/${RUN_ID}/timeline` });

    const bearerTimeline = await fetchJson(`${rsUrl}/v1/owner/runs/${RUN_ID}/timeline?limit=50`, auth);
    const cookieTimeline = await fetchJson(`${asUrl}/_ref/runs/${RUN_ID}/timeline?limit=50`);
    assert.equal(bearerTimeline.status, 200);
    assert.deepEqual(bearerTimeline.body, cookieTimeline.body);
    const events = bearerTimeline.body.data as { event_type: string }[];
    assert.deepEqual(
      events.map((event) => event.event_type),
      ["run.started", "run.failed"]
    );

    const bearerMissing = await fetchJson(`${rsUrl}/v1/owner/runs/run_never_existed`, auth);
    const cookieMissing = await fetchJson(`${asUrl}/_ref/runs/run_never_existed`);
    assert.equal(bearerMissing.status, 404);
    assert.equal(cookieMissing.status, 404);
    assert.deepEqual(withoutRequestId(bearerMissing.body), withoutRequestId(cookieMissing.body));
  });
});

test("owner run reads reject a request without a bearer", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    await seedProtocolViolationRun(await seedConnection(asUrl));
    assert.equal((await fetchJson(`${rsUrl}/v1/owner/runs/${RUN_ID}`)).status, 401);
    assert.equal((await fetchJson(`${rsUrl}/v1/owner/runs/${RUN_ID}/timeline`)).status, 401);
  });
});

test("owner run reads reject an active non-owner client bearer", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const connectorId = await seedConnection(asUrl);
    await seedProtocolViolationRun(connectorId);
    // PAR names the source by its manifest URI, not the canonical key the run is stamped with.
    const manifest = JSON.parse(
      readFileSync(join(REFERENCE_IMPL_DIR, "fixtures", "seed-manifests", "spotify.json"), "utf8")
    ) as { connector_id: string };
    const auth = { headers: { Authorization: `Bearer ${await issueClientToken(asUrl, manifest.connector_id)}` } };

    for (const path of [`/v1/owner/runs/${RUN_ID}`, `/v1/owner/runs/${RUN_ID}/timeline`]) {
      const { body, status } = await fetchJson(`${rsUrl}${path}`, auth);
      assert.equal(status, 403, path);
      assert.equal((body.error as Record<string, unknown>).code, "permission_error", path);
    }
  });
});

test("diagnostics last_run carries the run's failure reason and summary", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    await seedProtocolViolationRun(await seedConnection(asUrl));
    const auth = { headers: { Authorization: `Bearer ${await issueOwnerToken(asUrl)}` } };

    const diagnostics = await fetchJson(`${rsUrl}/v1/owner/connections/${CONNECTION_ID}/diagnostics`, auth);
    assert.equal(diagnostics.status, 200);
    const lastRun = diagnostics.body.last_run as Record<string, unknown>;
    assert.equal(lastRun.run_id, RUN_ID);
    assert.equal(lastRun.failure_reason, "connector_protocol_violation");

    const run = await fetchJson(`${rsUrl}/v1/owner/runs/${RUN_ID}`, auth);
    assert.deepEqual(lastRun.failure, run.body.failure);
    assert.deepEqual(lastRun.links, {
      run: `/v1/owner/runs/${RUN_ID}`,
      timeline: `/v1/owner/runs/${RUN_ID}/timeline`,
    });
  });
});
