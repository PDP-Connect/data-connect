const TOP_LEVEL_REGEX_2 = /already been consumed/i;

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * B6 conformance — single-use grant consumption.
 *
 * Single-use grants are one of PDPP's load-bearing access-mode primitives
 * (concept 30/32): the grant is consumed atomically on the FIRST token
 * issuance, the issued token stays valid until expiry, but NO second token
 * may ever be minted, and single-use runs persist no STATE.
 *
 * Each test boots a real server, issues a real single_use grant over HTTP,
 * and asserts the documented request/response shapes against reality. The
 * second-issuance rejection is exercised through the real `issueToken`
 * protocol primitive (the same function every HTTP re-issuance path calls).
 *
 * This file previously also proved the single-use flow described above
 * matched pdpp's own docs-site content
 * (apps/site/content/docs/reference-implementation-examples.md, Example 6) --
 * see the removed test below for why that assertion was dropped (pdpp
 * frontend-owned content Move B did not bring along).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { issueToken } from "../server/auth.ts";
import { canonicalConnectorKey } from "../server/connector-key.ts";
import { startServer } from "../server/index.ts";
import { createRequestConnectorInstanceStore } from "../server/request-store-factories.ts";
import { makeDefaultAccountConnectorInstanceId } from "../server/stores/connector-instance-store.ts";
import { TEST_INTROSPECTION_SERVER_OPTS } from "./helpers/introspection-test-credentials.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, "..");
const MANIFESTS_DIR = join(REFERENCE_IMPL_DIR, "fixtures", "seed-manifests");
// ─── shared helpers (mirrors b3 harness) ────────────────────────────────────

type TestServer = Awaited<ReturnType<typeof startServer>> & {
  asServer: { close: (cb: (err?: Error) => void) => void; closeAllConnections: () => void };
  rsServer: { close: (cb: (err?: Error) => void) => void; closeAllConnections: () => void };
};

async function closeServer(server: TestServer) {
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  await Promise.allSettled([
    new Promise((r) => server.asServer.close(r)),
    new Promise((r) => server.rsServer.close(r)),
  ]);
}

async function fetchJson<T = unknown>(url: string, opts: RequestInit = {}): Promise<{ status: number; body: T }> {
  const resp = await fetch(url, opts);
  const text = await resp.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { body: body as T, status: resp.status };
}

interface DeviceAuthorization {
  device_code: string;
  user_code: string;
}

interface TokenResponse {
  access_token: string;
}

