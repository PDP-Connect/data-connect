// Simulated MIVHED housing portal: a PDPP client that pre-fills the housing
// application with the citizen's SIUBEN household data, with their consent.
// Zero dependencies (Node 24).
//
//   browser            portal (this file)                     PDPP (AS + RS)
//   ───────            ──────────────────                     ──────────────
//   GET /         ──▶  "before" form
//   POST /siuben/start ─▶ DCR (once, cached) ───────────────▶ POST /oauth/register
//                  ◀── 302 authorize?authorization_details&PKCE
//   ───────────────────────────────────────────────────────▶ GET /oauth/authorize
//                                                             sign-in + consent pages
//   GET /callback?code&state ◀──────────────────────────────── 302 redirect_uri
//                      token exchange ────────────────────▶ POST /oauth/token
//                      read streams (Bearer) ─────────────▶ GET /v1/streams/*/records
//                  ◀── 302 /solicitud  ("after" form, real records)
//
// Env: PORT (8080), PORTAL_ORIGIN (public origin of this app), PDPP_ORIGIN.
// State is in memory only: sessions keyed by an HttpOnly cookie.

import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { renderSolicitud } from "./views.mjs";

const PORT = Number(process.env.PORT ?? 8080);
const PORTAL_ORIGIN = (process.env.PORTAL_ORIGIN ?? `http://localhost:${PORT}`).replace(/\/$/, "");
const PDPP_ORIGIN = (process.env.PDPP_ORIGIN ?? "http://localhost:3000").replace(/\/$/, "");
const REDIRECT_URI = `${PORTAL_ORIGIN}/callback`;
const SECURE_COOKIE = PORTAL_ORIGIN.startsWith("https:");

const CLIENT_NAME = "Portal de Vivienda MIVHED (demo)";
const SESSION_COOKIE = "mivhed_sid";
const SESSION_TTL_MS = 60 * 60 * 1000;
const PENDING_TTL_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_PAGES = 20;

const HTTP_OK = 200;
const HTTP_FOUND = 302;
const HTTP_NOT_FOUND = 404;
const HTTP_METHOD_NOT_ALLOWED = 405;
const HTTP_SERVER_ERROR = 500;

// What the portal asks for: exactly the fields the form displays.
const SIUBEN_SOURCE_ID = "https://demo.pdpp.dev/rd/connectors/siuben";
const DATA_ACCESS_TYPE = "https://pdpp.dev/data-access";
const STREAM_HOGAR = "clasificacion_hogar";
const STREAM_MIEMBROS = "miembros_hogar";
const AUTHORIZATION_DETAILS = [
  {
    type: DATA_ACCESS_TYPE,
    source: { id: SIUBEN_SOURCE_ID, kind: "connector" },
    purpose_code: "https://mivhed.gob.do/purpose/vivienda-elegibilidad",
    purpose_description: "Evaluar la elegibilidad del hogar para el programa de vivienda",
    access_mode: "single_use",
    streams: [
      {
        name: STREAM_HOGAR,
        fields: [
          "id",
          "nombre_jefe_hogar",
          "cedula_jefe_hogar",
          "miembros_hogar",
          "provincia",
          "municipio",
          "icv_grupo",
          "icv_descripcion",
          "programas_activos",
          "source_updated_at",
        ],
      },
      { name: STREAM_MIEMBROS, fields: ["id", "nombre", "parentesco", "edad", "ocupacion"] },
    ],
  },
];

// Spanish copy for callback failures, keyed by OAuth error code.
const ERRORS = {
  access_denied: {
    title: "No autorizaste compartir tus datos del SIUBEN.",
    detail: "No se compartió ningún dato. Puedes intentarlo de nuevo o llenar el formulario manualmente.",
  },
  state: {
    title: "La autorización no coincide con esta solicitud.",
    detail: "Por seguridad, vuelve a iniciar el proceso desde este portal.",
  },
  generic: {
    title: "No pudimos obtener tus datos del SIUBEN.",
    detail: "Ocurrió un problema al comunicarnos con Cuenta Única. Intenta de nuevo en unos minutos.",
  },
};

