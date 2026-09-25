// Simulated "Servicios Proactivos" portal (Ministerio de Administración
// Pública): a PDPP client that offers to arrange the baby's vaccinations and
// the child benefit, with ONE consent covering the citizen's SNS health record
// and SIUBEN household file. Zero dependencies (Node 24).
//
//   browser              portal (this file)                    PDPP (AS + RS)
//   ───────              ──────────────────                    ──────────────
//   GET /           ──▶  the offer ("Decir sí con Cuenta Única")
//   POST /decir-si  ──▶  DCR (once, cached) ─────────────────▶ POST /oauth/register
//                   ◀──  302 authorize?authorization_details&PKCE&ui_locales
//   ──────────────────────────────────────────────────────────▶ GET /oauth/authorize
//                                                              sign-in + one consent screen
//   GET /callback?code&state ◀─────────────────────────────── 302 redirect_uri
//                        token exchange ─────────────────────▶ POST /oauth/token
//                        read 3 streams (one Bearer) ────────▶ GET /v1/streams/*/records
//                   ◀──  302 /listo  (what was received + the authorization)
//   POST /volver-a-consultar ─▶ re-read (stored Bearer) ─────▶ GET /v1/streams/*/records
//                   ◀──  302 /listo  (re-read OK, or "revoked" if 401/403)
//
// Env: PORT (8080), PORTAL_ORIGIN (public origin of this app), PDPP_ORIGIN,
//      PDPP_RS_ORIGIN (local dev only: resource server on its own port; default PDPP_ORIGIN),
//      SOURCES (local dev only: "sns,siuben" default; e.g. "siuben"),
//      END_DATE=off (local dev only: omit the end date for servers that reject it).
// State is in memory only: sessions keyed by an HttpOnly cookie.

import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { LANG, renderListo, renderOffer } from "./views.mjs";

const PORT = Number(process.env.PORT ?? 8080);
const PORTAL_ORIGIN = (process.env.PORTAL_ORIGIN ?? `http://localhost:${PORT}`).replace(/\/$/, "");
const PDPP_ORIGIN = (process.env.PDPP_ORIGIN ?? "http://localhost:3000").replace(/\/$/, "");
const PDPP_RS_ORIGIN = (process.env.PDPP_RS_ORIGIN ?? PDPP_ORIGIN).replace(/\/$/, "");
const REDIRECT_URI = `${PORTAL_ORIGIN}/callback`;
const SECURE_COOKIE = PORTAL_ORIGIN.startsWith("https:");
const MIS_AUTORIZACIONES_URL = `${PDPP_ORIGIN}/owner/autorizaciones`;

const CLIENT_NAME = "Servicios Proactivos · MAP (demo)";
const SESSION_COOKIE = "proactivos_sid";
const LANG_COOKIE = "pdpp_demo_lang";
const LANG_COOKIE_MAX_AGE_S = 60 * 60 * 24 * 30;
const SESSION_TTL_MS = 60 * 60 * 1000;
const PENDING_TTL_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_PAGES = 20;

const HTTP_OK = 200;
const HTTP_FOUND = 302;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_METHOD_NOT_ALLOWED = 405;
const HTTP_SERVER_ERROR = 500;

// ── The request: one consent, two sources, one purpose, one end date ──────

const DATA_ACCESS_TYPE = "https://pdpp.dev/data-access";
const ACCESS_MODE = "continuous";
const PURPOSE_CODE = "https://map.gob.do/purpose/servicios-proactivos-nacimiento";
const PURPOSE = {
  en: "Prepare your baby's vaccinations and the child benefit at birth, without you having to apply.",
  es: "Preparar la vacunación de su bebé y el bono por hijo al nacer, sin que usted tenga que solicitarlos.",
};

// Requester-declared end date. The field name is set by the PDPP server
// (CONTRACT.md "Decided by protocol agent"); change it here only.
const END_DATE_FIELD = "expires_at";
const END_DATE_VALUE = "2027-01-31T23:59:59-04:00";
const SEND_END_DATE = process.env.END_DATE !== "off";

const STREAM = { HOGAR: "clasificacion_hogar", MIEMBROS: "miembros_hogar", PRENATAL: "control_prenatal" };

// source key -> manifest URI + the streams/fields the result page shows.
const SOURCES = {
  sns: {
    id: "https://demo.pdpp.dev/rd/connectors/sns",
    streams: [
      {
        fields: ["id", "nombre", "centro_salud", "semanas_gestacion", "fecha_probable_parto", "source_updated_at"],
        name: STREAM.PRENATAL,
      },
    ],
  },
  siuben: {
    id: "https://demo.pdpp.dev/rd/connectors/siuben",
    streams: [
      {
        fields: ["id", "icv_grupo", "icv_descripcion", "miembros_hogar", "municipio", "provincia", "source_updated_at"],
        name: STREAM.HOGAR,
      },
      { fields: ["id", "nombre", "parentesco", "edad"], name: STREAM.MIEMBROS },
    ],
  },
};

