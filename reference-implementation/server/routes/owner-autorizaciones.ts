// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// DR demo: "Mis autorizaciones", the citizen's own view of what they allowed,
// what was read and when, with a revoke button per active authorization.
// A simulated view of how this could look in Soy Yo RD, not Soy Yo RD itself.
//
//   GET  /owner/autorizaciones                    owner session, else /owner/login
//   POST /owner/autorizaciones/:grantId/revocar   owner session + CSRF
//        └─ revokes (whole package when one consent made several grants)
//           then 303 → /owner/autorizaciones?revocada=1
//
//   ┌ header card: Mis autorizaciones · subtitle · [revoked banner] ┐
//   ├ card[data-grant-id]: app · status badge                       │
//   │   Para qué · Datos (source → stream → field chips) · Hasta    │
//   │   Lo que se leyó: time · stream, newest first                 │
//   │   [ Revocar ]  (active only)                                  │
//   └───────────────────────────────────────────────────────────────┘

import {
  type CitizenAuthorization,
  type CitizenGrantStatus,
  type CitizenGrantsDeps,
  type CitizenRevokeDeps,
  listCitizenAuthorizations,
  revokeCitizenAuthorization,
} from "../citizen-grants.ts";
import { CITIZEN_GLYPHS, renderCitizenCard, renderCitizenDocument } from "../citizen-ui.ts";
import { type DemoLang, pickLang, resolveDemoLang } from "../demo-i18n.ts";
import type { MiddlewareHandler } from "./_route-contract.ts";

interface RouteRequest {
  headers: { cookie?: string | string[] | undefined };
  params?: Record<string, string>;
  query?: Record<string, unknown>;
}

interface RouteResponse {
  redirect: (statusOrUrl: number | string, url?: string) => unknown;
  send: (body: string) => unknown;
  setHeader: (name: string, value: string) => unknown;
  status: (code: number) => RouteResponse;
}

type RouteHandler = (req: RouteRequest, res: RouteResponse) => Promise<void>;

interface AppLike {
  get: (path: string, ...handlers: (MiddlewareHandler | RouteHandler)[]) => unknown;
  post: (path: string, ...handlers: (MiddlewareHandler | RouteHandler)[]) => unknown;
}

export interface MountOwnerAutorizacionesContext extends CitizenGrantsDeps, CitizenRevokeDeps {
  ensureCsrfToken: (req: RouteRequest, res: RouteResponse) => string;
  handleError: (res: unknown, err: unknown) => void;
  logger?: { warn?: (obj: Record<string, unknown>, msg: string) => void };
  renderCsrfField: (token: string) => string;
  requireCsrf: MiddlewareHandler;
  requireOwnerSession: MiddlewareHandler;
}

export const AUTORIZACIONES_PATH = "/owner/autorizaciones";
const REVOKED_QUERY = "revocada";
const HTTP_SEE_OTHER = 303;
const DR_TIME_ZONE = "America/Santo_Domingo";
// Enough to show the pattern of reads without an endless list.
const MAX_READS_SHOWN = 20;

