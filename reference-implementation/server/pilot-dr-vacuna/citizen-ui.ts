// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Citizen-facing page shell for the pilot, ported from the September DR demo
// (demo/dr-pdpp: server/citizen-ui.ts). Mirrors the public Cuenta Única
// design tokens (DR blue, Poppins, pill buttons, 560px card) without any
// official marks. Every selector is `cu-` prefixed.
//
//   ┌ muted demo line: "Entorno de demostración · datos ficticios"  ES | EN ┐
//   ├ nav: text wordmark ───────────────────── [person · Mis autorizaciones · Salir]
//   │           ┌ card: glyph + title ┐                    │
//   │           │ body                │                    │
//   │           └─────────────────────┘                    │
//   ├ blue footer: brand · INFÓRMATE · CONTÁCTANOS · DEMO ─┤
//   └ "no afiliada a la OGTIC ni al Gobierno…" ────────────┘

import { type Lang, langHref, pick } from "./i18n.ts";

export type CitizenShell = "cuenta-unica" | "dr-consent" | "citizen-grants" | "landing";

interface ShellBrand {
  footerNote: string;
  subtitle: string;
  wordmark: string;
}

function shellBrand(shell: CitizenShell, lang: Lang): ShellBrand {
  const t = (es: string, en: string) => pick(lang, es, en);
  const notState = t("No es un servicio del Estado dominicano.", "Not a service of the Dominican State.");
  if (shell === "cuenta-unica") {
    return {
      footerNote: `${t("Simulación para demostración.", "Simulation for demonstration.")} ${notState}`,
      subtitle: t("Entorno de demostración", "Demo environment"),
      wordmark: "Cuenta Única",
    };
  }
  if (shell === "citizen-grants") {
    return {
      footerNote: `${t("Vista simulada para demostración.", "Simulated view for demonstration.")} ${notState}`,
      subtitle: t(
        "Vista simulada de cómo podría verse en Soy Yo RD",
        "Simulated view of how this could look in Soy Yo RD"
      ),
      wordmark: t("Mis autorizaciones", "My authorizations"),
    };
  }
  if (shell === "landing") {
    return {
      footerNote: `${t("Piloto de demostración con datos ficticios.", "Demo pilot with fictitious data.")} ${notState}`,
      subtitle: t("Piloto · demostración", "Pilot · demo"),
      wordmark: "Vacuna al día",
    };
  }
  return {
    footerNote: `${t(
      "Servicio de demostración que funciona junto a Cuenta Única.",
      "Demo service that works alongside Cuenta Única."
    )} ${notState}`,
    subtitle: t("Autorización en nombre de un niño o niña · demostración", "Authorization on behalf of a child · demo"),
    wordmark: t("Autorización de acceso a datos", "Data access authorization"),
  };
}

const FONT_HREF = "https://fonts.googleapis.com/css2?family=Poppins:wght@300;400;500;600;700&display=swap";

/** Generic line glyphs (no brand marks). */
export const CITIZEN_GLYPHS = {
  child: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="7" r="4"/><path d="M5 21v-1a7 7 0 0 1 14 0v1"/></svg>`,
  home: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 10.5 12 4l9 6.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/></svg>`,
  lock: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>`,
  shield: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/><path d="m9 12 2 2 4-4"/></svg>`,
  stop: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m5.6 5.6 12.8 12.8"/></svg>`,
} as const;

