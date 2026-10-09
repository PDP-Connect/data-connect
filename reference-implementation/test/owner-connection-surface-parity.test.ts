// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Parity between the owner-session (`/_ref/connections`, cookie) and
 * owner-bearer (`/v1/owner/connections`) surfaces for list, rename, revoke,
 * and reactivate, against a real server and a real store. Each capability is
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

async function seedConnections(asUrl: string): Promise<void> {
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

async function withSurfaces(fn: (surfaces: Surfaces) => Promise<void>): Promise<void> {
  const server = (await startServer({
    asPort: 0,
    dbPath: ":memory:",
    ownerAuthPassword: "",
    preRegisteredPublicClients: TEST_PRE_REGISTERED_PUBLIC_CLIENTS,
    quiet: true,
    rsPort: 0,
  })) as StartedServer;
  try {
    const asUrl = `http://localhost:${server.asPort}`;
    const rsUrl = `http://localhost:${server.rsPort}`;
    await seedConnections(asUrl);
    const auth = { Authorization: `Bearer ${await issueOwnerToken(asUrl)}` };
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
      cookie: call(`${asUrl}/_ref/connections`, {}),
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
