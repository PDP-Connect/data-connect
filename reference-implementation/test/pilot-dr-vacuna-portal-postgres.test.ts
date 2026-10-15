// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * DR "Vacuna al día" pilot, browser path and held-data lifecycle
 * (server/pilot-dr-vacuna/routes.ts, grant-lifecycle.ts).
 *
 *   - a confidential client starts at /oauth/authorize; the parent signs in,
 *     picks a child, reviews and approves through form posts that answer
 *     303 → GET pages (ES default, ?lang=en toggle remembered in a cookie);
 *     the client gets its code and exchanges it with private_key_jwt;
 *   - the lifecycle endpoint needs client authentication, answers only for
 *     the client's own grants, and carries the parent's "delete" choice as an
 *     erasure instruction (stop use within 48 h);
 *   - a registry refusal reached by form shows the refusal page and returns
 *     the client an ordinary access_denied.
 *
 * Gated on PDPP_TEST_POSTGRES_URL (a provisioned scratch database).
 */

import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, type KeyObject, randomUUID, sign } from "node:crypto";
import test from "node:test";

import { closeDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";
import { closePostgresStorage, postgresQuery } from "../server/postgres-storage.ts";

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;
const PASSWORD = "vacuna-demo-2026";
const CONNECTOR = "dr-vacuna-registry";
const SOURCE_ID = `https://registry.pdpp.dev/connectors/${CONNECTOR}`;
const STREAM = "child_immunizations";
const REDIRECT_URI = "https://reminders.example/callback";
const MOTHER = "00100000117";
const FATHER = "00100000125";
const SUSPENDED = "00100000133";
const CHILD_A = "DR-9200001";
const CHILD_B = "DR-9200002";

const MANIFEST = {
  capabilities: { human_interaction: [], public_listing: { tier: "development" } },
  connector_id: CONNECTOR,
  connector_key: CONNECTOR,
  display_name: "Registro Nacional de Vacunación (test)",
  manifest_uri: SOURCE_ID,
  protocol_version: "0.1.0",
  runtime_requirements: { bindings: { network: { required: false } } },
  streams: [
    {
      consent_time_field: "updated_at",
      coverage_strategy: "full_inventory",
      cursor_field: "updated_at",
      freshness_strategy: "manual_as_of",
      incremental: true,
      name: STREAM,
      primary_key: ["child_id"],
      schema: {
        properties: {
          birth_date: { format: "date", type: "string" },
          child_id: { type: "string" },
          doses: { items: { type: "object" }, type: "array" },
          updated_at: { format: "date-time", type: "string" },
        },
        required: ["child_id", "birth_date", "doses"],
        type: "object",
      },
      selection: { fields: true, resources: true },
      semantics: "mutable_state",
    },
  ],
  version: "1.0.0",
};

interface CloseableServer {
  close: (callback?: (err?: Error) => void) => unknown;
  closeAllConnections: () => void;
}
type StartedServer = Awaited<ReturnType<typeof startServer>> & { asServer: CloseableServer; rsServer: CloseableServer };

interface Resp {
  // biome-ignore lint/suspicious/noExplicitAny: loosely typed JSON in a test harness
  body: Record<string, any>;
  headers: Headers;
  status: number;
  text: string;
}

async function call(url: string, init: RequestInit = {}): Promise<Resp> {
  const resp = await fetch(url, { redirect: "manual", ...init });
  const text = await resp.text();
  // biome-ignore lint/suspicious/noExplicitAny: loosely typed JSON in a test harness
  let body: Record<string, any> = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = {};
  }
  return { body, headers: resp.headers, status: resp.status, text };
}

const jsonPost = (payload: unknown): RequestInit => ({
  body: JSON.stringify(payload),
  headers: { Accept: "application/json", "Content-Type": "application/json" },
  method: "POST",
});

/** A browser form post (no JSON Accept): the pilot answers with redirects and HTML. */
const formPost = (fields: Record<string, string>, cookie?: string): RequestInit => ({
  body: new URLSearchParams(fields).toString(),
  headers: {
    Accept: "text/html",
    "Content-Type": "application/x-www-form-urlencoded",
    ...(cookie ? { Cookie: cookie } : {}),
  },
  method: "POST",
});

