// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// DR demo: Spanish/English toggle for the citizen-facing pages.
//
// Resolution order: ?lang=es|en (the toggle link), ?ui_locales=… (OIDC, set
// by the requesting app so the whole flow follows its language), the
// DEMO_LANG_COOKIE, then Spanish.
//
//   resolveDemoLang(req)            -> "es" | "en"
//   pickLang(lang, "Hola", "Hello") -> the string for that language

export type DemoLang = "es" | "en";

export const DEMO_LANG_COOKIE = "pdpp_demo_lang";
export const DEMO_DEFAULT_LANG: DemoLang = "es";

const DEMO_LANGS: readonly DemoLang[] = ["es", "en"];
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

interface DemoLangRequest {
  headers: { cookie?: string | string[] | undefined };
  query?: unknown;
}

function asDemoLang(value: unknown): DemoLang | null {
  if (typeof value !== "string") {
    return null;
  }
  // "en-US es" -> "en": first tag, primary subtag.
  const primary = value.trim().split(/\s+/)[0]?.split("-")[0]?.toLowerCase() ?? "";
  return (DEMO_LANGS as readonly string[]).includes(primary) ? (primary as DemoLang) : null;
}

function queryValue(query: unknown, key: string): unknown {
  if (!query || typeof query !== "object") {
    return undefined;
  }
  return (query as Record<string, unknown>)[key];
}

function cookieValue(header: string | string[] | undefined, name: string): string | null {
  const raw = Array.isArray(header) ? header.join("; ") : (header ?? "");
  for (const part of raw.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) {
      return decodeURIComponent(rest.join("="));
    }
  }
  return null;
}

/** Language explicitly requested on this request (?lang or ?ui_locales), if any. */
export function requestedDemoLang(req: DemoLangRequest): DemoLang | null {
  return asDemoLang(queryValue(req.query, "lang")) ?? asDemoLang(queryValue(req.query, "ui_locales"));
}

/** The language to render this request in. */
export function resolveDemoLang(req: DemoLangRequest): DemoLang {
  return requestedDemoLang(req) ?? asDemoLang(cookieValue(req.headers.cookie, DEMO_LANG_COOKIE)) ?? DEMO_DEFAULT_LANG;
}

/** Set-Cookie value that remembers the chosen language. */
export function demoLangCookie(lang: DemoLang): string {
  return `${DEMO_LANG_COOKIE}=${lang}; Path=/; Max-Age=${COOKIE_MAX_AGE_SECONDS}; SameSite=Lax`;
}

export function pickLang(lang: DemoLang, es: string, en: string): string {
  return lang === "en" ? en : es;
}
