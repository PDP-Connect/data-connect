// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Reference-only owner-auth placeholder.
 *
 * This module adds a minimal local-only session gate in front of the
 * reference approval UIs (`/consent*`, `/device*`). It is intentionally
 * narrow:
 *
 *   - enabled when an environment password or app-managed verifier is present
 *   - single-password, single-owner model
 *   - no user table or external IdP; app-managed passwords change in Settings
 *   - opaque session cookie with a server-side validation seam
 *
 * It is NOT a PDPP protocol surface. It is NOT a full owner-authentication
 * product. See
 * `openspec/changes/reference-implementation-program/design-notes/owner-auth-placeholder-open-question-2026-04-22.md`
 * for scope and rationale.
 */
import crypto from "node:crypto";
import { DATACONNECT_PRODUCT_IDENTITY } from "../vendor/brand-react/src/product-identity.ts";
import { CITIZEN_GLYPHS, renderCitizenCard, renderCitizenDocument } from "./citizen-ui.ts";
import { type DemoLang, pickLang, resolveDemoLang } from "./demo-i18n.ts";
import {
  escapeHtml as hostedEscape,
  readHostedThemeChoiceFromCookieHeader,
  renderActionRow,
  renderHostedDocument,
  renderKeyValueList,
  renderPageIntro,
  renderResultState,
  renderSurface,
} from "./hosted-ui.ts";
import {
  buildOwnerCsrfClearCookie,
  buildOwnerCsrfSetCookie,
  generateOwnerCsrfSecret,
  issueOwnerCsrfToken,
  OWNER_CSRF_COOKIE_NAME,
  OWNER_CSRF_FIELD_NAME,
  type OwnerCsrfSecret,
  readCsrfTokenFromCookieHeader,
  renderCsrfHiddenField,
  validateOwnerCsrfPair,
  verifyOwnerCsrfToken,
} from "./owner-csrf.ts";
import {
  createOwnerLoginRateLimiter,
  type OwnerLoginRateLimitConfig,
  type OwnerLoginRateLimiter,
} from "./owner-login-rate-limit.ts";
import {
  createOwnerSessionController,
  OWNER_SESSION_COOKIE_NAME,
  OWNER_SESSION_DEFAULT_SUBJECT_ID,
  OWNER_SESSION_DEFAULT_TTL_SECONDS,
  parseCookieHeader,
  type OwnerSessionController,
  type OwnerSessionPayload,
  type OwnerSessionRecord,
  type OwnerSessionStore,
  type OwnerSessionSameSite,
} from "./owner-session.ts";
import {
  createOwnerPasswordVerifier,
  OWNER_PASSWORD_MIN_LENGTH,
  verifyOwnerPassword,
  type OwnerPasswordVerifier,
} from "./owner-password-verifier.ts";
import type { OwnerPasswordVerifierStore } from "./stores/owner-password-verifier-store.ts";
import { getOwnerSessionStore } from "./stores/owner-session-store.ts";

const DEFAULT_RETURN_TO = "/owner/login";

// Minimal structural interfaces for the Express request/response surface
// actually used inside this module. We don't import express's type tree
// because this module is also driven by tests that fabricate a tiny
// request shim — keeping the contract local keeps the coupling honest.

interface AuthRequestHeaders {
  readonly accept?: string;
  readonly cookie?: string;
  readonly host?: string;
  readonly referer?: string;
  readonly referrer?: string;
  readonly "x-forwarded-proto"?: string;
  readonly "user-agent"?: string;
  readonly "x-pdpp-owner-session-label"?: string;
}

interface AuthRequest {
  readonly body?: Record<string, unknown>;
  readonly connection?: { readonly remoteAddress?: string };
  readonly headers: AuthRequestHeaders;
  readonly ip?: string;
  readonly method?: string;
  readonly originalUrl?: string;
  ownerSession?: OwnerSessionPayload;
  readonly query?: Record<string, unknown>;
  readonly params?: Record<string, string | undefined>;
  readonly secure?: boolean;
  readonly socket?: { readonly remoteAddress?: string };
  readonly url?: string;
}

interface AuthResponse {
  end: () => void;
  getHeader?: (name: string) => unknown;
  json: (body: Record<string, unknown>) => AuthResponse;
  redirect: (url: string) => void;
  send: (body: string) => AuthResponse;
  setHeader: (name: string, value: string | string[]) => AuthResponse;
  status: (code: number) => AuthResponse;
}

type AuthNextFunction = () => void;

interface AuthAppLike {
  get: (path: string, handler: (req: AuthRequest, res: AuthResponse) => unknown) => void;
  post: (path: string, handler: (req: AuthRequest, res: AuthResponse) => unknown) => void;
}

interface LoginPageOptions {
  clientName?: string | null;
  csrfToken: string;
  error: string | null;
  lang: DemoLang;
  providerName: string;
  returnTo: string;
  themeChoice?: string;
}

interface DisabledPageOptions {
  providerName: string;
  themeChoice?: string;
}

interface SignedInPageOptions {
  csrfToken: string;
  providerName: string;
  subjectId: string;
  themeChoice?: string;
}

export interface OwnerAuthPlaceholderOptions {
  /**
   * When owner auth is DISABLED (no password), this controls whether
   * `requireOwnerSession` falls through to the open local-dev behavior
   * (`true`, the historical default) or fails closed with a 401 / login
   * redirect (`false`). The host computes this from the owner-exposure
   * posture: it is `true` only in a local-dev (loopback) posture, and `false`
   * on any internet-facing deployment. Security audit S-1: an unset password
   * must never silently open the owner control plane on a hosted surface.
   * Defaults to `true` to preserve the password-optional convenience for the
   * unit-test fixtures that construct this directly without a posture.
   */
  allowUnauthenticatedWhenDisabled?: boolean;
  /**
   * Optional explicit CSRF HMAC secret. Defaults to a fresh random
   * 32-byte buffer minted per process. The default is the right
   * answer for almost everyone — explicit override exists only for
   * tests, deterministic fixtures, and the rare deployment that needs
   * a stable secret across restarts. Operators SHALL NOT set this to
   * a password-derived value.
   */
  csrfSecret?: OwnerCsrfSecret | null;
  forceSecureCookies?: boolean;
  /**
   * Login-attempt throttling config for `POST /owner/login`. Pass `false` to
   * disable throttling entirely (test fixtures only — every real deployment
   * should keep the default). See `owner-login-rate-limit.ts` for the
   * research-grounded design (time-boxed, self-clearing, local/remote split).
   */
  loginRateLimit?: OwnerLoginRateLimitConfig | false;
  password?: string | null;
  passwordVerifier?: OwnerPasswordVerifier | null;
  providerName?: string;
  /** Resolves a client_id to its display name for the sign-in page (injected; avoids importing the AS). */
  clientNameLookup?: ClientNameLookup | null;
  sameSite?: OwnerSessionSameSite;
  sessionTtlSeconds?: number;
  subjectId?: string | null;
  sessionStore?: OwnerSessionStore | null;
  passwordVerifierStore?: OwnerPasswordVerifierStore | null;
}

