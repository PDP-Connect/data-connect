// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pilot pages in the September demo's citizen shell (citizen-ui.ts), one
// language per page (Spanish default, ?lang=en toggle; i18n.ts).
//
//   landingPage        signed-out explanation + start
//   loginPage          Cuenta Única sign-in (stub)
//   pickChildPage      which child (from the civil registry) / named record
//   reviewPage         "Usted está actuando como …", fields, purpose, expiry
//   resultPage         approved / declined / refused by the registry
//   authorizationsPage "Mis autorizaciones", grouped by child, revoke keep|delete
//   errorPage

import type { GuardianCapacity } from "./config.ts";
import { PILOT_PATHS } from "./config.ts";
import { CITIZEN_GLYPHS, escapeText as esc, renderCitizenCard, renderCitizenDocument } from "./citizen-ui.ts";
import { formatCedula, type ParentSession } from "./cuenta-unica-stub.ts";
import { type Lang, pick } from "./i18n.ts";
import type { RegistryChild } from "./registry-stub.ts";
import type { RepresentativeGrantRow } from "./store.ts";

export { esc };

const CAPACITY_LABEL: Record<GuardianCapacity, { en: string; es: string }> = {
  legal_guardian: { en: "legal guardian", es: "tutor o tutora legal" },
  parent: { en: "parent", es: "madre o padre" },
};

export function capacityLabel(capacity: GuardianCapacity): { en: string; es: string } {
  return CAPACITY_LABEL[capacity] ?? { en: capacity, es: capacity };
}

/** Plain-language names for the record fields the reminder stream can share. */
const FIELD_LABELS: Record<string, readonly [string, string]> = {
  birth_date: ["Fecha de nacimiento", "Date of birth"],
  child_id: ["Número de registro", "Record number"],
  doses: ["Vacunas aplicadas (vacuna, dosis, fecha, centro)", "Vaccines given (vaccine, dose, date, centre)"],
  next_dose_due: ["Próxima dosis pendiente", "Next dose due"],
  updated_at: ["Fecha de actualización del registro", "Record last updated"],
};

/** Requester purposes shown in English on EN pages (the request carries Spanish). */
const PURPOSE_EN: Record<string, string> = {
  "Enviarle un recordatorio cuando a su hijo o hija le toque una vacuna.":
    "Send you a reminder when your child is due for a vaccine.",
  "Recordatorios de vacunación": "Vaccination reminders",
  "Recordatorios de vacunación para un niño o niña": "Vaccination reminders for a child",
};

const DR_TIME_ZONE = "America/Santo_Domingo";

function locale(lang: Lang): string {
  return lang === "en" ? "en-US" : "es-DO";
}

/** Calendar date (birthdays, expiry at the 18th birthday): read in UTC so the day never shifts. */
function formatDay(iso: string | null, lang: Lang): string {
  if (!iso) {
    return "—";
  }
  const date = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return new Intl.DateTimeFormat(locale(lang), { dateStyle: "long", timeZone: "UTC" }).format(date);
}

