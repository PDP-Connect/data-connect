// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Minimal bilingual (Spanish first, English second) pages for the pilot.

import type { GuardianCapacity } from "./config.ts";
import { PILOT_PATHS } from "./config.ts";
import { formatCedula, type ParentSession } from "./cuenta-unica-stub.ts";
import type { RegistryChild } from "./registry-stub.ts";
import type { RepresentativeGrantRow } from "./store.ts";

export function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const CAPACITY_LABEL: Record<GuardianCapacity, { en: string; es: string }> = {
  legal_guardian: { en: "legal guardian", es: "tutor/a legal" },
  parent: { en: "parent", es: "madre o padre" },
};

export function capacityLabel(capacity: GuardianCapacity): {
  en: string;
  es: string;
} {
  return CAPACITY_LABEL[capacity];
}

function dateEs(iso: string | null): string {
  if (!iso) {
    return "—";
  }
  return new Date(iso).toLocaleDateString("es-DO", {
    day: "numeric",
    month: "long",
    timeZone: "UTC",
    year: "numeric",
  });
}

function dateEn(iso: string | null): string {
  if (!iso) {
    return "—";
  }
  return new Date(iso).toLocaleDateString("en-US", {
    day: "numeric",
    month: "long",
    timeZone: "UTC",
    year: "numeric",
  });
}

function bi(es: string, en: string, tag = "p"): string {
  return `<${tag}>${es}<span class="en">${en}</span></${tag}>`;
}