const DEFAULT_SOURCES = "sns,siuben";
const SOURCE_KEYS = (process.env.SOURCES ?? DEFAULT_SOURCES)
  .split(",")
  .map((s) => s.trim())
  .filter((s) => SOURCES[s]);
const REQUESTED_STREAMS = new Set(SOURCE_KEYS.flatMap((k) => SOURCES[k].streams.map((s) => s.name)));

// Purpose text follows the page language so the consent screen matches it.
function authorizationDetails(lang) {
  return SOURCE_KEYS.map((key) => ({
    type: DATA_ACCESS_TYPE,
    source: { id: SOURCES[key].id, kind: "connector" },
    purpose_code: PURPOSE_CODE,
    purpose_description: PURPOSE[lang],
    access_mode: ACCESS_MODE,
    ...(SEND_END_DATE ? { [END_DATE_FIELD]: END_DATE_VALUE } : {}),
    streams: SOURCES[key].streams,
  }));
}

const CSS = readFileSync(new URL("./public/portal.css", import.meta.url));

// ── Sessions + language ─────────────────────────────────────────────────────

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

function addCookie(res, cookie) {
  const prev = res.getHeader("set-cookie") ?? [];
  res.setHeader("set-cookie", [...(Array.isArray(prev) ? prev : [prev]), cookie]);
}

const secureAttr = () => (SECURE_COOKIE ? "; Secure" : "");

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
  const session = { access: null, error: null, notice: null, pending: null, result: null, touchedAt: Date.now() };
  sessions.set(newId, session);
  addCookie(res, `${SESSION_COOKIE}=${newId}; Path=/; HttpOnly; SameSite=Lax${secureAttr()}`);
  return session;
}