/** A moment (approved, withdrawn): Santo Domingo time. */
function formatMoment(iso: string | null, lang: Lang): string {
  if (!iso) {
    return "—";
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return new Intl.DateTimeFormat(locale(lang), { dateStyle: "long", timeStyle: "short", timeZone: DR_TIME_ZONE }).format(
    date
  );
}

/** "8 meses" / "3 años" / "8 months" / "3 years". */
export function ageLabel(birthDate: string, lang: Lang, now = Date.now()): string {
  const birth = new Date(`${birthDate}T00:00:00Z`);
  const today = new Date(now);
  let months = (today.getUTCFullYear() - birth.getUTCFullYear()) * 12 + (today.getUTCMonth() - birth.getUTCMonth());
  if (today.getUTCDate() < birth.getUTCDate()) {
    months -= 1;
  }
  months = Math.max(0, months);
  if (months < 1) {
    return pick(lang, "recién nacido/a", "newborn");
  }
  if (months < 24) {
    return lang === "en" ? `${months} month${months === 1 ? "" : "s"}` : `${months} ${months === 1 ? "mes" : "meses"}`;
  }
  const years = Math.floor(months / 12);
  return lang === "en" ? `${years} years` : `${years} años`;
}

function purposeText(purpose: string | null, lang: Lang): string {
  const fallback = pick(lang, "Recordatorios de vacunación", "Vaccination reminders");
  if (!purpose) {
    return fallback;
  }
  return lang === "en" ? (PURPOSE_EN[purpose] ?? purpose) : purpose;
}

function fieldChips(fields: string[], lang: Lang): string {
  const chips = fields.map((field) => {
    const label = FIELD_LABELS[field];
    return `<span class="cu-chip" data-field="${esc(field)}">${esc(label ? pick(lang, label[0], label[1]) : field)}</span>`;
  });
  return `<div class="cu-chips">${chips.join("")}</div>`;
}

function csrfField(session: ParentSession): string {
  return `<input type="hidden" name="csrf_token" value="${esc(session.csrfToken)}">`;
}

function navFor(session: ParentSession | null | undefined, lang: Lang): string {
  const t = (es: string, en: string) => pick(lang, es, en);
  if (!session) {
    return "";
  }
  return `<div class="cu-who"><span><b>${esc(session.displayName)}</b> · ${esc(formatCedula(session.cedula))}</span>
  <a href="${PILOT_PATHS.authorizations}">${t("Mis autorizaciones", "My authorizations")}</a>
  <form method="POST" action="${PILOT_PATHS.logout}">${csrfField(session)}<button type="submit" class="cu-linkbtn">${t("Salir", "Sign out")}</button></form></div>`;
}

interface PageOptions {
  body: string;
  currentUrl: string;
  lang: Lang;
  script?: string;
  session?: ParentSession | null;
  shell: Parameters<typeof renderCitizenDocument>[0]["shell"];
  title: string;
}

function page(opts: PageOptions): string {
  return renderCitizenDocument({
    body: opts.body,
    currentUrl: opts.currentUrl,
    lang: opts.lang,
    navAction: navFor(opts.session, opts.lang),
    script: opts.script ?? "",
    shell: opts.shell,
    title: opts.title,
  });
}

// ─── landing ────────────────────────────────────────────────────────────────

export function landingPage(input: {
  currentUrl: string;
  lang: Lang;
  session: ParentSession | null;
  startUrl: string | null;
}): string {
  const { lang } = input;
  const t = (es: string, en: string) => pick(lang, es, en);
  const start = input.startUrl
    ? `<a class="cu-btn cu-block" data-start href="${esc(input.startUrl)}">${t("Empezar la demostración", "Start the demo")}</a>`
    : "";
  const dashboard = input.startUrl
    ? `<p class="cu-note" style="text-align:center;margin-top:14px"><a class="cu-link" href="${esc(`${input.startUrl.replace(/\/$/, "")}/panel`)}">${t(
        "Ver lo que ve el servicio de recordatorios",
        "See what the reminder service sees"
      )}</a></p>`
    : "";
  const body = `<p class="cu-text" data-landing-intro>${t(
    "Una madre, padre o tutor entra con Cuenta Única y autoriza a «Vacuna al día», un servicio de recordatorios, a leer el registro de vacunación de su hijo o hija; antes, el Registro Civil confirma que esa persona puede actuar por ese niño.",
    "A parent or guardian signs in with Cuenta Única and allows “Vacuna al día”, a reminder service, to read their child's vaccination record; first, the civil registry confirms that this person may act for that child."
  )}</p><p class="cu-text">${t(
    "Después puede ver y retirar esa autorización en «Mis autorizaciones», y decidir si el servicio conserva o borra lo que ya recibió.",
    "Afterwards they can see and withdraw that authorization in “My authorizations”, and decide whether the service keeps or deletes what it already received."
  )}</p>
<div class="cu-actions">${start}<a class="cu-btn cu-outline cu-block" href="${PILOT_PATHS.authorizations}">${t("Mis autorizaciones", "My authorizations")}</a></div>${dashboard}`;
  return page({
    body: renderCitizenCard({
      body,
      glyph: CITIZEN_GLYPHS.shield,
      title: t("Vacuna al día: piloto de autorización", "Vacuna al día: authorization pilot"),
    }),
    currentUrl: input.currentUrl,
    lang,
    session: input.session,
    shell: "landing",
    title: t("Vacuna al día · piloto (demostración)", "Vacuna al día · pilot (demo)"),
  });
}

// ─── sign-in ────────────────────────────────────────────────────────────────

// Cédula mask (000-0000000-0) and password show/hide, as in the September demo.
const LOGIN_PAGE_SCRIPT = `(function () {
  var cedula = document.getElementById("cu-cedula");
  if (cedula) {
    cedula.addEventListener("input", function () {
      var d = cedula.value.replace(/\\D/g, "").slice(0, 11);
      var out = d.slice(0, 3);
      if (d.length > 3) out += "-" + d.slice(3, 10);
      if (d.length > 10) out += "-" + d.slice(10);
      cedula.value = out;
    });
  }
  var toggle = document.getElementById("cu-toggle-password");
  var pw = document.getElementById("cu-password");
  if (toggle && pw) {
    toggle.addEventListener("click", function () {
      var show = pw.type === "password";
      pw.type = show ? "text" : "password";
      toggle.setAttribute("aria-label", toggle.getAttribute(show ? "data-label-hide" : "data-label-show"));
      toggle.setAttribute("aria-pressed", String(show));
    });
  }
})();`;

const EYE_ICON = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>`;
const ARROW_ICON = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="m12 16 4-4-4-4M8 12h8"/></svg>`;

export function loginPage(input: {
  clientName: string | null;
  currentUrl: string;
  error: boolean;
  lang: Lang;
  returnTo: string;
}): string {
  const { lang } = input;
  const t = (es: string, en: string) => pick(lang, es, en);
  const continueTo = input.clientName
    ? `${t("Continuará a", "You will continue to")} <b>${esc(input.clientName)}</b>`
    : t("Continuará a sus autorizaciones", "You will continue to your authorizations");
  const error = input.error
    ? `<div class="cu-error" role="alert">${t("La cédula o la contraseña no son correctas.", "The cédula or the password is not correct.")}</div>`
    : "";
  const body = `<div class="cu-client">${CITIZEN_GLYPHS.home}<span>${continueTo}</span></div>
<p class="cu-lead">${t("Inicie sesión con su número de cédula y contraseña.", "Sign in with your cédula number and password.")}</p>
<form method="POST" action="${PILOT_PATHS.login}" aria-label="${t("Inicio de sesión", "Sign in")}">
  <input type="hidden" name="return_to" value="${esc(input.returnTo)}">
  ${error}
  <div class="cu-field">
    <label for="cu-cedula">${t("Número de cédula", "Cédula number")} <span>*</span></label>
    <input id="cu-cedula" type="text" name="cedula" inputmode="numeric" autocomplete="username" placeholder="000-0000000-0" maxlength="13" required autofocus>
  </div>
  <div class="cu-field cu-has-adorn">
    <label for="cu-password">${t("Contraseña", "Password")} <span>*</span></label>
    <input id="cu-password" type="password" name="password" autocomplete="current-password" required>
    <button type="button" class="cu-adorn" id="cu-toggle-password" aria-label="${t("Mostrar contraseña", "Show password")}" data-label-show="${t("Mostrar contraseña", "Show password")}" data-label-hide="${t("Ocultar contraseña", "Hide password")}" aria-pressed="false">${EYE_ICON}</button>
  </div>
  <button type="submit" class="cu-btn cu-block">${t("Iniciar sesión", "Sign in")} ${ARROW_ICON}</button>
</form>
<div class="cu-divider">${t("demostración", "demo")}</div>
<p class="cu-note" style="text-align:center">${t(
    "Use una de las cédulas de prueba y la contraseña compartida de la demostración. No use datos reales.",
    "Use one of the test cédulas and the shared demo password. Do not use real data."
  )}</p>`;
  return page({
    body: renderCitizenCard({
      body,
      glyph: CITIZEN_GLYPHS.lock,
      title: t("Cuenta Única Ciudadana", "Cuenta Única citizen account"),
    }),
    currentUrl: input.currentUrl,
    lang,
    script: LOGIN_PAGE_SCRIPT,
    shell: "cuenta-unica",
    title: t("Cuenta Única Ciudadana (simulación) · Iniciar sesión", "Cuenta Única (simulation) · Sign in"),
  });
}

// ─── consent ────────────────────────────────────────────────────────────────

function declineForm(session: ParentSession, requestUri: string, lang: Lang): string {
  return `<form method="POST" action="${PILOT_PATHS.consent}/deny">
  <input type="hidden" name="request_uri" value="${esc(requestUri)}">${csrfField(session)}
  <button type="submit" class="cu-btn cu-outline cu-block">${pick(lang, "No autorizar", "Do not authorize")}</button>
</form>`;
}

export function pickChildPage(input: {
  children: Array<RegistryChild & { capacity: GuardianCapacity }> | null;
  clientName: string | null;
  currentUrl: string;
  lang: Lang;
  requestUri: string;
  session: ParentSession;
}): string {
  const { lang, session, requestUri, children } = input;
  const t = (es: string, en: string) => pick(lang, es, en);
  const client = esc(input.clientName || t("Una aplicación", "An app"));
  let chooser: string;
  let canContinue = true;
  if (children === null) {
    chooser = `<p class="cu-text" data-named-record>${t(
      "Esta solicitud es para el registro de un niño o niña en particular. Antes de mostrarle nada, el Registro Civil confirmará que usted puede autorizar en su nombre.",
      "This request is for one particular child's record. Before showing you anything, the civil registry will confirm that you may authorize on that child's behalf."
    )}</p>`;
  } else if (children.length === 0) {
    canContinue = false;
    chooser = `<div class="cu-error" role="alert">${t(
      "El Registro Civil no tiene a ningún niño o niña a su cargo, así que no puede autorizar esta solicitud.",
      "The civil registry lists no children in your care, so you cannot authorize this request."
    )}</div>`;
  } else {
    const options = children
      .map((c, i) => {
        const cap = capacityLabel(c.capacity);
        return `<label class="cu-choice" data-child-id="${esc(c.child_id)}"><input type="radio" name="child_id" value="${esc(c.child_id)}"${i === 0 ? " required" : ""}${children.length === 1 ? " checked" : ""}>
  <span><b>${esc(c.given_name)} ${esc(c.family_name)}</b><small>${esc(ageLabel(c.birth_date, lang))} · ${t("usted es", "you are their")} ${esc(pick(lang, cap.es, cap.en))}</small></span></label>`;
      })
      .join("");
    chooser = `<fieldset class="cu-choices"><legend>${t("¿Para cuál niño o niña?", "Which child is this for?")}</legend>${options}</fieldset>
<p class="cu-note" style="margin:-10px 0 22px">${t("Lista según el Registro Civil.", "List from the civil registry.")}</p>`;
  }
  const body = `<div class="cu-client">${CITIZEN_GLYPHS.home}<span><b>${client}</b> ${t(
    "solicita el registro de vacunación de un niño o niña a su cargo.",
    "is requesting the vaccination record of a child in your care."
  )}</span></div>
<form method="POST" action="${PILOT_PATHS.consent}/select" id="cu-select">
  <input type="hidden" name="request_uri" value="${esc(requestUri)}">${csrfField(session)}
  ${chooser}
</form>
<div class="cu-actions">
  ${canContinue ? `<button type="submit" form="cu-select" class="cu-btn cu-block">${t("Continuar", "Continue")}</button>` : ""}
  ${declineForm(session, requestUri, lang)}
</div>`;
  return page({
    body: renderCitizenCard({
      body,
      glyph: CITIZEN_GLYPHS.child,
      title: t("Autorización de acceso a datos", "Data access authorization"),
    }),
    currentUrl: input.currentUrl,
    lang,
    session,
    shell: "dr-consent",
    title: t("Autorizar acceso · elegir niño o niña", "Authorize access · choose a child"),
  });
}

export interface ReviewView {
  capacity: GuardianCapacity;
  child: RegistryChild;
  clientName: string | null;
  expiresAt: string;
  fields: string[];
  pilotRevision: string;
  purposeDescription: string | null;
  requestUri: string;
}

export function reviewPage(input: { currentUrl: string; lang: Lang; review: ReviewView; session: ParentSession }): string {
  const { lang, session, review } = input;
  const t = (es: string, en: string) => pick(lang, es, en);
  const cap = capacityLabel(review.capacity);
  const childName = `${esc(review.child.given_name)} ${esc(review.child.family_name)}`;
  const given = esc(review.child.given_name);
  const client = esc(review.clientName || t("Esta aplicación", "This app"));
  const body = `<p class="cu-acting" data-acting-as="${esc(review.capacity)}">${t(
    `Usted está actuando como <b>${esc(cap.es)}</b> de <b>${childName}</b>.`,
    `You are acting as <b>${esc(cap.en)}</b> of <b>${childName}</b>.`
  )}<span class="cu-note">${t("Confirmado por el Registro Civil.", "Confirmed by the civil registry.")}</span></p>
<h2 class="cu-title">${t(
    `${client} quiere leer el registro de vacunación de ${given}`,
    `${client} wants to read ${given}'s vaccination record`
  )}</h2>
