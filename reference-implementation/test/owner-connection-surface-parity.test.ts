// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Parity between the owner-session (`/_ref/connections`, cookie) and
 * owner-bearer (`/v1/owner/connections`) surfaces for list, rename, revoke,
 * reactivate, schedule writes, and detail, against a real server and store.
 * Each capability is
 * one handler mounted behind both auth adapters, so for the same request both
 * surfaces must return the same status, the same body, and the same audit
 * event. What may differ:
 *   - list and rename rows: the bearer adds `supported_actions` (links into
 *     the bearer control catalog);
 *   - audit events: the actor (`owner_session` vs `owner_agent` and the
 *     bearer's client fields);
 *   - per-request ids, timestamps, and the connection a request targeted.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// biome-ignore lint/correctness/noUnresolvedImports: Node and TypeScript resolve this installed package export.
import { readPolyfillManifests } from "@pdpp/polyfill-connectors/manifests";

import { listSpineEventsPage } from "../lib/spine.ts";
import { canonicalConnectorKey } from "../server/connector-key.ts";
import { startServer } from "../server/index.ts";
import { createSqliteConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";
import { TEST_PRE_REGISTERED_PUBLIC_CLIENTS } from "./fixtures/demo-clients.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, "..");
const OWNER_SUBJECT_ID = "owner_local";
const OWNER_CLIENT_ID = "cli_longview";
const NOW = "2026-10-07T00:00:00.000Z";
// One connection per surface, so each surface mutates its own row.
const COOKIE_CONNECTION = "cin_parity_cookie";
const BEARER_CONNECTION = "cin_parity_bearer";

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

interface Surfaces {
  asUrl: string;
  auth: Record<string, string>;
  /** Calls the bearer route for `connectionId`. */
  bearer: (method: string, connectionId: string, suffix?: string, body?: unknown) => Promise<JsonResult>;
  /** Calls the cookie route for `connectionId`. */
  cookie: (method: string, connectionId: string, suffix?: string, body?: unknown) => Promise<JsonResult>;
  rsUrl: string;
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

async function issueOwnerToken(asUrl: string, sessionCookie?: string): Promise<string> {
  const device = (
    await fetchJson(`${asUrl}/oauth/device_authorization`, {
      body: new URLSearchParams({ client_id: OWNER_CLIENT_ID }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    })
  ).body as { user_code: string; device_code: string };
  const csrf = sessionCookie ? await hostedCsrf(asUrl, `/device?user_code=${device.user_code}`, sessionCookie) : null;
  const approval = await fetch(`${asUrl}/device/approve`, {
    body: new URLSearchParams({
      subject_id: OWNER_SUBJECT_ID,
      user_code: device.user_code,
      ...(csrf ? { _csrf: csrf.field } : {}),
    }).toString(),
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...(csrf ? { Cookie: `${sessionCookie}; ${csrf.cookie}` } : {}),
    },
    method: "POST",
    redirect: "manual",
  });
  assert.ok(approval.status === 200 || approval.status === 302, "owner device approval succeeds");
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

async function seedConnections(asUrl: string, sessionCookie?: string): Promise<void> {
  const manifest = JSON.parse(
    readFileSync(join(REFERENCE_IMPL_DIR, "fixtures", "seed-manifests", "spotify.json"), "utf8")
  ) as { connector_id: string };
  const resp = await fetch(`${asUrl}/connectors`, {
    body: JSON.stringify(manifest),
    headers: { "Content-Type": "application/json", ...(sessionCookie ? { Cookie: sessionCookie } : {}) },
    method: "POST",
  });
  assert.equal(resp.status, 201);
  const connectorKey = canonicalConnectorKey(manifest.connector_id);
  assert.ok(connectorKey, "expected a canonical connector key");
  const store = createSqliteConnectorInstanceStore();
  for (const [connectorInstanceId, label] of [
    [COOKIE_CONNECTION, "cookie"],
    [BEARER_CONNECTION, "bearer"],
  ] as const) {
    // biome-ignore lint/performance/noAwaitInLoops: Seed rows in a stable order.
    await store.upsert({
      connectorId: connectorKey,
      connectorInstanceId,
      createdAt: NOW,
      displayName: `Spotify ${label}`,
      ownerSubjectId: OWNER_SUBJECT_ID,
      sourceBinding: { account_hint: label },
      sourceBindingKey: label,
      sourceKind: "account",
      status: "active",
      updatedAt: NOW,
    });
  }
}

async function withSurfaces(fn: (surfaces: Surfaces) => Promise<void>, authenticated = false): Promise<void> {
  const server = (await startServer({
    asPort: 0,
    dbPath: ":memory:",
    ownerAuthPassword: authenticated ? "owner-parity-test-password" : "",
    preRegisteredPublicClients: TEST_PRE_REGISTERED_PUBLIC_CLIENTS,
    quiet: true,
    rsPort: 0,
  })) as StartedServer;
  try {
    const asUrl = `http://localhost:${server.asPort}`;
    const rsUrl = `http://localhost:${server.rsPort}`;
    const sessionCookie = authenticated ? await loginOwner(asUrl) : undefined;
    await seedConnections(asUrl, sessionCookie);
    const auth = { Authorization: `Bearer ${await issueOwnerToken(asUrl, sessionCookie)}` };
    const call =
      (base: string, headers: Record<string, string>) =>
      (method: string, connectionId: string, suffix = "", body?: unknown) =>
        fetchJson(`${base}/${connectionId}${suffix}`, {
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
          method,
        });
    await fn({
      asUrl,
      auth,
      bearer: call(`${rsUrl}/v1/owner/connections`, auth),
      cookie: call(`${asUrl}/_ref/connections`, sessionCookie ? { Cookie: sessionCookie } : {}),
      rsUrl,
    });
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

// Fields that legitimately differ between two requests: which connection
// they targeted, when they ran, and the bearer-only control links.
const PER_REQUEST_FIELDS = new Set([
  "connection_id",
  "connector_instance_id",
  "display_name",
  "reactivated_at",
  "revoked_at",
  "source_binding",
  "supported_actions",
  "updated_at",
]);

function comparable(body: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(body).filter(([key]) => !PER_REQUEST_FIELDS.has(key)));
}

function errorBody(result: JsonResult): Record<string, unknown> {
  const { request_id: _requestId, ...error } = result.body.error as Record<string, unknown>;
  return error;
}

interface AuditEvent {
  data: Record<string, unknown>;
  event_type: string;
  object_type: string;
  status: string;
}

function auditEvent(result: JsonResult, eventType: string): AuditEvent {
  const traceId = result.headers.get("PDPP-Reference-Trace-Id");
  assert.ok(traceId, `a ${eventType} response carries its audit trace id`);
  const events = listSpineEventsPage("trace", traceId, { limit: 20 }).events as unknown as AuditEvent[];
  const event = events.find((entry) => entry.event_type === eventType);
  assert.ok(event, `expected a ${eventType} audit event on ${traceId}`);
  return event;
}

// The audit fields that do not depend on the surface or the target row.
function auditWithoutActor(event: AuditEvent): Record<string, unknown> {
  const {
    actor_kind: _actorKind,
    auth_token_kind: _authTokenKind,
    client_id: _clientId,
    client_name: _clientName,
    connection_id: _connectionId,
    ...rest
  } = event.data;
  return { event_type: event.event_type, object_type: event.object_type, status: event.status, ...rest };
}

function assertAuditParity(cookie: JsonResult, bearer: JsonResult, eventType: string): void {
  const cookieEvent = auditEvent(cookie, eventType);
  const bearerEvent = auditEvent(bearer, eventType);
  assert.equal(cookieEvent.data.actor_kind, "owner_session");
  assert.equal(bearerEvent.data.actor_kind, "owner_agent");
  assert.equal(bearerEvent.data.client_id, OWNER_CLIENT_ID);
  assert.deepEqual(auditWithoutActor(bearerEvent), auditWithoutActor(cookieEvent));
}

test("parity: list returns the same owner_connection rows on both surfaces", async () => {
  await withSurfaces(async ({ asUrl, auth, rsUrl }) => {
    for (const query of ["", "?connector_id=spotify", "?status=active", "?status=revoked"]) {
      // biome-ignore lint/performance/noAwaitInLoops: Requests are compared pairwise and in order.
      const cookie = await fetchJson(`${asUrl}/_ref/connections${query}`);
      const bearer = await fetchJson(`${rsUrl}/v1/owner/connections${query}`, { headers: auth });
      assert.equal(cookie.status, 200);
      assert.equal(bearer.status, 200);
      const bearerRows = bearer.body.data as Record<string, unknown>[];
      const cookieRows = cookie.body.data as Record<string, unknown>[];
      for (const row of bearerRows) {
        assert.ok(Array.isArray(row.supported_actions), "bearer rows carry supported_actions");
      }
      for (const row of cookieRows) {
        assert.equal(row.supported_actions, undefined, "cookie rows carry no bearer control links");
      }
      assert.deepEqual(
        bearerRows.map(({ supported_actions: _actions, ...bearerRow }) => bearerRow),
        cookieRows,
        `list parity for "${query}"`
      );
    }
    const all = await fetchJson(`${asUrl}/_ref/connections`);
    const [row] = all.body.data as Record<string, unknown>[];
    assert.ok(row);
    assert.equal(row.object, "owner_connection");
    assert.equal(row.connection_id, row.connector_instance_id);
    assert.equal(row.connector_key, "spotify");
    assert.equal(row.label_status, "owner_set");
  });
});

test("parity: rename returns the same row, errors, and audit on both surfaces, for any owned status", async () => {
  await withSurfaces(async ({ bearer, cookie }) => {
    const cookieRenamed = await cookie("PATCH", COOKIE_CONNECTION, "", { display_name: "  Family account  " });
    const bearerRenamed = await bearer("PATCH", BEARER_CONNECTION, "", { display_name: "  Family account  " });
    assert.equal(cookieRenamed.status, 200, JSON.stringify(cookieRenamed.body));
    assert.equal(bearerRenamed.status, 200, JSON.stringify(bearerRenamed.body));
    assert.equal(cookieRenamed.body.display_name, "Family account");
    assert.equal(bearerRenamed.body.display_name, "Family account");
    assert.deepEqual(comparable(bearerRenamed.body), comparable(cookieRenamed.body));
    assert.equal(cookieRenamed.body.object, "owner_connection");
    assert.equal(cookieRenamed.body.label_status, "owner_set");
    assertAuditParity(cookieRenamed, bearerRenamed, "owner_agent.connection.rename");

    // Invalid body and unknown connection: same typed errors, same audit.
    for (const [connectionId, body, status] of [
      [COOKIE_CONNECTION, { display_name: "   " }, 400],
      [COOKIE_CONNECTION, {}, 400],
      ["cin_never_existed", { display_name: "x" }, 404],
    ] as const) {
      // biome-ignore lint/performance/noAwaitInLoops: Requests are compared pairwise and in order.
      const viaCookie = await cookie("PATCH", connectionId, "", body);
      const viaBearer = await bearer("PATCH", connectionId, "", body);
      assert.equal(viaCookie.status, status);
      assert.equal(viaBearer.status, status);
      assert.deepEqual(errorBody(viaBearer), errorBody(viaCookie));
      assertAuditParity(viaCookie, viaBearer, "owner_agent.connection.rename");
    }

    // A revoked connection is still the owner's and can be renamed on both.
    for (const surface of [cookie, bearer]) {
      // biome-ignore lint/performance/noAwaitInLoops: Each surface is checked in turn.
      assert.equal((await surface("POST", COOKIE_CONNECTION, "/revoke")).status, 200);
      const renamed = await surface("PATCH", COOKIE_CONNECTION, "", { display_name: "Old account" });
      assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
      assert.equal(renamed.body.status, "revoked");
      assert.equal((await surface("POST", COOKIE_CONNECTION, "/reactivate")).status, 200);
    }
  });
});

test("parity: revoke and reactivate return the same bodies, errors, and audit on both surfaces", async () => {
  await withSurfaces(async ({ asUrl, bearer, cookie }) => {
    const cookieRevoked = await cookie("POST", COOKIE_CONNECTION, "/revoke");
    const bearerRevoked = await bearer("POST", BEARER_CONNECTION, "/revoke");
    assert.equal(cookieRevoked.status, 200, JSON.stringify(cookieRevoked.body));
    assert.equal(bearerRevoked.status, 200, JSON.stringify(bearerRevoked.body));
    assert.equal(bearerRevoked.body.object, "owner_connection_revoke");
    assert.equal(bearerRevoked.body.status, "revoked");
    assert.deepEqual(comparable(bearerRevoked.body), comparable(cookieRevoked.body));
    assertAuditParity(cookieRevoked, bearerRevoked, "owner_agent.connection.revoke");

    // Revoked rows read the same on both surfaces.
    const listed = await fetchJson(`${asUrl}/_ref/connections?status=revoked`);
    assert.deepEqual((listed.body.data as { connection_id: string }[]).map((row) => row.connection_id).sort(), [
      BEARER_CONNECTION,
      COOKIE_CONNECTION,
    ]);

    // Repeat revoke and unknown id: same typed errors, same audit.
    for (const [connectionId, status] of [
      [COOKIE_CONNECTION, 400],
      ["cin_never_existed", 404],
    ] as const) {
      // biome-ignore lint/performance/noAwaitInLoops: Requests are compared pairwise and in order.
      const viaCookie = await cookie("POST", connectionId, "/revoke");
      const viaBearer = await bearer("POST", connectionId, "/revoke");
      assert.equal(viaCookie.status, status);
      assert.equal(viaBearer.status, status);
      assert.deepEqual(errorBody(viaBearer), errorBody(viaCookie));
      assertAuditParity(viaCookie, viaBearer, "owner_agent.connection.revoke");
    }

    // Each surface reactivates the row the other one revoked.
    const cookieReactivated = await cookie("POST", BEARER_CONNECTION, "/reactivate");
    const bearerReactivated = await bearer("POST", COOKIE_CONNECTION, "/reactivate");
    assert.equal(cookieReactivated.status, 200, JSON.stringify(cookieReactivated.body));
    assert.equal(bearerReactivated.status, 200, JSON.stringify(bearerReactivated.body));
    assert.equal(cookieReactivated.body.object, "owner_connection_reactivate");
    assert.equal(cookieReactivated.body.status, "active");
    assert.deepEqual(comparable(bearerReactivated.body), comparable(cookieReactivated.body));
    assertAuditParity(cookieReactivated, bearerReactivated, "owner_agent.connection.reactivate");

    // Reactivating an active connection is a typed 409 on both, and audited.
    for (const [connectionId, status] of [
      [COOKIE_CONNECTION, 409],
      ["cin_never_existed", 404],
    ] as const) {
      // biome-ignore lint/performance/noAwaitInLoops: Requests are compared pairwise and in order.
      const viaCookie = await cookie("POST", connectionId, "/reactivate");
      const viaBearer = await bearer("POST", connectionId, "/reactivate");
      assert.equal(viaCookie.status, status);
      assert.equal(viaBearer.status, status);
      assert.deepEqual(errorBody(viaBearer), errorBody(viaCookie));
      const audit = auditEvent(viaBearer, "owner_agent.connection.reactivate");
      assert.equal(audit.status, "failed");
      assertAuditParity(viaCookie, viaBearer, "owner_agent.connection.reactivate");
    }
  });
});

async function approveClientGrant(
  asUrl: string,
  sourceId: string,
  streamName: string,
  instanceId: string
): Promise<string> {
  const par = (
    await fetchJson(`${asUrl}/oauth/par`, {
      body: JSON.stringify({
        authorization_details: [
          {
            access_mode: "continuous",
            purpose_code: "https://pdpp.dev/purpose/analytics",
            purpose_description: "owner-connection schedule boundary test",
            source: { id: sourceId, kind: "connector" },
            streams: [{ fields: ["id"], instance_ids: [instanceId], name: streamName }],
            type: "https://pdpp.dev/data-access",
          },
        ],
        client_id: "longview",
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    })
  ).body as { request_uri: string };
  const review = (
    await fetchJson(`${asUrl}/consent/review`, {
      body: JSON.stringify({
        request_uri: par.request_uri,
        subject_id: OWNER_SUBJECT_ID,
      }),
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      method: "POST",
    })
  ).body as {
    approval_review?: object;
    approval_review_revision?: string;
    request_uri?: string;
  };
  assert.ok(review.approval_review);
  assert.ok(review.approval_review_revision);
  assert.equal(review.request_uri, par.request_uri);
  const approved = (
    await fetchJson(`${asUrl}/consent/approve`, {
      body: JSON.stringify({
        approval_review_revision: review.approval_review_revision,
        request_uri: review.request_uri,
      }),
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      method: "POST",
    })
  ).body as { token?: string };
  assert.ok(approved.token, "consent approval should issue a client grant token");
  return approved.token as string;
}

// Real HTTP and storage catch missing mounts and guards that handler doubles cannot.
function comparableSchedule(body: Record<string, unknown>): Record<string, unknown> {
  const { created_at: _createdAt, updated_at: _updatedAt, connector_instance_id: _id, ...rest } = body;
  return rest;
}

async function seedForeignConnection(): Promise<void> {
  await createSqliteConnectorInstanceStore().upsert({
    connectorId: "spotify",
    connectorInstanceId: "cin_foreign",
    ownerSubjectId: "another_owner",
    sourceKind: "account",
    status: "active",
    displayName: "Foreign",
    sourceBindingKey: "foreign",
    createdAt: NOW,
    updatedAt: NOW,
  });
}

test("parity: connection detail returns the exact same body, schedule, and legacy alias", async () => {
  await withSurfaces(async ({ asUrl, bearer, cookie }) => {
    assert.equal(
      (
        await cookie("PUT", COOKIE_CONNECTION, "/schedule", {
          enabled: false,
          interval_seconds: 3600,
        })
      ).status,
      200
    );
    const a = await cookie("GET", COOKIE_CONNECTION);
    const b = await bearer("GET", COOKIE_CONNECTION);
    const alias = await fetchJson(`${asUrl}/_ref/connector-instances/${COOKIE_CONNECTION}`);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(alias.status, 200);
    assert.deepEqual(b.body, a.body);
    assert.deepEqual(alias.body, a.body);
    assert.equal(b.body.object, "owner_connection");
    assert.equal(b.body.connection_id, COOKIE_CONNECTION);
    assert.equal((b.body.schedule as Record<string, unknown>).interval_seconds, 3600);
  });
});

test("parity: connection detail has identical missing, foreign-owner, and inactive errors", async () => {
  await withSurfaces(async ({ bearer, cookie }) => {
    await seedForeignConnection();
    assert.equal((await cookie("POST", COOKIE_CONNECTION, "/revoke")).status, 200);
    for (const [id, status] of [
      ["cin_missing", 404],
      ["cin_foreign", 403],
      [COOKIE_CONNECTION, 400],
    ] as const) {
      // biome-ignore lint/performance/noAwaitInLoops: Compare both surfaces for each boundary.
      const a = await cookie("GET", id);
      const b = await bearer("GET", id);
      assert.equal(a.status, status, JSON.stringify(a.body));
      assert.equal(b.status, status, JSON.stringify(b.body));
      assert.deepEqual(errorBody(b), errorBody(a));
    }
  });
});

test("parity: schedule PUT creates and replaces with identical bodies and audit", async () => {
  await withSurfaces(async ({ bearer, cookie }) => {
    for (const interval of [3600, 7200]) {
      // biome-ignore lint/performance/noAwaitInLoops: Create then replace the same persisted schedules.
      const a = await cookie("PUT", COOKIE_CONNECTION, "/schedule", {
        enabled: false,
        interval_seconds: interval,
        jitter_seconds: 10,
      });
      const b = await bearer("PUT", BEARER_CONNECTION, "/schedule", {
        enabled: false,
        interval_seconds: interval,
        jitter_seconds: 10,
      });
      assert.equal(a.status, 200, JSON.stringify(a.body));
      assert.equal(b.status, 200, JSON.stringify(b.body));
      assert.deepEqual(comparableSchedule(b.body), comparableSchedule(a.body));
      assert.equal(b.body.interval_seconds, interval);
      assert.equal(b.body.jitter_seconds, 10);
      assertAuditParity(a, b, "owner_agent.connection.schedule");
      const detail = await cookie("GET", BEARER_CONNECTION);
      assert.equal((detail.body.schedule as Record<string, unknown>).interval_seconds, interval);
    }
  });
});

test("parity: schedule PUT returns identical validation and resolution errors and failed audit", async () => {
  await withSurfaces(async ({ bearer, cookie }) => {
    await seedForeignConnection();
    for (const [id, input, status] of [
      [COOKIE_CONNECTION, {}, 400],
      [COOKIE_CONNECTION, { interval_seconds: 0 }, 400],
      [COOKIE_CONNECTION, { interval_seconds: 3600, jitter_seconds: -1 }, 400],
      ["cin_missing", { interval_seconds: 3600 }, 404],
      ["cin_foreign", { interval_seconds: 3600 }, 403],
    ] as const) {
      // biome-ignore lint/performance/noAwaitInLoops: Compare both surfaces for each boundary.
      const a = await cookie("PUT", id, "/schedule", input);
      const b = await bearer("PUT", id, "/schedule", input);
      assert.equal(a.status, status, JSON.stringify(a.body));
      assert.equal(b.status, status, JSON.stringify(b.body));
      assert.deepEqual(errorBody(b), errorBody(a));
      assertAuditParity(a, b, "owner_agent.connection.schedule");
      assert.equal(auditEvent(b, "owner_agent.connection.schedule").status, "failed");
    }
    assert.equal((await cookie("GET", COOKIE_CONNECTION)).body.schedule, null);
  });
});

test("detail and schedule PUT reject client tokens with 403 and leave the schedule untouched", async () => {
  await withSurfaces(async ({ asUrl, rsUrl, cookie }) => {
    const manifest = JSON.parse(
      readFileSync(join(REFERENCE_IMPL_DIR, "fixtures", "seed-manifests", "spotify.json"), "utf8")
    ) as { connector_id: string; streams: { name: string }[] };
    const [stream] = manifest.streams;
    assert.ok(stream);
    const token = await approveClientGrant(asUrl, manifest.connector_id, stream.name, COOKIE_CONNECTION);
    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };
    const detail = await fetchJson(`${rsUrl}/v1/owner/connections/${COOKIE_CONNECTION}`, { headers });
    assert.equal(detail.status, 403);
    assert.equal((detail.body.error as Record<string, unknown>).code, "permission_error");
    const write = await fetchJson(`${rsUrl}/v1/owner/connections/${COOKIE_CONNECTION}/schedule`, {
      headers,
      method: "PUT",
      body: JSON.stringify({ enabled: false, interval_seconds: 3600 }),
    });
    assert.equal(write.status, 403);
    assert.equal((write.body.error as Record<string, unknown>).code, "permission_error");
    const audit = auditEvent(write, "owner_agent.connection.schedule");
    assert.equal(audit.status, "failed");
    assert.equal(audit.data.actor_kind, "client");
    assert.equal((await cookie("GET", COOKIE_CONNECTION)).body.schedule, null);
  });
});

test("parity: connector-keyed schedule PUT preserves ambiguity errors and single-connection selection", async () => {
  await withSurfaces(async ({ asUrl, rsUrl, auth, cookie }) => {
    const input = { enabled: false, interval_seconds: 3600 };
    const write = (base: string, headers: Record<string, string>) =>
      fetchJson(`${base}/spotify/schedule`, {
        method: "PUT",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
    const a = await write(`${asUrl}/_ref/connectors`, {});
    const b = await write(`${rsUrl}/v1/owner/connectors`, auth);
    assert.equal(a.status, 400);
    assert.equal(b.status, 400);
    assert.deepEqual(errorBody(b), errorBody(a));
    assert.equal(errorBody(b).code, "ambiguous_connector_instance");
    assertAuditParity(a, b, "owner_agent.connection.schedule");
    assert.equal((await cookie("POST", BEARER_CONNECTION, "/revoke")).status, 200);
    const created = await write(`${asUrl}/_ref/connectors`, {});
    const replaced = await write(`${rsUrl}/v1/owner/connectors`, auth);
    assert.equal(created.status, 200);
    assert.equal(replaced.status, 200);
    assert.equal(replaced.body.connector_instance_id, COOKIE_CONNECTION);
    assert.deepEqual(comparableSchedule(replaced.body), comparableSchedule(created.body));
    assertAuditParity(created, replaced, "owner_agent.connection.schedule");
  });
});

test("parity: schedule PUT preserves policy warnings and automation eligibility without changing a rejected row", async () => {
  await withSurfaces(async ({ asUrl, bearer, cookie }) => {
    const manifest = readPolyfillManifests().find((entry) => entry.file === "usaa.json")?.manifest;
    assert.ok(manifest);
    const registered = await fetchJson(`${asUrl}/connectors`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(manifest),
    });
    assert.equal(registered.status, 201);
    await createSqliteConnectorInstanceStore().upsert({
      connectorId: "usaa",
      connectorInstanceId: "cin_policy",
      ownerSubjectId: OWNER_SUBJECT_ID,
      sourceKind: "account",
      status: "active",
      displayName: "Policy",
      sourceBindingKey: "policy",
      createdAt: NOW,
      updatedAt: NOW,
    });
    const input = { enabled: false, interval_seconds: 60 };
    const a = await cookie("PUT", "cin_policy", "/schedule", input);
    const b = await bearer("PUT", "cin_policy", "/schedule", input);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.ok(typeof a.body.policy_warning === "string");
    assert.deepEqual(comparableSchedule(b.body), comparableSchedule(a.body));
    assertAuditParity(a, b, "owner_agent.connection.schedule");
    const rejectedCookie = await cookie("PUT", "cin_policy", "/schedule", { ...input, enabled: true });
    const rejectedBearer = await bearer("PUT", "cin_policy", "/schedule", { ...input, enabled: true });
    assert.equal(rejectedCookie.status, 400);
    assert.equal(rejectedBearer.status, 400);
    assert.deepEqual(errorBody(rejectedBearer), errorBody(rejectedCookie));
    assertAuditParity(rejectedCookie, rejectedBearer, "owner_agent.connection.schedule");
    const detail = await cookie("GET", "cin_policy");
    assert.equal((detail.body.schedule as Record<string, unknown>).enabled, false);
  });
});

test("detail and both schedule PUT routes require a bearer (401)", async () => {
  await withSurfaces(async ({ rsUrl }) => {
    for (const [path, method] of [
      [`connections/${COOKIE_CONNECTION}`, "GET"],
      [`connections/${COOKIE_CONNECTION}/schedule`, "PUT"],
      ["connectors/spotify/schedule", "PUT"],
    ] as const) {
      // biome-ignore lint/performance/noAwaitInLoops: Check each new auth boundary.
      const response = await fetchJson(`${rsUrl}/v1/owner/${path}`, { method });
      assert.equal(response.status, 401);
    }
  });
});

const CSRF_FIELD_PATTERN = /name="_csrf" value="([^"]+)"/;

async function hostedCsrf(
  asUrl: string,
  path: string,
  sessionCookie?: string
): Promise<{ field: string; cookie: string }> {
  const response = await fetch(`${asUrl}${path}`, {
    headers: { Accept: "text/html", ...(sessionCookie ? { Cookie: sessionCookie } : {}) },
    redirect: "manual",
  });
  assert.equal(response.status, 200);
  const field = (await response.text()).match(CSRF_FIELD_PATTERN)?.[1];
  const cookie = response.headers
    .getSetCookie()
    .find((value) => value.startsWith("pdpp_owner_csrf="))
    ?.split(";")[0];
  assert.ok(field && cookie, "the hosted owner form provides CSRF protection");
  return { field, cookie };
}

async function loginOwner(asUrl: string): Promise<string> {
  const csrf = await hostedCsrf(asUrl, "/owner/login");
  const response = await fetch(`${asUrl}/owner/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: csrf.cookie },
    body: new URLSearchParams({ _csrf: csrf.field, password: "owner-parity-test-password", return_to: "/" }).toString(),
  });
  assert.equal(response.status, 302);
  const cookie = response.headers
    .getSetCookie()
    .find((value) => value.startsWith("pdpp_owner_session="))
    ?.split(";")[0];
  assert.ok(cookie, "owner login issues a session cookie");
  return cookie;
}

test("parity: authenticated cookie and owner bearer share schedule PUT and exact connection detail", async () => {
  await withSurfaces(async ({ asUrl, bearer, cookie }) => {
    const unauthenticated = await fetchJson(`${asUrl}/_ref/connections/${COOKIE_CONNECTION}`, {
      headers: { Accept: "application/json" },
    });
    assert.equal(unauthenticated.status, 401, "cookie auth is active in this journey");
    const input = { enabled: false, interval_seconds: 3600 };
    const a = await cookie("PUT", COOKIE_CONNECTION, "/schedule", input);
    const b = await bearer("PUT", COOKIE_CONNECTION, "/schedule", input);
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal(b.status, 200, JSON.stringify(b.body));
    assert.deepEqual(comparableSchedule(b.body), comparableSchedule(a.body));
    assertAuditParity(a, b, "owner_agent.connection.schedule");
    const cookieDetail = await cookie("GET", COOKIE_CONNECTION);
    const bearerDetail = await bearer("GET", COOKIE_CONNECTION);
    assert.equal(cookieDetail.status, 200);
    assert.equal(bearerDetail.status, 200);
    assert.deepEqual(bearerDetail.body, cookieDetail.body);
    const rejectedCookie = await cookie("PUT", COOKIE_CONNECTION, "/schedule", {});
    const rejectedBearer = await bearer("PUT", COOKIE_CONNECTION, "/schedule", {});
    assert.equal(rejectedCookie.status, 400);
    assert.equal(rejectedBearer.status, 400);
    assert.deepEqual(errorBody(rejectedBearer), errorBody(rejectedCookie));
    assertAuditParity(rejectedCookie, rejectedBearer, "owner_agent.connection.schedule");
  }, true);
});