function csrfFrom(html: string): string {
  const match = /name="csrf_token" value="([^"]+)"/.exec(html);
  assert.ok(match, "page carries a CSRF token");
  return match[1] as string;
}

interface ConfidentialClient {
  assertion: () => Record<string, string>;
  clientId: string;
}

async function registerConfidential(as: string, name: string): Promise<ConfidentialClient> {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = { ...(publicKey.export({ format: "jwk" }) as Record<string, unknown>), alg: "ES256", kid: "k1", use: "sig" };
  const reg = await call(
    `${as}/oauth/register`,
    jsonPost({
      client_name: name,
      grant_types: ["authorization_code", "refresh_token"],
      jwks: { keys: [jwk] },
      redirect_uris: [REDIRECT_URI],
      response_types: ["code"],
      token_endpoint_auth_method: "private_key_jwt",
    })
  );
  assert.equal(reg.status, 201, reg.text);
  const clientId = String(reg.body.client_id);
  return { assertion: () => assertionFields(clientId, privateKey, as), clientId };
}

function assertionFields(clientId: string, key: KeyObject, audience: string): Record<string, string> {
  const header = Buffer.from(JSON.stringify({ alg: "ES256", kid: "k1", typ: "JWT" })).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(
    JSON.stringify({ aud: audience, exp: now + 60, iat: now, iss: clientId, jti: randomUUID(), sub: clientId })
  ).toString("base64url");
  const sig = sign("sha256", Buffer.from(`${header}.${payload}`), { dsaEncoding: "ieee-p1363", key });
  return {
    client_assertion: `${header}.${payload}.${sig.toString("base64url")}`,
    client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    client_id: clientId,
  };
}

function authorizeUrl(as: string, clientId: string, childId: string | null, verifier: string, state: string): string {
  const url = new URL(`${as}/oauth/authorize`);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("code_challenge", createHash("sha256").update(verifier).digest("base64url"));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set(
    "authorization_details",
    JSON.stringify([
      {
        access_mode: "continuous",
        purpose_code: "https://pdpp.dev/purpose/assist_summarize",
        purpose_description: "Recordatorios de vacunación",
        source: { id: SOURCE_ID, kind: "connector" },
        streams: [{ name: STREAM, ...(childId ? { resources: [childId] } : {}) }],
        type: "https://pdpp.dev/data-access",
      },
    ])
  );
  return url.toString();
}

/** Browser: authorize → consent link → pilot consent → sign-in → back to the picker. Returns cookie + picker HTML. */
async function startAsBrowser(as: string, url: string, cedula: string) {
  const authorize = await call(url);
  assert.equal(authorize.status, 302, authorize.text);
  const consentLink = new URL(String(authorize.headers.get("location")));
  const consent = await call(`${as}${consentLink.pathname}${consentLink.search}`);
  assert.equal(consent.status, 302);
  const pilotConsent = String(consent.headers.get("location"));
  const unauth = await call(`${as}${pilotConsent}`, { headers: { Accept: "text/html" } });
  assert.equal(unauth.status, 302);
  const loginUrl = new URL(String(unauth.headers.get("location")), as);
  assert.equal(loginUrl.pathname, "/pilot/cuenta-unica/login");
  const loginPage = await call(loginUrl.toString(), { headers: { Accept: "text/html" } });
  assert.match(loginPage.text, /Cuenta Única Ciudadana/);
  assert.match(loginPage.text, /Continuará a <b>/, "sign-in names the requesting app");
  const login = await call(
    `${as}/pilot/cuenta-unica/login`,
    formPost({ cedula, password: PASSWORD, return_to: String(loginUrl.searchParams.get("return_to")) })
  );
  assert.equal(login.status, 303);
  const cookie = String(login.headers.get("set-cookie")).split(";")[0] as string;
  const picker = await call(`${as}${login.headers.get("location")}`, { headers: { Accept: "text/html", Cookie: cookie } });
  assert.equal(picker.status, 200);
  return { cookie, picker: picker.text, requestUri: String(consentLink.searchParams.get("request_uri")) };
}