<dl class="cu-summary">
  <div><dt>${t("Quién", "Who")}</dt><dd>${client}</dd></div>
  <div><dt>${t("Para qué", "What for")}</dt><dd>${esc(purposeText(review.purposeDescription, lang))}</dd></div>
  <div><dt>${t("Qué datos", "What data")}</dt><dd><span class="cu-note" style="margin:0 0 4px">${t(
    `Solo el registro de vacunación de ${given}:`,
    `Only ${given}'s vaccination record:`
  )}</span>${fieldChips(review.fields, lang)}<span class="cu-note">${t(
    "No se comparte el nombre del niño o niña, su cédula ni datos de otros niños.",
    "The child's name, your cédula and other children's data are not shared."
  )}</span></dd></div>
  <div><dt>${t("Cómo", "How")}</dt><dd>${t("Lecturas periódicas mientras la autorización esté vigente", "Repeated reads while the authorization is active")}</dd></div>
  <div><dt>${t("Hasta cuándo", "Until when")}</dt><dd data-expires-at="${esc(review.expiresAt)}">${t("Hasta el", "Until")} ${esc(formatDay(review.expiresAt, lang))}<span class="cu-note">${t(
    `El día que ${given} cumple 18 años. Ahí termina sola.`,
    `The day ${given} turns 18. It ends on its own then.`
  )}</span></dd></div>