// Demo sources: stream and field names in plain language. Unknown keys fall
// back to the key with underscores as spaces.
const STREAM_LABELS: Record<string, readonly [string, string]> = {
  clasificacion_hogar: ["Clasificación socioeconómica del hogar", "Household socio-economic classification"],
  control_prenatal: ["Control prenatal", "Prenatal care"],
  licencias_conducir: ["Licencia de conducir", "Driving licence"],
  miembros_hogar: ["Miembros del hogar", "Household members"],
};
const FIELD_LABELS: Record<string, readonly [string, string]> = {
  categoria: ["Categoría", "Category"],
  cedula: ["Cédula", "Cédula (ID number)"],
  cedula_jefe_hogar: ["Cédula del jefe del hogar", "Head of household's cédula"],
  centro_salud: ["Centro de salud", "Health centre"],
  controles_prenatales: ["Controles prenatales", "Prenatal check-ups"],
  edad: ["Edad", "Age"],
  estado: ["Estado", "Status"],
  fecha_expedicion: ["Fecha de expedición", "Issue date"],
  fecha_probable_parto: ["Fecha probable de parto", "Expected due date"],
  fecha_ultima_consulta: ["Última consulta", "Last check-up"],
  fecha_ultima_visita: ["Última visita", "Last visit"],
  fecha_vencimiento: ["Fecha de vencimiento", "Expiry date"],
  grupo_sanguineo: ["Grupo sanguíneo", "Blood group"],
  hogar_id: ["Identificador del hogar", "Household identifier"],
  icv_descripcion: ["Descripción ICV", "ICV description"],
  icv_grupo: ["Grupo ICV", "ICV group"],
  icv_puntaje: ["Puntaje ICV", "ICV score"],
  id: ["Identificador", "Identifier"],
  miembros_hogar: ["Miembros del hogar", "Household members"],
  municipio: ["Municipio", "Municipality"],
  nivel_educativo: ["Nivel educativo", "Education level"],
  nombre: ["Nombre", "Name"],
  nombre_jefe_hogar: ["Nombre del jefe del hogar", "Head of household's name"],
  numero_licencia: ["Número de licencia", "Licence number"],
  ocupacion: ["Ocupación", "Occupation"],
  parentesco: ["Parentesco", "Relationship"],
  programas_activos: ["Programas activos", "Active programmes"],
  provincia: ["Provincia", "Province"],
  restricciones: ["Restricciones", "Restrictions"],
  riesgo_obstetrico: ["Riesgo obstétrico", "Obstetric risk"],
  semanas_gestacion: ["Semanas de gestación", "Weeks of pregnancy"],
  sexo: ["Sexo", "Sex"],
  source_updated_at: ["Última actualización", "Last updated"],
  tipo_sangre: ["Tipo de sangre", "Blood type"],
  vacunas_embarazo: ["Vacunas del embarazo", "Pregnancy vaccines"],
};
// Requester purposes shown in English on EN pages (the grant stores Spanish).
const PURPOSE_EN: Record<string, string> = {
  "https://map.gob.do/purpose/servicios-proactivos-nacimiento":
    "Prepare your baby's vaccinations and the child benefit at birth, without you having to apply.",
};
const STATUS_LABELS: Record<CitizenGrantStatus, readonly [string, string]> = {
  active: ["Vigente", "Active"],
  expired: ["Vencida", "Expired"],
  revoked: ["Revocada", "Revoked"],
};

const PAGE_CSS = `
.cu-grants { display: grid; gap: 18px; margin-top: 18px; }
.cu-grant-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 16px 25px;
  background: var(--cu-card-head); border-bottom: 1px solid var(--cu-card-head-border); border-radius: 10px 10px 0 0; }
.cu-grant-head h2 { margin: 0; font-size: 16px; font-weight: 600; color: var(--cu-primary); }
.cu-badge { font-size: 12px; font-weight: 600; border-radius: 60px; padding: 3px 12px; white-space: nowrap; }
.cu-badge[data-status="active"] { background: #E6F4EA; color: #1E6B34; border: 1px solid #A8D5B5; }
.cu-badge[data-status="revoked"] { background: #FDECEA; color: var(--cu-danger); border: 1px solid #F5C2C0; }
.cu-badge[data-status="expired"] { background: #F1F1F1; color: var(--cu-text-muted); border: 1px solid var(--cu-card-border); }
.cu-subhead { margin: 0 0 8px; font-size: 14px; font-weight: 600; color: var(--cu-primary); }
.cu-reads { list-style: none; margin: 0 0 22px; padding: 0; border: 1px solid var(--cu-card-border); border-radius: 8px; }
.cu-reads li { display: grid; grid-template-columns: 170px 1fr; gap: 12px; padding: 9px 14px; font-size: 13px; border-top: 1px solid #EEF0F2; }
.cu-reads li:first-child { border-top: 0; }
.cu-reads time { color: var(--cu-text-muted); }
.cu-reads-empty { margin: 0 0 22px; font-size: 13px; color: var(--cu-text-muted); }
.cu-ok { background: #E6F4EA; border: 1px solid #A8D5B5; color: #1E6B34; border-radius: 8px; padding: 10px 14px; margin: 0 0 18px; font-size: 13px; font-weight: 500; }
@media (max-width: 720px) { .cu-reads li { grid-template-columns: 1fr; gap: 2px; } }
`;