export interface OwnerAuthPlaceholder {
  attachRoutes: (app: AuthAppLike) => void;
  readonly csrfCookieName: string;
  readonly csrfFieldName: string;
  readonly enabled: boolean;
  /** Install the verifier after a successful first-run claim. */
  setPasswordVerifier: (verifier: OwnerPasswordVerifier) => void;
  ensureCsrfToken: (req: AuthRequest, res: AuthResponse) => string;
  /** Watch a successful logout for this session; callers remove the listener on disconnect. */
  onSessionLogout: (req: AuthRequest, listener: () => void) => () => void;
  /**
   * Soft session reader — returns the validated owner session payload when
   * the request carries one, or null when it doesn't. Unlike
   * `requireOwnerSession`, this never sends a response. Use from routes that
   * accept anonymous traffic but want to behave differently when an owner
   * happens to be signed in (e.g. `/oauth/register` stamping
   * `issuer_subject_id`).
   */
  readOwnerSession: (req: AuthRequest) => Promise<OwnerSessionPayload | null>;
  readOwnerAuthorizationFence: (
    req: AuthRequest
  ) => Promise<{ credentialRevision?: string | null; sessionIdHash?: string } | null>;
  renderCsrfField: (token: string) => string;
  requireCsrf: (req: AuthRequest, res: AuthResponse, next: AuthNextFunction) => void;
  requireOwnerSession: (req: AuthRequest, res: AuthResponse, next: AuthNextFunction) => Promise<void>;
  readonly subjectId: string;
}

function timingSafeEqualString(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function isSecureRequest(req: AuthRequest): boolean {
  if (req.secure) {
    return true;
  }
  const forwarded = req.headers["x-forwarded-proto"];
  if (typeof forwarded === "string") {
    // biome-ignore lint/style/useDestructuring: Explicit property or positional access documents this compatibility boundary.
    const first = forwarded.split(",")[0];
    if (first && first.trim() === "https") {
      return true;
    }
  }
  return false;
}

function wantsHtml(req: AuthRequest): boolean {
  // biome-ignore lint/style/useDestructuring: Explicit property or positional access documents this compatibility boundary.
  const accept = req.headers.accept;
  if (typeof accept !== "string") {
    return false;
  }
  // Accept headers from browsers always include text/html; API clients
  // typically send application/json or */* without text/html.
  return accept.includes("text/html");
}

const AUTHORIZE_PATH = "/oauth/authorize";

// DR demo: cédula mask (000-0000000-0) and password show/hide toggle.
const LOGIN_PAGE_SCRIPT = `(function () {
  var cedula = document.getElementById("hosted-ui-cedula");
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
  var pw = document.getElementById("hosted-ui-password");
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

/**
 * Name of the app the owner continues to, from the authorize URL's client_id.
 * Best effort: any lookup failure falls back to generic copy.
 */
async function resolveLoginClientName(returnTo: string, lookup: ClientNameLookup | null): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(returnTo, "http://localhost");
  } catch {
    return null;
  }
  const clientId = url.pathname === AUTHORIZE_PATH ? url.searchParams.get("client_id") : null;
  if (!(clientId && lookup)) {
    return null;
  }
  try {
    return await lookup(clientId);
  } catch {
    return null;
  }
}

// DR demo: sign-in copy; the error strings are shown in the red alert.
const LOGIN_ERRORS = {
  csrf: [
    "La sesión expiró o el formulario ya se envió. Inténtalo de nuevo.",
    "The session expired or the form was already sent. Please try again.",
  ],
  passwordChanged: [
    "La contraseña cambió durante el inicio de sesión. Inténtalo de nuevo con la contraseña actual.",
    "The password changed while signing in. Try again with the current password.",
  ],
  wrongPassword: ["La cédula o la contraseña no son correctas.", "The cédula or the password is not correct."],
} as const;

function loginError(lang: DemoLang, key: keyof typeof LOGIN_ERRORS): string {
  const [es, en] = LOGIN_ERRORS[key];
  return pickLang(lang, es, en);
}

function renderLoginPage({ clientName, error, lang, returnTo, csrfToken }: LoginPageOptions): string {
  const t = (es: string, en: string) => pickLang(lang, es, en);
  const safeReturnTo = typeof returnTo === "string" ? returnTo : "";
  const errorBlock = error ? `<div class="hosted-ui-error cu-error" role="alert">${hostedEscape(error)}</div>` : "";
  const continueTo = clientName
    ? `${t("Continuarás a", "You will continue to")} <b>${hostedEscape(clientName)}</b>`
    : t("Continuarás a la aplicación que solicitó tus datos", "You will continue to the app that requested your data");

  // DR demo: simulated Cuenta Única sign-in. The cédula field is
  // presentational only; the owner password is still the real check.
  const body = `<div class="cu-client">${CITIZEN_GLYPHS.home}<span>${continueTo}</span></div>
<p class="cu-lead">${t("Inicia sesión con tu número de cédula y contraseña.", "Sign in with your cédula number and password.")}</p>
<form method="POST" action="/owner/login" data-surface="human" aria-label="${t("Inicio de sesión", "Sign in")}">
  ${renderCsrfHiddenField(csrfToken)}
  <input type="hidden" name="return_to" value="${hostedEscape(safeReturnTo)}" />
  ${errorBlock}
  <div class="cu-field">
    <label for="hosted-ui-cedula">${t("Número de cédula", "Cédula number")} <span>*</span></label>
    <input id="hosted-ui-cedula" type="text" name="cedula_demo" inputmode="numeric" autocomplete="username" value="000-1234567-8" placeholder="000-0000000-0" maxlength="13" />
  </div>
  <div class="cu-field cu-has-adorn">
    <label for="hosted-ui-password">${t("Contraseña", "Password")} <span>*</span></label>
    <input id="hosted-ui-password" type="password" name="password" autofocus autocomplete="current-password" required />
    <button type="button" class="cu-adorn" id="cu-toggle-password" aria-label="${t("Mostrar contraseña", "Show password")}" data-label-show="${t("Mostrar contraseña", "Show password")}" data-label-hide="${t("Ocultar contraseña", "Hide password")}" aria-pressed="false">${EYE_ICON}</button>
  </div>
  <div class="cu-row-links"><a class="cu-link" href="#">${t("¿Olvidaste tu contraseña?", "Forgot your password?")}</a></div>
  <button type="submit" class="cu-btn cu-block">${t("Iniciar sesión", "Sign in")} ${ARROW_ICON}</button>
</form>
<div class="cu-divider">${t("o", "or")}</div>
<a class="cu-btn cu-outline cu-block" href="#">${t("Recuperar cuenta", "Recover account")}</a>
<div class="cu-alt"><span class="cu-q">${t("¿No tienes una cuenta?", "Don't have an account?")}</span> <a class="cu-link" href="#">${t("Regístrate aquí.", "Register here.")}</a></div>`;

  // The toggle keeps return_to so the sign-in still continues to the app.
  const currentUrl = safeReturnTo ? `/owner/login?return_to=${encodeURIComponent(safeReturnTo)}` : "/owner/login";
  const cardTitle = t("Cuenta Única Ciudadana", "Cuenta Única citizen account");
  return renderCitizenDocument({
    body: renderCitizenCard({ body, glyph: CITIZEN_GLYPHS.lock, title: cardTitle }),
    currentUrl,
    lang,
    script: LOGIN_PAGE_SCRIPT,
    shell: "cuenta-unica",
    title: t("Cuenta Única Ciudadana (simulación) · Iniciar sesión", "Cuenta Única (simulation) · Sign in"),
  });
}

function renderOwnerAuthDisabledPage({ providerName, themeChoice }: DisabledPageOptions): string {
  const body = [
    renderPageIntro({
      eyebrow: "Owner approval UI",
      lede: "No owner password is set, so approval pages open without sign-in.",
      title: `${providerName} owner access`,
    }),
    renderSurface({
      ariaLabel: "Owner auth status",
      children: renderResultState({
        body: "Device approvals are open locally. Consent approvals still arrive through pending request links.",
        footnote: "Set PDPP_OWNER_PASSWORD to require sign-in.",
        title: "Sign-in is not required right now",
        tone: "neutral",
      }),
      surface: "human",
    }),
    renderSurface({
      ariaLabel: "Owner auth configuration details",
      children: renderKeyValueList([
        { label: "Current mode", value: "Open local-dev approval UI" },
        {
          html: "<code>PDPP_OWNER_PASSWORD=&lt;password&gt;</code>",
          label: "Enable sign-in",
        },
        {
          label: "Protected when enabled",
          value: "/consent*, /device*, /owner/login",
        },
        {
          label: "Consent pages",
          value: "Reached from a pending request authorization_url / request_uri flow",
        },
      ]),
      surface: "protocol",
    }),
    renderActionRow([{ href: "/device", label: "Open device approval UI", variant: "primary" }]),
  ].join("\n");

  return renderHostedDocument({
    body,
    providerName,
    themeChoice,
    title: `${providerName} — Owner access`,
  });
}

function renderSignedInOwnerPage({ providerName, subjectId, csrfToken, themeChoice }: SignedInPageOptions): string {
  const body = [
    renderPageIntro({
      eyebrow: "Owner approval UI",
      lede: `You are signed in to ${providerName}.`,
      title: `${providerName} owner access`,
    }),
    renderSurface({
      ariaLabel: "Signed-in owner state",
      children: [
        renderResultState({
          body: "You can approve device flows directly here, or open a pending consent URL from a staged provider-connect request.",
          footnote: "Sign out when you finish on a shared computer.",
          title: "Signed in",
          tone: "success",
        }),
        renderKeyValueList([
          {
            html: `<code>${hostedEscape(subjectId)}</code>`,
            label: "Owner subject",
          },
        ]),
      ].join("\n"),
      surface: "human",
    }),
    renderActionRow([
      {
        href: "/",
        label: `Open ${DATACONNECT_PRODUCT_IDENTITY.name}`,
        variant: "primary",
      },
      { href: "/device", label: "Open device approval UI" },
      {
        action: "/owner/logout",
        hidden: [{ name: OWNER_CSRF_FIELD_NAME, value: csrfToken }],
        label: "Sign out",
      },
    ]),
  ].join("\n");

  return renderHostedDocument({
    body,
    providerName,
    themeChoice,
    title: `${providerName} — Owner access`,
  });
}

function pickReferrerHeader(headers: AuthRequestHeaders): string {
  if (typeof headers.referer === "string") {
    return headers.referer;
  }
  if (typeof headers.referrer === "string") {
    return headers.referrer;
  }
  return "";
}

// ASCII control chars (U+0000..U+001F) and DEL (U+007F) are intentionally
// disallowed in `return_to` so the placeholder can't be abused as an open
// redirect. We do the check with charCodeAt instead of a regex to avoid
// Biome's noControlCharactersInRegex lint (the rule is about accidental
// inclusion; this is an intentional security sanitizer).
function containsControlCharacter(value: string): boolean {
  // biome-ignore lint/style/noIncrementDecrement: The explicit counter update preserves this loop’s evaluation order.
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

/**
 * Normalize a `return_to` form/query parameter to a same-origin path. We
 * reject anything that looks like an absolute URL or protocol-relative URL
 * so the placeholder cannot be abused as an open redirect.
 */
function sanitizeReturnTo(input: unknown): string {
  if (typeof input !== "string" || !input) {
    return DEFAULT_RETURN_TO;
  }
  // Must start with a single '/' and not '//' (protocol-relative) and not contain \\.
  if (!isSafeReturnToPath(input)) {
    return DEFAULT_RETURN_TO;
  }
  return input;
}

function isSafeReturnToPath(input: string): boolean {
  return input.startsWith("/") && !input.startsWith("//") && !input.includes("\\") && !containsControlCharacter(input);
}

function deriveRequestOrigin(req: AuthRequest): string | null {
  const host = typeof req.headers.host === "string" ? req.headers.host : "";
  if (!host) {
    return null;
  }
  return `${isSecureRequest(req) ? "https" : "http"}://${host}`;
}

