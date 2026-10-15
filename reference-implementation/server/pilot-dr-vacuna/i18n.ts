// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Spanish/English toggle for the pilot pages, ported from the September DR
// demo (demo/dr-pdpp: server/demo-i18n.ts). Spanish by default.
//
// Resolution order: ?lang=es|en (the toggle link), ?ui_locales=… (OIDC, set
// by the requesting app), the LANG_COOKIE, then Spanish.

export type Lang = "es" | "en";

export const LANG_COOKIE = "pdpp_demo_lang";
export const DEFAULT_LANG: Lang = "es";

const LANGS: readonly Lang[] = ["es", "en"];
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

interface LangRequest {
  headers: { cookie?: unknown };
  query?: unknown;
}

function asLang(value: unknown): Lang | null {
  if (typeof value !== "string") {
    return null;
  }
  // "en-US es" -> "en": first tag, primary subtag.
  const primary = value.trim().split(/\s+/)[0]?.split("-")[0]?.toLowerCase() ?? "";
  return (LANGS as readonly string[]).includes(primary) ? (primary as Lang) : null;
}

function queryValue(query: unknown, key: string): unknown {
  if (!query || typeof query !== "object") {
    return undefined;
  }
  return (query as Record<string, unknown>)[key];
}

function cookieValue(header: unknown, name: string): string | null {
  const raw = Array.isArray(header) ? header.join("; ") : typeof header === "string" ? header : "";
  for (const part of raw.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) {
      try {
        return decodeURIComponent(rest.join("="));
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Language explicitly requested on this request (?lang or ?ui_locales), if any. */
export function requestedLang(req: LangRequest): Lang | null {
  return asLang(queryValue(req.query, "lang")) ?? asLang(queryValue(req.query, "ui_locales"));
}

/** The language to render this request in. */
export function resolveLang(req: LangRequest): Lang {
  return requestedLang(req) ?? asLang(cookieValue(req.headers.cookie, LANG_COOKIE)) ?? DEFAULT_LANG;
}

/** Set-Cookie value that remembers the chosen language (shared by every page on the origin). */
export function langCookie(lang: Lang): string {
  return `${LANG_COOKIE}=${lang}; Path=/; Max-Age=${COOKIE_MAX_AGE_SECONDS}; SameSite=Lax`;
}

export function pick(lang: Lang, es: string, en: string): string {
  return lang === "en" ? en : es;
}

/** The URL (path + query) with `lang` set, for the ES | EN toggle. */
export function langHref(currentUrl: string, lang: Lang): string {
  const url = new URL(currentUrl || "/", "http://localhost");
  url.searchParams.set("lang", lang);
  return `${url.pathname}${url.search}`;
}