async function issueOwnerToken(asUrl: string, subjectId = "owner_local"): Promise<string> {
  const clientId = "cli_longview";
  const { body: device } = await fetchJson<DeviceAuthorization>(`${asUrl}/oauth/device_authorization`, {
    body: new URLSearchParams({ client_id: clientId }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  await fetch(`${asUrl}/device/approve`, {
    body: new URLSearchParams({
      subject_id: subjectId,
      user_code: device.user_code,
    }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const { body: tokenBody } = await fetchJson<TokenResponse>(`${asUrl}/oauth/token`, {
    body: new URLSearchParams({
      client_id: clientId,
      device_code: device.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  return tokenBody.access_token;
}

interface ClientGrantParams {
  access_mode: string;
  client_id: string;
  connector_id: string;
  purpose_code: string;
  purpose_description: string;
  streams: { name: string; fields: string[] }[];
}

interface ApprovedGrant {
  grant: { grant_id: string; access_mode: string; expires_at?: string };
  token: string;
}

function sourceIdForConnectorId(connectorId: string): string {
  return connectorId.includes("://") ? connectorId : `https://registry.pdpp.dev/connectors/${connectorId}`;
}

async function seedDefaultGrantInstance(connectorId: string, ownerSubjectId: string): Promise<void> {
  const store = createRequestConnectorInstanceStore();
  const connectorKey = canonicalConnectorKey(connectorId) ?? connectorId;
  const connectorInstanceId = makeDefaultAccountConnectorInstanceId(ownerSubjectId, connectorKey);
  if (await store.get(connectorInstanceId)) {
    return;
  }
  const now = new Date().toISOString();
  await store.upsert({
    connectorId: connectorKey,
    connectorInstanceId,
    createdAt: now,
    displayName: "Spotify",
    ownerSubjectId,
    sourceBinding: { fixture: "b6-conformance-default-account" },
    sourceBindingKey: connectorInstanceId,
    sourceKind: "account",
    status: "active",
    updatedAt: now,
  });
}

async function issueClientGrant(asUrl: string, subjectId: string, params: ClientGrantParams): Promise<ApprovedGrant> {
  await seedDefaultGrantInstance(params.connector_id, subjectId);
  const { body: par } = await fetchJson<{ request_uri: string }>(`${asUrl}/oauth/par`, {
    body: JSON.stringify({
      authorization_details: [
        {
          access_mode: params.access_mode,
          purpose_code: params.purpose_code,
          purpose_description: params.purpose_description,
          source: { id: sourceIdForConnectorId(params.connector_id), kind: "connector" },
          streams: params.streams,
          type: "https://pdpp.dev/data-access",
        },
      ],
      client_id: params.client_id,
    }),
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    method: "POST",
  });
  const { body: review, status: reviewStatus } = await fetchJson<{ approval_review_revision?: unknown }>(
    `${asUrl}/consent/review`,
    {
      body: JSON.stringify({ request_uri: par.request_uri, subject_id: subjectId }),
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      method: "POST",
    }
  );
  assert.equal(reviewStatus, 200, JSON.stringify(review));
  assert.equal(typeof review.approval_review_revision, "string", "consent review returns a revision");
  const { body: approved } = await fetchJson<ApprovedGrant>(`${asUrl}/consent/approve`, {
    body: JSON.stringify({
      approval_review_revision: review.approval_review_revision,
      request_uri: par.request_uri,
    }),
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    method: "POST",
  });
  return approved;
}

interface SeedRecord {
  emitted_at?: string;
  id: string;
  [key: string]: unknown;
}

async function seedStream(
  rsUrl: string,
  ownerToken: string,
  connectorId: string,
  stream: string,
  records: SeedRecord[]
) {
  const ndjson = records
    .map((r) =>
      JSON.stringify({
        data: r,
        emitted_at: r.emitted_at || "2026-01-01T00:00:00Z",
        key: r.id,
      })
    )
    .join("\n");
  const resp = await fetch(
    `${rsUrl}/v1/ingest/${encodeURIComponent(stream)}?connector_id=${encodeURIComponent(connectorId)}`,
    {
      body: ndjson,
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        "Content-Type": "application/x-ndjson",
      },
      method: "POST",
    }
  );
  assert.equal(resp.status, 200, `seed ${stream} ok`);
}

interface ConnectorManifest {
  connector_id: string;
  [key: string]: unknown;
}

function readSpotifyManifest(): ConnectorManifest {
  return JSON.parse(readFileSync(join(MANIFESTS_DIR, "spotify.json"), "utf8")) as ConnectorManifest;
}

async function withHarness(fn: (ctx: { asUrl: string; rsUrl: string; connectorId: string }) => Promise<void>) {
  const server = (await startServer({
    asPort: 0,
    dbPath: ":memory:",
    quiet: true,
    rsPort: 0,
    ...TEST_INTROSPECTION_SERVER_OPTS,
  })) as TestServer;
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;

  const manifest = readSpotifyManifest();
  const regResp = await fetch(`${asUrl}/connectors`, {
    body: JSON.stringify(manifest),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(regResp.status, 201, "register spotify connector");

  try {
    await fn({ asUrl, connectorId: manifest.connector_id, rsUrl });
  } finally {
    await closeServer(server);
  }
}

// ─── B6.1 — single_use grant is consumed on first issuance ──────────────────

test("single_use: grant returns access_mode single_use and a bounded expiry (B6)", async () => {
  await withHarness(async ({ asUrl, rsUrl, connectorId }) => {
    const ownerToken = await issueOwnerToken(asUrl, "b6_su_owner");
    await seedStream(rsUrl, ownerToken, connectorId, "top_artists", [
      { id: "a1", name: "Artist One", popularity: 80, source_updated_at: "2026-01-01T00:00:00Z" },
    ]);

    const approved = await issueClientGrant(asUrl, "b6_su_owner", {
      access_mode: "single_use",
      client_id: "longview",
      connector_id: connectorId,
      purpose_code: "https://pdpp.dev/purpose/assist_summarize",
      purpose_description: "B6 single-use proof",
      streams: [{ fields: ["id", "name", "popularity"], name: "top_artists" }],
    });

    // Documented in Example 6 Step 2: the issued grant carries access_mode and
    // a bounded expiry (single_use grants always expire; continuous may not).
    assert.equal(approved.grant.access_mode, "single_use", "grant.access_mode is single_use");
    assert.ok(approved.token, "a first token was issued");
    assert.ok(approved.grant.expires_at, "single_use grant carries a bounded expires_at");
  });
});

// ─── B6.2 — the issued token still serves queries (consumption ≠ revocation) ─

test("single_use: the issued token stays valid for RS queries after consumption (B6)", async () => {
  await withHarness(async ({ asUrl, rsUrl, connectorId }) => {
    const ownerToken = await issueOwnerToken(asUrl, "b6_query_owner");
    await seedStream(rsUrl, ownerToken, connectorId, "top_artists", [
      { id: "a1", name: "Artist One", popularity: 80, source_updated_at: "2026-01-01T00:00:00Z" },
      { id: "a2", name: "Artist Two", popularity: 70, source_updated_at: "2026-01-02T00:00:00Z" },
    ]);

    const approved = await issueClientGrant(asUrl, "b6_query_owner", {
      access_mode: "single_use",
      client_id: "longview",
      connector_id: connectorId,
      purpose_code: "https://pdpp.dev/purpose/assist_summarize",
      purpose_description: "B6 single-use query proof",
      streams: [{ fields: ["id", "name", "popularity"], name: "top_artists" }],
    });

    // Documented in Example 6 Step 3: consumption applies to NEW token
    // issuance, not to the already-issued token. The token remains usable
    // until its own expiry — single_use bounds how many tokens, not how many
    // queries one token may perform.
    const { status } = await fetchJson(`${rsUrl}/v1/streams/top_artists/records?limit=10`, {
      headers: { Authorization: `Bearer ${approved.token}` },
    });
    assert.equal(status, 200, "the issued single_use token still serves queries");
  });
});

// ─── B6.3 — a second token issuance on a consumed grant is rejected ─────────

test("single_use: second token issuance is rejected with grant_consumed (B6)", async () => {
  await withHarness(async ({ asUrl, rsUrl, connectorId }) => {
    const ownerToken = await issueOwnerToken(asUrl, "b6_reissue_owner");
    await seedStream(rsUrl, ownerToken, connectorId, "top_artists", [
      { id: "a1", name: "Artist One", popularity: 80, source_updated_at: "2026-01-01T00:00:00Z" },
    ]);

    const approved = await issueClientGrant(asUrl, "b6_reissue_owner", {
      access_mode: "single_use",
      client_id: "longview",
      connector_id: connectorId,
      purpose_code: "https://pdpp.dev/purpose/assist_summarize",
      purpose_description: "B6 single-use re-issuance proof",
      streams: [{ fields: ["id", "name", "popularity"], name: "top_artists" }],
    });

    // Documented in Example 6 Step 4: the grant was consumed atomically on the
    // first issuance. Every subsequent issuance attempt against the same grant
    // — whichever HTTP re-issuance path reaches it (refresh_token grant, device
    // re-exchange) — bottoms out in the same `issueToken` primitive and is
    // rejected with code `grant_consumed`, which the error map surfaces as
    // HTTP 403. This is the consumption enforcement, not a generic error.
    await assert.rejects(
      () =>
        issueToken(approved.grant.grant_id, "b6_reissue_owner", "longview", approved.grant.expires_at ?? null, {
          source: "b6_second_issuance",
        }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal((err as Error & { code?: string }).code, "grant_consumed", "error code is grant_consumed");
        assert.match(err.message, TOP_LEVEL_REGEX_2, "message names consumption");
        return true;
      },
      "second issuance on a consumed single_use grant must throw grant_consumed"
    );
  });
});

// ─── B6.5 — the examples doc documents the load-bearing single-use facts ────

// This file previously also asserted ("single_use: examples doc documents
// the consumption contract (B6)") that pdpp's own `apps/site` docs-site
// content (apps/site/content/docs/reference-implementation-examples.md,
// Examples 6 + 7) kept stating the consumption facts this file's other
// tests prove against the real runtime. That doc lives inside pdpp's
// frontend docs-site content tree, which Move B did not bring along (this
// repo has no `apps/site` at all -- only `apps/console`), unlike
// spec-collection-profile.md (a protocol-level spec at pdpp's repo root,
// unaffiliated with any one app, which this repo's collection-profile.test.ts
// legitimately needed and got copied in alongside this change). Removed;
// that doc-drift coverage belongs in pdpp's own suite, which still owns the
// doc, not here. The runtime-behavior tests above (B6.1-B6.3, which boot a
// real server and exercise the real single-use consumption protocol) are
// unaffected and stay.

// ─── B6.4 — control: a continuous grant is NOT consumed ─────────────────────

test("single_use control: a continuous grant re-issues freely (not consumed) (B6)", async () => {
  await withHarness(async ({ asUrl, rsUrl, connectorId }) => {
    const ownerToken = await issueOwnerToken(asUrl, "b6_cont_owner");
    await seedStream(rsUrl, ownerToken, connectorId, "top_artists", [
      { id: "a1", name: "Artist One", popularity: 80, source_updated_at: "2026-01-01T00:00:00Z" },
    ]);

    const approved = await issueClientGrant(asUrl, "b6_cont_owner", {
      access_mode: "continuous",
      client_id: "longview",
      connector_id: connectorId,
      purpose_code: "https://pdpp.dev/purpose/assist_summarize",
      purpose_description: "B6 continuous control",
      streams: [{ fields: ["id", "name", "popularity"], name: "top_artists" }],
    });
    assert.equal(approved.grant.access_mode, "continuous");

    // The contrast that makes single_use meaningful: a continuous grant mints
    // additional tokens on demand until it is explicitly revoked or expires.
    const secondToken = await issueToken(approved.grant.grant_id, "b6_cont_owner", "longview", null, {
      source: "b6_second_issuance",
    });
    assert.ok(secondToken, "second issuance on a continuous grant succeeds");
  });
});