function deriveReturnToFromRequest(req: AuthRequest): string {
  const originalUrl = sanitizeReturnTo(req.originalUrl || req.url || DEFAULT_RETURN_TO);
  if (req.method === "GET" || req.method === "HEAD") {
    return originalUrl;
  }

  const referrer = pickReferrerHeader(req.headers);
  if (!referrer) {
    return originalUrl;
  }

  return deriveReturnToFromReferrer(req, originalUrl, referrer);
}

function deriveReturnToFromReferrer(req: AuthRequest, originalUrl: string, referrer: string): string {
  try {
    const referrerUrl = new URL(referrer);
    const currentOrigin = deriveRequestOrigin(req);
    if (!currentOrigin || referrerUrl.origin !== currentOrigin) {
      return originalUrl;
    }
    return sanitizeReturnTo(`${referrerUrl.pathname || "/"}${referrerUrl.search || ""}${referrerUrl.hash || ""}`);
  } catch {
    return originalUrl;
  }
}

function readReturnToFromQuery(req: AuthRequest): string {
  const raw = req.query?.return_to;
  return sanitizeReturnTo(typeof raw === "string" ? raw : "");
}

function readReturnToFromBodyOrQuery(req: AuthRequest): string {
  const bodyReturnTo = req.body && typeof req.body.return_to === "string" ? req.body.return_to : "";
  if (bodyReturnTo) {
    return sanitizeReturnTo(bodyReturnTo);
  }
  return readReturnToFromQuery(req);
}

interface SessionHelpers {
  clearSession: (res: AuthResponse, req: AuthRequest) => void;
  issueSession: (res: AuthResponse, req: AuthRequest, credentialRevision?: string) => Promise<boolean>;
  readSession: (req: AuthRequest) => Promise<OwnerSessionPayload | null>;
  readSessionRecord: (req: AuthRequest) => Promise<OwnerSessionRecord | null>;
  revokeSession: (req: AuthRequest) => Promise<boolean>;
  listSessions: (req: AuthRequest, subjectId: string) => ReturnType<OwnerSessionController["listSessions"]>;
  revokeSessionByPublicId: (subjectId: string, publicId: string) => Promise<boolean>;
  revokeOtherSessions: (req: AuthRequest, subjectId: string) => Promise<void>;
  revokeAllSessions: (subjectId: string) => Promise<void>;
  listOwnerBearers: (subjectId: string) => ReturnType<OwnerSessionController["listOwnerBearers"]>;
  revokeOwnerBearer: (subjectId: string, publicId: string) => Promise<boolean>;
}