if (POSTGRES_URL) {
  test.describe("DR pilot browser path and held-data lifecycle", () => {
    let as = "";
    let rs = "";
    let server: StartedServer | undefined;
    const saved: Record<string, string | undefined> = {};

    test.before(async () => {
      for (const key of ["PDPP_PILOT_DR_VACUNA", "PDPP_CONFIDENTIAL_CLIENTS", "PDPP_PILOT_DR_VACUNA_START_URL"]) {
        saved[key] = process.env[key];
      }
      process.env.PDPP_PILOT_DR_VACUNA = "1";
      process.env.PDPP_CONFIDENTIAL_CLIENTS = "1";
      process.env.PDPP_PILOT_DR_VACUNA_START_URL = "/recordatorio";
      server = (await startServer({
        asPort: 0,
        bindHost: "127.0.0.1",
        databaseUrl: POSTGRES_URL,
        dbPath: ":memory:",
        ownerAuthPassword: "",
        quiet: true,
        reconcilePolyfillManifests: false,
        rsPort: 0,
        storageBackend: "postgres" as const,
      } as Parameters<typeof startServer>[0])) as StartedServer;
      as = `http://127.0.0.1:${server.asPort}`;
      rs = `http://127.0.0.1:${server.rsPort}`;

      assert.ok([200, 201, 409].includes((await call(`${as}/connectors`, jsonPost(MANIFEST))).status));
      const form = (f: Record<string, string>): RequestInit => ({
        body: new URLSearchParams(f).toString(),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        method: "POST",
      });
      const device = await call(`${as}/oauth/device_authorization`, form({ client_id: "cli_longview" }));
      await fetch(`${as}/device/approve`, form({ subject_id: "owner_local", user_code: String(device.body.user_code) }));
      const owner = await call(
        `${as}/oauth/token`,
        form({
          client_id: "cli_longview",
          device_code: String(device.body.device_code),
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        })
      );
      const lines = [CHILD_A, CHILD_B].map((id, i) => {
        const data = { birth_date: i ? "2021-02-03" : "2023-05-17", child_id: id, doses: [], updated_at: "2026-09-01T00:00:00Z" };
        return JSON.stringify({ data, emitted_at: data.updated_at, key: id });
      });
      const ingest = await call(`${rs}/v1/ingest/${STREAM}?connector_id=${CONNECTOR}`, {
        body: lines.join("\n"),
        headers: { Authorization: `Bearer ${owner.body.access_token}`, "Content-Type": "application/x-ndjson" },
        method: "POST",
      });
      assert.equal(ingest.status, 200, ingest.text);
      await call(`${as}/pilot/cuenta-unica/login`, jsonPost({ cedula: "0", password: "x" }));
      await postgresQuery(
        `INSERT INTO pilot_rc_parents (cedula, given_name, family_name) VALUES
           ($1, 'Lucía', 'Báez'), ($2, 'Andrés', 'Báez'), ($3, 'Nelson', 'Ortiz') ON CONFLICT DO NOTHING`,
        [MOTHER, FATHER, SUSPENDED]
      );
      await postgresQuery(
        `INSERT INTO pilot_rc_children (child_id, given_name, family_name, birth_date) VALUES
           ($1, 'Elena', 'Báez', '2023-05-17'), ($2, 'Marcos', 'Ortiz', '2021-02-03') ON CONFLICT DO NOTHING`,
        [CHILD_A, CHILD_B]
      );
      await postgresQuery(
        `INSERT INTO pilot_rc_guardianships (parent_cedula, child_id, capacity, status) VALUES
           ($1, $4, 'parent', 'active'), ($2, $4, 'parent', 'active'), ($3, $5, 'parent', 'suspended')
         ON CONFLICT DO NOTHING`,
        [MOTHER, FATHER, SUSPENDED, CHILD_A, CHILD_B]
      );
    });

    test.after(async () => {
      if (server) {
        server.asServer.closeAllConnections();
        server.rsServer.closeAllConnections();
        await Promise.allSettled([
          new Promise((resolve) => server?.asServer.close(resolve)),
          new Promise((resolve) => server?.rsServer.close(resolve)),
        ]);
      }
      await closePostgresStorage();
      closeDb();
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    });

    test("landing page explains the demo in Spanish by default and links to the start", async () => {
      const es = await call(`${as}/pilot/vacuna`);
      assert.equal(es.status, 200);
      assert.match(es.text, /<html lang="es">/);
      assert.match(es.text, /data-start href="\/recordatorio"/);
      const en = await call(`${as}/pilot/vacuna?lang=en`);
      assert.match(en.text, /<html lang="en">/);
      assert.match(String(en.headers.get("set-cookie")), /pdpp_demo_lang=en/);
      const remembered = await call(`${as}/pilot/vacuna`, { headers: { Cookie: "pdpp_demo_lang=en" } });
      assert.match(remembered.text, /Start the demo/);
    });

    test("form path: pick, review (ES/EN), approve, code for a private_key_jwt client; delete reaches the lifecycle answer", async () => {
      const client = await registerConfidential(as, "Vacuna al día (test)");
      const verifier = "w".repeat(50);
      const { cookie, picker, requestUri } = await startAsBrowser(
        as,
        authorizeUrl(as, client.clientId, null, verifier, "st-browser"),
        MOTHER
      );
      assert.match(picker, /data-child-id="DR-9200001"/);
      assert.doesNotMatch(picker, /DR-9200002/, "only the person's own registry children");

      const select = await call(
        `${as}/pilot/vacuna/consent/select`,
        formPost({ child_id: CHILD_A, csrf_token: csrfFrom(picker), request_uri: requestUri }, cookie)
      );
      assert.equal(select.status, 303);
      const reviewPath = String(select.headers.get("location"));
      assert.match(reviewPath, /^\/pilot\/vacuna\/consent\/review\?request_uri=/);
      const review = await call(`${as}${reviewPath}`, { headers: { Accept: "text/html", Cookie: cookie } });
      assert.match(review.text, /Usted está actuando como <b>madre o padre<\/b> de <b>Elena Báez<\/b>/);
      assert.match(review.text, /data-expires-at="2041-05-17/);
      assert.doesNotMatch(review.text, /You are acting as/, "one language per page");
      const reviewEn = await call(`${as}${reviewPath}&lang=en`, { headers: { Accept: "text/html", Cookie: cookie } });
      assert.match(reviewEn.text, /You are acting as <b>parent<\/b> of <b>Elena Báez<\/b>/);

      const revision = /name="pilot_revision" value="([^"]+)"/.exec(review.text)?.[1] as string;
      const approve = await call(
        `${as}/pilot/vacuna/consent/approve`,
        formPost({ csrf_token: csrfFrom(review.text), pilot_revision: revision, request_uri: requestUri }, cookie)
      );
      assert.equal(approve.status, 303);
      const back = new URL(String(approve.headers.get("location")));
      assert.equal(`${back.origin}${back.pathname}`, REDIRECT_URI);
      assert.equal(back.searchParams.get("state"), "st-browser");

      const token = await call(`${as}/oauth/token`, {
        body: new URLSearchParams({
          ...client.assertion(),
          code: String(back.searchParams.get("code")),
          code_verifier: verifier,
          grant_type: "authorization_code",
          redirect_uri: REDIRECT_URI,
        }).toString(),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        method: "POST",
      });
      assert.equal(token.status, 200, token.text);
      const grantId = String(token.body.grant_id);

      const lifecycle = (fields: Record<string, string>) =>
        call(`${as}/pilot/vacuna/grant-lifecycle`, {
          body: new URLSearchParams(fields).toString(),
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          method: "POST",
        });
      const unauthenticated = await lifecycle({ client_id: client.clientId, grant_id: grantId });
      assert.equal(unauthenticated.status, 401);
      const active = await lifecycle({ ...client.assertion(), grant_id: grantId });
      assert.equal(active.status, 200, active.text);
      assert.equal(active.body.grants[0].read_state, "active");
      assert.equal(active.body.grants[0].held_data, "permitted");
      const stranger = await registerConfidential(as, "Otra app");
      const foreign = await lifecycle({ ...stranger.assertion(), grant_id: grantId });
      assert.deepEqual(foreign.body.grants[0], { error: "invalid_grant", grant_id: grantId });

      // The other parent withdraws it from Mis autorizaciones, choosing "delete".
      const father = await call(
        `${as}/pilot/cuenta-unica/login`,
        formPost({ cedula: FATHER, password: PASSWORD, return_to: "/pilot/vacuna/autorizaciones" })
      );
      const fatherCookie = String(father.headers.get("set-cookie")).split(";")[0] as string;
      const page = await call(`${as}/pilot/vacuna/autorizaciones`, { headers: { Accept: "text/html", Cookie: fatherCookie } });
      assert.match(page.text, new RegExp(`data-grant-id="${grantId}"[^>]*data-grant-status="active"`));
      assert.match(page.text, /data-approved-by="other"/);
      const revoke = await call(
        `${as}/pilot/vacuna/autorizaciones/${grantId}/revoke`,
        formPost({ csrf_token: csrfFrom(page.text), disposition: "delete" }, fatherCookie)
      );
      assert.equal(revoke.status, 303);
      assert.equal(revoke.headers.get("location"), "/pilot/vacuna/autorizaciones?revoked=delete");
      const after = await call(`${as}/pilot/vacuna/autorizaciones?revoked=delete`, {
        headers: { Accept: "text/html", Cookie: fatherCookie },
      });
      assert.match(after.text, /data-revoke-banner="delete"/);

      const ended = await lifecycle({ ...client.assertion(), grant_id: grantId });
      const entry = ended.body.grants[0];
      assert.equal(entry.read_state, "revoked");
      assert.equal(entry.held_data, "erase");
      assert.equal(entry.erasure.instruction_id, `ers_${grantId}`);
      assert.equal(Date.parse(entry.erasure.stop_use_by) - Date.parse(entry.ended_at), 48 * 3600 * 1000);
      const reported = await lifecycle({
        ...client.assertion(),
        grant_id: grantId,
        instruction_id: entry.erasure.instruction_id,
        report: "received",
        reported_at: new Date().toISOString(),
      });
      assert.equal(reported.status, 200, reported.text);
      const events = await postgresQuery(
        "SELECT actor_type FROM spine_events WHERE event_type = 'representative.erasure_received' AND object_id = $1",
        [grantId]
      );
      assert.equal(events.rows[0]?.actor_type, "client");
    });

    test("form path: a registry refusal shows the refusal page and the client gets access_denied", async () => {
      const client = await registerConfidential(as, "Vacuna al día (refusal)");
      const { cookie, picker, requestUri } = await startAsBrowser(
        as,
        authorizeUrl(as, client.clientId, CHILD_B, "x".repeat(50), "st-refused"),
        SUSPENDED
      );
      assert.match(picker, /data-named-record/);
      assert.doesNotMatch(picker, /Marcos/, "nothing about the child before authority is verified");
      const select = await call(
        `${as}/pilot/vacuna/consent/select`,
        formPost({ csrf_token: csrfFrom(picker), request_uri: requestUri }, cookie)
      );
      assert.equal(select.status, 303);
      assert.equal(select.headers.get("location"), "/pilot/vacuna/resultado");
      const result = await call(`${as}/pilot/vacuna/resultado`, { headers: { Accept: "text/html", Cookie: cookie } });
      assert.match(result.text, /data-result="refused"/);
      assert.doesNotMatch(result.text, /Marcos/);
      const back = /data-return-to-app href="([^"]+)"/.exec(result.text)?.[1]?.replace(/&amp;/g, "&") ?? "";
      const url = new URL(back);
      assert.equal(url.searchParams.get("error"), "access_denied");
      assert.equal(url.searchParams.get("state"), "st-refused");
    });
  });
} else {
  test("DR pilot browser path (skipped: PDPP_TEST_POSTGRES_URL unset)", { skip: true }, () => undefined);
}
