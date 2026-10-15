// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// HTTP surface for the DR pilot. Mounted on the AS app only when
// PDPP_PILOT_DR_VACUNA=1 (see server/index.ts buildAsApp).
//
//   GET  /pilot/vacuna                        landing (explains the demo, links to start)
//   GET  /pilot/cuenta-unica/login            sign-in form (stub)
//   POST /pilot/cuenta-unica/login            cédula + demo password -> session cookie
//   POST /pilot/cuenta-unica/logout
//   GET  /pilot/vacuna/consent?request_uri=   pick a child (or confirm the named record)
//   POST /pilot/vacuna/consent/select         registry check, then review
//   GET  /pilot/vacuna/consent/review         the review shown after select (browser)
//   POST /pilot/vacuna/consent/approve        approve the bound review revision
//   POST /pilot/vacuna/consent/deny           decline
//   GET  /pilot/vacuna/resultado              approved / declined / refused (browser)
//   GET  /pilot/vacuna/autorizaciones         "Mis autorizaciones"
//   POST /pilot/vacuna/autorizaciones/:grantId/revoke  keep-or-delete withdrawal
//   POST /pilot/vacuna/grant-lifecycle        held-data answer for the client (grant-lifecycle.ts)
//
// Every route answers JSON when the request sends `Accept: application/json`
// or a JSON body; that is the headless path the load harness uses. Browser
// form posts answer with a 302/303 to a GET page (post-redirect-get), so the
// ES | EN toggle (i18n.ts) and reload work on every page.
//
// GET /consent for a pending request on the pilot source is redirected here,
// so a client that starts with PAR or /oauth/authorize lands on the parent
// surface without knowing about it.

import { getRegisteredClient } from "../auth.ts";
import { authenticateClientRequest, createJtiReplayCache } from "../client-authentication.ts";
import { resolvePublicUrl } from "../metadata.ts";
import { isPostgresStorageBackend } from "../postgres-storage.ts";
import { PILOT_PATHS, walkthroughStartUrl } from "./config.ts";
import {
  type CuentaUnicaStub,
  clearedSessionCookie,
  createCuentaUnicaStub,
  type ParentSession,
  sessionCookie,
} from "./cuenta-unica-stub.ts";
import { answerLifecycleQuery } from "./grant-lifecycle.ts";
import {
  authorizationsPage,
  errorPage,
  landingPage,
  loginPage,
  pickChildPage,
  type ResultKind,
  resultPage,
  reviewPage,
} from "./html.ts";
import { type Lang, langCookie, requestedLang, resolveLang } from "./i18n.ts";
import { type CivilRegistry, createPostgresCivilRegistry, ensureRegistrySchema } from "./registry-stub.ts";
import { createRepresentativeConsent, loadPendingPilotRequest, PilotError } from "./representative-consent.ts";
import { ensurePilotStoreSchema } from "./store.ts";

interface Req {
  body?: Record<string, unknown> | null;
  headers: Record<string, unknown>;
  method?: string;
  originalUrl?: string;
  params?: Record<string, string>;
  path?: string;
  protocol?: string;
  query: Record<string, unknown>;
  url?: string;
}

interface Res {
  headersSent?: boolean;
  json: (body: unknown) => unknown;
  redirect: (status: number, url: string) => unknown;
  send: (body: unknown) => unknown;
  setHeader: (name: string, value: string | string[]) => unknown;
  status: (code: number) => Res;
}

type Handler = (req: Req, res: Res) => Promise<void>;

interface AppLike {
  get: (path: string, handler: Handler) => unknown;
  post: (path: string, handler: Handler) => unknown;
  use: (fn: (req: Req, res: Res, next: () => void) => unknown) => unknown;
}

export interface DrVacunaPilotOptions {
  registry?: CivilRegistry;
}

const SEE_OTHER = 303;

function wantsJson(req: Req): boolean {
  const accept = String(req.headers.accept ?? "");
  const type = String(req.headers["content-type"] ?? "");
  return accept.includes("application/json") || type.includes("application/json");
}

