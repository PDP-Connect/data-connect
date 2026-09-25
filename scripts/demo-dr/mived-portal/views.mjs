// HTML views for the simulated MIVHED housing portal. Markup follows the
// design mock (scratchpad design/mivhed-solicitud.html). No logos, no escudo,
// fictitious contacts only.
//
//   renderSolicitud({ prefill: null, error })   -> "before" state (empty form)
//   renderSolicitud({ prefill: {...} })         -> "after" state (SIUBEN data)
//   renderSolicitud({ prefill, notice })        -> after a re-read: verified or revoked

const SOURCE_TAG = '<span class="tag">SIUBEN</span>';
const ACCESS_MODE_LABELS = { single_use: "Consulta única", continuous: "Acceso continuo" };

// Minimal HTML escaping for every interpolated value.
export function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// "2026-09-01T12:00:00Z" -> "01/09/2026" (date part only, no timezone math).
function formatDate(iso) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? ""));
  if (!match) {
    return "";
  }
  const [, y, m, d] = match;
  return `${d}/${m}/${y}`;
}

// "Rosa Elena Martínez Guzmán" -> { short: "Rosa E. Martínez", initials: "RM" }.
function shortName(fullName) {
  const parts = String(fullName ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return { initials: "", short: "" };
  }
  const first = parts[0];
  const surname = parts.length >= 4 ? parts[2] : parts[parts.length - 1];
  const middle = parts.length >= 4 ? ` ${parts[1][0]}.` : "";
  const short = parts.length === 1 ? first : `${first}${middle} ${surname}`;
  const initials = `${first[0]}${parts.length > 1 ? surname[0] : ""}`.toUpperCase();
  return { initials, short };
}

function field({ label, required, value, placeholder, full, hint, name }) {
  const filled = value !== undefined && value !== null && value !== "";
  const star = required ? " <span>*</span>" : "";
  const cls = filled ? ' class="filled"' : "";
  const val = filled ? ` value="${esc(value)}"` : "";
  return `<div class="f${full ? " full" : ""}">
  <label for="${name}">${esc(label)}${star}</label>
  <div class="input-wrap"><input id="${name}" name="${name}" type="text" placeholder="${esc(placeholder)}"${cls}${val}>${filled ? SOURCE_TAG : ""}</div>${hint ? `\n  <div class="hint">${esc(hint)}</div>` : ""}
</div>`;
}

function fieldsGrid(hogar) {
  const h = hogar ?? {};
  const icv = [h.icv_grupo, h.icv_descripcion].filter(Boolean).join(" · ");
  const programas = Array.isArray(h.programas_activos) ? h.programas_activos.join(", ") : h.programas_activos;
  return `<div class="grid">
${field({ full: true, label: "Nombre del jefe o jefa del hogar", name: "nombre_jefe", placeholder: "Nombre completo", required: true, value: h.nombre_jefe_hogar })}
${field({ label: "Cédula del jefe o jefa del hogar", name: "cedula_jefe", placeholder: "000-0000000-0", required: true, value: h.cedula_jefe_hogar })}
${field({ label: "Cantidad de miembros del hogar", name: "cantidad_miembros", placeholder: "0", required: true, value: h.miembros_hogar })}
${field({ label: "Provincia", name: "provincia", placeholder: "Selecciona una provincia", required: true, value: h.provincia })}
${field({ label: "Municipio", name: "municipio", placeholder: "Selecciona un municipio", required: true, value: h.municipio })}
${field({ hint: "Índice de Calidad de Vida del SIUBEN.", label: "Clasificación socioeconómica (ICV)", name: "icv", placeholder: "—", value: icv })}
${field({ label: "Programas sociales activos", name: "programas", placeholder: "—", value: programas })}
</div>`;
}

function membersTable(miembros) {
  const hasRows = Array.isArray(miembros) && miembros.length > 0;
  const body = hasRows
    ? miembros
        .map(
          (m) =>
            `<tr data-member><td>${esc(m.nombre)}</td><td>${esc(m.parentesco)}</td><td>${esc(m.edad)}</td><td>${esc(m.ocupacion)}</td></tr>`
        )
        .join("\n")
    : '<tr><td class="empty" colspan="4">Aún no has agregado miembros del hogar.</td></tr>';
  return `<h3 class="sub">Miembros del hogar${hasRows ? ` ${SOURCE_TAG}` : ""}</h3>
<table>
  <thead><tr><th>Nombre</th><th>Parentesco</th><th>Edad</th><th>Ocupación</th></tr></thead>
  <tbody>
${body}
  </tbody>
</table>`;
}