function appendSetCookie(res: AuthResponse, value: string): void {
  // Preserve any prior Set-Cookie headers (we may set both the session
  // cookie and the CSRF cookie on the same response). `res.setHeader`
  // overwrites; passing an array preserves all values for Node/Express.
  const existing = typeof res.getHeader === "function" ? res.getHeader("Set-Cookie") : undefined;
  if (Array.isArray(existing)) {
    res.setHeader("Set-Cookie", [...existing.map(String), value]);
    return;
  }
  if (typeof existing === "string" && existing) {
    res.setHeader("Set-Cookie", [existing, value]);
    return;
  }
  res.setHeader("Set-Cookie", value);
}

function buildSessionHelpers(controller: OwnerSessionController): SessionHelpers {
  return {
    clearSession(res: AuthResponse, req: AuthRequest): void {
      appendSetCookie(res, controller.clearSessionCookieHeader({ secure: isSecureRequest(req) }));
    },
    async issueSession(res: AuthResponse, req: AuthRequest, credentialRevision?: string): Promise<boolean> {
      const requestedLabel = req.headers["x-pdpp-owner-session-label"]?.trim();
      const desktopSession = requestedLabel?.toLowerCase() === "this computer";
      const ipAddress = req.ip ?? req.socket?.remoteAddress ?? req.connection?.remoteAddress ?? null;
      const userAgent = req.headers["user-agent"] ?? null;
      const cookieHeader = await controller.issueSessionCookieHeader(
        { secure: isSecureRequest(req) },
        {
          ...(credentialRevision === undefined ? {} : { credentialRevision }),
          deviceKey: desktopSession ? "desktop-shell" : null,
          ipAddress,
          label: desktopSession ? "This computer" : labelOwnerSession(userAgent),
          userAgent,
      }
      );
      if (!cookieHeader) return false;
      appendSetCookie(res, cookieHeader);
      return true;
    },
    readSession(req: AuthRequest): Promise<OwnerSessionPayload | null> {
      return controller.readSessionFromCookieHeader(req.headers.cookie);
    },
    readSessionRecord(req: AuthRequest): Promise<OwnerSessionRecord | null> {
      return controller.readSessionRecordFromCookieHeader(req.headers.cookie);
    },
    revokeSession(req: AuthRequest): Promise<boolean> {
      return controller.revokeSessionFromCookieHeader(req.headers.cookie);
    },
    listSessions(req: AuthRequest, subjectId: string) {
      return controller.listSessions(subjectId, req.headers.cookie);
    },
    revokeSessionByPublicId(subjectId: string, publicId: string) {
      return controller.revokeSessionByPublicId(subjectId, publicId);
    },
    revokeOtherSessions(req: AuthRequest, subjectId: string) {
      return controller.revokeOtherSessions(req.headers.cookie, subjectId);
    },
    revokeAllSessions(subjectId: string) {
      return controller.revokeAllSessions(subjectId);
    },
    listOwnerBearers(subjectId: string) {
      return controller.listOwnerBearers(subjectId);
    },
    revokeOwnerBearer(subjectId: string, publicId: string) {
      return controller.revokeOwnerBearer(subjectId, publicId);
    },
  };
}

function labelOwnerSession(userAgent: string | null): string {
  if (!userAgent) return "Unknown browser";
  const browser = /Firefox\//u.test(userAgent)
    ? "Firefox"
    : /Edg\//u.test(userAgent)
      ? "Edge"
      : /Chrome\//u.test(userAgent)
        ? "Chrome"
        : /Safari\//u.test(userAgent)
          ? "Safari"
          : "Browser";
  const platform = /Windows/u.test(userAgent)
    ? "Windows"
    : /Android/u.test(userAgent)
      ? "Android"
      : /iPhone|iPad|iPod/u.test(userAgent)
        ? "iOS"
        : /Macintosh|Mac OS X/u.test(userAgent)
          ? "macOS"
          : /Linux/u.test(userAgent)
            ? "Linux"
            : null;
  return platform ? `${browser} on ${platform}` : browser;
}

export type ClientNameLookup = (clientId: string) => Promise<string | null>;

interface OwnerAuthRouteContext {
  readonly clientNameLookup: ClientNameLookup | null;
  readonly csrfPairValid: (req: AuthRequest) => boolean;
  readonly enabled: boolean;
  readonly ensureCsrfToken: (req: AuthRequest, res: AuthResponse) => string;
  readonly loginRateLimiter: OwnerLoginRateLimiter;
  readonly notifySessionLogout: (req: AuthRequest) => void;
  readonly passwordMatches: (submitted: string) => Promise<OwnerPasswordMatch>;
  readonly credentialSource: () => "app" | "env" | "disabled";
  readonly changeAppPassword: (
    password: string,
    subjectId: string,
    keepSessionIdHash: string,
    expectedRevision: string
  ) => Promise<boolean>;
  readonly providerName: string;
  readonly resolvedSubjectId: string;
  readonly rotateCsrfCookie: (req: AuthRequest, res: AuthResponse) => void;
  readonly session: SessionHelpers;
}

interface OwnerPasswordMatch {
  matched: boolean;
  credentialRevision?: string;
}

function isJsonRequest(req: AuthRequest): boolean {
  // Pure JSON callers (CLIs, server-to-server, dashboards using
  // `fetch` with `Content-Type: application/json`) cannot be forged
  // into a cross-origin browser POST without a CORS preflight, so
  // we exempt them from CSRF and preserve existing JSON API
  // behavior. The exemption is intentionally limited to exactly
  // `application/json`: the reference's Fastify body parser only
  // parses `application/json`, so accepting structured-syntax
  // variants like `application/problem+json` for CSRF purposes
  // would diverge from what the route handlers actually decode.
  const contentType =
    typeof (req.headers as Record<string, unknown>)["content-type"] === "string"
      ? ((req.headers as Record<string, string>)["content-type"] as string).toLowerCase()
      : "";
  if (!contentType) {
    return false;
  }
  const mediaType = contentType.split(";")[0]?.trim() ?? "";
  return mediaType === "application/json";
}

function shouldRequireCsrf(req: AuthRequest): boolean {
  // Every browser-submittable POST that is *not* JSON needs CSRF.
  // That includes the obvious form encodings
  // (`application/x-www-form-urlencoded`, `multipart/form-data`)
  // *and* `text/plain`, which the HTML form spec accepts as a third
  // valid `enctype` and which a browser can send cross-origin
  // without a CORS preflight. Exempting only the two form encodings
  // (the prior heuristic) left a `text/plain` bypass.
  return !isJsonRequest(req);
}

function readValidCsrfCookie(req: AuthRequest, csrfSecret: OwnerCsrfSecret): string | null {
  const fromCookie = readCsrfTokenFromCookieHeader(req.headers.cookie);
  if (fromCookie && verifyOwnerCsrfToken(fromCookie, csrfSecret)) {
    return fromCookie;
  }
  return null;
}

function appendCsrfTokenToRequest(req: AuthRequest, token: string): void {
  const nextHeader = req.headers.cookie
    ? `${req.headers.cookie}; ${OWNER_CSRF_COOKIE_NAME}=${token}`
    : `${OWNER_CSRF_COOKIE_NAME}=${token}`;
  (req as unknown as { headers: Record<string, string> }).headers.cookie = nextHeader;
}