const CSS = readFileSync(new URL("./public/portal.css", import.meta.url));

// ── Sessions ────────────────────────────────────────────────────────────────

const sessions = new Map();

function sweepSessions() {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.touchedAt > SESSION_TTL_MS) {
      sessions.delete(id);
    }
  }
}

function readCookie(req, name) {
  const header = req.headers.cookie ?? "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) {
      return v.join("=");
    }
  }
  return null;
}

// Returns the caller's session, creating one (and its Set-Cookie) if needed.
function getSession(req, res) {
  const id = readCookie(req, SESSION_COOKIE);
  const existing = id ? sessions.get(id) : null;
  if (existing) {
    existing.touchedAt = Date.now();
    return existing;
  }

  sweepSessions();
  const newId = randomBytes(24).toString("base64url");
  const session = { error: null, pending: null, prefill: null, touchedAt: Date.now() };
  sessions.set(newId, session);
  const secure = SECURE_COOKIE ? "; Secure" : "";
  res.setHeader("set-cookie", `${SESSION_COOKIE}=${newId}; Path=/; HttpOnly; SameSite=Lax${secure}`);
  return session;
}

// ── PDPP client ─────────────────────────────────────────────────────────────

let clientIdPromise = null;

// Dynamic client registration, once per process.
function getClientId() {
  clientIdPromise ??= registerClient().catch((err) => {
    clientIdPromise = null;
    throw err;
  });
  return clientIdPromise;
}