const PREFILL_PROMPT = `<div class="prefill">
  <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#003670" stroke-width="1.8" aria-hidden="true"><path d="M4 7h16M4 12h10M4 17h7"/><path d="m15 17 2 2 4-4"/></svg>
  <p>Puedes completar esta sección con la información de tu hogar registrada en el SIUBEN.
    <small>Te pediremos autorización en tu Cuenta Única antes de compartir cualquier dato. Solo se usará para esta solicitud.</small></p>
  <form method="POST" action="/siuben/start"><button class="btn btn-blue" type="submit">Completar con mis datos del SIUBEN</button></form>
</div>`;

function errorAlert(error) {
  if (!error) {
    return "";
  }
  return `<div class="alert-error" role="alert">
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#EE2A24" stroke-width="2.2" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 7v6M12 16.5v.5"/></svg>
  <div><p><b>${esc(error.title)}</b> ${esc(error.detail)}</p>${
    error.retry === false
      ? ""
      : `
  <form method="POST" action="/siuben/start" class="inline-form"><button class="btn btn-blue" type="submit" style="margin-top:10px">Intentar de nuevo</button></form>`
  }</div>
</div>`;
}

function successAlert(prefill) {
  const updated = formatDate(prefill.hogar?.source_updated_at);
  const asOf = updated ? ` Actualizados al ${esc(updated)}.` : "";
  return `<div class="alert-ok" role="status">
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#2ECC71" stroke-width="2.2" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="m8 12 3 3 5-6"/></svg>
  <div><b>Datos obtenidos del SIUBEN con tu autorización.</b>${asOf} Revisa la información; si algo no coincide, puedes corregirlo o <form method="POST" action="/siuben/clear" class="inline-form"><button type="submit" class="link-button">quitar los datos del SIUBEN</button></form>.</div>
</div>`;
}

// Re-read succeeded: the data were confirmed against SIUBEN just now.
function verifiedAlert(notice) {
  return `<div class="alert-ok" role="status">
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#2ECC71" stroke-width="2.2" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="m8 12 3 3 5-6"/></svg>
  <div><b>Datos verificados nuevamente con el SIUBEN a las ${esc(notice.time)}.</b></div>
</div>`;
}

// Re-read refused (401/403): the citizen withdrew the grant; only the old copy remains.
function revokedAlert(prefill) {
  return `<div class="alert-error" role="alert">
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#EE2A24" stroke-width="2.2" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 7v6M12 16.5v.5"/></svg>
  <div><p><b>El ciudadano revocó esta autorización.</b> MIVHED ya no puede consultar sus datos del SIUBEN. Se conserva solo la copia recibida el ${esc(prefill.receivedAt)}.</p>
  <form method="POST" action="/siuben/start" class="inline-form"><button class="btn btn-blue" type="submit" style="margin-top:10px">Solicitar autorización nuevamente</button></form></div>
</div>`;
}

function authNote(prefill, pdppOrigin) {
  const g = prefill.grant;
  const mode = ACCESS_MODE_LABELS[g.accessMode] ?? g.accessMode ?? "";
  const status = g.revoked ? '<span class="revoked">Revocada</span>' : "Vigente";
  const refresh = g.revoked
    ? ""
    : '<form method="POST" action="/siuben/refresh" class="inline-form"><button class="btn btn-outline-blue" type="submit">Volver a consultar el SIUBEN</button></form>';
  const grantUrl = `${pdppOrigin}/grants/${encodeURIComponent(g.id)}`;
  return `<aside class="auth-note" aria-label="Autorización">
  <h3><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#003670" stroke-width="2" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>Autorización</h3>
  <dl>
    <dt>Identificador</dt><dd><code>${esc(g.id)}</code></dd>
    <dt>Propósito</dt><dd>${esc(g.purpose)}</dd>
    <dt>Tipo de acceso</dt><dd>${esc(mode)}</dd>
    <dt>Estado</dt><dd>${status}</dd>
    <dt>Fuente</dt><dd>SIUBEN · clasificación del hogar y miembros del hogar</dd>
  </dl>
  <div class="note-actions">
    ${refresh}
    <a href="${esc(grantUrl)}" target="_blank" rel="noopener">Ver o revocar esta autorización</a>
  </div>
</aside>`;
}

