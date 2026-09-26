// HTML views for the simulated "Servicios Proactivos" portal (MAP). Look
// follows the gob.do tokens in public/portal.css. Text only: no logos, no
// escudo, fictitious contacts only. Spanish by default, English via the toggle.
//
//   renderOffer({ lang, error, until })                 -> the offer (deck slide 19)
//   renderListo({ lang, result, notice, error })   -> "Listo" (slide 23): data received + the authorization

export const LANG = { EN: "en", ES: "es" };
const LOCALE = { en: "en-GB", es: "es-DO" };
const TIME_ZONE = "America/Santo_Domingo";

// Every visible string, by language.
const T = {
  es: {
    simBar: "Entorno de demostración · datos ficticios",
    brand: "Servicios Proactivos · Ministerio de Administración Pública",
    brandSub: "Portal de servicios · simulación",
    myRequests: "Mis trámites",
    menu: ["Inicio", "Servicios Proactivos", "Transparencia", "Contáctenos"],
    home: "Inicio",
    offerTitle: "Servicios Proactivos",
    messageLabel: "Nuevo mensaje · Servicios Proactivos",
    messageBody:
      "Cuando nazca su bebé, podemos organizar sus vacunas y el bono por hijo por usted, sin que tenga que solicitarlos. Inicie sesión con Cuenta Única para decir sí.",
    needTitle: "Qué necesitaremos y por qué",
    need: {
      sns: {
        tag: "SNS",
        title: "Su expediente de salud",
        what: "La fecha probable de parto y su centro de salud.",
        why: "Para programar las vacunas de su bebé en su centro, a tiempo.",
      },
      siuben: {
        tag: "SIUBEN",
        title: "Su ficha del hogar",
        what: "La clasificación de su hogar y quiénes viven en él.",
        why: "Para incluir el bono por hijo sin que tenga que presentar documentos.",
      },
    },
    untilTitle: "Hasta cuándo",
    untilBody: (d) =>
      `Hasta el ${d}, unas 10 semanas después de la fecha probable de parto. Puede cancelarlo antes, cuando quiera, en Mis autorizaciones.`,
    yes: "Decir sí con Cuenta Única",
    yesNote: "Le pediremos que inicie sesión y confirme. No se comparte nada hasta que usted diga sí.",
    doneTitle: "Listo.",
    doneLead: (due) =>
      due
        ? `Cuando nazca su bebé (fecha probable: ${due}) organizaremos su vacunación y el bono por hijo. No tiene que solicitar nada.`
        : "Cuando nazca su bebé organizaremos su vacunación y el bono por hijo. No tiene que solicitar nada.",
    received: "Lo que recibimos",
    receivedAt: (t) => `Recibido el ${t}.`,
    keptCopy: (t) => `Copia recibida el ${t}. Ya no se actualiza.`,
    healthRecord: "Expediente de salud",
    householdFile: "Ficha del hogar",
    dueDate: "Fecha probable de parto",
    weeks: "Semanas de gestación",
    centre: "Centro de salud",
    icv: "Clasificación del hogar (ICV)",
    place: "Municipio, provincia",
    membersCount: "Número de miembros del hogar",
    memberCols: ["Nombre", "Parentesco", "Edad"],
    updated: (d) => `Actualizado al ${d}`,
    noData: "No recibido",
    notShared: "No lo compartió",
    members: "Quiénes viven en el hogar",
    planTitle: "Qué haremos",
    planVaccines: (c) => `Vacunas: programaremos las primeras vacunas de su bebé${c ? ` en ${c}` : ""}.`,
    planBenefit: "Bono por hijo: lo incluiremos para su hogar al registrarse el nacimiento.",
    grant: "Autorización",
    grantId: "Identificador",
    grantPurpose: "Propósito",
    grantSources: "Fuentes",
    grantUntil: "Hasta",
    grantStatus: "Estado",
    active: "Vigente",
    revoked: "Revocada",
    sourceNames: {
      sns: "SNS · expediente de salud (control prenatal)",
      siuben: "SIUBEN · ficha del hogar (clasificación y miembros)",
      siubenHogar: "SIUBEN · ficha del hogar (clasificación)",
      siubenMiembros: "SIUBEN · ficha del hogar (miembros)",
    },
    reRead: "Volver a consultar",
    misAutorizaciones: "Ver o revocar en Mis autorizaciones",
    verified: (t) => `Datos consultados nuevamente a las ${t}, con la misma autorización.`,
    revokedTitle: "Esta autorización fue revocada.",
    revokedBody: (t) =>
      `Servicios Proactivos ya no puede consultar su expediente de salud ni su ficha del hogar. Se conserva solo la copia recibida el ${t}.`,
    askAgain: "Solicitar autorización nuevamente",
    retry: "Intentar de nuevo",
    errors: {
      denied: {
        title: "Usted no dio su autorización.",
        detail: "No se compartió ningún dato. Si cambia de opinión, puede decir sí cuando quiera.",
      },
      state: {
        title: "La autorización no coincide con esta solicitud.",
        detail: "Por seguridad, vuelva a empezar desde este portal.",
      },
      generic: {
        title: "No pudimos obtener sus datos.",
        detail: "Ocurrió un problema al comunicarnos con Cuenta Única. Intente de nuevo en unos minutos.",
      },
      refresh: {
        title: "No pudimos volver a consultar.",
        detail: "Se muestran los datos recibidos anteriormente. Intente de nuevo en unos minutos.",
        retry: false,
      },
    },
    footerNote: "Portal simulado para demostración. No es un sitio oficial.",
    footerCols: [
      ["Conózcanos", ["Sobre esta demostración"]],
      ["Contáctenos", ["Tel: (000) 000-0000", "demo@example.org"]],
      ["Infórmese", ["Términos de uso", "Política de privacidad", "Preguntas frecuentes"]],
    ],
    footerLeft: "© 2026 Demostración · datos ficticios",
    footerRight: "No afiliado al MAP ni al Gobierno de la República Dominicana",
  },
  en: {
    simBar: "Demo environment · fictitious data",
    brand: "Servicios Proactivos · Ministry of Public Administration",
    brandSub: "Service portal · simulation",
    myRequests: "My requests",
    menu: ["Home", "Servicios Proactivos", "Transparency", "Contact us"],
    home: "Home",
    offerTitle: "Servicios Proactivos",
    messageLabel: "New message · Servicios Proactivos",
    messageBody:
      "When your baby is born, we can set up the vaccinations and the child benefit for you, without you applying. Sign in with Cuenta Única to say yes.",
    needTitle: "What we will need and why",
    need: {
      sns: {
        tag: "SNS",
        title: "Your health record",
        what: "Your due date and your health centre.",
        why: "To schedule your baby's vaccinations at your centre, on time.",
      },
      siuben: {
        tag: "SIUBEN",
        title: "Your household file",
        what: "Your household's classification and who lives in it.",
        why: "To include the child benefit without you having to bring documents.",
      },
    },
    untilTitle: "Until when",
    untilBody: (d) =>
      `Until ${d}, about 10 weeks after the due date. You can cancel it earlier, at any time, in Mis autorizaciones.`,
    yes: "Say yes with Cuenta Única",
    yesNote: "We will ask you to sign in and confirm. Nothing is shared until you say yes.",
    doneTitle: "Done.",
    doneLead: (due) =>
      due
        ? `When your baby is born (due date: ${due}) we will arrange the vaccinations and the child benefit. You don't need to apply for anything.`
        : "When your baby is born we will arrange the vaccinations and the child benefit. You don't need to apply for anything.",
    received: "What we received",
    receivedAt: (t) => `Received on ${t}.`,
    keptCopy: (t) => `Copy received on ${t}. No longer updated.`,
    healthRecord: "Health record",
    householdFile: "Household file",
    dueDate: "Due date",
    weeks: "Weeks of pregnancy",
    centre: "Health centre",
    icv: "Household classification (ICV)",
    place: "Municipality, province",
    membersCount: "Number of household members",
    memberCols: ["Name", "Relationship", "Age"],
    updated: (d) => `Updated ${d}`,
    noData: "Not received",
    notShared: "You didn't share this",
    members: "Who lives in the household",
    planTitle: "What we will do",
    planVaccines: (c) => `Vaccinations: we will schedule your baby's first vaccinations${c ? ` at ${c}` : ""}.`,
    planBenefit: "Child benefit: we will add it for your household when the birth is registered.",
    grant: "Authorization",
    grantId: "Identifier",
    grantPurpose: "Purpose",
    grantSources: "Sources",
    grantUntil: "Until",
    grantStatus: "Status",
    active: "Active",
    revoked: "Revoked",
    sourceNames: {
      sns: "SNS · health record (prenatal care)",
      siuben: "SIUBEN · household file (classification and members)",
      siubenHogar: "SIUBEN · household file (classification)",
      siubenMiembros: "SIUBEN · household file (members)",
    },
    reRead: "Read again",
    misAutorizaciones: "View or revoke in Mis autorizaciones",
    verified: (t) => `Data read again at ${t}, under the same authorization.`,
    revokedTitle: "This authorization was revoked.",
    revokedBody: (t) =>
      `Servicios Proactivos can no longer read your health record or your household file. Only the copy received on ${t} is kept.`,
    askAgain: "Ask for authorization again",
    retry: "Try again",
    errors: {
      denied: {
        title: "You did not give your authorization.",
        detail: "No data was shared. If you change your mind, you can say yes at any time.",
      },
      state: {
        title: "The authorization does not match this request.",
        detail: "For your security, please start again from this portal.",
      },
      generic: {
        title: "We could not get your data.",
        detail: "Something went wrong talking to Cuenta Única. Please try again in a few minutes.",
      },
      refresh: {
        title: "We could not read the data again.",
        detail: "The data received earlier is shown. Please try again in a few minutes.",
        retry: false,
      },
    },
    footerNote: "Simulated portal for a demo. Not an official site.",
    footerCols: [
      ["About", ["About this demo"]],
      ["Contact", ["Tel: (000) 000-0000", "demo@example.org"]],
      ["Information", ["Terms of use", "Privacy policy", "FAQ"]],
    ],
    footerLeft: "© 2026 Demo · fictitious data",
    footerRight: "Not affiliated with MAP or the Government of the Dominican Republic",
  },
};