// ?lang=es|en (the toggle) wins and is remembered; then the cookie; then Spanish.
function resolveLang(req, res, url) {
  const asked = url.searchParams.get("lang");
  if (asked === LANG.EN || asked === LANG.ES) {
    addCookie(res, `${LANG_COOKIE}=${asked}; Path=/; Max-Age=${LANG_COOKIE_MAX_AGE_S}; SameSite=Lax${secureAttr()}`);
    return asked;
  }
  return readCookie(req, LANG_COOKIE) === LANG.EN ? LANG.EN : LANG.ES;
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
  const body = await pdppJson(PDPP_ORIGIN, "/oauth/register", {
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

async function pdppJson(origin, path, init = {}) {
  const res = await fetch(`${origin}${path}`, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
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
  return pdppJson(PDPP_ORIGIN, "/oauth/token", {
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
  if (!REQUESTED_STREAMS.has(stream)) {
    return [];
  }
  const records = [];
  let path = `/v1/streams/${encodeURIComponent(stream)}/records`;
  for (let page = 0; path && page < MAX_PAGES; page++) {
    const body = await pdppJson(PDPP_RS_ORIGIN, path, { headers: { authorization: `Bearer ${token}` } });
    records.push(...(body.data ?? []).map((r) => r.data ?? {}));
    path = body.has_more ? body.links?.next : null;
  }
  return records;
}

// "siuben:miembro:2" < "siuben:miembro:10"
const byId = (a, b) => String(a.id).localeCompare(String(b.id), "es", { numeric: true });

// Reads the three streams with the one token.
async function readAll(token) {
  const [prenatal, hogares, miembros] = await Promise.all([
    readStream(token, STREAM.PRENATAL),
    readStream(token, STREAM.HOGAR),
    readStream(token, STREAM.MIEMBROS),
  ]);
  return { hogar: hogares[0] ?? null, miembros: miembros.sort(byId), prenatal: prenatal[0] ?? null };
}

// Authorization id(s) from the token response. A multi-source consent returns
// one `grant_package_id` (one child grant per source); single grants return `grant_id`.
function grantIds(tokens) {
  const ids = [
    tokens.grant_package_id,
    tokens.grant_id,
    ...(Array.isArray(tokens.grant_ids) ? tokens.grant_ids : []),
  ].filter(Boolean);
  return [...new Set(ids)];
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

function offer(res, session, lang, path) {
  const error = session.error;
  session.error = null;
  sendHtml(res, renderOffer({ error, lang, path, sources: SOURCE_KEYS, until: END_DATE_VALUE }));
}

// Build PKCE + state and send the browser to the PDPP authorize endpoint.
async function start(res, session, lang) {
  const clientId = await getClientId();
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(16).toString("base64url");
  session.pending = { clientId, createdAt: Date.now(), state, verifier };

  // A new request replaces any earlier (e.g. revoked) copy, so a denial lands
  // on the offer with its message instead of the old /listo.
  session.access = null;
  session.result = null;

  const url = new URL(`${PDPP_ORIGIN}/oauth/authorize`);
  url.search = new URLSearchParams({
    authorization_details: JSON.stringify(authorizationDetails(lang)),
    client_id: clientId,
    code_challenge: challenge,
    code_challenge_method: "S256",
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    state,
    ui_locales: lang,
  }).toString();
  redirect(res, url.toString());
}

// OAuth callback: verify state, exchange the code, read everything, show /listo.
async function callback(url, res, session) {
  const pending = session.pending;
  session.pending = null;
  const state = url.searchParams.get("state");
  const stateOk = pending && state === pending.state && Date.now() - pending.createdAt < PENDING_TTL_MS;

  const oauthError = url.searchParams.get("error");
  if (oauthError) {
    console.log(`callback error=${oauthError}`);
    session.error = oauthError === "access_denied" ? "denied" : "generic";
    return redirect(res, "/");
  }
  if (!stateOk) {
    session.error = "state";
    return redirect(res, "/");
  }

  try {
    const tokens = await exchangeCode(pending.clientId, url.searchParams.get("code") ?? "", pending.verifier);
    const data = await readAll(tokens.access_token);
    session.result = {
      ...data,
      grant: { ids: grantIds(tokens), revoked: false, sources: SOURCE_KEYS, until: END_DATE_VALUE },
      receivedAt: new Date(),
    };
    session.access = { grantId: grantIds(tokens)[0], token: tokens.access_token };
    console.log(`grant ${grantIds(tokens).join(",")}: read prenatal=${Boolean(data.prenatal)} hogar=${Boolean(data.hogar)} miembros=${data.miembros.length}`);
    redirect(res, "/listo");
  } catch (err) {
    console.error("callback failed:", err.message);
    // Client unknown (e.g. PDPP data reset): register again next time.
    if (err.body?.error === "invalid_client") {
      clientIdPromise = null;
    }
    session.error = "generic";
    redirect(res, "/");
  }
}

// Re-read with the stored token. 401/403 means the grant is gone (e.g.
// grant_revoked): keep the copy already received, mark it revoked.
async function reRead(res, session) {
  const result = session.result;
  if (!result || !session.access) {
    return redirect(res, "/");
  }

  try {
    Object.assign(result, await readAll(session.access.token));
    result.receivedAt = new Date();
    session.notice = { at: new Date(), kind: "verified" };
    console.log(`grant ${session.access.grantId}: re-read ok`);
  } catch (err) {
    console.error("re-read failed:", err.message);
    if (err.status !== HTTP_UNAUTHORIZED && err.status !== HTTP_FORBIDDEN) {
      session.error = "refresh";
      return redirect(res, "/listo");
    }
    result.grant.revoked = true;
    session.access = null;
    session.notice = { kind: "revoked" };
  }
  redirect(res, "/listo");
}

function listo(res, session, lang, path) {
  if (!session.result) {
    return redirect(res, "/");
  }
  const { error, notice } = session;
  session.error = null;
  session.notice = null;
  sendHtml(
    res,
    renderListo({
      error,
      lang,
      misAutorizacionesUrl: `${MIS_AUTORIZACIONES_URL}?lang=${lang}`,
      notice,
      path,
      purpose: PURPOSE[lang],
      result: session.result,
    })
  );
}

const ROUTES = ["/", "/decir-si", "/callback", "/listo", "/volver-a-consultar"];

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

  const lang = resolveLang(req, res, url);
  const session = getSession(req, res);
  switch (key) {
    case "GET /":
      return session.result ? redirect(res, "/listo") : offer(res, session, lang, url.pathname);
    case "POST /decir-si":
      return start(res, session, lang);
    case "GET /callback":
      return callback(url, res, session);
    case "GET /listo":
      return listo(res, session, lang, url.pathname);
    case "POST /volver-a-consultar":
      return reRead(res, session);
  }

  const known = ROUTES.includes(url.pathname);
  res.writeHead(known ? HTTP_METHOD_NOT_ALLOWED : HTTP_NOT_FOUND, { "content-type": "text/plain; charset=utf-8" });
  res.end(known ? "Método no permitido" : "Página no encontrada");
}

const server = createServer((req, res) => {
  route(req, res).catch((err) => {
    console.error(`${req.method} ${req.url} failed:`, err.message);
    if (res.headersSent) {
      return res.end();
    }
    sendHtml(res, renderOffer({ error: "generic", lang: LANG.ES, path: "/", sources: SOURCE_KEYS, until: END_DATE_VALUE }), HTTP_SERVER_ERROR);
  });
});

server.listen(PORT, () => {
  console.log(`Servicios Proactivos portal on :${PORT}  origin=${PORTAL_ORIGIN}  pdpp=${PDPP_ORIGIN}  sources=${SOURCE_KEYS}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    server.closeAllConnections();
  });
}