async function registerClient() {
  const body = await pdppJson("/oauth/register", {
    body: JSON.stringify({
      client_name: CLIENT_NAME,
      grant_types: ["authorization_code"],
      redirect_uris: [REDIRECT_URI],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  console.log(`registered client ${body.client_id} (redirect ${REDIRECT_URI})`);
  return body.client_id;
}

async function pdppJson(path, init = {}) {
  const res = await fetch(`${PDPP_ORIGIN}${path}`, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 300) };
  }
  if (!res.ok) {
    const err = new Error(`${init.method ?? "GET"} ${path} -> ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

function exchangeCode(clientId, code, verifier) {
  return pdppJson("/oauth/token", {
    body: new URLSearchParams({
      client_id: clientId,
      code,
      code_verifier: verifier,
      grant_type: "authorization_code",
      redirect_uri: REDIRECT_URI,
    }),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
}

// All records of one stream, following `links.next` pagination.
async function readStream(token, stream) {
  const records = [];
  let path = `/v1/streams/${encodeURIComponent(stream)}/records`;
  for (let page = 0; path && page < MAX_PAGES; page++) {
    const body = await pdppJson(path, { headers: { authorization: `Bearer ${token}` } });
    records.push(...(body.data ?? []).map((r) => r.data ?? {}));
    path = body.has_more ? body.links?.next : null;
  }
  return records;
}

// "siuben:miembro:2" < "siuben:miembro:10"
const byId = (a, b) => String(a.id).localeCompare(String(b.id), "es", { numeric: true });

// Reads both SIUBEN streams and shapes them for the form.
async function loadPrefill(tokenResponse) {
  const token = tokenResponse.access_token;
  const [hogares, miembros] = await Promise.all([readStream(token, STREAM_HOGAR), readStream(token, STREAM_MIEMBROS)]);
  const detail = tokenResponse.authorization_details?.[0] ?? AUTHORIZATION_DETAILS[0];
  return {
    grant: {
      accessMode: detail.access_mode,
      id: tokenResponse.grant_id,
      purpose: detail.purpose_description,
    },
    hogar: hogares[0] ?? null,
    miembros: miembros.sort(byId),
  };
}

// ── Handlers ────────────────────────────────────────────────────────────────

function sendHtml(res, html, status = HTTP_OK) {
  res.writeHead(status, { "cache-control": "no-store", "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

function redirect(res, location) {
  res.writeHead(HTTP_FOUND, { "cache-control": "no-store", location });
  res.end();
}

function page(res, session) {
  const error = session.error;
  session.error = null;
  sendHtml(res, renderSolicitud({ error, pdppOrigin: PDPP_ORIGIN, prefill: null }));
}

// Build PKCE + state and send the browser to the PDPP authorize endpoint.
async function startSiuben(res, session) {
  const clientId = await getClientId();
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(16).toString("base64url");
  session.pending = { clientId, createdAt: Date.now(), state, verifier };

  const url = new URL(`${PDPP_ORIGIN}/oauth/authorize`);
  url.search = new URLSearchParams({
    authorization_details: JSON.stringify(AUTHORIZATION_DETAILS),
    client_id: clientId,
    code_challenge: challenge,
    code_challenge_method: "S256",
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    state,
  }).toString();
  redirect(res, url.toString());
}

// OAuth callback: verify state, exchange the code, read SIUBEN, show the form.
async function callback(url, res, session) {
  const pending = session.pending;
  session.pending = null;
  const state = url.searchParams.get("state");
  const stateOk = pending && state === pending.state && Date.now() - pending.createdAt < PENDING_TTL_MS;

  const oauthError = url.searchParams.get("error");
  if (oauthError) {
    console.log(`callback error=${oauthError}`);
    session.error = ERRORS[oauthError] ?? ERRORS.generic;
    return redirect(res, "/");
  }
  if (!stateOk) {
    session.error = ERRORS.state;
    return redirect(res, "/");
  }

  try {
    const tokens = await exchangeCode(pending.clientId, url.searchParams.get("code") ?? "", pending.verifier);
    session.prefill = await loadPrefill(tokens);
    console.log(`grant ${tokens.grant_id}: read ${session.prefill.miembros.length} miembros`);
    redirect(res, "/solicitud");
  } catch (err) {
    console.error("callback failed:", err.message);
    // Client unknown (e.g. PDPP data reset): register again next time.
    if (err.body?.error === "invalid_client") {
      clientIdPromise = null;
    }
    session.error = ERRORS.generic;
    redirect(res, "/");
  }
}

function solicitud(res, session) {
  if (!session.prefill) {
    return redirect(res, "/");
  }
  sendHtml(res, renderSolicitud({ pdppOrigin: PDPP_ORIGIN, prefill: session.prefill }));
}

async function route(req, res) {
  const url = new URL(req.url ?? "/", PORTAL_ORIGIN);
  const key = `${req.method} ${url.pathname}`;

  // Stateless routes first (no cookie for probes and assets).
  if (key === "GET /healthz") {
    res.writeHead(HTTP_OK, { "content-type": "text/plain" });
    return res.end("ok");
  }
  if (key === "GET /portal.css") {
    res.writeHead(HTTP_OK, { "cache-control": "public, max-age=300", "content-type": "text/css; charset=utf-8" });
    return res.end(CSS);
  }

  const session = getSession(req, res);
  switch (key) {
    case "GET /":
      return session.prefill ? redirect(res, "/solicitud") : page(res, session);
    case "GET /siuben/start":
    case "POST /siuben/start":
      return startSiuben(res, session);
    case "GET /callback":
      return callback(url, res, session);
    case "GET /solicitud":
      return solicitud(res, session);
    case "POST /siuben/clear":
      session.prefill = null;
      return redirect(res, "/");
  }

  const known = ["/", "/siuben/start", "/callback", "/solicitud", "/siuben/clear"].includes(url.pathname);
  res.writeHead(known ? HTTP_METHOD_NOT_ALLOWED : HTTP_NOT_FOUND, { "content-type": "text/plain; charset=utf-8" });
  res.end(known ? "Método no permitido" : "Página no encontrada");
}

const server = createServer((req, res) => {
  route(req, res).catch((err) => {
    console.error(`${req.method} ${req.url} failed:`, err.message);
    if (res.headersSent) {
      return res.end();
    }
    sendHtml(
      res,
      renderSolicitud({ error: ERRORS.generic, pdppOrigin: PDPP_ORIGIN, prefill: null }),
      HTTP_SERVER_ERROR
    );
  });
});

server.listen(PORT, () => {
  console.log(`MIVHED portal on :${PORT}  origin=${PORTAL_ORIGIN}  pdpp=${PDPP_ORIGIN}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    server.closeAllConnections();
  });
}