export function page(title: string, body: string, session?: ParentSession | null): string {
  const who = session
    ? `<div class="who">${esc(session.displayName)} · ${esc(formatCedula(session.cedula))}
        <form method="POST" action="${PILOT_PATHS.logout}"><input type="hidden" name="csrf_token" value="${esc(session.csrfToken)}"><button class="link">Salir / Sign out</button></form></div>`
    : "";
  return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root { --ink:#1b2430; --muted:#5b6675; --line:#d9dee5; --accent:#0b5cad; --bg:#f6f7f9; --ok:#1d7a46; --warn:#9a3412; }
  * { box-sizing: border-box; }
  body { margin:0; font:16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; color:var(--ink); background:var(--bg); }
  header { background:#fff; border-bottom:1px solid var(--line); padding:12px 16px; display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap; }
  header strong { font-size:15px; }
  main { max-width:640px; margin:24px auto; padding:0 16px; }
  .card { background:#fff; border:1px solid var(--line); border-radius:10px; padding:20px; margin-bottom:16px; }
  h1 { font-size:22px; margin:0 0 4px; } h2 { font-size:17px; margin:0 0 8px; }
  .en { display:block; color:var(--muted); font-size:14px; }
  h1 .en, h2 .en { font-weight:400; }
  dl { display:grid; grid-template-columns:max-content 1fr; gap:6px 16px; margin:12px 0; }
  dt { color:var(--muted); } dd { margin:0; }
  label { display:block; margin:12px 0 4px; font-weight:600; }
  input[type=text], input[type=password] { width:100%; padding:10px; border:1px solid var(--line); border-radius:6px; font:inherit; }
  .choice { display:flex; gap:10px; align-items:flex-start; padding:10px; border:1px solid var(--line); border-radius:8px; margin:8px 0; font-weight:400; }
  .actions { display:flex; gap:10px; flex-wrap:wrap; margin-top:16px; }
  button { font:inherit; padding:10px 16px; border-radius:6px; border:1px solid var(--accent); background:var(--accent); color:#fff; cursor:pointer; }
  button.secondary { background:#fff; color:var(--accent); }
  button.link { background:none; border:none; color:var(--accent); padding:0; text-decoration:underline; }
  .who { display:flex; gap:12px; align-items:center; font-size:14px; color:var(--muted); }
  .who form { margin:0; }
  .notice { border-left:4px solid var(--accent); padding:8px 12px; background:#eef4fb; border-radius:4px; }
  .refused { border-left-color:var(--warn); background:#fdf1ea; }
  .ok { border-left-color:var(--ok); background:#ecf7f0; }
  .tag { display:inline-block; font-size:12px; padding:2px 8px; border-radius:999px; background:#eef0f3; color:var(--muted); }
  .tag.active { background:#ecf7f0; color:var(--ok); }
</style></head><body>
<header><strong>Vacuna al día · piloto</strong>${who}</header>
<main>${body}</main></body></html>`;
}

export function loginPage(returnTo: string, error: boolean): string {
  return page(
    "Cuenta Única",
    `<div class="card">
      <h1>Cuenta Única (demo)<span class="en">National sign-in (demo stub)</span></h1>
      ${error ? `<p class="notice refused">Cédula o contraseña incorrecta.<span class="en">Wrong cédula or password.</span></p>` : ""}
      <form method="POST" action="${PILOT_PATHS.login}">
        <input type="hidden" name="return_to" value="${esc(returnTo)}">
        <label for="cedula">Cédula</label>
        <input id="cedula" name="cedula" type="text" inputmode="numeric" autocomplete="username" placeholder="000-0000000-0" required>
        <label for="password">Contraseña <span class="en">Password</span></label>
        <input id="password" name="password" type="password" autocomplete="current-password" required>
        <div class="actions"><button>Entrar / Sign in</button></div>
      </form>
    </div>`
  );
}

export function pickChildPage(
  session: ParentSession,
  requestUri: string,
  clientName: string | null,
  children: Array<RegistryChild & { capacity: GuardianCapacity }> | null
): string {
  const client = esc(clientName || "Una aplicación");
  const chooser =
    children === null
      ? bi(
          "Esta solicitud es para un registro específico. Primero verificaremos con el Registro Civil que usted puede autorizar en nombre de ese niño o niña.",
          "This request names one record. We will first check with the civil registry that you may approve on that child's behalf."
        )
      : children.length === 0
        ? `<p class="notice refused">El Registro Civil no tiene niños o niñas a su cargo.<span class="en">The civil registry lists no children in your care.</span></p>`
        : `${bi("¿Para cuál niño o niña?", "Which child is this for?", "h2")}
           ${children
             .map(
               (
                 c,
                 i
               ) => `<label class="choice"><input type="radio" name="child_id" value="${esc(c.child_id)}" ${i === 0 ? "required" : ""}>
                 <span>${esc(c.given_name)} ${esc(c.family_name)}<span class="en">${esc(capacityLabel(c.capacity).es)} / ${esc(capacityLabel(c.capacity).en)}</span></span></label>`
             )
             .join("")}`;
  return page(
    "Autorizar acceso",
    `<div class="card">
      <h1>${client} solicita un registro de vacunación<span class="en">${client} is requesting a vaccination record</span></h1>
      <form method="POST" action="${PILOT_PATHS.consent}/select">
        <input type="hidden" name="request_uri" value="${esc(requestUri)}">
        <input type="hidden" name="csrf_token" value="${esc(session.csrfToken)}">
        ${chooser}
        <div class="actions">
          ${children !== null && children.length === 0 ? "" : `<button>Continuar / Continue</button>`}
        </div>
      </form>
      <form method="POST" action="${PILOT_PATHS.consent}/deny">
        <input type="hidden" name="request_uri" value="${esc(requestUri)}">
        <input type="hidden" name="csrf_token" value="${esc(session.csrfToken)}">
        <div class="actions"><button class="secondary">No autorizar / Decline</button></div>
      </form>
    </div>`,
    session
  );
}

export function reviewPage(
  session: ParentSession,
  input: {
    capacity: GuardianCapacity;
    child: RegistryChild;
    clientName: string | null;
    expiresAt: string;
    pilotRevision: string;
    purposeDescription: string | null;
    requestUri: string;
    streams: string[];
  }
): string {
  const cap = capacityLabel(input.capacity);
  const childName = `${esc(input.child.given_name)} ${esc(input.child.family_name)}`;
  const client = esc(input.clientName || "Esta aplicación");
  return page(
    "Revisar autorización",
    `<div class="card">
      <p class="notice ok">Usted está actuando como <strong>${esc(cap.es)}</strong> de <strong>${childName}</strong>.
        <span class="en">You are acting as <strong>${esc(cap.en)}</strong> of <strong>${childName}</strong>.</span></p>
      <h1>${client} quiere leer el registro de vacunación de ${childName}<span class="en">${client} wants to read ${childName}'s vaccination record</span></h1>
      <dl>
        <dt>Registro<span class="en">Record</span></dt><dd>${esc(input.streams.join(", "))} · ${esc(input.child.child_id)}</dd>
        <dt>Propósito<span class="en">Purpose</span></dt><dd>${esc(input.purposeDescription || "Recordatorios de vacunación")}</dd>
        <dt>Acceso<span class="en">Access</span></dt><dd>Continuo (lecturas periódicas)<span class="en">Continuous (repeated reads)</span></dd>
        <dt>Vence<span class="en">Expires</span></dt><dd>${esc(dateEs(input.expiresAt))}<span class="en">${esc(dateEn(input.expiresAt))} — no later than the child's 18th birthday</span></dd>
      </dl>
      ${bi(
        "Puede retirar esta autorización en cualquier momento desde «Mis autorizaciones».",
        "You can withdraw this authorization at any time from “My authorizations”."
      )}
      <div class="actions">
        <form method="POST" action="${PILOT_PATHS.consent}/approve">
          <input type="hidden" name="request_uri" value="${esc(input.requestUri)}">
          <input type="hidden" name="pilot_revision" value="${esc(input.pilotRevision)}">
          <input type="hidden" name="csrf_token" value="${esc(session.csrfToken)}">
          <button>Autorizar / Approve</button>
        </form>
        <form method="POST" action="${PILOT_PATHS.consent}/deny">
          <input type="hidden" name="request_uri" value="${esc(input.requestUri)}">
          <input type="hidden" name="csrf_token" value="${esc(session.csrfToken)}">
          <button class="secondary">No autorizar / Decline</button>
        </form>
      </div>
    </div>`,
    session
  );
}

export function resultPage(
  session: ParentSession | null,
  kind: "approved" | "declined" | "refused",
  returnTo: string | null = null
): string {
  const body =
    kind === "approved"
      ? `<p class="notice ok">Autorización registrada.<span class="en">Authorization recorded.</span></p>`
      : kind === "declined"
        ? `<p class="notice">No se autorizó el acceso.<span class="en">Access was not authorized.</span></p>`
        : `<p class="notice refused">El Registro Civil no confirma que usted pueda autorizar en nombre de este niño o niña. No se compartió ningún dato.<span class="en">The civil registry does not confirm that you may approve on this child's behalf. No data was shared.</span></p>`;
  return page(
    "Resultado",
    `<div class="card">${body}
      ${returnTo ? `<p><a href="${esc(returnTo)}">Volver a la aplicación / Return to the app</a></p>` : ""}
      <p><a href="${PILOT_PATHS.authorizations}">Mis autorizaciones / My authorizations</a></p></div>`,
    session
  );
}

export function authorizationsPage(
  session: ParentSession,
  children: Array<RegistryChild & { capacity: GuardianCapacity }>,
  grants: Array<RepresentativeGrantRow & { approved_by_you: boolean }>,
  flash: string | null
): string {
  const byChild = new Map(children.map((c) => [c.child_id, c]));
  const rows = grants
    .map((g) => {
      const child = byChild.get(g.child_id);
      const name = child ? `${esc(child.given_name)} ${esc(child.family_name)}` : esc(g.child_id);
      const active = g.grant_status === "active" && !(g.expires_at && Date.parse(g.expires_at) <= Date.now());
      const status = active
        ? `<span class="tag active">Activa / Active</span>`
        : `<span class="tag">${g.revoked_at ? "Retirada / Withdrawn" : "Terminada / Ended"}${g.disposition ? ` · ${g.disposition === "delete" ? "borrar datos / delete data" : "conservar / keep"}` : ""}</span>`;
      const revoke = active
        ? `<form method="POST" action="${PILOT_PATHS.authorizations}/${esc(g.grant_id)}/revoke">
            <input type="hidden" name="csrf_token" value="${esc(session.csrfToken)}">
            <p><strong>¿Qué debe hacer la aplicación con los datos que ya recibió?</strong><span class="en">What should the app do with data it already received?</span></p>
            <label class="choice"><input type="radio" name="disposition" value="keep" required> <span>Conservarlos según el propósito aprobado<span class="en">Keep them, within the approved purpose</span></span></label>
            <label class="choice"><input type="radio" name="disposition" value="delete"> <span>Borrarlos<span class="en">Delete them</span></span></label>
            <div class="actions"><button>Retirar autorización / Withdraw</button></div>
          </form>`
        : "";
      return `<div class="card">
        <h2>${esc(g.client_display_name || g.client_id)} · ${name}</h2>
        ${status}
        <dl>
          <dt>Aprobada<span class="en">Approved</span></dt><dd>${esc(dateEs(g.approved_at))}${g.approved_by_you ? " · por usted / by you" : " · por otro tutor / by another guardian"}</dd>
          <dt>Vence<span class="en">Expires</span></dt><dd>${esc(dateEs(g.expires_at))}</dd>
        </dl>
        ${revoke}
      </div>`;
    })
    .join("");
  return page(
    "Mis autorizaciones",
    `<h1>Mis autorizaciones<span class="en">My authorizations</span></h1>
     ${flash ? `<p class="notice ok">${flash}</p>` : ""}
     ${rows || `<div class="card">${bi("No hay autorizaciones para los niños o niñas a su cargo.", "There are no authorizations for the children in your care.")}</div>`}`,
    session
  );
}

export function errorPage(session: ParentSession | null, status: number, message: string): string {
  return page("Error", `<div class="card"><h1>Error ${status}</h1><p>${esc(message)}</p></div>`, session);
}