function replyCsrfFailure(req: AuthRequest, res: AuthResponse, providerName: string): void {
  if (wantsHtml(req)) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.status(403).send(
      renderHostedDocument({
        body: [
          renderPageIntro({
            eyebrow: "Owner approval UI",
            lede: "The form submission is missing a valid CSRF token. Reload the page and try again from a freshly rendered owner-hosted form.",
            title: "Request blocked",
          }),
        ].join("\n"),
        providerName,
        title: `${providerName} — Request blocked`,
      })
    );
    return;
  }
  res
    .status(403)
    .setHeader("Content-Type", "application/json")
    .json({
      error: {
        code: "csrf_token_invalid",
        message: "CSRF token missing or invalid for hosted owner form POST.",
        type: "invalid_request",
      },
    });
}

function replyLoginRateLimited(
  req: AuthRequest,
  res: AuthResponse,
  providerName: string,
  retryAfterSeconds: number
): void {
  res.setHeader("Retry-After", String(retryAfterSeconds));
  if (wantsHtml(req)) {
    const lang = resolveDemoLang(req);
    const t = (es: string, en: string) => pickLang(lang, es, en);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.status(429).send(
      renderHostedDocument({
        body: renderCitizenCard({
          body: `<p class="cu-lead">${t(
            `Demasiados intentos de inicio de sesión desde esta dirección. Intenta de nuevo en unos ${retryAfterSeconds} segundos.`,
            `Too many sign-in attempts from this address. Try again in about ${retryAfterSeconds} seconds.`
          )}</p>`,
          glyph: CITIZEN_GLYPHS.lock,
          title: t("Espera un momento", "Please wait a moment"),
        }),
        lang,
        providerName,
        shell: "cuenta-unica",
        title: t("Cuenta Única Ciudadana (simulación) · Espera un momento", "Cuenta Única (simulation) · Please wait"),
      })
    );
    return;
  }
  res
    .status(429)
    .setHeader("Content-Type", "application/json")
    .json({
      error: {
        code: "owner_login_rate_limited",
        message: "Too many sign-in attempts. Retry after the indicated delay.",
        type: "slow_down",
      },
    });
}

function replyDisabledLogin(req: AuthRequest, res: AuthResponse, providerName: string): void {
  if (wantsHtml(req)) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.status(400).send(
      renderOwnerAuthDisabledPage({
        providerName,
        themeChoice: readHostedThemeChoiceFromCookieHeader(req.headers.cookie),
      })
    );
    return;
  }
  res
    .status(400)
    .setHeader("Content-Type", "application/json")
    .json({
      error: {
        code: "owner_auth_disabled",
        message: "Owner sign-in is disabled because no owner password is set.",
        type: "invalid_request",
      },
    });
}

function replyLogoutCsrfFailure(req: AuthRequest, res: AuthResponse, providerName: string): void {
  if (wantsHtml(req)) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.status(403).send(
      renderHostedDocument({
        body: renderPageIntro({
          eyebrow: "Owner approval UI",
          lede: "The sign-out submission is missing a valid CSRF token. Reload the page and try again.",
          title: "Request blocked",
        }),
        providerName,
        title: `${providerName} — Request blocked`,
      })
    );
    return;
  }
  res
    .status(403)
    .setHeader("Content-Type", "application/json")
    .json({
      error: {
        code: "csrf_token_invalid",
        message: "CSRF token missing or invalid for /owner/logout.",
        type: "invalid_request",
      },
    });
}

async function sendOwnerLoginPage(
  res: AuthResponse,
  clientNameLookup: ClientNameLookup | null,
  providerName: string,
  csrfToken: string,
  returnTo: string,
  status: number,
  error: string | null,
  lang: DemoLang,
  themeChoice?: string
): Promise<void> {
  const clientName = await resolveLoginClientName(returnTo, clientNameLookup);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.status(status).send(
    renderLoginPage({
      clientName,
      csrfToken,
      error,
      lang,
      providerName,
      returnTo,
      ...(themeChoice === undefined ? {} : { themeChoice }),
    })
  );
}

async function handleOwnerLoginGet(req: AuthRequest, res: AuthResponse, context: OwnerAuthRouteContext): Promise<void> {
  const hasExplicitReturnTo = typeof req.query?.return_to === "string" && req.query.return_to.length > 0;
  const returnTo = readReturnToFromQuery(req);
  res.setHeader("Content-Type", "text/html; charset=utf-8");

  if (!context.enabled) {
    res.status(200).send(
      renderOwnerAuthDisabledPage({
        providerName: context.providerName,
        themeChoice: readHostedThemeChoiceFromCookieHeader(req.headers.cookie),
      })
    );
    return;
  }

  const currentSession = await context.session.readSession(req);
  if (!currentSession) {
    const csrfToken = context.ensureCsrfToken(req, res);
    const clientName = await resolveLoginClientName(returnTo, context.clientNameLookup);
    res.status(200).send(
      renderLoginPage({
        clientName,
        csrfToken,
        error: null,
        lang: resolveDemoLang(req),
        providerName: context.providerName,
        returnTo,
        themeChoice: readHostedThemeChoiceFromCookieHeader(req.headers.cookie),
      })
    );
    return;
  }
  if (hasExplicitReturnTo) {
    res.redirect(returnTo);
    return;
  }
  const csrfToken = context.ensureCsrfToken(req, res);
  res.status(200).send(
    renderSignedInOwnerPage({
      csrfToken,
      providerName: context.providerName,
      subjectId: context.resolvedSubjectId,
      themeChoice: readHostedThemeChoiceFromCookieHeader(req.headers.cookie),
    })
  );
}