// Minimal HTML escaping for every interpolated value.
export function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// "2026-11-20" -> "20 de noviembre de 2026" | "20 November 2026" (date part only).
function formatDateLong(iso, lang) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? ""));
  if (!match) {
    return "";
  }
  const [, y, m, d] = match.map(Number);
  const opts = { day: "numeric", month: "long", timeZone: "UTC", year: "numeric" };
  return new Intl.DateTimeFormat(LOCALE[lang], opts).format(new Date(Date.UTC(y, m - 1, d)));
}

// Santo Domingo wall clock: "time" -> "14:05", "date_time" -> "25/09/2026, 14:05".
export function formatDateTime(date, lang, clock) {
  const opts = { hour: "2-digit", hourCycle: "h23", minute: "2-digit", timeZone: TIME_ZONE };
  const dateOpts = clock === "date_time" ? { day: "2-digit", month: "2-digit", year: "numeric" } : {};
  return new Intl.DateTimeFormat(LOCALE[lang], { ...opts, ...dateOpts }).format(date);
}

// ── Shared chrome ───────────────────────────────────────────────────────────

// Small muted demo line + ES|EN toggle; each link points to the current path with ?lang.
function simBar(t, lang, path) {
  const link = (code) =>
    `<a data-lang-toggle="${code}" href="${esc(path)}?lang=${code}"${code === lang ? ' aria-current="true"' : ""}>${code.toUpperCase()}</a>`;
  return `<div class="sim-bar" role="note">${esc(t.simBar)}
  <nav class="lang-toggle" aria-label="Idioma / Language">${link(LANG.ES)} | ${link(LANG.EN)}</nav>
</div>`;
}