</dl>
<p class="cu-text">${t(
    "Puede retirar esta autorización en cualquier momento desde «Mis autorizaciones».",
    "You can withdraw this authorization at any time from “My authorizations”."
  )}</p>
<div class="cu-actions">
  <form method="POST" action="${PILOT_PATHS.consent}/approve">
    <input type="hidden" name="request_uri" value="${esc(review.requestUri)}">
    <input type="hidden" name="pilot_revision" value="${esc(review.pilotRevision)}">${csrfField(session)}
    <button type="submit" class="cu-btn cu-block">${t("Autorizar", "Authorize")}</button>
  </form>
  ${declineForm(session, review.requestUri, lang)}
</div>`;
  return page({
    body: renderCitizenCard({
      body,
      glyph: CITIZEN_GLYPHS.shield,
      title: t("Autorización de acceso a datos", "Data access authorization"),
    }),
    currentUrl: input.currentUrl,
    lang,
    session,
    shell: "dr-consent",
    title: t("Revisar autorización", "Review authorization"),
  });
}

export type ResultKind = "approved" | "declined" | "refused";

export function resultPage(input: {
  currentUrl: string;
  kind: ResultKind;
  lang: Lang;
  returnTo: string | null;
  session: ParentSession | null;
}): string {
  const { lang, kind } = input;
  const t = (es: string, en: string) => pick(lang, es, en);
  const back = input.returnTo
    ? `<a class="cu-btn cu-block" data-return-to-app href="${esc(input.returnTo)}">${t("Volver a la aplicación", "Return to the app")}</a>`
    : "";
  const mine = `<a class="cu-btn cu-outline cu-block" href="${PILOT_PATHS.authorizations}">${t("Mis autorizaciones", "My authorizations")}</a>`;
  let message: string;
  let title: string;
  let glyph: string = CITIZEN_GLYPHS.shield;
  let tone: "primary" | "danger" = "primary";
  if (kind === "refused") {
    title = t("No se pudo autorizar", "Could not authorize");
    glyph = CITIZEN_GLYPHS.stop;
    tone = "danger";
    message = `<div class="cu-error" role="alert" data-result="refused">${t(
      "El Registro Civil no confirma que usted pueda autorizar en nombre de este niño o niña.",
      "The civil registry does not confirm that you may authorize on this child's behalf."
    )}</div><p class="cu-text">${t(
      "No se compartió ningún dato. La aplicación solo recibe un aviso de que no se autorizó, sin el motivo. Si cree que es un error, acuda a una oficialía del Estado Civil.",
      "No data was shared. The app only learns that access was not authorized, not why. If you think this is a mistake, contact a civil registry office."
    )}</p>`;
  } else if (kind === "declined") {
    title = t("No se autorizó", "Not authorized");
    message = `<p class="cu-text" data-result="declined">${t(
      "Usted decidió no autorizar. No se compartió ningún dato.",
      "You decided not to authorize. No data was shared."
    )}</p>`;
  } else {
    title = t("Autorización registrada", "Authorization recorded");
    message = `<div class="cu-ok" role="status" data-result="approved">${t(
      "Listo. Puede verla o retirarla en «Mis autorizaciones».",
      "Done. You can see or withdraw it in “My authorizations”."
    )}</div>`;
  }
  return page({
    body: renderCitizenCard({
      body: `${message}<div class="cu-actions">${back}${mine}</div>`,
      glyph,
      glyphTone: tone,
      title,
    }),
    currentUrl: input.currentUrl,
    lang,
    session: input.session,
    shell: "dr-consent",
    title,
  });
}

// ─── Mis autorizaciones ─────────────────────────────────────────────────────

const PAGE_CSS = `
.cu-grants { display: grid; gap: 18px; margin-top: 18px; }
.cu-child-head { margin: 10px 0 -6px; display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.cu-child-head h2 { margin: 0; font-size: 17px; font-weight: 600; color: var(--cu-primary); }
.cu-child-head small { font-size: 12px; color: var(--cu-text-muted); }
.cu-grant-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 16px 25px;
  background: var(--cu-card-head); border-bottom: 1px solid var(--cu-card-head-border); border-radius: 10px 10px 0 0; }