async function handleOwnerLoginPost(
  req: AuthRequest,
  res: AuthResponse,
  context: OwnerAuthRouteContext
): Promise<void> {
  const returnTo = readReturnToFromBodyOrQuery(req);

  if (!context.enabled) {
    replyDisabledLogin(req, res, context.providerName);
    return;
  }

  // Enforce CSRF before any password check so attackers can't probe
  // password validity over a forged cross-origin POST. We render the
  // CSRF failure page rather than re-rendering the login form so we
  // don't leak whether the password attempt would have succeeded.
  //
  // Pure JSON callers stay exempt for the same reason as the rest
  // of the hosted-form CSRF surface: a cross-origin browser POST
  // with `Content-Type: application/json` requires a CORS preflight
  // and cannot be silently forged, so JSON `/owner/login` keeps
  // its programmatic contract and reaches the password branch.
  if (shouldRequireCsrf(req) && !context.csrfPairValid(req)) {
    const csrfToken = context.ensureCsrfToken(req, res);
    await sendOwnerLoginPage(
      res,
      context.clientNameLookup,
      context.providerName,
      csrfToken,
      returnTo,
      403,
      loginError(resolveDemoLang(req), "csrf"),
      resolveDemoLang(req),
      readHostedThemeChoiceFromCookieHeader(req.headers.cookie)
    );
    return;
  }

  // Checked after CSRF (so an attacker cannot cheaply burn the owner's own
  // attempt budget with CSRF-invalid junk — obtaining a valid CSRF pair
  // costs the attacker nothing either, but only real password attempts
  // should count against the throttle) and before the password comparison
  // (so every guess, right or wrong, counts toward the window).
  const retryAfterSeconds = context.loginRateLimiter.check(req);
  if (retryAfterSeconds !== null) {
    replyLoginRateLimited(req, res, context.providerName, retryAfterSeconds);
    return;
  }

  const submitted = req.body && typeof req.body.password === "string" ? req.body.password : "";
  const passwordMatch = await context.passwordMatches(submitted);
  if (!passwordMatch.matched) {
    const csrfToken = context.ensureCsrfToken(req, res);
    await sendOwnerLoginPage(
      res,
      context.clientNameLookup,
      context.providerName,
      csrfToken,
      returnTo,
      401,
      loginError(resolveDemoLang(req), "wrongPassword"),
      resolveDemoLang(req),
      readHostedThemeChoiceFromCookieHeader(req.headers.cookie)
    );
    return;
  }
  context.loginRateLimiter.recordSuccess(req);
  if (!(await context.session.issueSession(res, req, passwordMatch.credentialRevision))) {
    const csrfToken = context.ensureCsrfToken(req, res);
    await sendOwnerLoginPage(
      res,
      context.clientNameLookup,
      context.providerName,
      csrfToken,
      returnTo,
      401,
      loginError(resolveDemoLang(req), "passwordChanged"),
      resolveDemoLang(req),
      readHostedThemeChoiceFromCookieHeader(req.headers.cookie)
    );
    return;
  }
  // Rotate the CSRF cookie on auth-state change so a token captured
  // from a pre-login response cannot be reused after sign-in.
  context.rotateCsrfCookie(req, res);
  res.redirect(returnTo);
}

async function handleOwnerLogout(req: AuthRequest, res: AuthResponse, context: OwnerAuthRouteContext): Promise<void> {
  // CSRF only applies when owner-auth is enabled. With placeholder
  // auth disabled (no PDPP_OWNER_PASSWORD), there is no session
  // and no CSRF surface to protect; preserve the prior open
  // local-dev behavior so a form-encoded logout POST does not 403.
  // Pure JSON callers stay exempt because they cannot be
  // cross-origin-forged without a CORS preflight; every other
  // browser-submittable POST (form-encoded, multipart, text/plain)
  // requires a valid CSRF pair.
  if (context.enabled && shouldRequireCsrf(req) && !context.csrfPairValid(req)) {
    replyLogoutCsrfFailure(req, res, context.providerName);
    return;
  }
  await context.session.revokeSession(req);
  context.session.clearSession(res, req);
  context.rotateCsrfCookie(req, res);
  context.notifySessionLogout(req);
  if (wantsHtml(req)) {
    res.redirect("/owner/login");
    return;
  }
  res.status(204).end();
}

function denyOwnerAccess(req: AuthRequest, res: AuthResponse): void {
  if (wantsHtml(req)) {
    const returnTo = encodeURIComponent(deriveReturnToFromRequest(req));
    res.redirect(`/owner/login?return_to=${returnTo}`);
    return;
  }
  res
    .status(401)
    .setHeader("Content-Type", "application/json")
    .json({
      error: {
        code: "owner_session_required",
        message: "Owner session required. Sign in at /owner/login.",
        type: "authentication_error",
      },
    });
}

async function requireSignedInSession(
  req: AuthRequest,
  res: AuthResponse,
  context: OwnerAuthRouteContext
): Promise<OwnerSessionPayload | null> {
  if (!context.enabled) {
    denyOwnerAccess(req, res);
    return null;
  }
  const current = await context.session.readSession(req);
  if (!current) {
    denyOwnerAccess(req, res);
    return null;
  }
  return current;
}

function isCsrfAuthorized(req: AuthRequest, res: AuthResponse, context: OwnerAuthRouteContext): boolean {
  if (context.enabled && shouldRequireCsrf(req) && !context.csrfPairValid(req)) {
    replyCsrfFailure(req, res, context.providerName);
    return false;
  }
  return true;
}

function handleDisabledOwnerSession(
  req: AuthRequest,
  res: AuthResponse,
  next: AuthNextFunction,
  allowUnauthenticatedWhenDisabled: boolean
): void {
  if (allowUnauthenticatedWhenDisabled) {
    next();
    return;
  }
  denyOwnerAccess(req, res);
}

/**
 * Build the owner-auth placeholder. Returns an object with:
 *   - `enabled`: whether placeholder auth is active (password configured)
 *   - `subjectId`: the single owner subject id to use when enabled
 *   - `attachRoutes(app)`: wire `/owner/login*`, `/owner/logout` and the
 *     `/owner/session` admission check
 *   - `requireOwnerSession(req, res, next)`: Express middleware that gates
 *     a protected route. Redirects browsers to `/owner/login`, returns 401
 *     JSON to non-HTML callers.
 */