function header(t) {
  const menu = t.menu.map((m, i) => `<a href="/"${i === 1 ? ' class="active"' : ""}>${esc(m)}</a>`).join("\n        ");
  return `<header>
  <div class="topbar">
    <div class="container topbar-cont">
      <a class="logo" href="/"><span class="logo-text">${esc(t.brand)}<small>${esc(t.brandSub)}</small></span></a>
      <div class="topbar-right"><span>${esc(t.myRequests)}</span></div>
    </div>
  </div>
  <div class="main-menu">
    <div class="container">
      <nav class="menu">
        ${menu}
      </nav>
    </div>
  </div>
</header>`;
}

function breadcrumbs(t, title) {
  return `<div class="breadcrumbs">
  <div class="container">
    <div class="page-title">${esc(title)}</div>
    <div class="path"><a href="/">${esc(t.home)}</a> / ${esc(t.offerTitle)}</div>
  </div>
</div>`;
}

function footer(t) {
  const cols = t.footerCols
    .map(([title, items]) => `<div><div class="footer-title">${esc(title)}</div><ul>${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul></div>`)
    .join("\n      ");
  return `<footer>
  <div class="footer-top">
    <div class="container row">
      <div class="footer-brand">${esc(t.brand)}<small>${esc(t.footerNote)}</small></div>
      ${cols}
    </div>
  </div>
  <div class="footer-bottom">
    <div class="container"><span>${esc(t.footerLeft)}</span><span>${esc(t.footerRight)}</span></div>
  </div>
</footer>`;
}