export const CITIZEN_CSS = `
:root {
  --cu-primary: #003876;
  --cu-primary-label: #003579;
  --cu-info: #0087FF;
  --cu-bg: #EFF7FF;
  --cu-card-border: #E2E2E2;
  --cu-card-head: #F8F8F8;
  --cu-card-head-border: #DFDFDF;
  --cu-field-border: #E6E7E8;
  --cu-text: #231F20;
  --cu-text-muted: #707070;
  --cu-required: #F44336;
  --cu-danger: #B3261E;
  --cu-ok: #1E6B34;
  --cu-footer-muted: #B3CBE6;
  --cu-hairline: #9FD0FD;
  --sim-bg: #FFF4CC;
  --sim-border: #E0B100;
  --sim-text: #5C4600;
}
.cu-page * { box-sizing: border-box; }
html, body.cu-page { margin: 0; }
body.cu-page {
  font-family: 'Poppins', system-ui, sans-serif;
  background: var(--cu-bg);
  color: var(--cu-text);
  -webkit-font-smoothing: antialiased;
}
.cu-sim-bar {
  max-width: 1400px; margin: 0 auto; padding: 4px 24px; text-align: right;
  font-size: 11px; font-weight: 400; color: var(--cu-text-muted); letter-spacing: .2px;
}
.cu-sim-lang { margin-left: 10px; white-space: nowrap; }
.cu-sim-lang a { color: var(--cu-text-muted); }
.cu-sim-lang a[aria-current="true"] { font-weight: 600; color: var(--cu-primary); text-decoration: none; }
.cu-nav { background: #fff; box-shadow: 0 1.5px 4px 0 #00000040; }
.cu-nav-inner { max-width: 1400px; margin: 0 auto; min-height: 72px; padding: 10px 24px; display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
.cu-wordmark { flex: 1; display: flex; flex-direction: column; line-height: 1.1; color: var(--cu-primary); text-decoration: none; min-width: 180px; }
.cu-wordmark b { font-size: 20px; font-weight: 700; letter-spacing: -.2px; }
.cu-wordmark small { font-size: 11px; font-weight: 500; color: var(--cu-text-muted); }
.cu-who { display: flex; align-items: center; gap: 14px; font-size: 13px; color: var(--cu-text-muted); flex-wrap: wrap; }
.cu-who b { color: var(--cu-primary); font-weight: 600; }
.cu-who form { margin: 0; }
.cu-who a { color: var(--cu-primary); font-weight: 500; }
.cu-linkbtn { background: none; border: 0; padding: 0; font: inherit; color: var(--cu-primary); text-decoration: underline; cursor: pointer; }
.cu-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 8px;
  min-height: 40px; padding: 8px 22px; border-radius: 60px; border: 0;
  font-family: inherit; font-size: 14px; font-weight: 500; letter-spacing: .4px;
  text-transform: uppercase; cursor: pointer; text-decoration: none; text-align: center;
  background: var(--cu-primary); color: #fff;
  box-shadow: 0 3px 1px -2px rgba(0,0,0,.2), 0 2px 2px 0 rgba(0,0,0,.14), 0 1px 5px 0 rgba(0,0,0,.12);
}
.cu-btn.cu-block { width: 100%; }
.cu-btn.cu-outline { background: #fff; color: var(--cu-primary); border: 1px solid var(--cu-primary); box-shadow: none; }
.cu-btn.cu-outline-danger { background: #fff; color: var(--cu-danger); border: 1px solid var(--cu-danger); box-shadow: none; }
.cu-main { padding: 50px 10px; display: flex; justify-content: center; }
.cu-card-wrap { width: 100%; max-width: 560px; }
.cu-card { background: #fff; border: 1px solid var(--cu-card-border); border-radius: 10px; }
.cu-card-head {
  min-height: 95px; display: flex; align-items: center; gap: 15px; padding: 13px 25px 13px;
  background: var(--cu-card-head); border-bottom: 1px solid var(--cu-card-head-border); border-radius: 10px 10px 0 0;
}
.cu-glyph { width: 47px; height: 47px; border-radius: 50%; background: var(--cu-primary); display: grid; place-items: center; flex: none; }
.cu-glyph.cu-glyph-danger { background: var(--cu-danger); }
.cu-card-head h1 { margin: 0; color: var(--cu-primary); font-size: 21px; font-weight: 500; line-height: 1.3; }
.cu-card-body { padding: 25px 25px 35px; }
.cu-client {
  display: flex; align-items: center; gap: 10px; background: var(--cu-bg); border: 1px solid var(--cu-hairline);
  border-radius: 8px; padding: 10px 14px; margin-bottom: 22px; font-size: 13px; color: var(--cu-primary);
}
.cu-client b { font-weight: 600; }
.cu-lead { text-align: center; color: var(--cu-primary); font-size: 14px; font-weight: 500; margin: 0 0 26px; line-height: 1.5; }
.cu-error {
  background: #FDECEA; border: 1px solid #F5C2C0; color: var(--cu-danger); border-radius: 8px;
  padding: 10px 14px; margin-bottom: 22px; font-size: 13px; font-weight: 500; line-height: 1.5;
}
.cu-ok { background: #E6F4EA; border: 1px solid #A8D5B5; color: var(--cu-ok); border-radius: 8px; padding: 10px 14px; margin: 0 0 18px; font-size: 13px; font-weight: 500; line-height: 1.5; }
.cu-acting { background: var(--cu-bg); border: 1px solid var(--cu-hairline); border-left: 4px solid var(--cu-primary); border-radius: 8px; padding: 12px 14px; margin: 0 0 22px; font-size: 14px; line-height: 1.5; color: var(--cu-primary); }
.cu-acting b { font-weight: 600; }
.cu-field { position: relative; margin-bottom: 22px; }
.cu-field input {
  width: 100%; height: 56px; padding: 16.5px 14px; border-radius: 4px; border: 1px solid var(--cu-field-border);
  background: #fff; font-family: inherit; font-size: 16px; color: var(--cu-text); outline: none;
}
.cu-field input::placeholder { color: #A0A0A0; }
.cu-field input:hover { border-color: var(--cu-primary); }
.cu-field input:focus { border: 2px solid var(--cu-primary); padding: 15.5px 13px; }
.cu-field.cu-has-adorn input { padding-right: 48px; }
.cu-field.cu-has-adorn input:focus { padding-right: 47px; }
.cu-field label {
  position: absolute; left: 10px; top: -10px; padding: 0 4px; background: #fff;
  font-size: 12px; line-height: 1.6; color: var(--cu-primary-label); font-weight: 400;
}
.cu-field label span { color: var(--cu-required); }
.cu-adorn {
  position: absolute; right: 8px; top: 8px; width: 40px; height: 40px; border: 0; background: transparent;
  color: var(--cu-text-muted); cursor: pointer; display: grid; place-items: center; border-radius: 50%;
}
.cu-row-links { display: flex; justify-content: flex-end; margin: -10px 0 22px; }
a.cu-link { color: var(--cu-info); font-size: 14px; text-decoration: underline; }
.cu-alt { text-align: center; font-size: 14px; line-height: 21px; margin-top: 22px; }
.cu-alt .cu-q { color: var(--cu-primary); }
.cu-divider { display: flex; align-items: center; gap: 12px; color: var(--cu-text-muted); font-size: 12px; margin: 22px 0; }
.cu-divider::before, .cu-divider::after { content: ""; flex: 1; height: 1px; background: var(--cu-hairline); }
.cu-title { margin: 0 0 8px; color: var(--cu-primary); font-size: 18px; font-weight: 600; line-height: 1.35; }
.cu-text { margin: 0 0 22px; font-size: 14px; line-height: 1.6; color: var(--cu-text); }
.cu-summary { margin: 0 0 22px; border: 1px solid var(--cu-card-border); border-radius: 8px; }
.cu-summary > div { display: grid; grid-template-columns: 140px 1fr; gap: 12px; padding: 12px 14px; border-top: 1px solid #EEF0F2; }
.cu-summary > div:first-child { border-top: 0; }
.cu-summary dt { font-size: 13px; color: var(--cu-text-muted); font-weight: 500; }
.cu-summary dd { margin: 0; font-size: 14px; color: var(--cu-text); line-height: 1.5; overflow-wrap: anywhere; }
.cu-note { display: block; font-size: 12px; color: var(--cu-text-muted); margin-top: 2px; line-height: 1.5; }
.cu-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
.cu-chip { font-size: 12px; background: var(--cu-bg); color: var(--cu-primary); border: 1px solid var(--cu-hairline); border-radius: 60px; padding: 2px 10px; }
.cu-choices { display: grid; gap: 10px; margin: 0 0 22px; padding: 0; border: 0; }
.cu-choices legend { font-size: 14px; font-weight: 600; color: var(--cu-primary); margin-bottom: 10px; padding: 0; }
.cu-choice { display: flex; gap: 12px; align-items: center; padding: 12px 14px; border: 1px solid var(--cu-card-border); border-radius: 8px; cursor: pointer; font-size: 14px; }
.cu-choice:hover { border-color: var(--cu-primary); }
.cu-choice:has(input:checked) { border-color: var(--cu-primary); background: var(--cu-bg); }
.cu-choice input { accent-color: var(--cu-primary); width: 18px; height: 18px; margin: 0; flex: none; }
.cu-choice b { display: block; color: var(--cu-primary); font-weight: 600; }
.cu-choice small { display: block; font-size: 12px; color: var(--cu-text-muted); }
.cu-actions { display: grid; gap: 12px; }
.cu-actions form { margin: 0; }
.cu-steps { margin: 0 0 22px; padding-left: 20px; font-size: 14px; line-height: 1.6; }
.cu-steps li { margin-bottom: 6px; }
.cu-footer-top { background: var(--cu-primary); padding: 56px 25px; }
.cu-foot-inner { max-width: 1400px; margin: 0 auto; padding: 0 24px; }
.cu-foot-grid { display: grid; grid-template-columns: 1.2fr 1fr 1fr 1.4fr; gap: 32px; }
.cu-foot-grid h4 { color: #fff; font-size: 16px; font-weight: 600; margin: 0 0 8px; }
.cu-foot-grid p { color: var(--cu-footer-muted); font-size: 15px; line-height: 1.6; margin: 0; }
.cu-foot-brand { color: #fff; font-size: 20px; font-weight: 700; line-height: 1.2; }
.cu-foot-brand small { display: block; font-size: 12px; font-weight: 400; color: var(--cu-footer-muted); margin-top: 6px; }
.cu-footer-bottom { background: #fff; padding: 12px 25px; }
.cu-footer-bottom p { margin: 0; font-size: 12px; font-weight: 600; color: var(--cu-primary); }
@media (max-width: 720px) {
  .cu-sim-bar { padding: 4px 16px; }
  .cu-nav-inner { padding: 10px 16px; }
  .cu-main { padding: 28px 16px; }
  .cu-foot-grid { grid-template-columns: 1fr 1fr; }
  .cu-footer-top { padding: 36px 0; }
  .cu-foot-inner { padding: 0 16px; }
  .cu-card-head { padding: 13px 16px; min-height: 80px; }
  .cu-card-head h1 { font-size: 18px; }
  .cu-card-body { padding: 20px 16px 28px; }
  .cu-summary > div { grid-template-columns: 1fr; gap: 2px; }
}
`;