function header(userName) {
  const user = userName
    ? `<span class="user"><span class="avatar">${esc(userName.initials)}</span>${esc(userName.short)}</span>`
    : '<span class="user">Iniciar sesión</span>';
  return `<header>
  <div class="topbar">
    <div class="container topbar-cont">
      <a class="logo" href="/">
        <span class="logo-icon" aria-hidden="true">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.8" stroke-linejoin="round"><path d="M3 11 12 4l9 7"/><path d="M5 10v10h14V10"/><path d="M10 20v-5h4v5"/></svg>
        </span>
        <span class="logo-text">Ministerio de Vivienda, Hábitat y <b>Edificaciones</b><small>Portal de servicios · simulación</small></span>
      </a>
      <div class="topbar-right">
        <span>Mis solicitudes</span>
        ${user}
        <span class="lang">ES</span>
      </div>
    </div>
  </div>
  <div class="main-menu">
    <div class="container">
      <nav class="menu">
        <a href="/">Inicio</a>
        <a href="/" class="active">Servicios</a>
        <a href="/">Programas</a>
        <a href="/">Transparencia</a>
        <a href="/">Contáctenos</a>
      </nav>
      <div class="search"><span>¿Qué quieres buscar?</span><b>Buscar</b></div>
    </div>
  </div>
</header>`;
}

const FOOTER = `<footer>
  <div class="footer-top">
    <div class="container row">
      <div class="footer-brand">Ministerio de Vivienda, Hábitat y Edificaciones<small>Portal simulado para demostración. No es un sitio oficial.</small></div>
      <div><div class="footer-title">Conócenos</div><ul><li>Sobre esta demostración</li></ul></div>
      <div><div class="footer-title">Contáctanos</div><ul><li>Tel: (000) 000-0000</li><li>demo@example.org</li></ul></div>
      <div><div class="footer-title">Búscanos</div><ul><li>Dirección ficticia para demostración</li></ul></div>
      <div><div class="footer-title">Infórmate</div><ul><li>Términos de uso</li><li>Política de privacidad</li><li>Preguntas frecuentes</li></ul></div>
    </div>
  </div>
  <div class="footer-bottom">
    <div class="container"><span>© 2026 Demostración · datos ficticios</span><span>No afiliado al MIVHED ni al Gobierno de la República Dominicana</span></div>
  </div>
</footer>`;

// Banner above the pre-filled form: revoked > refresh error > re-verified > first read.
function prefillAlert(prefill, notice, error) {
  if (prefill.grant.revoked) {
    return revokedAlert(prefill);
  }
  if (error) {
    return errorAlert(error);
  }
  if (notice?.kind === "verified") {
    return verifiedAlert(notice);
  }
  return successAlert(prefill);
}

// Full application page. `prefill` = { hogar, miembros, grant } or null.
export function renderSolicitud({ prefill, error, notice, pdppOrigin }) {
  const userName = prefill ? shortName(prefill.hogar?.nombre_jefe_hogar) : null;
  const top = prefill ? `${prefillAlert(prefill, notice, error)}\n${authNote(prefill, pdppOrigin)}` : `${errorAlert(error)}\n${PREFILL_PROMPT}`;
  const leftAction = prefill
    ? '<button class="btn btn-link" type="button">Agregar otro miembro</button>'
    : '<button class="btn btn-link" type="button">Llenar manualmente</button>';

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Solicitud de vivienda (simulación)</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/portal.css">
</head>
<body>
<div class="sim-bar" role="note">Simulación · no es el portal oficial <span>— demostración con datos ficticios</span></div>
${header(userName)}
<div class="breadcrumbs">
  <div class="container">
    <div class="page-title">Solicitud de vivienda</div>
    <div class="path"><a href="/">Inicio</a> / <a href="/">Servicios</a> / Solicitud de vivienda</div>
  </div>
</div>

<div class="container service">
  <h1>Solicitud de vivienda — Programa (demo)</h1>
  <p>Solicita tu inclusión en el programa de vivienda. Completa los datos de tu hogar, tu situación de vivienda actual y adjunta los documentos requeridos.</p>
  <div class="meta"><span class="chip">Duración estimada: 10 minutos</span><span class="chip">Costo: gratuito</span><span class="chip">Requiere Cuenta Única</span></div>
</div>

<div class="container layout">
  <ol class="steps">
    <li class="active" data-n="1"><b>Datos del hogar</b><small>Jefatura y miembros</small></li>
    <li data-n="2"><b>Vivienda actual</b><small>Tenencia y condiciones</small></li>
    <li data-n="3"><b>Documentos</b><small>Soportes requeridos</small></li>
    <li data-n="4"><b>Revisión y envío</b><small>Confirmar solicitud</small></li>
  </ol>

  <section class="section">
    <div class="section-head">
      <h2>Datos del hogar</h2>
      <span class="step">Paso 1 de 4</span>
    </div>
    <div class="section-body">
${top}
${fieldsGrid(prefill?.hogar)}
${membersTable(prefill?.miembros)}
      <div class="actions">
        ${leftAction}
        <div class="right">
          <button class="btn btn-outline-blue" type="button">Guardar borrador</button>
          <button class="btn btn-blue" type="button">Continuar</button>
        </div>
      </div>
    </div>
  </section>
</div>
${FOOTER}
</body>
</html>`;
}