function layout({ lang, path, title, body }) {
  const t = T[lang];
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)} (${lang === LANG.EN ? "simulation" : "simulación"})</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/portal.css">
</head>
<body>
${simBar(t, lang, path)}
${header(t)}
${breadcrumbs(t, title)}
${body}
${footer(t)}
</body>
</html>`;
}

// ── Alerts ──────────────────────────────────────────────────────────────────

const ICON_ERROR =
  '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#EE2A24" stroke-width="2.2" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 7v6M12 16.5v.5"/></svg>';
const ICON_OK =
  '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#2ECC71" stroke-width="2.2" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="m8 12 3 3 5-6"/></svg>';

const yesForm = (label, cls = "btn btn-blue") =>
  `<form method="POST" action="/decir-si" class="inline-form"><button class="${cls}" type="submit">${esc(label)}</button></form>`;

function errorAlert(t, errorKey) {
  const error = errorKey ? (t.errors[errorKey] ?? t.errors.generic) : null;
  if (!error) {
    return "";
  }
  const retry = error.retry === false ? "" : `<div class="alert-actions">${yesForm(t.retry)}</div>`;
  return `<div class="alert-error" role="alert" data-notice="${esc(errorKey)}">
  ${ICON_ERROR}
  <div><p><b>${esc(error.title)}</b> ${esc(error.detail)}</p>${retry}</div>
</div>`;
}

// ── Offer (slide 19) ────────────────────────────────────────────────────────

export function renderOffer({ lang, error, path, sources, until }) {
  const t = T[lang];
  const needs = sources
    .map((key) => {
      const n = t.need[key];
      return `<li class="need" data-source="${key}">
        <span class="tag">${esc(n.tag)}</span>
        <div><b>${esc(n.title)}</b><p>${esc(n.what)}</p><p class="why">${esc(n.why)}</p></div>
      </li>`;
    })
    .join("\n      ");

  const body = `<main class="container narrow">
  ${errorAlert(t, error)}
  <article class="message" data-offer>
    <div class="message-label">${esc(t.messageLabel)}</div>
    <p class="message-body">${esc(t.messageBody)}</p>
  </article>

  <section class="card">
    <h2>${esc(t.needTitle)}</h2>
    <ul class="needs">
      ${needs}
    </ul>
    <h3 class="sub">${esc(t.untilTitle)}</h3>
    <p class="until" data-until>${esc(t.untilBody(formatDateLong(until, lang)))}</p>
    <div class="cta">
      ${yesForm(t.yes, "btn btn-blue btn-lg")}
      <small>${esc(t.yesNote)}</small>
    </div>
  </section>