export function escapeText(input: unknown): string {
  return String(input ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Card with a round glyph header, as in the Cuenta Única auth card. */
export function renderCitizenCard({
  body,
  glyph,
  glyphTone = "primary",
  headingId = "cu-page-title",
  title,
}: {
  body: string;
  glyph: string;
  glyphTone?: "primary" | "danger";
  headingId?: string;
  title: string;
}): string {
  const tone = glyphTone === "danger" ? " cu-glyph-danger" : "";
  return `<div class="cu-card">
  <div class="cu-card-head"><div class="cu-glyph${tone}">${glyph}</div><h1 id="${escapeText(headingId)}">${escapeText(title)}</h1></div>
  <div class="cu-card-body">${body}</div>
</div>`;
}

function renderLangToggle(lang: Lang, currentUrl: string): string {
  const link = (target: Lang) => {
    const current = target === lang ? ` aria-current="true"` : "";
    const href = escapeText(langHref(currentUrl, target));
    return `<a data-lang-toggle="${target}" href="${href}" hreflang="${target}"${current}>${target.toUpperCase()}</a>`;
  };
  return `<span class="cu-sim-lang">${link("es")} | ${link("en")}</span>`;
}

/**
 * Full standalone document; `body` goes inside the centered 560px column.
 * `currentUrl` (path + query of a GET-able page) is where the ES | EN toggle
 * links point. `navAction` is raw HTML for the right side of the nav.
 */
export function renderCitizenDocument({
  body,
  currentUrl,
  lang,
  navAction = "",
  script = "",
  shell,
  title,
}: {
  body: string;
  currentUrl: string;
  lang: Lang;
  navAction?: string;
  script?: string;
  shell: CitizenShell;
  title: string;
}): string {
  const brand = shellBrand(shell, lang);
  const t = (es: string, en: string) => pick(lang, es, en);
  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${escapeText(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="stylesheet" href="${FONT_HREF}" />
<style>${CITIZEN_CSS}</style>
</head>
<body class="cu-page" data-shell="${shell}" data-lang="${lang}">
<div class="cu-sim-bar" role="note">${t("Entorno de demostración · datos ficticios", "Demo environment · fictitious data")}${renderLangToggle(lang, currentUrl)}</div>
<nav class="cu-nav"><div class="cu-nav-inner">
  <span class="cu-wordmark"><b>${escapeText(brand.wordmark)}</b><small>${escapeText(brand.subtitle)}</small></span>
  ${navAction}
</div></nav>
<main class="cu-main" aria-labelledby="cu-page-title"><div class="cu-card-wrap">
${body}
</div></main>
<footer>
  <div class="cu-footer-top"><div class="cu-foot-inner cu-foot-grid">
    <div class="cu-foot-brand">${escapeText(brand.wordmark)}<small>${escapeText(brand.footerNote)}</small></div>
    <div><h4>${t("INFÓRMATE", "LEARN MORE")}</h4><p>${t("Términos de uso", "Terms of use")}</p><p>${t("Política de privacidad", "Privacy policy")}</p><p>${t("Preguntas frecuentes", "Frequently asked questions")}</p></div>
    <div><h4>${t("CONTÁCTANOS", "CONTACT US")}</h4><p>Tel: (000) 000-0000</p><p>demo@example.org</p></div>
    <div><h4>${t("SOBRE ESTA DEMO", "ABOUT THIS DEMO")}</h4><p>${t("Pantalla simulada. Los datos mostrados son ficticios.", "Simulated screen. The data shown is fictitious.")}</p></div>
  </div></div>
  <div class="cu-footer-bottom"><div class="cu-foot-inner"><p>${t(
    "© 2026 Demostración · no afiliada a la OGTIC ni al Gobierno de la República Dominicana.",
    "© 2026 Demo · not affiliated with OGTIC or the Government of the Dominican Republic."
  )}</p></div></div>
</footer>
${script ? `<script>${script}</script>` : ""}
</body>
</html>`;
}