function escapeHtml(input: unknown): string {
  return String(input ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function humanize(labels: Record<string, readonly [string, string]>, key: string, lang: DemoLang): string {
  const known = labels[key];
  if (known) {
    return pickLang(lang, known[0], known[1]);
  }
  const text = key.replace(/[_-]+/g, " ").trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function formatDate(iso: string, lang: DemoLang, style: Intl.DateTimeFormatOptions): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return new Intl.DateTimeFormat(lang === "en" ? "en-US" : "es-DO", { ...style, timeZone: DR_TIME_ZONE }).format(date);
}

const DATE_LONG: Intl.DateTimeFormatOptions = { dateStyle: "long" };
const DATE_TIME: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "short" };

function renderSources(auth: CitizenAuthorization, lang: DemoLang): string {
  const items = auth.sources.flatMap((source) =>
    source.streams.map((stream) => {
      const chips = stream.fields
        .map((field) => `<span class="cu-chip">${escapeHtml(humanize(FIELD_LABELS, field, lang))}</span>`)
        .join("");
      return `<li><b>${escapeHtml(humanize(STREAM_LABELS, stream.name, lang))}</b><small>${escapeHtml(source.name)}</small><div class="cu-chips">${chips}</div></li>`;
    })
  );
  return `<ul class="cu-streams">${items.join("")}</ul>`;
}

function renderReads(auth: CitizenAuthorization, lang: DemoLang): string {
  const t = (es: string, en: string) => pickLang(lang, es, en);
  const heading = `<h3 class="cu-subhead">${t("Lo que se leyó", "What was read")}</h3>`;
  if (!auth.reads.length) {
    return `${heading}<p class="cu-reads-empty">${t("Todavía no se ha leído nada.", "Nothing has been read yet.")}</p>`;
  }
  const shown = auth.reads
    .slice(0, MAX_READS_SHOWN)
    .map(
      (read) =>
        `<li data-read-stream="${escapeHtml(read.stream)}"><time datetime="${escapeHtml(read.at)}">${escapeHtml(
          formatDate(read.at, lang, DATE_TIME)
        )}</time><span>${escapeHtml(humanize(STREAM_LABELS, read.stream, lang))}</span></li>`
    );
  const more = auth.reads.length - shown.length;
  const moreNote =
    more > 0 ? `<li><span></span><span>${t(`y ${more} lecturas más`, `and ${more} more reads`)}</span></li>` : "";
  return `${heading}<ol class="cu-reads">${shown.join("")}${moreNote}</ol>`;
}

function renderUntil(auth: CitizenAuthorization, lang: DemoLang): string {
  if (!auth.expiresAt) {
    return pickLang(lang, "Sin fecha de fin", "No end date");
  }
  const date = formatDate(auth.expiresAt, lang, DATE_LONG);
  return pickLang(lang, `Hasta el ${date}`, `Until ${date}`);
}

function renderRevokeForm(auth: CitizenAuthorization, csrfField: string, lang: DemoLang): string {
  const grantId = auth.grantIds[0] ?? "";
  const action = `${AUTORIZACIONES_PATH}/${encodeURIComponent(grantId)}/revocar`;
  return `<form method="POST" action="${escapeHtml(action)}">${csrfField}<button type="submit" class="cu-btn cu-outline-danger cu-block">${pickLang(lang, "Revocar", "Revoke")}</button></form>`;
}

function renderAuthorization(auth: CitizenAuthorization, csrfField: string, lang: DemoLang): string {
  const t = (es: string, en: string) => pickLang(lang, es, en);
  const [statusEs, statusEn] = STATUS_LABELS[auth.status];
  const purpose =
    lang === "en" && auth.purposeCode && PURPOSE_EN[auth.purposeCode]
      ? PURPOSE_EN[auth.purposeCode]
      : (auth.purposeDescription ?? auth.purposeCode ?? "");
  const revokedRow = auth.revokedAt
    ? `<div><dt>${t("Revocada el", "Revoked on")}</dt><dd>${escapeHtml(formatDate(auth.revokedAt, lang, DATE_TIME))}</dd></div>`
    : "";
  const summary = `<dl class="cu-summary">
  <div><dt>${t("Para qué", "What for")}</dt><dd>${escapeHtml(purpose)}</dd></div>
  <div><dt>${t("Qué datos", "What data")}</dt><dd>${renderSources(auth, lang)}</dd></div>
  <div><dt>${t("Hasta cuándo", "Until when")}</dt><dd>${escapeHtml(renderUntil(auth, lang))}</dd></div>
  <div><dt>${t("Autorizada el", "Allowed on")}</dt><dd>${escapeHtml(formatDate(auth.issuedAt, lang, DATE_TIME))}</dd></div>
  ${revokedRow}
</dl>`;
  const action = auth.status === "active" ? renderRevokeForm(auth, csrfField, lang) : "";
  return `<article class="cu-card" data-grant-id="${escapeHtml(auth.grantIds[0])}" data-grant-ids="${escapeHtml(auth.grantIds.join(" "))}" data-grant-status="${auth.status}">
  <div class="cu-grant-head"><h2>${escapeHtml(auth.clientName)}</h2><span class="cu-badge" data-status="${auth.status}">${pickLang(lang, statusEs, statusEn)}</span></div>
  <div class="cu-card-body">${summary}${renderReads(auth, lang)}${action}</div>
</article>`;
}

function renderPage(auths: CitizenAuthorization[], csrfField: string, lang: DemoLang, revoked: boolean): string {
  const t = (es: string, en: string) => pickLang(lang, es, en);
  const banner = revoked
    ? `<div class="cu-ok" role="status" data-revoke-banner>${t(
        "Autorización revocada. Esa entidad ya no puede leer sus datos.",
        "Authorization revoked. That organisation can no longer read your data."
      )}</div>`
    : "";
  const intro = `${banner}<p class="cu-text">${t(
    "Aquí ve a quién permitió consultar sus datos, qué se leyó y cuándo. Puede revocar un permiso en cualquier momento.",
    "Here you see who you allowed to look at your data, what was read and when. You can revoke a permission at any time."
  )}</p><p class="cu-note">${t(
    "Vista simulada de cómo podría verse en Soy Yo RD",
    "Simulated view of how this could look in Soy Yo RD"
  )}</p>`;
  const header = renderCitizenCard({
    body: intro,
    glyph: CITIZEN_GLYPHS.shield,
    title: t("Mis autorizaciones", "My authorizations"),
  });
  const cards = auths.length
    ? auths.map((auth) => renderAuthorization(auth, csrfField, lang)).join("\n")
    : `<p class="cu-text">${t("Todavía no ha autorizado a ninguna entidad.", "You have not authorized anyone yet.")}</p>`;
  return `<style>${PAGE_CSS}</style>${header}<section class="cu-grants" aria-label="${t("Autorizaciones", "Authorizations")}">${cards}</section>`;
}

export function mountOwnerAutorizaciones(app: AppLike, ctx: MountOwnerAutorizacionesContext): void {
  app.get(AUTORIZACIONES_PATH, ctx.requireOwnerSession, async (req: RouteRequest, res: RouteResponse) => {
    const lang = resolveDemoLang(req);
    let auths: CitizenAuthorization[];
    try {
      auths = await listCitizenAuthorizations(ctx);
    } catch (err) {
      ctx.handleError(res, err);
      return;
    }
    const csrfField = ctx.renderCsrfField(ctx.ensureCsrfToken(req, res));
    const revoked = req.query?.[REVOKED_QUERY] === "1";
    const currentUrl = revoked ? `${AUTORIZACIONES_PATH}?${REVOKED_QUERY}=1` : AUTORIZACIONES_PATH;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.status(200).send(
      renderCitizenDocument({
        body: renderPage(auths, csrfField, lang, revoked),
        currentUrl,
        lang,
        shell: "citizen-grants",
        title: pickLang(lang, "Mis autorizaciones (simulación)", "My authorizations (simulation)"),
      })
    );
  });

  app.post(
    `${AUTORIZACIONES_PATH}/:grantId/revocar`,
    ctx.requireOwnerSession,
    ctx.requireCsrf,
    async (req: RouteRequest, res: RouteResponse) => {
      const grantId = req.params?.grantId ?? "";
      try {
        await revokeCitizenAuthorization(ctx, grantId);
      } catch (err) {
        // Already revoked or unknown: the page shows the current state.
        ctx.logger?.warn?.({ err: String((err as Error)?.message ?? err), grantId }, "citizen revoke failed");
        res.redirect(HTTP_SEE_OTHER, AUTORIZACIONES_PATH);
        return;
      }
      res.redirect(HTTP_SEE_OTHER, `${AUTORIZACIONES_PATH}?${REVOKED_QUERY}=1`);
    }
  );
}