</main>`;
  return layout({ body, lang, path, title: t.offerTitle });
}

// ── Listo (slide 23) ────────────────────────────────────────────────────────

function row(label, value, attr = "") {
  const shown = value === undefined || value === null || value === "" ? "—" : value;
  return `<dt>${esc(label)}</dt><dd${attr}>${esc(shown)}</dd>`;
}

// Granted = in the token's authorization_details (see server.mjs grantedStreams).
const isStreamGranted = (granted, stream) => !granted || stream in granted;
const isFieldGranted = (granted, stream, field) =>
  isStreamGranted(granted, stream) && (!granted?.[stream] || granted[stream].includes(field));

// Neutral line for what the citizen chose not to share.
function notSharedRow(t, label, key) {
  return `<dt>${esc(label)}</dt><dd class="not-shared" data-not-shared="${esc(key)}">${esc(t.notShared)}</dd>`;
}

function healthCard(t, lang, p, granted) {
  if (!isStreamGranted(granted, "control_prenatal")) {
    return `<div class="data-card"><h3><span class="tag">SNS</span>${esc(t.healthRecord)}</h3><p class="muted not-shared" data-not-shared="control_prenatal">${esc(t.notShared)}</p></div>`;
  }
  if (!p) {
    return `<div class="data-card"><h3><span class="tag">SNS</span>${esc(t.healthRecord)}</h3><p class="muted">${esc(t.noData)}</p></div>`;
  }
  const updated = formatDateLong(p.source_updated_at, lang);
  const centre = isFieldGranted(granted, "control_prenatal", "centro_salud")
    ? row(t.centre, p.centro_salud)
    : notSharedRow(t, t.centre, "centro_salud");
  return `<div class="data-card" data-source="sns" data-received-fields="${esc(Object.keys(p).sort().join(" "))}">
  <h3><span class="tag">SNS</span>${esc(t.healthRecord)}</h3>
  <dl>
    ${row(t.dueDate, formatDateLong(p.fecha_probable_parto, lang), ` data-due-date="${esc(p.fecha_probable_parto)}"`)}
    ${row(t.weeks, p.semanas_gestacion)}
    ${centre}
  </dl>
  ${updated ? `<p class="muted">${esc(t.updated(updated))}</p>` : ""}
