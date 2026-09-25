// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// DR demo: a client declares its request on GET /oauth/authorize (two
// sources, an end date, ui_locales) and the citizen sees ONE consent screen.
//
//   GET /oauth/authorize?authorization_details=[siuben, intrant]&ui_locales=en
//     └▶ GET /consent?request_uri=…&lang=en      one screen, already reviewed
//          └▶ POST /consent/approve              redirect_uri?code
//               └▶ POST /oauth/token             one token (grant_package_id)
//                    └▶ GET /v1/streams/<stream>/records   both sources

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { mock } from "node:test";
import { fileURLToPath } from "node:url";
import { getGrantPackageAccess } from "../server/auth.ts";
import { startServer } from "../server/index.ts";
import { ingestRecord } from "../server/records.ts";
import { createSqliteConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";
import { TEST_INTROSPECTION_SERVER_OPTS } from "./helpers/introspection-test-credentials.ts";

const REFERENCE_IMPL_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const REDIRECT_URI = "https://portal.example/callback";
const DATA_ACCESS = "https://pdpp.dev/data-access";
const PURPOSE_CODE = "https://map.gob.do/purpose/servicios-proactivos-nacimiento";
const PURPOSE_ES = "Preparar la vacunación de su bebé y el bono por hijo al nacer.";
const SIUBEN = { id: "https://demo.pdpp.dev/rd/connectors/siuben", kind: "connector" };
const INTRANT = { id: "https://demo.pdpp.dev/rd/connectors/intrant", kind: "connector" };
const DAY_MS = 24 * 60 * 60 * 1000;
const FORBIDDEN = 403;
const UNAUTHORIZED = 401;
const FOUND = 302;
const OK = 200;
const BAD_REQUEST = 400;

type TestServer = Awaited<ReturnType<typeof startServer>> & {
  asServer: { close: (cb: () => void) => void; closeAllConnections: () => void };
  rsServer: { close: (cb: () => void) => void; closeAllConnections: () => void };
};

interface Harness {
  asUrl: string;
  clientId: string;
  rsUrl: string;
}

async function withHarness(fn: (h: Harness) => Promise<void>): Promise<void> {
  const server = (await startServer({
    asPort: 0,
    dbPath: ":memory:",
    ownerAuthPassword: "",
    quiet: true,
    rsPort: 0,
    ...TEST_INTROSPECTION_SERVER_OPTS,
  })) as TestServer;
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  try {
    const household = { icv_grupo: "ICV-2", id: "hogar-1", provincia: "Santo Domingo" };
    await seedSource(asUrl, "siuben", "clasificacion_hogar", household);
    await seedSource(asUrl, "intrant", "licencias_conducir", { categoria: "02", id: "lic-1", nombre: "María" });
    const clientId = await registerClient(asUrl);
    await fn({ asUrl, clientId, rsUrl });
  } finally {
    server.asServer.closeAllConnections();
    server.rsServer.closeAllConnections();
    await Promise.allSettled([
      new Promise<void>((resolve) => server.asServer.close(() => resolve())),
      new Promise<void>((resolve) => server.rsServer.close(() => resolve())),
    ]);
  }
}

// Register the fixture manifest, an active owner connection, and one record.
async function seedSource(asUrl: string, key: string, stream: string, data: Record<string, unknown>): Promise<void> {
  const manifest = readFileSync(join(REFERENCE_IMPL_DIR, `fixtures/seed-manifests/${key}.json`), "utf8");
  const resp = await fetch(`${asUrl}/connectors`, {
    body: manifest,
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  assert.ok(resp.status < BAD_REQUEST, `register ${key}: ${resp.status}`);

  const now = new Date().toISOString();
  const connectorInstanceId = `cin_${key}`;
  await createSqliteConnectorInstanceStore().upsert({
    connectorId: key,
    connectorInstanceId,
    createdAt: now,
    displayName: key,
    ownerSubjectId: "owner_local",
    sourceBinding: { fixture: key },
    sourceBindingKey: connectorInstanceId,
    sourceKind: "account",
    status: "active",
    updatedAt: now,
  });
  await ingestRecord(
    { connector_id: key, connector_instance_id: connectorInstanceId },
    { data, emitted_at: now, key: String(data.id), stream }
  );
}

async function registerClient(asUrl: string): Promise<string> {
  const resp = await fetch(`${asUrl}/oauth/register`, {
    body: JSON.stringify({
      client_name: "Servicios Proactivos · MAP (demo)",
      grant_types: ["authorization_code"],
      redirect_uris: [REDIRECT_URI],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  const body = (await resp.json()) as { client_id: string };
  return body.client_id;
}

function detail(source: typeof SIUBEN, stream: string, fields: string[], extra: Record<string, unknown> = {}) {
  return {
    access_mode: "continuous",
    purpose_code: PURPOSE_CODE,
    purpose_description: PURPOSE_ES,
    source,
    streams: [{ fields, name: stream }],
    type: DATA_ACCESS,
    ...extra,
  };
}

function twoSourceDetails(extra: Record<string, unknown> = {}) {
  return [
    detail(SIUBEN, "clasificacion_hogar", ["id", "icv_grupo"], extra),
    detail(INTRANT, "licencias_conducir", ["id", "categoria"], extra),
  ];
}

/** RFC 3339 end date `days` from now, as a client would send it (DR offset). */
function endDateInDays(days: number): string {
  const date = new Date(Date.now() + days * DAY_MS);
  return `${date.toISOString().slice(0, 10)}T23:59:59-04:00`;
}

// Rejections only: the request never reaches a consent page.
async function authorize(h: Harness, details: unknown[]): Promise<Response> {
  const url = new URL(`${h.asUrl}/oauth/authorize`);
  url.search = new URLSearchParams({
    authorization_details: JSON.stringify(details),
    client_id: h.clientId,
    code_challenge: createHash("sha256").update("verifier").digest("base64url"),
    code_challenge_method: "S256",
    redirect_uri: REDIRECT_URI,
    response_type: "code",
  }).toString();
  return await fetch(url, { redirect: "manual" });
}

function formFields(html: string, action: string): URLSearchParams {
  const form = new RegExp(`<form[^>]*action="${action}"[^>]*>([\\s\\S]*?)</form>`).exec(html);
  assert.ok(form, `form ${action} present`);
  const params = new URLSearchParams();
  for (const input of (form[1] ?? "").matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"/g)) {
    params.append(input[1] ?? "", (input[2] ?? "").replaceAll("&amp;", "&").replaceAll("&quot;", '"'));
  }
  return params;
}

async function post(url: string, body: URLSearchParams): Promise<Response> {
  return await fetch(url, {
    body: body.toString(),
    headers: { Accept: "text/html", "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
    redirect: "manual",
  });
}

// Approve the one screen and exchange the code: the portal's whole round trip.
async function approveAndExchange(h: Harness, html: string, verifier: string): Promise<Record<string, unknown>> {
  const approve = await post(`${h.asUrl}/consent/approve`, formFields(html, "/consent/approve"));
  assert.equal(approve.status, FOUND, await approve.text());
  const callback = new URL(approve.headers.get("location") ?? "");
  assert.equal(callback.searchParams.get("state"), "st-1");

  const token = await fetch(`${h.asUrl}/oauth/token`, {
    body: new URLSearchParams({
      client_id: h.clientId,
      code: callback.searchParams.get("code") ?? "",
      code_verifier: verifier,
      grant_type: "authorization_code",
      redirect_uri: REDIRECT_URI,
    }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const body = (await token.json()) as Record<string, unknown>;
  assert.equal(token.status, OK, JSON.stringify(body));
  return body;
}

async function read(h: Harness, token: unknown, stream: string): Promise<Response> {
  return await fetch(`${h.rsUrl}/v1/streams/${stream}/records`, {
    headers: { Authorization: `Bearer ${String(token)}` },
  });
}

// Declare a request and load its consent page.
async function declare(h: Harness, details: unknown[], extra: Record<string, string> = {}) {
  const verifier = randomBytes(32).toString("base64url");
  const url = new URL(`${h.asUrl}/oauth/authorize`);
  url.search = new URLSearchParams({
    authorization_details: JSON.stringify(details),
    client_id: h.clientId,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    state: "st-1",
    ...extra,
  }).toString();
  const resp = await fetch(url, { redirect: "manual" });
  assert.equal(resp.status, FOUND, await resp.text());
  const consentUrl = new URL(resp.headers.get("location") ?? "", h.asUrl);
  const page = await fetch(consentUrl);
  const html = await page.text();
  assert.equal(page.status, OK, html);
  return { consentUrl, html, verifier };
}

test("two sources, one consent screen, one token that reads both", async () => {
  await withHarness(async (h) => {
    const { html, verifier } = await declare(h, twoSourceDetails());

    // One screen: final approval and deny, no separate review step.
    assert.match(html, /action="\/consent\/approve"/);
    assert.match(html, /action="\/consent\/deny"/);
    assert.doesNotMatch(html, /action="\/consent\/review"/);
    assert.match(html, /SIUBEN · Sistema Único de Beneficiarios \(demo\)/);
    assert.match(html, /INTRANT · Licencia de conducir \(demo\)/);
    assert.match(html, /ICV grupo/);
    assert.match(html, /Categoría/);
    assert.match(html, />Autorizar</);
    assert.match(html, />Rechazar</);
    assert.match(html, /Hasta que usted la cancele/);

    const token = await approveAndExchange(h, html, verifier);
    assert.equal(typeof token.grant_package_id, "string", "one token for the package");
    assert.equal(token.grant_id, undefined);

    const household = await read(h, token.access_token, "clasificacion_hogar");
    const householdBody = (await household.json()) as { data: Array<{ data: Record<string, unknown> }> };
    assert.equal(household.status, OK, JSON.stringify(householdBody));
    assert.deepEqual(Object.keys(householdBody.data[0]?.data ?? {}).sort(), ["icv_grupo", "id"]);

    const licence = await read(h, token.access_token, "licencias_conducir");
    assert.equal(licence.status, OK, await licence.text());

    // Same refusal a single-source grant gets for a stream it does not cover.
    const ungranted = await read(h, token.access_token, "miembros_hogar");
    const refusal = (await ungranted.json()) as { error?: { code?: string } };
    assert.equal(ungranted.status, UNAUTHORIZED);
    assert.equal(refusal.error?.code, "context.stream_not_allowed");
  });
});

test("requester-declared end date: validated, shown, recorded, enforced", async () => {
  await withHarness(async (h) => {
    const past = await authorize(h, twoSourceDetails({ expires_at: "2020-01-31T23:59:59-04:00" }));
    assert.equal(past.status, BAD_REQUEST, "past end date is refused");
    const tooFar = await authorize(h, twoSourceDetails({ expires_at: endDateInDays(6 * 365) }));
    assert.equal(tooFar.status, BAD_REQUEST, "end date beyond five years is refused");
    const mixed = [
      detail(SIUBEN, "clasificacion_hogar", ["id"], { expires_at: endDateInDays(90) }),
      detail(INTRANT, "licencias_conducir", ["id"], { expires_at: endDateInDays(91) }),
    ];
    assert.equal((await authorize(h, mixed)).status, BAD_REQUEST, "one consent, one end date");

    const endDate = endDateInDays(120);
    const expiresAt = new Date(endDate).toISOString();
    const shown = new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeZone: "America/Santo_Domingo" }).format(
      new Date(expiresAt)
    );
    const { consentUrl, html, verifier } = await declare(h, twoSourceDetails({ expires_at: endDate }), {
      ui_locales: "en",
    });

    // ui_locales on /oauth/authorize carries through to the consent page.
    assert.equal(consentUrl.searchParams.get("lang"), "en");
    assert.ok(html.includes(`Until ${shown}`), `end date shown in English: ${shown}`);
    assert.match(html, />Allow</);
    assert.match(html, />Deny</);
    assert.match(html, /<summary>Technical details<\/summary>/);

    const token = await approveAndExchange(h, html, verifier);
    const access = await getGrantPackageAccess(token.grant_package_id);
    const members = (access?.members ?? []) as Array<{ grant: { expires_at?: string } }>;
    assert.equal(members.length, 2);
    for (const member of members) {
      assert.equal(member.grant.expires_at, expiresAt, "each child grant records the declared end");
    }

    assert.equal((await read(h, token.access_token, "clasificacion_hogar")).status, OK);
    mock.timers.enable({ apis: ["Date"], now: Date.parse(expiresAt) + DAY_MS });
    try {
      const after = await read(h, token.access_token, "clasificacion_hogar");
      const body = (await after.json()) as { error?: { code?: string } };
      assert.equal(after.status, FORBIDDEN);
      assert.equal(body.error?.code, "grant_expired");
    } finally {
      mock.timers.reset();
    }
  });
});

test("Spanish end date on the one screen", async () => {
  await withHarness(async (h) => {
    const endDate = endDateInDays(120);
    const shown = new Intl.DateTimeFormat("es-DO", { dateStyle: "long", timeZone: "America/Santo_Domingo" }).format(
      new Date(endDate)
    );
    const { html } = await declare(h, twoSourceDetails({ expires_at: endDate }));
    assert.ok(html.includes(`Hasta el ${shown}`), `end date shown in Spanish: ${shown}`);
    assert.match(html, /<summary>Detalles técnicos<\/summary>/);
  });
});

test("deny on the one screen returns error=access_denied to the client", async () => {
  await withHarness(async (h) => {
    const { html } = await declare(h, twoSourceDetails());
    const deny = await post(`${h.asUrl}/consent/deny`, formFields(html, "/consent/deny"));
    assert.equal(deny.status, FOUND);
    const callback = new URL(deny.headers.get("location") ?? "");
    assert.equal(`${callback.origin}${callback.pathname}`, REDIRECT_URI);
    assert.equal(callback.searchParams.get("error"), "access_denied");
    assert.equal(callback.searchParams.get("state"), "st-1");
  });
});