export function createOwnerAuthPlaceholder({
  password,
  passwordVerifier,
  subjectId,
  providerName = DATACONNECT_PRODUCT_IDENTITY.name,
  clientNameLookup = null,
  sessionTtlSeconds = OWNER_SESSION_DEFAULT_TTL_SECONDS,
  sameSite = "lax",
  forceSecureCookies = false,
  allowUnauthenticatedWhenDisabled = true,
  csrfSecret: csrfSecretOverride = null,
  loginRateLimit = {},
  sessionStore,
  passwordVerifierStore,
}: OwnerAuthPlaceholderOptions = {}): OwnerAuthPlaceholder {
  // `exactOptionalPropertyTypes` won't accept `undefined` in these fields,
  // so we fall back to the declared `null` sentinel the controller already
  // understands as "not provided."
  let activePasswordVerifier = passwordVerifier ?? null;
  let credentialSource: "app" | "env" | "disabled" = password ? "env" : activePasswordVerifier ? "app" : "disabled";
  const hasPasswordCredential =
    (typeof password === "string" && password.length > 0) ||
    passwordVerifier != null ||
    !allowUnauthenticatedWhenDisabled;
  const sessionController = createOwnerSessionController({
    enabled: hasPasswordCredential,
    forceSecureCookies,
    password: password ?? null,
    sessionStore: sessionStore ?? getOwnerSessionStore(),
    sameSite,
    sessionTtlSeconds,
    subjectId: subjectId ?? null,
  });
  const { enabled, subjectId: resolvedSubjectId } = sessionController;
  const session = buildSessionHelpers(sessionController);
  const logoutListeners = new Map<string, Set<() => void>>();

  function ownerSessionKey(req: AuthRequest): string | null {
    const cookie = parseCookieHeader(req.headers.cookie)[OWNER_SESSION_COOKIE_NAME];
    return cookie ? crypto.createHash("sha256").update(cookie).digest("base64url") : null;
  }

  function onSessionLogout(req: AuthRequest, listener: () => void): () => void {
    const key = enabled ? ownerSessionKey(req) : null;
    if (!key) return () => undefined;
    let listeners = logoutListeners.get(key);
    if (!listeners) {
      listeners = new Set();
      logoutListeners.set(key, listeners);
    }
    const registered = listeners;
    registered.add(listener);
    return () => {
      registered.delete(listener);
      if (registered.size === 0 && logoutListeners.get(key) === registered) logoutListeners.delete(key);
    };
  }

  function notifySessionLogout(req: AuthRequest): void {
    const key = ownerSessionKey(req);
    if (!key) return;
    const listeners = logoutListeners.get(key);
    logoutListeners.delete(key);
    for (const listener of listeners ?? []) listener();
  }
  // CSRF protection is only meaningful when owner-auth is enabled (the
  // password gates everything). When disabled, the helpers no-op and
  // the routes stay open as before.
  //
  // The CSRF HMAC secret is **not** derived from the owner password.
  // GET /owner/login is unauthenticated and returns a signed token in
  // the hidden field, so any password-derived secret would expose one
  // HMAC sample to every anonymous fetcher and let them brute-force a
  // weak password offline. We mint a random 32-byte secret per process
  // instead. An operator who needs a stable secret across restarts
  // SHOULD pass an explicit `csrfSecret` (high-entropy, unrelated to
  // any user input) — but the default is the random secret.
  const csrfSecret: OwnerCsrfSecret | null = enabled ? (csrfSecretOverride ?? generateOwnerCsrfSecret()) : null;

  // Disabled only for test fixtures that need deterministic unlimited
  // attempts (`loginRateLimit: false`); every real deployment keeps the
  // default throttle. `check` always returning `null` yields a genuine
  // no-op, not merely a very high ceiling.
  const loginRateLimiter: OwnerLoginRateLimiter =
    loginRateLimit === false
      ? { check: () => null, recordSuccess: () => undefined }
      : createOwnerLoginRateLimiter(loginRateLimit);

  function ensureCsrfToken(req: AuthRequest, res: AuthResponse): string {
    if (!csrfSecret) {
      return "";
    }
    // Reuse the cookie value only if the signature still verifies; an
    // injected/forged cookie would fail verification and is rotated out.
    const fromCookie = readValidCsrfCookie(req, csrfSecret);
    if (fromCookie) {
      return fromCookie;
    }
    const token = issueOwnerCsrfToken(csrfSecret);
    appendSetCookie(
      res,
      buildOwnerCsrfSetCookie(token, {
        maxAgeSeconds: sessionTtlSeconds,
        sameSite,
        secure: forceSecureCookies || isSecureRequest(req),
      })
    );
    // Ensure subsequent reads in the same request see the freshly minted
    // token via the request cookie header.
    appendCsrfTokenToRequest(req, token);
    return token;
  }

  function rotateCsrfCookie(req: AuthRequest, res: AuthResponse): void {
    appendSetCookie(
      res,
      buildOwnerCsrfClearCookie({
        sameSite,
        secure: forceSecureCookies || isSecureRequest(req),
      })
    );
  }

  function requireCsrf(req: AuthRequest, res: AuthResponse, next: AuthNextFunction): void {
    if (!(enabled && csrfSecret)) {
      // Owner-auth disabled — no session, no CSRF surface to protect.
      next();
      return;
    }
    if (!shouldRequireCsrf(req)) {
      next();
      return;
    }
    const cookieToken = readCsrfTokenFromCookieHeader(req.headers.cookie);
    const formToken =
      (req.body && typeof (req.body as Record<string, unknown>)[OWNER_CSRF_FIELD_NAME] === "string"
        ? ((req.body as Record<string, unknown>)[OWNER_CSRF_FIELD_NAME] as string)
        : "") || "";
    if (!(csrfSecret && validateOwnerCsrfPair(cookieToken, formToken, csrfSecret))) {
      replyCsrfFailure(req, res, providerName);
      return;
    }
    next();
  }

  function extractCsrfFormToken(req: AuthRequest): string {
    if (!req.body) {
      return "";
    }
    const value = (req.body as Record<string, unknown>)[OWNER_CSRF_FIELD_NAME];
    return typeof value === "string" ? value : "";
  }

  function csrfPairValid(req: AuthRequest): boolean {
    if (!csrfSecret) {
      return false;
    }
    const cookieToken = readCsrfTokenFromCookieHeader(req.headers.cookie);
    const formToken = extractCsrfFormToken(req);
    return validateOwnerCsrfPair(cookieToken, formToken, csrfSecret);
  }

  async function passwordMatches(submitted: string): Promise<OwnerPasswordMatch> {
    if (!submitted) return { matched: false };
    if (typeof password === "string" && password) {
      return { matched: timingSafeEqualString(submitted, password) };
    }
    let credentialRevision: string | undefined;
    if (passwordVerifierStore) {
      const storedVerifier = await passwordVerifierStore.readVersioned();
      if (storedVerifier) {
        activePasswordVerifier = storedVerifier.verifier;
        credentialRevision = storedVerifier.revision;
      }
    }
    if (!activePasswordVerifier) return { matched: false };
    return {
      matched: await verifyOwnerPassword(submitted, activePasswordVerifier),
      ...(credentialRevision === undefined ? {} : { credentialRevision }),
    };
    }

  async function changeAppPassword(
    newPassword: string,
    subjectId: string,
    keepSessionIdHash: string,
    expectedRevision: string
  ): Promise<boolean> {
    if (credentialSource !== "app" || !passwordVerifierStore || !passwordVerifierStore.isDurable()) {
      throw new Error("App-managed password changes require a durable verifier store.");
    }
    const verifier = await createOwnerPasswordVerifier(newPassword);
    const changed = await passwordVerifierStore.writeAndRevokeAccess(
      verifier,
      subjectId,
      keepSessionIdHash,
      expectedRevision
    );
    if (!changed) return false;
    activePasswordVerifier = verifier;
    return true;
  }

  function attachRoutes(app: AuthAppLike): void {
    const context: OwnerAuthRouteContext = {
      clientNameLookup,
      csrfPairValid,
      credentialSource: () => credentialSource,
      changeAppPassword,
      enabled,
      ensureCsrfToken,
      loginRateLimiter,
      notifySessionLogout,
      passwordMatches,
      providerName,
      resolvedSubjectId,
      rotateCsrfCookie,
      session,
    };
    app.get("/owner/login", async (req, res) => {
      if (!allowUnauthenticatedWhenDisabled && !(typeof password === "string" && password) && !activePasswordVerifier) {
        res.redirect("/setup");
        return;
      }
      await handleOwnerLoginGet(req, res, context);
    });
    app.post("/owner/login", async (req, res) => {
      if (!allowUnauthenticatedWhenDisabled && !(typeof password === "string" && password) && !activePasswordVerifier) {
        res.redirect("/setup");
        return;
      }
      await handleOwnerLoginPost(req, res, context);
    });
    app.post("/owner/logout", async (req, res) => await handleOwnerLogout(req, res, context));

    app.get("/owner/password", async (req, res) => {
      const current = await requireSignedInSession(req, res, context);
      if (!current) return;
      res.setHeader("Content-Type", "application/json").status(200).json({
        object: "owner_password",
        source: context.credentialSource(),
        minimumLength: OWNER_PASSWORD_MIN_LENGTH,
      });
    });

    app.post("/owner/password/change", async (req, res) => {
      if (!isCsrfAuthorized(req, res, context)) return;
      if (context.credentialSource() === "env") {
        res.status(409).json({
          error: {
            code: "owner_password_env_managed",
            message:
              "This password is set by PDPP_OWNER_PASSWORD. Change that environment variable and restart the server.",
          },
        });
        return;
      }
      if (context.credentialSource() !== "app") {
        res.status(404).json({
          error: {
            code: "owner_auth_disabled",
            message: "Owner password changes are unavailable.",
          },
        });
        return;
      }
      const current = await requireSignedInSession(req, res, context);
      if (!current) return;
      const retryAfterSeconds = context.loginRateLimiter.check(req);
      if (retryAfterSeconds !== null) {
        replyLoginRateLimited(req, res, context.providerName, retryAfterSeconds);
        return;
      }
      const currentPassword = typeof req.body?.currentPassword === "string" ? req.body.currentPassword : "";
      const newPassword = typeof req.body?.newPassword === "string" ? req.body.newPassword : "";
      const passwordMatch = await context.passwordMatches(currentPassword);
      if (!passwordMatch.matched || !passwordMatch.credentialRevision) {
        res.status(401).json({
          error: {
            code: "owner_password_invalid",
            message: "Current password is incorrect.",
          },
        });
        return;
      }
      const currentRecord = await context.session.readSessionRecord(req);
      if (!currentRecord) {
        res.status(401).json({
          error: { code: "owner_session_required", message: "Sign in to change the owner password." },
        });
        return;
      }
      context.loginRateLimiter.recordSuccess(req);
      if (Array.from(newPassword).length < OWNER_PASSWORD_MIN_LENGTH) {
        res.status(400).json({
          error: {
            code: "owner_password_too_short",
            message: `New passwords must be at least ${OWNER_PASSWORD_MIN_LENGTH} characters long.`,
          },
        });
        return;
      }
      try {
        const changed = await context.changeAppPassword(
          newPassword,
          current.sub,
          currentRecord.idHash,
          passwordMatch.credentialRevision
        );
        if (!changed) {
          res.status(409).json({
            error: {
              code: "owner_password_changed",
              message: "The password changed during this request. Sign in with the current password and try again.",
            },
          });
          return;
        }
      } catch {
        res.status(503).json({
          error: {
            code: "owner_password_not_durable",
            message: "Could not save the new password to durable storage.",
          },
        });
        return;
      }
      res.status(204).end();
    });
    // Body-less admission check for a server that forwards a browser's cookie
    // but cannot validate it itself (the console in a split deployment, before
    // it hands out the owner bearer). Same decision as every other gated
    // route: 204 when `requireOwnerSession` admits the request (a valid
    // session, or the open local-dev posture), otherwise its 401/redirect.
    app.get("/owner/session", async (req, res) => {
      await requireOwnerSession(req, res, () => {
        res.status(204).end();
      });
    });

    app.get("/owner/sessions", async (req, res) => {
      if (!context.enabled) {
        res.status(404).json({
          error: {
            code: "owner_sessions_disabled",
            message: "Owner sessions are not enabled.",
          },
        });
        return;
  }
      const current = await requireSignedInSession(req, res, context);
      if (!current) return;
      const [sessions, bearers] = await Promise.all([
        context.session.listSessions(req, current.sub),
        context.session.listOwnerBearers(current.sub),
      ]);
      res
        .setHeader("Content-Type", "application/json")
        .status(200)
        .json({ object: "owner_sessions", sessions, bearers });
    });

    app.post("/owner/sessions/revoke-others", async (req, res) => {
      if (!isCsrfAuthorized(req, res, context)) return;
      const current = await requireSignedInSession(req, res, context);
      if (!current) return;
      await context.session.revokeOtherSessions(req, current.sub);
      res.status(204).end();
    });

    app.post("/owner/sessions/revoke-all", async (req, res) => {
      if (!isCsrfAuthorized(req, res, context)) return;
      const current = await requireSignedInSession(req, res, context);
      if (!current) return;
      await context.session.revokeAllSessions(current.sub);
      res.status(204).end();
    });

    app.post("/owner/sessions/:publicId/revoke", async (req, res) => {
      if (!isCsrfAuthorized(req, res, context)) return;
      const current = await requireSignedInSession(req, res, context);
      if (!current) return;
      const publicId = req.params?.publicId ?? "";
      if (!/^[A-Za-z0-9_-]{16}$/u.test(publicId)) {
        res.status(400).json({
          error: {
            code: "invalid_request",
            message: "Session id is invalid.",
          },
        });
        return;
      }
      if (!(await context.session.revokeSessionByPublicId(current.sub, publicId))) {
        res.status(404).json({ error: { code: "not_found", message: "Session not found." } });
        return;
      }
      res.status(204).end();
    });

    app.post("/owner/bearers/:publicId/revoke", async (req, res) => {
      if (!isCsrfAuthorized(req, res, context)) return;
      const current = await requireSignedInSession(req, res, context);
      if (!current) return;
      const publicId = req.params?.publicId ?? "";
      if (!/^tok_[A-Za-z0-9_-]{43}$/u.test(publicId)) {
        res.status(400).json({
          error: {
            code: "invalid_request",
            message: "Bearer id is invalid.",
          },
        });
        return;
      }
      if (!(await context.session.revokeOwnerBearer(current.sub, publicId))) {
        res.status(404).json({ error: { code: "not_found", message: "Bearer not found." } });
        return;
      }
      res.status(204).end();
    });
  }

  async function requireOwnerSession(req: AuthRequest, res: AuthResponse, next: AuthNextFunction): Promise<void> {
    if (!enabled) {
      // Owner auth is disabled (no PDPP_OWNER_PASSWORD). Whether that means
      // "open" depends on the deployment posture the host computed:
      //   - local-dev / explicit override → fall through (frictionless dev).
      //   - any internet-facing posture    → fail closed (401 / login redirect).
      // Security audit S-1: an unset password must never silently open the
      // owner control plane on a hosted surface. The host's boot guard makes
      // hosted-without-password unreachable; this is defense in depth.
      handleDisabledOwnerSession(req, res, next, allowUnauthenticatedWhenDisabled);
      return;
    }

    const current = await session.readSession(req);
    if (current) {
      req.ownerSession = current;
      next();
      return;
    }

    denyOwnerAccess(req, res);
  }

  return {
    attachRoutes,
    csrfCookieName: OWNER_CSRF_COOKIE_NAME,
    csrfFieldName: OWNER_CSRF_FIELD_NAME,
    enabled,
    setPasswordVerifier(verifier) {
      activePasswordVerifier = verifier;
      credentialSource = "app";
    },
    ensureCsrfToken,
    onSessionLogout,
    readOwnerSession: async (req) => await session.readSession(req),
    readOwnerAuthorizationFence: async (req) => {
      const record = await session.readSessionRecord(req);
      if (!record) return null;
      const storedVerifier = await passwordVerifierStore?.readVersioned();
      return {
        ...(storedVerifier === null || storedVerifier === undefined
          ? {}
          : { credentialRevision: storedVerifier.revision }),
        sessionIdHash: record.idHash,
      };
    },
    renderCsrfField: renderCsrfHiddenField,
    requireCsrf,
    requireOwnerSession,
    subjectId: resolvedSubjectId,
  };
}

export const OWNER_AUTH_DEFAULT_SUBJECT_ID = OWNER_SESSION_DEFAULT_SUBJECT_ID;
export const OWNER_AUTH_COOKIE_NAME = OWNER_SESSION_COOKIE_NAME;