</div>`;
}

function householdCard(t, lang, h, miembros, granted) {
  const hogarGranted = isStreamGranted(granted, "clasificacion_hogar");
  const miembrosGranted = isStreamGranted(granted, "miembros_hogar");
  if (!(hogarGranted || miembrosGranted)) {
    return `<div class="data-card"><h3><span class="tag">SIUBEN</span>${esc(t.householdFile)}</h3><p class="muted not-shared" data-not-shared="siuben">${esc(t.notShared)}</p></div>`;
  }
  if (!h && miembros.length === 0 && miembrosGranted) {
    return `<div class="data-card"><h3><span class="tag">SIUBEN</span>${esc(t.householdFile)}</h3><p class="muted">${esc(t.noData)}</p></div>`;
  }
  const icv = [h?.icv_grupo, h?.icv_descripcion].filter(Boolean).join(" · ");
  const place = [h?.municipio, h?.provincia].filter(Boolean).join(", ");
  const rows = miembros
    .map((m) => `<tr data-member><td>${esc(m.nombre)}</td><td>${esc(m.parentesco)}</td><td>${esc(m.edad)}</td></tr>`)
    .join("\n      ");
  const updated = formatDateLong(h?.source_updated_at, lang);
  const membersCount = isFieldGranted(granted, "clasificacion_hogar", "miembros_hogar")
    ? row(t.membersCount, h?.miembros_hogar)
    : notSharedRow(t, t.membersCount, "miembros_hogar_count");
  const hogarRows = hogarGranted
    ? `${row(t.icv, icv, ` data-icv="${esc(h?.icv_grupo)}"`)}
    ${row(t.place, place)}
    ${membersCount}`
    : notSharedRow(t, t.icv, "clasificacion_hogar");
  const members = miembrosGranted
    ? `<table>
    <thead><tr>${t.memberCols.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead>
    <tbody>
      ${rows}
    </tbody>
  </table>`
    : `<dl>${notSharedRow(t, t.members, "miembros_hogar")}</dl>`;
  return `<div class="data-card" data-source="siuben">
  <h3><span class="tag">SIUBEN</span>${esc(t.householdFile)}</h3>
  <dl>
    ${hogarRows}
  </dl>
  ${members}
  ${updated ? `<p class="muted">${esc(t.updated(updated))}</p>` : ""}
</div>`;
}

// SIUBEN label that names only the granted streams.
function sourceName(t, key, granted) {
  if (key !== "siuben" || !granted) {
    return t.sourceNames[key];
  }
  const hogar = "clasificacion_hogar" in granted;
  const miembros = "miembros_hogar" in granted;
  if (hogar && !miembros) {
    return t.sourceNames.siubenHogar;
  }
  return miembros && !hogar ? t.sourceNames.siubenMiembros : t.sourceNames.siuben;
}

// Sources with at least one granted stream.
function grantedSources(g) {
  const streamsOf = { siuben: ["clasificacion_hogar", "miembros_hogar"], sns: ["control_prenatal"] };
  return g.sources.filter((key) => !g.granted || (streamsOf[key] ?? []).some((s) => s in g.granted));
}

function grantCard(t, lang, result, purpose, misAutorizacionesUrl) {
  const g = result.grant;
  const status = g.revoked ? `<span class="revoked">${esc(t.revoked)}</span>` : `<span class="active">${esc(t.active)}</span>`;
  const sources = grantedSources(g).map((s) => `<div>${esc(sourceName(t, s, g.granted))}</div>`).join("");
  const reRead = g.revoked
    ? ""
    : `<form method="POST" action="/volver-a-consultar" class="inline-form" data-action="re-read"><button class="btn btn-outline-blue" type="submit">${esc(t.reRead)}</button></form>`;
  return `<aside class="auth-note" aria-label="${esc(t.grant)}" data-grant-id="${esc(g.ids[0] ?? "")}" data-grant-status="${g.revoked ? "revoked" : "active"}">
  <h3><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#003670" stroke-width="2" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>${esc(t.grant)}</h3>
  <dl>
    <dt>${esc(t.grantId)}</dt><dd>${g.ids.map((id) => `<code>${esc(id)}</code>`).join(" ")}</dd>
    <dt>${esc(t.grantPurpose)}</dt><dd>${esc(purpose)}</dd>
    <dt>${esc(t.grantSources)}</dt><dd>${sources}</dd>
    <dt>${esc(t.grantUntil)}</dt><dd>${esc(formatDateLong(g.until, lang))}</dd>
    <dt>${esc(t.grantStatus)}</dt><dd>${status}</dd>
  </dl>
  <div class="note-actions">
    ${reRead}
    <a href="${esc(misAutorizacionesUrl)}" target="_blank" rel="noopener" data-mis-autorizaciones>${esc(t.misAutorizaciones)}</a>
  </div>
</aside>`;
}

// Banner on /listo: revoked > re-read error > re-read OK > none.
function listoAlert(t, lang, result, notice, error) {
  const received = formatDateTime(result.receivedAt, lang, "date_time");
  if (result.grant.revoked) {
    return `<div class="alert-error" role="alert" data-notice="revoked">
  ${ICON_ERROR}
  <div><p><b>${esc(t.revokedTitle)}</b> ${esc(t.revokedBody(received))}</p>
  <div class="alert-actions">${yesForm(t.askAgain)}</div></div>
</div>`;
  }
  if (error) {
    return errorAlert(t, error);
  }
  if (notice?.kind === "verified") {
    return `<div class="alert-ok" role="status" data-notice="verified">
  ${ICON_OK}
  <div><b>${esc(t.verified(formatDateTime(notice.at, lang, "time")))}</b></div>
</div>`;
  }
  return "";
}

export function renderListo({ lang, result, notice, error, path, purpose, misAutorizacionesUrl }) {
  const t = T[lang];
  const received = formatDateTime(result.receivedAt, lang, "date_time");
  const due = formatDateLong(result.prenatal?.fecha_probable_parto, lang);
  const centre = result.prenatal?.centro_salud;
  const receivedLine = result.grant.revoked ? t.keptCopy(received) : t.receivedAt(received);

  const grantedList = result.grant.granted ? Object.keys(result.grant.granted).sort().join(" ") : "";
  const body = `<main class="container" data-granted-streams="${esc(grantedList)}">
  ${listoAlert(t, lang, result, notice, error)}
  <section class="done">
    <h1>${esc(t.doneTitle)}</h1>
    <p class="lead" data-lead>${esc(t.doneLead(due))}</p>
  </section>

  <div class="listo-layout">
    <div>
      <section class="card">
        <h2>${esc(t.planTitle)}</h2>
        <ul class="plan">
          <li>${esc(t.planVaccines(centre))}</li>
          <li>${esc(t.planBenefit)}</li>
        </ul>
      </section>
      <section class="card">
        <h2>${esc(t.received)}</h2>
        <p class="muted" data-received>${esc(receivedLine)}</p>
        <div class="data-cards">
          ${healthCard(t, lang, result.prenatal, result.grant.granted)}
          ${householdCard(t, lang, result.hogar, result.miembros, result.grant.granted)}
        </div>
      </section>
    </div>
    ${grantCard(t, lang, result, purpose, misAutorizacionesUrl)}
  </div>
</main>`;
  return layout({ body, lang, path, title: t.offerTitle });
}
