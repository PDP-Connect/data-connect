// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Every RS request leaves an audit trail, and that trail never holds a live
// bearer:
//   - rejected bearers (unknown, missing, failed introspection) write
//     query.received + query.rejected with a denial_reason;
//   - spine token_id / token object_id are keyed HMAC references;
//   - in-process introspection still sees a revocation on the next request;
//   - coalesced record-detail audit still writes both rows;
//   - pool size and keep-alive knobs read their env vars.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AUDIT_TOKEN_REF_PREFIX, auditTokenRef } from "../server/audit-token-ref.ts";
import { canonicalConnectorKey } from "../server/connector-key.ts";
import { getDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";
import { resolvePostgresInteractivePoolMax } from "../server/postgres-storage.ts";
import { createSqliteConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";
import { httpKeepAliveEnabled } from "../server/transport.ts";
import { TEST_RS_INTROSPECTION_CREDENTIALS } from "./helpers/introspection-test-credentials.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, "..");
const NOW = "2026-10-14T00:00:00.000Z";
const UNKNOWN_BEARER = "f".repeat(64);

type TestServer = Awaited<ReturnType<typeof startServer>> & {
  asServer: { close: (cb: (err?: Error) => void) => void; closeAllConnections: () => void };
  rsServer: { close: (cb: (err?: Error) => void) => void; closeAllConnections: () => void };
};

interface SpineRow {
  data_json: string;
  event_type: string;
  object_id: string;
  object_type: string;
  token_id: string | null;
  trace_id: string;
}

interface Manifest {
  readonly connector_id: string;
  readonly [key: string]: unknown;
}

interface Approval {
  readonly grant: { readonly grant_id: string };
  readonly token: string;
}

async function closeServer(server: TestServer): Promise<void> {
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  const closeOne = (srv: TestServer["asServer"]): Promise<void> =>
    new Promise((resolve) => {
      const t = setTimeout(resolve, 2000);
      srv.close(() => {
        clearTimeout(t);
        resolve();
      });
    });
  await Promise.allSettled([closeOne(server.asServer), closeOne(server.rsServer)]);
}

function spineRowsForRequest(requestId: string): SpineRow[] {
  return getDb()
    .prepare(
      "SELECT event_type, object_id, object_type, token_id, trace_id, data_json FROM spine_events WHERE object_id = ? ORDER BY rowid"
    )
    .all(requestId) as SpineRow[];
}

async function approveGrant(asUrl: string, manifest: Manifest): Promise<Approval> {
  const par = await fetch(`${asUrl}/oauth/par`, {
    body: JSON.stringify({
      authorization_details: [
        {
          access_mode: "continuous",
          purpose_code: "https://pdpp.dev/purpose/personalization",
          purpose_description: "Pilot audit gate test",
          source: { id: manifest.connector_id, kind: "connector" },
          streams: [{ name: "top_artists", view: "basic" }],
          type: "https://pdpp.dev/data-access",
        },
      ],
      client_id: "concert_recommendation_app",
    }),
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(par.status, 201, await par.clone().text());
  const { request_uri } = (await par.json()) as { request_uri: string };
  const review = await fetch(`${asUrl}/consent/review`, {
    body: JSON.stringify({ request_uri, subject_id: "owner_local" }),
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(review.status, 200);
  const reviewBody = (await review.json()) as { approval_review_revision: string; request_uri: string };
  const approve = await fetch(`${asUrl}/consent/approve`, {
    body: JSON.stringify({
      approval_review_revision: reviewBody.approval_review_revision,
      request_uri: reviewBody.request_uri,
    }),
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(approve.status, 200);
  return (await approve.json()) as Approval;
}

async function withServer(
  opts: Record<string, unknown>,
  fn: (ctx: { asUrl: string; rsUrl: string; manifest: Manifest }) => Promise<void>
): Promise<void> {
  const manifest = JSON.parse(
    readFileSync(join(REFERENCE_IMPL_DIR, "fixtures/seed-manifests/spotify.json"), "utf8")
  ) as Manifest;
  const server = (await startServer({
    asPort: 0,
    dbPath: ":memory:",
    introspectionCallerCredentials: TEST_RS_INTROSPECTION_CREDENTIALS,
    quiet: true,
    rsIntrospectionCredentials: TEST_RS_INTROSPECTION_CREDENTIALS,
    rsPort: 0,
    ...opts,
  })) as TestServer;
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  try {
    const register = await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(manifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(register.status, 201);
    const connectorId = canonicalConnectorKey(manifest.connector_id);
    assert.ok(connectorId);
    await createSqliteConnectorInstanceStore().upsert({
      connectorId,
      connectorInstanceId: "cin_pilot_audit_gate_spotify",
      createdAt: NOW,
      displayName: "Pilot audit gate Spotify",
      ownerSubjectId: "owner_local",
      sourceBinding: { account_hint: "pilot-audit@example.com" },
      sourceBindingKey: "pilot-audit@example.com",
      sourceKind: "account",
      status: "active",
      updatedAt: NOW,
    });
    await fn({ asUrl, manifest, rsUrl });
  } finally {
    await closeServer(server);
  }
}

function assertGatePair(rows: SpineRow[], denialReason: string, tokenId: string | null): void {
  assert.deepEqual(
    rows.map((r) => r.event_type),
    ["query.received", "query.rejected"],
    "a rejected request writes exactly the received/rejected pair"
  );
  for (const row of rows) {
    const data = JSON.parse(row.data_json) as Record<string, unknown>;
    assert.equal(data.auth_gate, true);
    assert.equal(data.denial_reason, denialReason);
    assert.equal(row.token_id, tokenId);
    assert.ok(row.trace_id, "the pair carries a trace id even without an AS binding");
  }
  assert.equal(rows[0]?.trace_id, rows[1]?.trace_id);
}

test("unknown bearer is rejected and audited with a keyed token reference", async () => {
  await withServer({}, async ({ rsUrl }) => {
    const resp = await fetch(`${rsUrl}/v1/streams/top_artists/records/rec_1`, {
      headers: { Authorization: `Bearer ${UNKNOWN_BEARER}` },
    });
    assert.equal(resp.status, 401);
    const requestId = resp.headers.get("Request-Id");
    assert.ok(requestId);
    const rows = spineRowsForRequest(requestId);
    assertGatePair(rows, "token_unknown", auditTokenRef(UNKNOWN_BEARER));
    const rejected = JSON.parse(rows[1]?.data_json ?? "{}") as Record<string, unknown>;
    assert.equal(rejected.query_shape, "record_detail");
    assert.equal(rejected.requested_record_id, "rec_1");
  });
});

test("missing and non-Bearer authorization are audited", async () => {
  await withServer({}, async ({ rsUrl }) => {
    const missing = await fetch(`${rsUrl}/v1/streams`);
    assert.equal(missing.status, 401);
    assertGatePair(spineRowsForRequest(missing.headers.get("Request-Id") ?? ""), "bearer_missing", null);

    const basic = await fetch(`${rsUrl}/v1/streams`, { headers: { Authorization: "Basic Zm9vOmJhcg==" } });
    assert.equal(basic.status, 401);
    const rows = spineRowsForRequest(basic.headers.get("Request-Id") ?? "");
    assertGatePair(rows, "bearer_malformed", null);
  });
});

test("failed RS-to-AS introspection is audited instead of dropped", async () => {
  const failingFetch = (() => Promise.reject(new Error("connect ECONNREFUSED"))) as unknown as typeof fetch;
  await withServer({ introspectionFetch: failingFetch }, async ({ asUrl, manifest, rsUrl }) => {
    const approval = await approveGrant(asUrl, manifest);
    const resp = await fetch(`${rsUrl}/v1/streams`, { headers: { Authorization: `Bearer ${approval.token}` } });
    assert.equal(resp.status, 401);
    const rows = spineRowsForRequest(resp.headers.get("Request-Id") ?? "");
    assertGatePair(rows, "context.authentication_failed", auditTokenRef(approval.token));
  });
});

test("spine never stores the raw bearer, for reads or token issuance", async () => {
  await withServer({}, async ({ asUrl, manifest, rsUrl }) => {
    const approval = await approveGrant(asUrl, manifest);
    const read = await fetch(`${rsUrl}/v1/streams`, { headers: { Authorization: `Bearer ${approval.token}` } });
    assert.equal(read.status, 200);
    const readRows = spineRowsForRequest(read.headers.get("Request-Id") ?? "");
    assert.ok(readRows.length > 0, "the read was audited");
    for (const row of readRows) {
      assert.equal(row.token_id, auditTokenRef(approval.token));
    }
    const leaks = getDb()
      .prepare("SELECT count(*) AS n FROM spine_events WHERE token_id = ? OR object_id = ? OR data_json LIKE ?")
      .get(approval.token, approval.token, `%${approval.token}%`) as { n: number };
    assert.equal(leaks.n, 0, "raw bearer found in the audit spine");
    const tokenObjects = getDb()
      .prepare("SELECT object_id FROM spine_events WHERE object_type = 'token'")
      .all() as { object_id: string }[];
    assert.ok(tokenObjects.length > 0, "token.issued was audited");
    for (const row of tokenObjects) {
      assert.ok(row.object_id.startsWith(AUDIT_TOKEN_REF_PREFIX));
    }
  });
});

test("in-process introspection skips the HTTP hop and still sees revocation on the next request", async () => {
  const originalFetch = globalThis.fetch;
  let introspectCalls = 0;
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (String(input instanceof Request ? input.url : input).endsWith("/introspect")) {
      introspectCalls += 1;
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  try {
    await withServer({ rsInProcessIntrospection: true }, async ({ asUrl, manifest, rsUrl }) => {
      const approval = await approveGrant(asUrl, manifest);
      const headers = { Authorization: `Bearer ${approval.token}` };
      const before = await fetch(`${rsUrl}/v1/streams`, { headers });
      assert.equal(before.status, 200);

      const revoke = await fetch(`${asUrl}/grants/${approval.grant.grant_id}/revoke`, { headers, method: "POST" });
      assert.equal(revoke.status, 200);

      const after = await fetch(`${rsUrl}/v1/streams`, { headers });
      assert.equal(after.status, 403);
      assert.equal(((await after.json()) as { error: { code: string } }).error.code, "grant_revoked");
      assertGatePair(spineRowsForRequest(after.headers.get("Request-Id") ?? ""), "grant_revoked", auditTokenRef(approval.token));

      const unknown = await fetch(`${rsUrl}/v1/streams`, { headers: { Authorization: `Bearer ${UNKNOWN_BEARER}` } });
      assert.equal(unknown.status, 401);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(introspectCalls, 0, "RS must not call the AS /introspect over HTTP in in-process mode");
});

test("coalesced record-detail audit still writes received and outcome", async () => {
  await withServer({ coalesceReadAuditEvents: true, rsInProcessIntrospection: true }, async ({ asUrl, manifest, rsUrl }) => {
    const approval = await approveGrant(asUrl, manifest);
    const resp = await fetch(`${rsUrl}/v1/streams/top_artists/records/missing_record`, {
      headers: { Authorization: `Bearer ${approval.token}` },
    });
    assert.equal(resp.status, 404);
    const rows = spineRowsForRequest(resp.headers.get("Request-Id") ?? "");
    assert.deepEqual(
      rows.map((r) => r.event_type),
      ["query.received", "query.rejected"]
    );
  });
});

test("PDPP_PG_INTERACTIVE_POOL_MAX sets the interactive pool size; default unchanged", () => {
  assert.equal(resolvePostgresInteractivePoolMax({}), 8);
  assert.equal(resolvePostgresInteractivePoolMax({ PDPP_PG_INTERACTIVE_POOL_MAX: "" }), 8);
  assert.equal(resolvePostgresInteractivePoolMax({ PDPP_PG_INTERACTIVE_POOL_MAX: "32" }), 32);
  for (const bad of ["0", "-1", "8.5", "abc", "1001"]) {
    assert.throws(() => resolvePostgresInteractivePoolMax({ PDPP_PG_INTERACTIVE_POOL_MAX: bad }), /PDPP_PG_INTERACTIVE_POOL_MAX/);
  }
});

test("keep-alive is opt-in; default responses still force Connection: close", async () => {
  assert.equal(httpKeepAliveEnabled({}), false);
  assert.equal(httpKeepAliveEnabled({ PDPP_HTTP_KEEP_ALIVE: "1" }), true);

  await withServer({}, async ({ rsUrl }) => {
    const resp = await fetch(`${rsUrl}/v1/streams`);
    assert.equal(resp.headers.get("connection"), "close");
  });
  const previous = process.env.PDPP_HTTP_KEEP_ALIVE;
  process.env.PDPP_HTTP_KEEP_ALIVE = "1";
  try {
    await withServer({}, async ({ rsUrl }) => {
      const resp = await fetch(`${rsUrl}/v1/streams`);
      assert.notEqual(resp.headers.get("connection"), "close");
    });
  } finally {
    if (previous === undefined) {
      delete process.env.PDPP_HTTP_KEEP_ALIVE;
    } else {
      process.env.PDPP_HTTP_KEEP_ALIVE = previous;
    }
  }
});
