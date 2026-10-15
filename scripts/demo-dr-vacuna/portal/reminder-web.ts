// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// "Vacuna al día" reminder service: a small web front for the reminder
// service in ../reminder-service (same store, OAuth client, payer and
// lifecycle logic). It is the client app the walkthrough starts from.
//
//   GET  /recordatorio                 landing: "Conectar con Cuenta Única"
//   POST /recordatorio/conectar        → GET <AS>/oauth/authorize (PKCE, state,
//                                        authorization_details; optional child_id)
//   GET  /recordatorio/callback        code → token (private_key_jwt) → real read
//                                        of the child's record → landing with next dose
//   GET  /recordatorio/panel           what the service sees: children, status,
//                                        last read, next dose, counters (runs the
//                                        lifecycle check and deletion sweep first)
//   POST /recordatorio/panel/leer      run one read cycle for every active child
//
// The service only ever sees what the grant shares: the record number, birth
// date and doses. It never learns the child's name or the parent's cédula.

import { createHash, createPublicKey, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { type Lang, langCookie, langHref, pick, requestedLang, resolveLang } from "../../../reference-implementation/server/pilot-dr-vacuna/i18n.ts";
import { SOURCE_ID, STREAM } from "../baseline/lib/manifest.ts";
import { createClock } from "../reminder-service/lib/clock.ts";
import { type ClientCredentials, loadOrCreateClientKey, privateKeyJwtClient } from "../reminder-service/lib/oauth.ts";
import { type GatewayPayer, HttpGatewayPayer, MockPayer, NATIVE_ASSET, ONE_HUNDREDTH_VANA_WEI } from "../reminder-service/lib/payer.ts";
import { evaluateDueDose, type ImmunizationRecord } from "../reminder-service/lib/schedule.ts";
import { DEFAULT_CONFIG, ReminderService } from "../reminder-service/lib/service.ts";
import { LifecycleEndpointStatusSource } from "../reminder-service/lib/status.ts";
import { type ChildRow, ReminderStore } from "../reminder-service/lib/store.ts";

export const BASE = "/recordatorio";
export const CLIENT_NAME = "Vacuna al día";
export const PURPOSE_DESCRIPTION = "Enviarle un recordatorio cuando a su hijo o hija le toque una vacuna.";
const CHILD_ID_RE = /^DR-\d{7}$/;
const PENDING_TTL_MS = 10 * 60 * 1000;

export interface ReminderWebOptions {
  asInternal: string;
  issuer: string;
  publicOrigin: string;
  rsInternal: string;
  stateDir: string;
}

interface ClientState {
  clientId: string;
  redirectUri: string;
}

/** "DR-9100003" -> 9100003 (the store keys children by integer index). */
export function childIndexOf(childId: string): number {
  return Number.parseInt(childId.replace(/\D/g, ""), 10);
}

function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const VACCINE_EN: Record<string, string> = {
  DPT: "DTP booster",
  Neumococo: "Pneumococcal",
  Pentavalente: "Pentavalent (DTP-HepB-Hib)",
  SRP: "MMR",
};

export function vaccineName(vaccine: string, lang: Lang): string {
  return lang === "en" ? (VACCINE_EN[vaccine] ?? vaccine) : vaccine;
}

function formatDay(isoDate: string, lang: Lang): string {
  const d = new Date(`${isoDate.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(d.getTime())
    ? isoDate
    : new Intl.DateTimeFormat(lang === "en" ? "en-US" : "es-DO", { dateStyle: "long", timeZone: "UTC" }).format(d);
}

function formatMoment(ms: number | null, lang: Lang): string {
  if (!ms) {
    return "—";
  }
  return new Intl.DateTimeFormat(lang === "en" ? "en-US" : "es-DO", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/Santo_Domingo",
  }).format(new Date(ms));
}

function parseRecord(json: string | null): ImmunizationRecord | null {
  if (!json) {
    return null;
  }
  try {
    const body = JSON.parse(json) as Record<string, unknown>;
    return ((body.data ?? body) as unknown) as ImmunizationRecord;
  } catch {
    return null;
  }
}

/** Next dose from a held record, whatever its date (the landing and panel show it ahead of time). */
export function nextDose(record: ImmunizationRecord | null, now: number) {
  return record ? evaluateDueDose(record, now, 3650) : null;
}

// ─── page shell ─────────────────────────────────────────────────────────────

const CSS = `
:root { --vd-brand: #0B6E4F; --vd-brand-dark: #08513A; --vd-ink: #1C2B27; --vd-muted: #5D6B66; --vd-line: #DCE5E1;
  --vd-bg: #F4F8F6; --vd-card: #fff; --vd-warn: #9A3412; --vd-warn-bg: #FFF1E7; --vd-ok-bg: #E7F5EE; --vd-info-bg: #EAF2FB; }
* { box-sizing: border-box; }
body { margin: 0; font-family: 'Nunito Sans', system-ui, sans-serif; color: var(--vd-ink); background: var(--vd-bg); -webkit-font-smoothing: antialiased; }
a { color: var(--vd-brand); }
.vd-demo { max-width: 960px; margin: 0 auto; padding: 4px 16px; font-size: 11px; color: var(--vd-muted); display: flex; justify-content: space-between; gap: 12px; }
.vd-demo a { color: var(--vd-muted); }
.vd-demo a[aria-current="true"] { color: var(--vd-brand); font-weight: 700; text-decoration: none; }
header.vd-top { background: var(--vd-brand); color: #fff; }
.vd-top-inner { max-width: 960px; margin: 0 auto; padding: 14px 16px; display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.vd-logo { display: flex; align-items: center; gap: 10px; color: #fff; text-decoration: none; font-weight: 800; font-size: 20px; }
.vd-logo span { width: 34px; height: 34px; border-radius: 10px; background: #fff; color: var(--vd-brand); display: grid; place-items: center; font-size: 18px; }
.vd-nav { display: flex; gap: 16px; font-size: 14px; }
.vd-nav a { color: #DDF3EA; text-decoration: none; font-weight: 600; }
.vd-nav a[aria-current="page"] { color: #fff; text-decoration: underline; text-underline-offset: 4px; }
main { max-width: 960px; margin: 0 auto; padding: 28px 16px 48px; }
.vd-hero { display: grid; grid-template-columns: 1.2fr 1fr; gap: 28px; align-items: start; }
.vd-hero h1 { font-size: 30px; line-height: 1.2; margin: 0 0 12px; }
.vd-lead { font-size: 17px; line-height: 1.55; color: var(--vd-muted); margin: 0 0 22px; }
.vd-card { background: var(--vd-card); border: 1px solid var(--vd-line); border-radius: 14px; padding: 22px; }
.vd-card h2 { margin: 0 0 10px; font-size: 18px; }
.vd-btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 46px; padding: 10px 22px; border-radius: 10px; border: 0;
  background: var(--vd-brand); color: #fff; font: inherit; font-weight: 700; font-size: 16px; cursor: pointer; text-decoration: none; }
.vd-btn:hover { background: var(--vd-brand-dark); }
.vd-btn.vd-block { width: 100%; }
.vd-btn.vd-secondary { background: #fff; color: var(--vd-brand); border: 1px solid var(--vd-brand); }
.vd-steps { margin: 0; padding-left: 20px; line-height: 1.6; color: var(--vd-muted); font-size: 15px; }
.vd-steps li { margin-bottom: 6px; }
details.vd-more { margin-top: 16px; font-size: 14px; }
details.vd-more summary { cursor: pointer; color: var(--vd-brand); font-weight: 600; }
.vd-field { display: grid; gap: 6px; margin: 12px 0; }
.vd-field label { font-size: 13px; font-weight: 600; }
.vd-field input { height: 44px; padding: 0 12px; border: 1px solid var(--vd-line); border-radius: 8px; font: inherit; font-size: 16px; }
.vd-note { font-size: 13px; color: var(--vd-muted); line-height: 1.5; margin: 8px 0 0; }
.vd-alert { border-radius: 10px; padding: 12px 14px; margin: 0 0 20px; font-size: 15px; line-height: 1.5; }
.vd-alert.vd-ok { background: var(--vd-ok-bg); border: 1px solid #A9D8C1; }
.vd-alert.vd-warn { background: var(--vd-warn-bg); border: 1px solid #F3C4A3; color: var(--vd-warn); }
.vd-dose { display: grid; gap: 4px; padding: 14px; border-radius: 10px; background: var(--vd-info-bg); margin: 12px 0; }
.vd-dose b { font-size: 18px; }
.vd-dose[data-status="overdue"] { background: var(--vd-warn-bg); }
.vd-dose[data-status="overdue"] b { color: var(--vd-warn); }
.vd-kv { display: grid; grid-template-columns: 160px 1fr; gap: 6px 12px; font-size: 14px; margin: 12px 0 0; }
.vd-kv dt { color: var(--vd-muted); }
.vd-kv dd { margin: 0; overflow-wrap: anywhere; }
.vd-stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin: 0 0 20px; }
.vd-stat { background: #fff; border: 1px solid var(--vd-line); border-radius: 12px; padding: 14px; }
.vd-stat b { display: block; font-size: 26px; font-variant-numeric: tabular-nums; }
.vd-stat span { font-size: 13px; color: var(--vd-muted); }
.vd-table { width: 100%; border-collapse: collapse; font-size: 14px; background: #fff; border: 1px solid var(--vd-line); border-radius: 12px; overflow: hidden; }
.vd-table th, .vd-table td { text-align: left; padding: 10px 12px; border-top: 1px solid var(--vd-line); vertical-align: top; }
.vd-table th { background: #EEF4F1; font-size: 12px; text-transform: uppercase; letter-spacing: .4px; color: var(--vd-muted); border-top: 0; }
.vd-table td small { display: block; color: var(--vd-muted); font-size: 12px; }
.vd-pill { display: inline-block; font-size: 12px; font-weight: 700; padding: 2px 10px; border-radius: 999px; white-space: nowrap; }
.vd-pill[data-status="active"] { background: var(--vd-ok-bg); color: var(--vd-brand-dark); }
.vd-pill[data-status="ended_keep"] { background: #F1F1F1; color: #444; }
.vd-pill[data-status="erase_pending"], .vd-pill[data-status="needs_reauth"] { background: var(--vd-warn-bg); color: var(--vd-warn); }
.vd-pill[data-status="deleted"] { background: #FDECEA; color: #B3261E; }
.vd-toolbar { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; margin: 0 0 16px; }
.vd-toolbar h1 { margin: 0; font-size: 24px; }
footer.vd-foot { max-width: 960px; margin: 0 auto; padding: 0 16px 32px; font-size: 12px; color: var(--vd-muted); }
@media (max-width: 760px) {
  .vd-hero { grid-template-columns: 1fr; }
  .vd-hero h1 { font-size: 25px; }
  .vd-stats { grid-template-columns: 1fr 1fr; }
  .vd-kv { grid-template-columns: 1fr; gap: 2px; }
  .vd-kv dd { margin-bottom: 8px; }
  .vd-table thead { display: none; }
  .vd-table, .vd-table tbody, .vd-table tr, .vd-table td { display: block; width: 100%; }
  .vd-table tr { border-top: 1px solid var(--vd-line); padding: 8px 0; }
  .vd-table td { border: 0; padding: 4px 12px; }
  .vd-table td::before { content: attr(data-label); display: block; font-size: 11px; text-transform: uppercase; color: var(--vd-muted); letter-spacing: .4px; }
}
`;

function shell(input: { body: string; currentUrl: string; lang: Lang; page: "home" | "panel"; title: string }): string {
  const { lang } = input;
  const t = (es: string, en: string) => pick(lang, es, en);
  const toggle = (["es", "en"] as const)
    .map(
      (l) =>
        `<a href="${esc(langHref(input.currentUrl, l))}" hreflang="${l}"${l === lang ? ' aria-current="true"' : ""}>${l.toUpperCase()}</a>`
    )
    .join(" | ");
  const nav = (key: "home" | "panel", href: string, label: string) =>
    `<a href="${href}"${input.page === key ? ' aria-current="page"' : ""}>${label}</a>`;
  return `<!DOCTYPE html>
<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(input.title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Nunito+Sans:wght@400;600;700;800&display=swap">
<style>${CSS}</style></head>
<body data-lang="${lang}">
<div class="vd-demo" role="note"><span>${t("Aplicación de demostración · datos ficticios", "Demo app · fictitious data")}</span><span>${toggle}</span></div>
<header class="vd-top"><div class="vd-top-inner">
  <a class="vd-logo" href="${BASE}"><span aria-hidden="true">+</span>${CLIENT_NAME}</a>
  <nav class="vd-nav">${nav("home", BASE, t("Inicio", "Home"))}${nav("panel", `${BASE}/panel`, t("Panel del servicio", "Service dashboard"))}<a href="/pilot/vacuna">${t("Sobre la demo", "About the demo")}</a></nav>
</div></header>
<main>${input.body}</main>
<footer class="vd-foot">${t(
    "«Vacuna al día» es un servicio privado ficticio creado para esta demostración. No es un servicio del Estado dominicano.",
    "“Vacuna al día” is a fictitious private service made for this demo. It is not a service of the Dominican State."
  )}</footer>
</body></html>`;
}

function childCard(row: ChildRow, lang: Lang, now: number): string {
  const t = (es: string, en: string) => pick(lang, es, en);
  const record = parseRecord(row.last_record_json);
  const due = nextDose(record, now);
  const dose = due
    ? `<div class="vd-dose" data-status="${due.status}"><span>${due.status === "overdue" ? t("Vacuna atrasada", "Overdue vaccine") : t("Próxima vacuna", "Next vaccine")}</span>
<b data-next-dose>${esc(vaccineName(due.vaccine, lang))} · ${t("dosis", "dose")} ${due.dose_number}</b><span>${due.status === "overdue" ? t("Debía aplicarse el", "Was due on") : t("Le toca el", "Due on")} ${esc(formatDay(due.due_date, lang))}</span></div>`
    : `<div class="vd-dose"><b data-next-dose>${t("Al día: no tiene dosis pendientes del esquema infantil", "Up to date: no pending doses on the childhood schedule")}</b></div>`;
  return `<div class="vd-card" data-connected-child="${esc(row.child_id)}">
<h2>${t("Conectado: registro", "Connected: record")} ${esc(row.child_id)}</h2>
${dose}
<dl class="vd-kv">
  <dt>${t("Fecha de nacimiento", "Date of birth")}</dt><dd>${esc(record ? formatDay(record.birth_date, lang) : "—")}</dd>
  <dt>${t("Vacunas registradas", "Vaccines on record")}</dt><dd>${record ? record.doses.length : "—"}</dd>
  <dt>${t("Leído del registro", "Read from the register")}</dt><dd>${esc(formatMoment(row.last_read_at, lang))}</dd>
</dl>
<p class="vd-note">${t(
    "Esto es todo lo que vemos: el número de registro, la fecha de nacimiento y las vacunas. No recibimos el nombre del niño o niña ni la cédula de quien autorizó.",
    "This is all we see: the record number, the date of birth and the vaccines. We do not receive the child's name or the cédula of whoever authorized."
  )}</p></div>`;
}

/** Block explorer transaction URL prefix (Moksha testnet by default). */
export function explorerTxBase(): string {
  return process.env.VACUNA_EXPLORER_TX_URL || "https://moksha.vanascan.io/tx/";
}

/** A settlement transaction hash in a gateway response, if it carries one. */
export function txHashOf(responseJson: string | null): string | null {
  if (!responseJson) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseJson);
  } catch {
    return null;
  }
  const seen: unknown[] = [parsed];
  while (seen.length) {
    const node = seen.shift();
    if (!node || typeof node !== "object") {
      continue;
    }
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (/^(tx_?hash|transaction_?hash|transactionHash|txHash|hash)$/i.test(key) && typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value)) {
        return value;
      }
      if (value && typeof value === "object") {
        seen.push(value);
      }
    }
  }
  return null;
}

function formatVana(wei: string): string {
  try {
    const n = BigInt(wei);
    const whole = n / 10n ** 18n;
    const frac = (n % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "");
    return `${whole}${frac ? `.${frac}` : ""} VANA`;
  } catch {
    return wei;
  }
}

const STATUS_LABEL: Record<string, readonly [string, string]> = {
  active: ["Activa", "Active"],
  deleted: ["Retirada · datos borrados", "Withdrawn · data deleted"],
  ended_keep: ["Retirada · datos conservados", "Withdrawn · data kept"],
  erase_pending: ["Retirada · borrado pendiente", "Withdrawn · deletion pending"],
  needs_reauth: ["Requiere nueva autorización", "Needs re-authorization"],
};

// ─── the app ────────────────────────────────────────────────────────────────

export async function createReminderWeb(opts: ReminderWebOptions) {
  const store = new ReminderStore(join(opts.stateDir, "reminder.sqlite"));
  const redirectUri = `${opts.publicOrigin}${BASE}/callback`;
  const keyPath = join(opts.stateDir, "client-key.pem");
  const clientFile = join(opts.stateDir, "client.json");

  async function ensureClient(): Promise<ClientState> {
    let state: ClientState | null = null;
    try {
      state = JSON.parse(readFileSync(clientFile, "utf8")) as ClientState;
    } catch {
      state = null;
    }
    if (state?.redirectUri === redirectUri) {
      return state;
    }
    const { jwk } = loadOrCreateClientKey(keyPath);
    const resp = await fetch(`${opts.asInternal}/oauth/register`, {
      body: JSON.stringify({
        client_name: CLIENT_NAME,
        grant_types: ["authorization_code", "refresh_token"],
        jwks: { keys: [jwk] },
        redirect_uris: [redirectUri],
        response_types: ["code"],
        token_endpoint_auth_method: "private_key_jwt",
      }),
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      method: "POST",
    });
    const body = (await resp.json()) as Record<string, unknown>;
    if (resp.status !== 201) {
      throw new Error(`client registration failed: HTTP ${resp.status} ${JSON.stringify(body)} (needs PDPP_CONFIDENTIAL_CLIENTS=1)`);
    }
    state = { clientId: String(body.client_id), redirectUri };
    writeFileSync(clientFile, `${JSON.stringify(state, null, 2)}\n`);
    return state;
  }

  const clientState = await ensureClient();
  const { key, kid } = loadOrCreateClientKey(keyPath);
  const client: ClientCredentials = privateKeyJwtClient({ clientId: clientState.clientId, issuer: opts.issuer, key, kid });
  const payer = buildPayer(store);
  const status = new LifecycleEndpointStatusSource({ client, endpoint: `${opts.asInternal}/pilot/vacuna/grant-lifecycle` });
  const receiptKeyFile = process.env.PDPP_READ_RECEIPTS_KEY_FILE ? `${process.env.PDPP_READ_RECEIPTS_KEY_FILE}.pub` : "";
  const receiptPublicKey =
    receiptKeyFile && existsSync(receiptKeyFile) ? createPublicKey(readFileSync(receiptKeyFile, "utf8")) : null;
  const clock = createClock();
  const baseConfig = {
    ...DEFAULT_CONFIG,
    concurrency: 4,
    deleteGraceMs: 0,
    receiptPublicKey,
    rsUrl: opts.rsInternal,
    stream: STREAM,
    tokenEndpoint: `${opts.asInternal}/oauth/token`,
  };
  // Connect: read only children not read in the last few minutes (the new one).
  const connectService = new ReminderService({
    client,
    clock,
    config: { ...baseConfig, readIntervalMs: 5 * 60 * 1000 },
    payer,
    status,
    store,
  });
  // Panel: check every grant's lifecycle on each view; "read now" reads everyone active.
  const panelService = new ReminderService({
    client,
    clock,
    config: { ...baseConfig, readIntervalMs: 0, statusIntervalMs: 0 },
    payer,
    status,
    store,
  });

  const pending = new Map<string, { at: number; verifier: string }>();

  function counters() {
    const merged = { ...connectService.snapshot(), counters: {} as Record<string, unknown> };
    const sum = (path: string) => connectService.counters.get(path) + panelService.counters.get(path);
    const denied = (svc: ReminderService) => {
      const tree = (svc.counters.data.reads as Record<string, unknown> | undefined)?.denied as
        | Record<string, number>
        | undefined;
      return Object.values(tree ?? {}).reduce((a, b) => a + (typeof b === "number" ? b : 0), 0);
    };
    merged.counters = {
      denied: denied(connectService) + denied(panelService),
      paymentsAccepted: sum("payments.accepted"),
      paymentsSent: sum("payments.sent"),
      readsAttempted: sum("reads.attempted"),
      readsSucceeded: sum("reads.succeeded"),
      receiptsVerified: sum("receipts.verified"),
    };
    return merged;
  }

  function langFor(req: IncomingMessage, url: URL, res: ServerResponse): Lang {
    const query = Object.fromEntries(url.searchParams);
    const explicit = requestedLang({ headers: req.headers, query });
    if (explicit) {
      res.setHeader("Set-Cookie", langCookie(explicit));
    }
    return resolveLang({ headers: req.headers, query });
  }

  function currentUrl(url: URL): string {
    const copy = new URL(url.toString());
    copy.searchParams.delete("lang");
    return `${copy.pathname}${copy.search}`;
  }

  function html(res: ServerResponse, body: string, statusCode = 200): void {
    res.writeHead(statusCode, { "Cache-Control": "no-store", "Content-Type": "text/html; charset=utf-8" });
    res.end(body);
  }

  function redirect(res: ServerResponse, location: string, statusCode = 303): void {
    res.writeHead(statusCode, { Location: location });
    res.end();
  }

  async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > 16_384) {
        throw new Error("form too large");
      }
      chunks.push(chunk as Buffer);
    }
    return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
  }

  function authorizeUrl(childId: string | null): string {
    const now = Date.now();
    for (const [k, v] of pending) {
      if (now - v.at > PENDING_TTL_MS) {
        pending.delete(k);
      }
    }
    const state = randomBytes(16).toString("base64url");
    const verifier = randomBytes(32).toString("base64url");
    pending.set(state, { at: now, verifier });
    const url = new URL(`${opts.publicOrigin}/oauth/authorize`);
    url.searchParams.set("client_id", clientState.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", createHash("sha256").update(verifier).digest("base64url"));
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set(
      "authorization_details",
      JSON.stringify([
        {
          access_mode: "continuous",
          purpose_code: "https://pdpp.dev/purpose/assist_summarize",
          purpose_description: PURPOSE_DESCRIPTION,
          source: { id: SOURCE_ID, kind: "connector" },
          streams: [{ name: STREAM, ...(childId ? { resources: [childId] } : {}) }],
          type: "https://pdpp.dev/data-access",
        },
      ])
    );
    return url.toString();
  }

  /** Code → tokens → which record the grant covers → stored → one real read. */
  async function completeConnection(code: string, verifier: string): Promise<string> {
    const tokenResp = await fetch(`${opts.asInternal}/oauth/token`, {
      body: new URLSearchParams({
        ...client.fields(),
        code,
        code_verifier: verifier,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
      }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    const token = (await tokenResp.json()) as Record<string, unknown>;
    if (tokenResp.status !== 200 || typeof token.access_token !== "string") {
      throw new Error(`token exchange failed: HTTP ${tokenResp.status} ${String(token.error ?? "")}`);
    }
    // The grant names one child's record; the service learns its number from the RS.
    const list = await fetch(`${opts.rsInternal}/v1/streams/${STREAM}/records?limit=1`, {
      headers: { Accept: "application/json", Authorization: `Bearer ${token.access_token}` },
    });
    const listed = (await list.json()) as { data?: Array<{ data?: { child_id?: string }; key?: string }> };
    const childId = listed.data?.[0]?.data?.child_id ?? listed.data?.[0]?.key;
    if (!(list.status === 200 && typeof childId === "string" && CHILD_ID_RE.test(childId))) {
      throw new Error(`could not identify the granted record (HTTP ${list.status})`);
    }
    store.upsertChild({
      access_expires_at: typeof token.expires_in === "number" ? Date.now() + token.expires_in * 1000 : null,
      access_token: token.access_token,
      child_id: childId,
      child_index: childIndexOf(childId),
      grant_id: String(token.grant_id),
      refresh_token: typeof token.refresh_token === "string" ? token.refresh_token : null,
    });
    // A re-connected child starts fresh: clear any earlier read/erasure state.
    store.update(childIndexOf(childId), {
      deleted_at: null,
      delete_by: null,
      disposition: null,
      ended_at: null,
      erasure_effective_at: null,
      erasure_instruction_id: null,
      erasure_receipt_at: null,
      last_read_at: null,
      stop_use_by: null,
      stopped_at: null,
    });
    await connectService.runWeeklyReads();
    return childId;
  }

  function landing(lang: Lang, url: URL): string {
    const t = (es: string, en: string) => pick(lang, es, en);
    const now = clock.now();
    const connectedId = url.searchParams.get("hijo");
    const connected = connectedId && CHILD_ID_RE.test(connectedId) ? store.getChild(childIndexOf(connectedId)) : undefined;
    const result = url.searchParams.get("resultado");
    let notice = "";
    if (connected) {
      notice = `<div class="vd-alert vd-ok" role="status" data-connect-ok>${t(
        "¡Listo! Ya podemos avisarle cuando le toque la próxima vacuna.",
        "All set! We can now let you know when the next vaccine is due."
      )}</div>`;
    } else if (result === "denegado") {
      notice = `<div class="vd-alert vd-warn" role="status" data-connect-denied>${t(
        "No se autorizó el acceso, así que no recibimos ningún dato. Puede intentarlo de nuevo cuando quiera.",
        "Access was not authorized, so we received no data. You can try again whenever you like."
      )}</div>`;
    } else if (result === "error") {
      notice = `<div class="vd-alert vd-warn" role="alert">${t(
        "No pudimos completar la conexión. Inténtelo de nuevo.",
        "We could not complete the connection. Please try again."
      )}</div>`;
    }
    const connectCard = `<div class="vd-card">
<h2>${connected ? t("Conectar otro registro", "Connect another record") : t("Conecte el registro de vacunación", "Connect the vaccination record")}</h2>
<ol class="vd-steps">
  <li>${t("Entre con Cuenta Única.", "Sign in with Cuenta Única.")}</li>
  <li>${t("Elija a su hijo o hija. El Registro Civil confirma que usted puede hacerlo.", "Pick your child. The civil registry confirms you may do so.")}</li>
  <li>${t("Revise qué datos compartimos y autorice.", "Review what we receive and authorize.")}</li>
</ol>
<form method="POST" action="${BASE}/conectar" style="margin-top:16px">
  <button type="submit" class="vd-btn vd-block" data-connect>${t("Conectar con Cuenta Única", "Connect with Cuenta Única")}</button>
  <details class="vd-more"><summary>${t("¿Tiene el número de registro del niño o niña?", "Do you have the child's record number?")}</summary>
    <div class="vd-field"><label for="vd-child">${t("Número de registro (opcional)", "Record number (optional)")}</label>
    <input id="vd-child" name="child_id" placeholder="DR-0000000" pattern="DR-[0-9]{7}" autocomplete="off"></div>
    <p class="vd-note">${t(
      "Si lo indica, la solicitud será solo para ese registro y el Registro Civil verificará que usted puede autorizarlo.",
      "If you enter it, the request is for that record only and the civil registry checks that you may authorize it."
    )}</p>
  </details>
</form></div>`;
    const body = `${notice}<div class="vd-hero"><div>
<h1>${t("Le avisamos cuando a su hijo o hija le toque una vacuna.", "We remind you when your child is due for a vaccine.")}</h1>
<p class="vd-lead">${t(
      "Con su permiso, leemos el registro nacional de vacunación de su hijo o hija y le avisamos antes de cada dosis. Usted puede retirar el permiso cuando quiera.",
      "With your permission, we read your child's national vaccination record and remind you before each dose. You can withdraw permission at any time."
    )}</p>
${connected ? childCard(connected, lang, now) : ""}
</div>${connectCard}</div>`;
    return shell({ body, currentUrl: currentUrl(url), lang, page: "home", title: `${CLIENT_NAME} · ${t("Recordatorios de vacunas", "Vaccine reminders")}` });
  }

  async function panel(lang: Lang, url: URL): Promise<string> {
    const t = (es: string, en: string) => pick(lang, es, en);
    // What the service knows now: lifecycle answers, then any deletion they require.
    await panelService.runStatusChecks().catch(() => undefined);
    await panelService.runDeletionSweep().catch(() => undefined);
    const now = clock.now();
    const rows = store.db.prepare("SELECT * FROM children ORDER BY child_index").all() as ChildRow[];
    const totals = store.totals();
    const c = counters().counters as Record<string, number>;
    const stat = (n: number, label: string, key: string) =>
      `<div class="vd-stat" data-stat="${key}"><b>${n}</b><span>${label}</span></div>`;
    const stats = `<div class="vd-stats">
${stat(totals.children_active ?? 0, t("niños con autorización activa", "children with an active authorization"), "active")}
${stat(totals.records_received ?? 0, t("lecturas recibidas del registro", "reads received from the register"), "reads")}
${stat(c.denied ?? 0, t("lecturas rechazadas (desde el último reinicio)", "reads refused (since last restart)"), "denied")}
${stat(totals.payments_accepted ?? 0, t(`pagos por lectura aceptados (${payer.name})`, `per-read payments accepted (${payer.name})`), "payments")}
</div>`;
    const rowsHtml = rows.length
      ? rows
          .map((row) => {
            const record = parseRecord(row.last_record_json);
            const due = row.status === "deleted" ? null : nextDose(record, now);
            const label = STATUS_LABEL[row.status] ?? [row.status, row.status];
            const dueText = due
              ? `${esc(vaccineName(due.vaccine, lang))} ${due.dose_number}<small>${esc(formatDay(due.due_date, lang))}${due.status === "overdue" ? ` · ${t("atrasada", "overdue")}` : ""}</small>`
              : row.status === "deleted"
                ? `—<small>${t("datos borrados", "data deleted")}</small>`
                : record
                  ? t("Al día", "Up to date")
                  : "—";
            return `<tr data-child-row="${esc(row.child_id)}" data-status="${esc(row.status)}">
<td data-label="${t("Registro", "Record")}">${esc(row.child_id)}<small>${record ? `${t("nac.", "born")} ${esc(formatDay(record.birth_date, lang))}` : ""}</small></td>
<td data-label="${t("Autorización", "Authorization")}"><span class="vd-pill" data-status="${esc(row.status)}">${esc(pick(lang, label[0], label[1]))}</span></td>
<td data-label="${t("Última lectura", "Last read")}">${esc(formatMoment(row.last_read_at, lang))}<small>${row.received_count} ${row.received_count === 1 ? t("lectura", "read") : t("lecturas", "reads")}</small></td>
<td data-label="${t("Próxima dosis", "Next dose")}">${dueText}</td></tr>`;
          })
          .join("")
      : `<tr><td colspan="4">${t("Todavía no hay niños conectados. Empiece desde Inicio.", "No children connected yet. Start from Home.")}</td></tr>`;
    const payments = store.db
      .prepare(
        `SELECT p.read_id, p.amount, p.status, p.response_json, p.created_at, c.child_id
           FROM payments p LEFT JOIN children c ON c.child_index = p.child_index
          ORDER BY p.created_at DESC LIMIT 12`
      )
      .all() as Array<{ amount: string; child_id: string | null; created_at: number; read_id: string; response_json: string | null; status: string }>;
    const paymentRows = payments
      .map((p) => {
        const hash = txHashOf(p.response_json);
        const settled = hash
          ? `<a href="${esc(`${explorerTxBase()}${hash}`)}" target="_blank" rel="noopener" data-tx>${esc(`${hash.slice(0, 10)}…`)}</a>`
          : payer.name === "mock"
            ? t("simulado (sin transacción)", "simulated (no transaction)")
            : p.status === "accepted"
            ? t("aceptado, sin transacción todavía", "accepted, no transaction yet")
            : p.status === "pending"
              ? t("pendiente", "pending")
              : t("rechazado", "rejected");
        return `<tr data-payment="${esc(p.read_id)}" data-status="${esc(p.status)}">
<td data-label="${t("Lectura", "Read")}">${esc(`${p.read_id.slice(0, 10)}…`)}<small>${esc(p.child_id ?? "")}</small></td>
<td data-label="${t("Monto", "Amount")}">${esc(formatVana(p.amount))}</td>
<td data-label="${t("Cuándo", "When")}">${esc(formatMoment(p.created_at, lang))}</td>
<td data-label="${t("Liquidación", "Settlement")}">${settled}</td></tr>`;
      })
      .join("");
    const paymentsTable = payments.length
      ? `<h2 style="font-size:18px;margin:28px 0 10px">${t("Pagos por lectura", "Per-read payments")}</h2>
<table class="vd-table"><thead><tr><th>${t("Lectura", "Read")}</th><th>${t("Monto", "Amount")}</th><th>${t("Cuándo", "When")}</th><th>${t("Liquidación", "Settlement")}</th></tr></thead><tbody>${paymentRows}</tbody></table>`
      : "";
    const ranRead = url.searchParams.get("leido") === "1";
    const body = `<div class="vd-toolbar"><h1>${t("Panel del servicio", "Service dashboard")}</h1>
<form method="POST" action="${BASE}/panel/leer"><button type="submit" class="vd-btn vd-secondary" data-read-now>${t("Leer ahora todos los registros activos", "Read all active records now")}</button></form></div>
${ranRead ? `<div class="vd-alert vd-ok" role="status">${t("Lectura completada.", "Read cycle finished.")}</div>` : ""}
<p class="vd-note" style="margin:0 0 16px">${t(
      "Esto es lo que ve «Vacuna al día»: un número de registro por niño, sin nombres. Al abrir esta página el servicio consulta el estado de cada autorización; si una madre o padre la retiró y pidió borrar, los datos se borran aquí.",
      "This is what “Vacuna al día” sees: one record number per child, no names. Opening this page makes the service check each authorization; if a parent withdrew it and asked for deletion, the data is deleted here."
    )}</p>
${stats}
<table class="vd-table"><thead><tr><th>${t("Registro", "Record")}</th><th>${t("Autorización", "Authorization")}</th><th>${t("Última lectura", "Last read")}</th><th>${t("Próxima dosis", "Next dose")}</th></tr></thead>
<tbody>${rowsHtml}</tbody></table>
${paymentsTable}
<p class="vd-note">${t(
      `Pagos: ${payer.name === "mock" ? "simulados (no se mueve dinero)" : "pasarela de datos de Vana (Moksha)"} · recibos de lectura verificados: ${c.receiptsVerified ?? 0} · lecturas intentadas: ${c.readsAttempted ?? 0}`,
      `Payments: ${payer.name === "mock" ? "simulated (no money moves)" : "Vana data gateway (Moksha)"} · read receipts verified: ${c.receiptsVerified ?? 0} · reads attempted: ${c.readsAttempted ?? 0}`
    )}</p>`;
    return shell({ body, currentUrl: currentUrl(url), lang, page: "panel", title: `${CLIENT_NAME} · ${t("Panel", "Dashboard")}` });
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", opts.publicOrigin);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method ?? "GET";
    if (method === "GET" && path === BASE) {
      html(res, landing(langFor(req, url, res), url));
      return;
    }
    if (method === "POST" && path === `${BASE}/conectar`) {
      const form = await readForm(req);
      const raw = (form.get("child_id") ?? "").trim().toUpperCase();
      const childId = CHILD_ID_RE.test(raw) ? raw : null;
      redirect(res, authorizeUrl(childId));
      return;
    }
    if (method === "GET" && path === `${BASE}/callback`) {
      const state = url.searchParams.get("state") ?? "";
      const entry = pending.get(state);
      pending.delete(state);
      if (url.searchParams.get("error")) {
        redirect(res, `${BASE}?resultado=denegado`);
        return;
      }
      const code = url.searchParams.get("code");
      if (!(entry && code)) {
        redirect(res, `${BASE}?resultado=error`);
        return;
      }
      try {
        const childId = await completeConnection(code, entry.verifier);
        redirect(res, `${BASE}?hijo=${encodeURIComponent(childId)}`);
      } catch (err) {
        console.error("reminder connect failed:", (err as Error).message);
        redirect(res, `${BASE}?resultado=error`);
      }
      return;
    }
    if (method === "GET" && path === `${BASE}/panel`) {
      html(res, await panel(langFor(req, url, res), url));
      return;
    }
    if (method === "GET" && path === `${BASE}/panel.json`) {
      res.writeHead(200, { "Cache-Control": "no-store", "Content-Type": "application/json" });
      res.end(JSON.stringify({ ...counters(), client_id: clientState.clientId }));
      return;
    }
    if (method === "POST" && path === `${BASE}/panel/leer`) {
      await panelService.runWeeklyReads();
      redirect(res, `${BASE}/panel?leido=1`);
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }

  return {
    clientId: clientState.clientId,
    close: () => store.close(),
    handle,
    store,
  };
}

function isLoopback(url: string): boolean {
  const host = new URL(url).hostname;
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

/**
 * Hook for the Moksha registration (scripts/demo-dr-vacuna/moksha/): a
 * KEY=VALUE file with the non-secret on-chain settings it produced (contract
 * addresses, data owner, data point scope). Values already in the
 * environment win; private keys belong in secrets, not in this file.
 */
export function loadPayerEnvFile(path: string | undefined): void {
  if (!(path && existsSync(path))) {
    return;
  }
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match || line.trim().startsWith("#")) {
      continue;
    }
    const [, key, value] = match as unknown as [string, string, string];
    if (/PRIVATE_KEY/.test(key)) {
      throw new Error(`${path} must not hold ${key}; set it as a secret`);
    }
    process.env[key] ??= value.replace(/^["']|["']$/g, "");
  }
}

/** VACUNA_PAYER=mock (default) records payments locally; =http pays through the data gateway (see DEPLOY.md). */
function buildPayer(store: ReminderStore): GatewayPayer {
  loadPayerEnvFile(process.env.VACUNA_PAYER_ENV_FILE);
  const env = process.env;
  const kind = env.VACUNA_PAYER || "mock";
  if (kind === "mock") {
    return new MockPayer();
  }
  if (kind !== "http") {
    throw new Error(`unknown VACUNA_PAYER ${kind}`);
  }
  const required = (name: string): string => {
    const v = env[name];
    if (!v) {
      throw new Error(`VACUNA_PAYER=http needs ${name}`);
    }
    return v;
  };
  const gatewayUrl = required("VACUNA_GATEWAY_URL");
  if (!(isLoopback(gatewayUrl) || env.VACUNA_ALLOW_REMOTE_GATEWAY === "1")) {
    throw new Error("refusing a non-loopback gateway without VACUNA_ALLOW_REMOTE_GATEWAY=1");
  }
  return new HttpGatewayPayer({
    config: {
      amountWei: env.VACUNA_PAYMENT_AMOUNT_WEI || ONE_HUNDREDTH_VANA_WEI,
      asset: env.VACUNA_PAYMENT_ASSET || NATIVE_ASSET,
      builderPrivateKey: required("VACUNA_BUILDER_PRIVATE_KEY") as `0x${string}`,
      chainId: BigInt(required("VACUNA_CHAIN_ID")),
      dataOwnerAddress: required("VACUNA_DATA_OWNER_ADDRESS"),
      dataPointScope: env.VACUNA_DATA_POINT_SCOPE || "dr.vacuna.child_immunizations",
      dataPointVersion: BigInt(env.VACUNA_DATA_POINT_VERSION || "1"),
      dataRegistryContract: required("VACUNA_DATA_REGISTRY_CONTRACT"),
      escrowContract: required("VACUNA_ESCROW_CONTRACT"),
      gatewayUrl,
      registerServerPrivateKey: required("VACUNA_REGISTER_SERVER_PRIVATE_KEY") as `0x${string}`,
    },
    nextNonce: () => store.nextPaymentNonce(),
  });
}