function safeReturnTo(raw: unknown): string {
  return typeof raw === "string" && raw.startsWith("/pilot/") && !raw.startsWith("//")
    ? raw
    : PILOT_PATHS.authorizations;
}

/** Path + query of this GET request without `lang`, for the ES | EN toggle. */
function currentUrlOf(req: Req): string {
  const raw = req.originalUrl ?? req.url ?? req.path ?? "/";
  const url = new URL(raw, "http://localhost");
  url.searchParams.delete("lang");
  return `${url.pathname}${url.search}`;
}

function consentUrl(requestUri: string): string {
  return `${PILOT_PATHS.consent}?request_uri=${encodeURIComponent(requestUri)}`;
}

function headerGetter(req: Req): (name: string) => string | undefined {
  return (name) => {
    const value = req.headers[name.toLowerCase()];
    if (Array.isArray(value)) {
      return value.length ? String(value[0]) : undefined;
    }
    return value === undefined || value === null ? undefined : String(value);
  };
}

export function mountDrVacunaPilot(app: AppLike, options: DrVacunaPilotOptions = {}) {
  const registry = options.registry ?? createPostgresCivilRegistry();
  const cuentaUnica: CuentaUnicaStub = createCuentaUnicaStub(registry);
  const consent = createRepresentativeConsent(registry);
  const lifecycleJti = createJtiReplayCache();
  let readyPromise: Promise<void> | null = null;

  function ready(): Promise<void> {
    if (!isPostgresStorageBackend()) {
      return Promise.reject(new PilotError(503, "unsupported", "The DR pilot requires the Postgres storage backend"));
    }
    readyPromise ??= (async () => {
      await ensureRegistrySchema();
      await ensurePilotStoreSchema();
    })().catch((err) => {
      readyPromise = null;
      throw err;
    });
    return readyPromise;
  }

  /** Language for this request; remembers an explicit ?lang= choice in a cookie. */
  function langFor(req: Req, res: Res): Lang {
    const explicit = requestedLang(req);
    if (explicit) {
      res.setHeader("Set-Cookie", langCookie(explicit));
    }
    return resolveLang(req);
  }

  function sendHtml(res: Res, html: string, status = 200): void {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.status(status).send(html);
  }

  function fail(req: Req, res: Res, err: unknown, session: ParentSession | null = null): void {
    const status = err instanceof PilotError ? err.status : Number((err as { status?: number }).status) || 500;
    const code = err instanceof PilotError ? err.code : String((err as { code?: string }).code || "server_error");
    const message = err instanceof Error ? err.message : String(err);
    const httpStatus = status >= 400 && status < 600 ? status : code === "server_error" ? 500 : 400;
    if (wantsJson(req)) {
      res.status(httpStatus).json({ error: code, error_description: message });
      return;
    }
    const currentUrl = req.method === "GET" ? currentUrlOf(req) : PILOT_PATHS.landing;
    sendHtml(
      res,
      errorPage({ currentUrl, lang: resolveLang(req), message, session, status: httpStatus }),
      httpStatus
    );
  }

  function requireSession(req: Req, res: Res, returnTo: string): ParentSession | null {
    const session = cuentaUnica.sessionFromRequest(req.headers);
    if (session) {
      return session;
    }
    if (wantsJson(req)) {
      res.status(401).json({
        error: "login_required",
        error_description: "Sign in with Cuenta Única first",
      });
    } else {
      res.redirect(302, `${PILOT_PATHS.login}?return_to=${encodeURIComponent(returnTo)}`);
    }
    return null;
  }

  function requireCsrf(req: Req, session: ParentSession): void {
    const supplied = req.body?.csrf_token ?? req.headers["x-pilot-csrf"];
    if (supplied !== session.csrfToken) {
      throw new PilotError(403, "csrf_failed", "Missing or invalid CSRF token");
    }
  }

  /** Browser path: remember the outcome on the session and show it on a GET page. */
  function redirectToResult(res: Res, session: ParentSession, kind: ResultKind, returnTo: string | null): void {
    session.lastResult = { kind, returnTo };
    res.redirect(SEE_OTHER, PILOT_PATHS.result);
  }

  // Route the hosted consent link for pilot-source requests to the parent surface.
  async function redirectPilotConsent(res: Res, next: () => void, requestUri: string): Promise<void> {
    try {
      await ready();
      if (await loadPendingPilotRequest(requestUri)) {
        res.redirect(302, consentUrl(requestUri));
        return;
      }
    } catch {
      // Fall through to the reference consent route.
    }
    next();
  }
  // Synchronous for every other request so the AS hot path (introspection) pays nothing.
  app.use((req, res, next) => {
    const requestUri = req.query?.request_uri;
    if (req.method !== "GET" || req.path !== "/consent" || typeof requestUri !== "string") {
      next();
      return;
    }
    return redirectPilotConsent(res, next, requestUri);
  });

  app.get(PILOT_PATHS.landing, async (req, res) => {
    const lang = langFor(req, res);
    const session = cuentaUnica.sessionFromRequest(req.headers);
    sendHtml(res, landingPage({ currentUrl: currentUrlOf(req), lang, session, startUrl: walkthroughStartUrl() }));
  });

  app.get(PILOT_PATHS.login, async (req, res) => {
    const lang = langFor(req, res);
    const returnTo = safeReturnTo(req.query.return_to);
    // Name the app the person continues to, when the sign-in comes from a consent link.
    let clientName: string | null = null;
    const requestUri = new URL(returnTo, "http://localhost").searchParams.get("request_uri");
    if (requestUri) {
      try {
        await ready();
        clientName = (await loadPendingPilotRequest(requestUri))?.clientName ?? null;
      } catch {
        clientName = null;
      }
    }
    sendHtml(
      res,
      loginPage({ clientName, currentUrl: currentUrlOf(req), error: req.query.error === "1", lang, returnTo })
    );
  });

  app.post(PILOT_PATHS.login, async (req, res) => {
    try {
      await ready();
      const session = await cuentaUnica.signIn(req.body?.cedula, req.body?.password);
      const returnTo = safeReturnTo(req.body?.return_to);
      if (!session) {
        if (wantsJson(req)) {
          res.status(401).json({
            error: "invalid_credentials",
            error_description: "Wrong cédula or password",
          });
        } else {
          res.redirect(SEE_OTHER, `${PILOT_PATHS.login}?error=1&return_to=${encodeURIComponent(returnTo)}`);
        }
        return;
      }
      res.setHeader("Set-Cookie", sessionCookie(session));
      if (wantsJson(req)) {
        res.json({
          csrf_token: session.csrfToken,
          display_name: session.displayName,
          session: session.sessionId,
        });
        return;
      }
      res.redirect(SEE_OTHER, returnTo);
    } catch (err) {
      fail(req, res, err);
    }
  });

  app.post(PILOT_PATHS.logout, async (req, res) => {
    const session = cuentaUnica.sessionFromRequest(req.headers);
    if (session) {
      cuentaUnica.signOut(session.sessionId);
    }
    res.setHeader("Set-Cookie", clearedSessionCookie());
    if (wantsJson(req)) {
      res.json({ signed_out: true });
      return;
    }
    res.redirect(SEE_OTHER, PILOT_PATHS.landing);
  });

  app.get(PILOT_PATHS.consent, async (req, res) => {
    const requestUri = String(req.query.request_uri ?? "");
    const session = requireSession(req, res, consentUrl(requestUri));
    if (!session) {
      return;
    }
    try {
      const lang = langFor(req, res);
      await ready();
      const pending = await consent.describeRequest(requestUri);
      // Before authority is verified, show only the person's own registry children.
      const children = consent.fixedChild(pending) ? null : await consent.listOwnChildren(session);
      if (wantsJson(req)) {
        res.json({
          children:
            children?.map((c) => ({
              capacity: c.capacity,
              child_id: c.child_id,
              given_name: c.given_name,
            })) ?? null,
          client_name: pending.clientName,
          record_named_by_request: children === null,
        });
        return;
      }
      sendHtml(
        res,
        pickChildPage({
          children,
          clientName: pending.clientName,
          currentUrl: currentUrlOf(req),
          lang,
          requestUri,
          session,
        })
      );
    } catch (err) {
      fail(req, res, err, session);
    }
  });

  app.post(`${PILOT_PATHS.consent}/select`, async (req, res) => {
    const requestUri = String(req.body?.request_uri ?? "");
    const session = requireSession(req, res, consentUrl(requestUri));
    if (!session) {
      return;
    }
    try {
      requireCsrf(req, session);
      await ready();
      const outcome = await consent.selectChild(session, requestUri, req.body?.child_id);
      if (outcome.kind === "refused") {
        if (wantsJson(req)) {
          res.status(403).json({
            error: "access_denied",
            redirect_to: outcome.redirectTo,
            registry_reason: outcome.registryReason,
          });
          return;
        }
        redirectToResult(res, session, "refused", outcome.redirectTo);
        return;
      }
      if (wantsJson(req)) {
        res.json({
          acting_as: outcome.capacity,
          approval_review: outcome.review,
          child: {
            birth_date: outcome.child.birth_date,
            child_id: outcome.child.child_id,
            given_name: outcome.child.given_name,
          },
          expires_at: outcome.expiresAt,
          grantors: outcome.grantors,
          pilot_revision: outcome.pilotRevision,
          request_uri: requestUri,
        });
        return;
      }
      const streams = (outcome.review.resolved_streams ?? []) as Array<{ fields?: unknown }>;
      session.review = {
        capacity: outcome.capacity,
        child: outcome.child,
        clientName: outcome.pending.clientName,
        expiresAt: outcome.expiresAt,
        fields: [...new Set(streams.flatMap((s) => (Array.isArray(s.fields) ? s.fields.map(String) : [])))],
        pilotRevision: outcome.pilotRevision,
        purposeDescription: outcome.pending.purposeDescription,
        requestUri,
      };
      res.redirect(SEE_OTHER, `${PILOT_PATHS.consentReview}?request_uri=${encodeURIComponent(requestUri)}`);
    } catch (err) {
      fail(req, res, err, session);
    }
  });

  app.get(PILOT_PATHS.consentReview, async (req, res) => {
    const requestUri = String(req.query.request_uri ?? "");
    const session = requireSession(req, res, consentUrl(requestUri));
    if (!session) {
      return;
    }
    const lang = langFor(req, res);
    // Only the review this session was already shown; otherwise start over at the picker.
    if (session.review?.requestUri !== requestUri) {
      res.redirect(302, consentUrl(requestUri));
      return;
    }
    sendHtml(res, reviewPage({ currentUrl: currentUrlOf(req), lang, review: session.review, session }));
  });

  app.post(`${PILOT_PATHS.consent}/approve`, async (req, res) => {
    const requestUri = String(req.body?.request_uri ?? "");
    const session = requireSession(req, res, consentUrl(requestUri));
    if (!session) {
      return;
    }
    try {
      requireCsrf(req, session);
      await ready();
      const outcome = await consent.approve(session, requestUri, req.body?.pilot_revision);
      if (session.review?.requestUri === requestUri) {
        delete session.review;
      }
      if (outcome.kind === "refused") {
        if (wantsJson(req)) {
          res.status(403).json({
            error: "access_denied",
            redirect_to: outcome.redirectTo,
            registry_reason: outcome.registryReason,
          });
          return;
        }
        redirectToResult(res, session, "refused", outcome.redirectTo);
        return;
      }
      res.setHeader("Cache-Control", "no-store");
      if (wantsJson(req)) {
        // Headless path: same envelope as the reference JSON /consent/approve.
        res.json({
          grant: outcome.grant,
          grant_id: outcome.grantId,
          redirect_to: outcome.redirectTo,
          token: outcome.token,
        });
        return;
      }
      if (outcome.redirectTo) {
        res.redirect(SEE_OTHER, outcome.redirectTo);
        return;
      }
      redirectToResult(res, session, "approved", null);
    } catch (err) {
      fail(req, res, err, session);
    }
  });

  app.post(`${PILOT_PATHS.consent}/deny`, async (req, res) => {
    const requestUri = String(req.body?.request_uri ?? "");
    const session = requireSession(req, res, PILOT_PATHS.authorizations);
    if (!session) {
      return;
    }
    try {
      requireCsrf(req, session);
      await ready();
      const outcome = await consent.decline(session, requestUri);
      if (session.review?.requestUri === requestUri) {
        delete session.review;
      }
      if (wantsJson(req)) {
        res.json({ error: "access_denied", redirect_to: outcome.redirectTo });
        return;
      }
      if (outcome.redirectTo) {
        res.redirect(SEE_OTHER, outcome.redirectTo);
        return;
      }
      redirectToResult(res, session, "declined", null);
    } catch (err) {
      fail(req, res, err, session);
    }
  });

  app.get(PILOT_PATHS.result, async (req, res) => {
    const session = requireSession(req, res, PILOT_PATHS.authorizations);
    if (!session) {
      return;
    }
    const lang = langFor(req, res);
    if (!session.lastResult) {
      res.redirect(302, PILOT_PATHS.authorizations);
      return;
    }
    sendHtml(
      res,
      resultPage({
        currentUrl: currentUrlOf(req),
        kind: session.lastResult.kind,
        lang,
        returnTo: session.lastResult.returnTo,
        session,
      })
    );
  });

  app.get(PILOT_PATHS.authorizations, async (req, res) => {
    const session = requireSession(req, res, PILOT_PATHS.authorizations);
    if (!session) {
      return;
    }
    try {
      const lang = langFor(req, res);
      await ready();
      const { children, grants } = await consent.listAuthorizations(session);
      if (wantsJson(req)) {
        res.json({
          authorizations: grants.map((g) => ({
            approved_at: g.approved_at,
            approved_by_you: g.approved_by_you,
            child_id: g.child_id,
            client_id: g.client_id,
            client_name: g.client_display_name,
            disposition: g.disposition,
            expires_at: g.expires_at,
            grant_id: g.grant_id,
            revoked_at: g.revoked_at,
            status: g.grant_status,
          })),
        });
        return;
      }
      const flash = req.query.revoked === "keep" || req.query.revoked === "delete" ? req.query.revoked : null;
      sendHtml(res, authorizationsPage({ children, currentUrl: currentUrlOf(req), flash, grants, lang, session }));
    } catch (err) {
      fail(req, res, err, session);
    }
  });

  app.post(`${PILOT_PATHS.authorizations}/:grantId/revoke`, async (req, res) => {
    const session = requireSession(req, res, PILOT_PATHS.authorizations);
    if (!session) {
      return;
    }
    try {
      requireCsrf(req, session);
      await ready();
      const grantId = String(req.params?.grantId ?? "");
      const disposition = req.body?.disposition;
      const row = await consent.revoke(session, grantId, disposition);
      if (wantsJson(req)) {
        res.json({
          disposition: row.disposition,
          grant_id: row.grant_id,
          revoked_at: row.revoked_at,
          status: row.grant_status,
        });
        return;
      }
      res.redirect(SEE_OTHER, `${PILOT_PATHS.authorizations}?revoked=${encodeURIComponent(String(disposition))}`);
    } catch (err) {
      fail(req, res, err, session);
    }
  });

  // Held-data lifecycle for the client holding the data (confidential clients only).
  app.post(PILOT_PATHS.grantLifecycle, async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      await ready();
      const get = headerGetter(req);
      const issuer = resolvePublicUrl(
        { get, protocol: req.protocol ?? "http" },
        process.env.AS_ISSUER || process.env.AS_PUBLIC_URL || null
      );
      const auth = await authenticateClientRequest({
        authorizationHeader: get("authorization"),
        body: req.body,
        expectedAudiences: [issuer],
        jtiCache: lifecycleJti,
        lookupClient: (clientId) => getRegisteredClient(clientId),
      });
      if (auth.kind !== "confidential") {
        res.status(401).json({
          error: "invalid_client",
          error_description: auth.kind === "failure" ? auth.description : "confidential client authentication required",
        });
        return;
      }
      const answer = await answerLifecycleQuery(auth.clientId, req.body ?? {});
      res.status(answer.status).json(answer.body);
    } catch (err) {
      fail(req, res, err);
    }
  });

  return { consent, cuentaUnica, ready, registry };
}