.cu-grant-head h3 { margin: 0; font-size: 16px; font-weight: 600; color: var(--cu-primary); }
.cu-badge { font-size: 12px; font-weight: 600; border-radius: 60px; padding: 3px 12px; white-space: nowrap; }
.cu-badge[data-status="active"] { background: #E6F4EA; color: #1E6B34; border: 1px solid #A8D5B5; }
.cu-badge[data-status="revoked"] { background: #FDECEA; color: var(--cu-danger); border: 1px solid #F5C2C0; }
.cu-badge[data-status="expired"] { background: #F1F1F1; color: var(--cu-text-muted); border: 1px solid var(--cu-card-border); }
.cu-empty { margin: 0; padding: 14px 16px; font-size: 13px; color: var(--cu-text-muted); background: #fff; border: 1px dashed var(--cu-card-border); border-radius: 10px; }
@media (max-width: 720px) { .cu-grant-head { padding: 14px 16px; } }
`;

type GrantView = RepresentativeGrantRow & { approved_by_you: boolean };

function grantStatus(g: GrantView): "active" | "revoked" | "expired" {
  if (g.revoked_at || g.grant_status === "revoked") {
    return "revoked";
  }
  if (g.grant_status !== "active" || (g.expires_at && Date.parse(g.expires_at) <= Date.now())) {
    return "expired";
  }
  return "active";
}

function renderGrant(g: GrantView, child: RegistryChild | undefined, session: ParentSession, lang: Lang): string {
  const t = (es: string, en: string) => pick(lang, es, en);
  const status = grantStatus(g);
  const badge = {
    active: t("Vigente", "Active"),
    expired: t("Terminada", "Ended"),
    revoked: t("Retirada", "Withdrawn"),
  }[status];
  const cap = capacityLabel(g.capacity as GuardianCapacity);
  const who = g.approved_by_you
    ? t(`Usted, como ${cap.es}`, `You, as ${cap.en}`)
    : t(`Otra persona con autoridad (${cap.es})`, `Another person with authority (${cap.en})`);
  const given = esc(child?.given_name ?? g.child_id);
  const disposition =
    g.disposition === "delete"
      ? t("Se pidió al servicio borrar los datos que ya recibió.", "The service was told to delete the data it already received.")
      : g.disposition === "keep"
        ? t(
            "El servicio puede conservar lo que ya recibió, solo para el propósito aprobado.",
            "The service may keep what it already received, only for the approved purpose."
          )
        : "";
  const revokedRow = g.revoked_at
    ? `<div><dt>${t("Retirada el", "Withdrawn on")}</dt><dd>${esc(formatMoment(g.revoked_at, lang))}${disposition ? `<span class="cu-note" data-disposition="${esc(g.disposition)}">${disposition}</span>` : ""}</dd></div>`
    : "";
  const revoke =
    status === "active"
      ? `<form method="POST" action="${PILOT_PATHS.authorizations}/${esc(encodeURIComponent(g.grant_id))}/revoke" data-revoke-form>
  ${csrfField(session)}
  <fieldset class="cu-choices"><legend>${t(
    "Si la retira, ¿qué debe hacer el servicio con los datos que ya recibió?",
    "If you withdraw it, what should the service do with the data it already received?"
  )}</legend>
    <label class="cu-choice"><input type="radio" name="disposition" value="keep" required><span><b>${t("Conservarlos", "Keep them")}</b><small>${t(
      "Solo para el propósito que usted aprobó; no podrá leer datos nuevos.",
      "Only for the purpose you approved; it cannot read new data."
    )}</small></span></label>
    <label class="cu-choice"><input type="radio" name="disposition" value="delete"><span><b>${t("Borrarlos", "Delete them")}</b><small>${t(
      "Debe dejar de usarlos en 48 horas y borrarlos en 30 días.",
      "It must stop using them within 48 hours and delete them within 30 days."
    )}</small></span></label>
  </fieldset>
  <button type="submit" class="cu-btn cu-outline-danger cu-block">${t("Retirar autorización", "Withdraw authorization")}</button>
</form>`
      : "";
  return `<article class="cu-card" data-grant-id="${esc(g.grant_id)}" data-child-id="${esc(g.child_id)}" data-grant-status="${status}">
  <div class="cu-grant-head"><h3>${esc(g.client_display_name || g.client_id)}</h3><span class="cu-badge" data-status="${status}">${badge}</span></div>
  <div class="cu-card-body"><dl class="cu-summary">
    <div><dt>${t("Para qué", "What for")}</dt><dd>${esc(purposeText(g.purpose_description, lang))}</dd></div>
    <div><dt>${t("Qué datos", "What data")}</dt><dd><span class="cu-note" style="margin:0">${t(`Registro de vacunación de ${given}`, `${given}'s vaccination record`)}</span>${fieldChips(g.fields, lang)}</dd></div>
    <div><dt>${t("Autorizada por", "Authorized by")}</dt><dd data-approved-by="${g.approved_by_you ? "you" : "other"}">${esc(who)}<span class="cu-note">${esc(formatMoment(g.approved_at, lang))}</span></dd></div>
    <div><dt>${t("Hasta cuándo", "Until when")}</dt><dd>${t("Hasta el", "Until")} ${esc(formatDay(g.expires_at, lang))}<span class="cu-note">${t("Cumpleaños 18", "18th birthday")}</span></dd></div>
    ${revokedRow}
  </dl>${revoke}</div>
</article>`;
}

export function authorizationsPage(input: {
  children: Array<RegistryChild & { capacity: GuardianCapacity }>;
  currentUrl: string;
  flash: "keep" | "delete" | null;
  grants: GrantView[];
  lang: Lang;
  session: ParentSession;
}): string {
  const { lang, session } = input;
  const t = (es: string, en: string) => pick(lang, es, en);
  const flash =
    input.flash === "keep"
      ? t(
          "Autorización retirada. El servicio ya no puede leer datos nuevos y puede conservar lo que recibió.",
          "Authorization withdrawn. The service can no longer read new data and may keep what it received."
        )
      : input.flash === "delete"
        ? t(
            "Autorización retirada. El servicio ya no puede leer datos nuevos y debe borrar lo que recibió.",
            "Authorization withdrawn. The service can no longer read new data and must delete what it received."
          )
        : "";
  const header = renderCitizenCard({
    body: `${flash ? `<div class="cu-ok" role="status" data-revoke-banner="${esc(input.flash)}">${flash}</div>` : ""}<p class="cu-text">${t(
      "Aquí ve qué servicios pueden leer el registro de vacunación de los niños y niñas a su cargo, quién lo autorizó y hasta cuándo. Puede retirar una autorización en cualquier momento, aunque la haya dado otra persona con autoridad sobre el niño.",
      "Here you see which services may read the vaccination record of the children in your care, who authorized it and until when. You can withdraw an authorization at any time, even one given by another person with authority over the child."
    )}</p><p class="cu-note">${t("Lista según el Registro Civil a día de hoy.", "List based on the civil registry as of today.")}</p>`,
    glyph: CITIZEN_GLYPHS.shield,
    title: t("Mis autorizaciones", "My authorizations"),
  });
  const byChild = new Map<string, GrantView[]>();
  for (const g of input.grants) {
    byChild.set(g.child_id, [...(byChild.get(g.child_id) ?? []), g]);
  }
  const sections = input.children.length
    ? input.children
        .map((c) => {
          const cap = capacityLabel(c.capacity);
          const grants = byChild.get(c.child_id) ?? [];
          const cards = grants.length
            ? grants.map((g) => renderGrant(g, c, session, lang)).join("\n")
            : `<p class="cu-empty">${t("Ningún servicio tiene autorización para este registro.", "No service is authorized for this record.")}</p>`;
          return `<div class="cu-child-head" data-child-section="${esc(c.child_id)}"><h2>${esc(c.given_name)} ${esc(c.family_name)}</h2><small>${esc(ageLabel(c.birth_date, lang))} · ${t("usted es", "you are their")} ${esc(pick(lang, cap.es, cap.en))}</small></div>${cards}`;
        })
        .join("\n")
    : `<p class="cu-empty">${t("El Registro Civil no tiene a ningún niño o niña a su cargo.", "The civil registry lists no children in your care.")}</p>`;
  return page({
    body: `<style>${PAGE_CSS}</style>${header}<section class="cu-grants" aria-label="${t("Autorizaciones por niño o niña", "Authorizations by child")}">${sections}</section>`,
    currentUrl: input.currentUrl,
    lang,
    session,
    shell: "citizen-grants",
    title: t("Mis autorizaciones (simulación)", "My authorizations (simulation)"),
  });
}

export function errorPage(input: {
  currentUrl: string;
  lang: Lang;
  message: string;
  session: ParentSession | null;
  status: number;
}): string {
  const { lang } = input;
  const t = (es: string, en: string) => pick(lang, es, en);
  const known: Record<number, readonly [string, string]> = {
    403: ["No tiene permiso para hacer esto.", "You are not allowed to do this."],
    404: [
      "Este enlace ya no es válido. Es posible que la solicitud haya vencido o ya se haya respondido.",
      "This link is no longer valid. The request may have expired or already been answered.",
    ],
    409: [
      "La solicitud cambió mientras la revisaba. Vuelva a empezar desde la aplicación.",
      "The request changed while you were reviewing it. Start again from the app.",
    ],
  };
  const text = known[input.status];
  const body = `<p class="cu-text">${esc(text ? pick(lang, text[0], text[1]) : t("Algo salió mal.", "Something went wrong."))}</p>
<p class="cu-note">${esc(input.message)}</p>
<div class="cu-actions" style="margin-top:18px"><a class="cu-btn cu-outline cu-block" href="${PILOT_PATHS.landing}">${t("Ir al inicio", "Go to start")}</a></div>`;
  return page({
    body: renderCitizenCard({ body, glyph: CITIZEN_GLYPHS.stop, glyphTone: "danger", title: `Error ${input.status}` }),
    currentUrl: input.currentUrl,
    lang,
    session: input.session,
    shell: "dr-consent",
    title: `Error ${input.status}`,
  });
}
