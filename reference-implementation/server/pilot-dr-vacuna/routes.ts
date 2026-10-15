// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// HTTP surface for the DR pilot. Mounted on the AS app only when
// PDPP_PILOT_DR_VACUNA=1 (see server/index.ts buildAsApp).
//
//   GET  /pilot/cuenta-unica/login            sign-in form (stub)
//   POST /pilot/cuenta-unica/login            cédula + demo password -> session cookie
//   POST /pilot/cuenta-unica/logout
//   GET  /pilot/vacuna/consent?request_uri=   pick a child (or confirm the named record)
//   POST /pilot/vacuna/consent/select         registry check, then review
//   POST /pilot/vacuna/consent/approve        approve the bound review revision
//   POST /pilot/vacuna/consent/deny           decline
//   GET  /pilot/vacuna/autorizaciones         "Mis autorizaciones"
//   POST /pilot/vacuna/autorizaciones/:grantId/revoke  keep-or-delete withdrawal
//
// Every route answers JSON when the request sends `Accept: application/json`
// or a JSON body; that is the headless path the load harness uses.
//
// GET /consent for a pending request on the pilot source is redirected here,
// so a client that starts with PAR or /oauth/authorize lands on the parent
// surface without knowing about it.

import { isPostgresStorageBackend } from "../postgres-storage.ts";
import { PILOT_PATHS } from "./config.ts";
import {
  type CuentaUnicaStub,
  clearedSessionCookie,
  createCuentaUnicaStub,
  type ParentSession,
  sessionCookie,
} from "./cuenta-unica-stub.ts";
import { authorizationsPage, errorPage, loginPage, pickChildPage, resultPage, reviewPage } from "./html.ts";
import { type CivilRegistry, createPostgresCivilRegistry, ensureRegistrySchema } from "./registry-stub.ts";
import { createRepresentativeConsent, loadPendingPilotRequest, PilotError } from "./representative-consent.ts";
import { ensurePilotStoreSchema } from "./store.ts";

interface Req {
  body?: Record<string, unknown> | null;
  headers: Record<string, unknown>;
  method?: string;
  params?: Record<string, string>;
  path?: string;
  query: Record<string, unknown>;
}

interface Res {
  headersSent?: boolean;
  json: (body: unknown) => unknown;
  redirect: (status: number, url: string) => unknown;
  send: (body: unknown) => unknown;
  setHeader: (name: string, value: string) => unknown;
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

export function mountDrVacunaPilot(app: AppLike, options: DrVacunaPilotOptions = {}) {
  const registry = options.registry ?? createPostgresCivilRegistry();
  const cuentaUnica: CuentaUnicaStub = createCuentaUnicaStub(registry);
  const consent = createRepresentativeConsent(registry);
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

  function fail(req: Req, res: Res, err: unknown, session: ParentSession | null = null): void {
    const status = err instanceof PilotError ? err.status : Number((err as { status?: number }).status) || 500;
    const code = err instanceof PilotError ? err.code : String((err as { code?: string }).code || "server_error");
    const message = err instanceof Error ? err.message : String(err);
    const httpStatus = status >= 400 && status < 600 ? status : code === "server_error" ? 500 : 400;
    if (wantsJson(req)) {
      res.status(httpStatus).json({ error: code, error_description: message });
      return;
    }
    res.status(httpStatus).send(errorPage(session, httpStatus, message));
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

  // Route the hosted consent link for pilot-source requests to the parent surface.
  async function redirectPilotConsent(res: Res, next: () => void, requestUri: string): Promise<void> {
    try {
      await ready();
      if (await loadPendingPilotRequest(requestUri)) {
        res.redirect(302, `${PILOT_PATHS.consent}?request_uri=${encodeURIComponent(requestUri)}`);
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

  app.get(PILOT_PATHS.login, async (req, res) => {
    res.send(loginPage(safeReturnTo(req.query.return_to), req.query.error === "1"));
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
          res.redirect(302, `${PILOT_PATHS.login}?error=1&return_to=${encodeURIComponent(returnTo)}`);
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
      res.redirect(302, returnTo);
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
    res.redirect(302, PILOT_PATHS.login);
  });

  app.get(PILOT_PATHS.consent, async (req, res) => {
    const requestUri = String(req.query.request_uri ?? "");
    const session = requireSession(req, res, `${PILOT_PATHS.consent}?request_uri=${encodeURIComponent(requestUri)}`);
    if (!session) {
      return;
    }
    try {
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
      res.send(pickChildPage(session, requestUri, pending.clientName, children));
    } catch (err) {
      fail(req, res, err, session);
    }
  });

  app.post(`${PILOT_PATHS.consent}/select`, async (req, res) => {
    const requestUri = String(req.body?.request_uri ?? "");
    const session = requireSession(req, res, `${PILOT_PATHS.consent}?request_uri=${encodeURIComponent(requestUri)}`);
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
        res.send(resultPage(session, "refused", outcome.redirectTo));
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
      res.send(
        reviewPage(session, {
          capacity: outcome.capacity,
          child: outcome.child,
          clientName: outcome.pending.clientName,
          expiresAt: outcome.expiresAt,
          pilotRevision: outcome.pilotRevision,
          purposeDescription: outcome.pending.purposeDescription,
          requestUri,
          streams: outcome.pending.streams,
        })
      );
    } catch (err) {
      fail(req, res, err, session);
    }
  });

  app.post(`${PILOT_PATHS.consent}/approve`, async (req, res) => {
    const requestUri = String(req.body?.request_uri ?? "");
    const session = requireSession(req, res, `${PILOT_PATHS.consent}?request_uri=${encodeURIComponent(requestUri)}`);
    if (!session) {
      return;
    }
    try {
      requireCsrf(req, session);
      await ready();
      const outcome = await consent.approve(session, requestUri, req.body?.pilot_revision);
      if (outcome.kind === "refused") {
        if (wantsJson(req)) {
          res.status(403).json({
            error: "access_denied",
            redirect_to: outcome.redirectTo,
            registry_reason: outcome.registryReason,
          });
          return;
        }
        res.send(resultPage(session, "refused", outcome.redirectTo));
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
        res.redirect(302, outcome.redirectTo);
        return;
      }
      res.send(resultPage(session, "approved"));
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
      if (wantsJson(req)) {
        res.json({ error: "access_denied", redirect_to: outcome.redirectTo });
        return;
      }
      if (outcome.redirectTo) {
        res.redirect(302, outcome.redirectTo);
        return;
      }
      res.send(resultPage(session, "declined"));
    } catch (err) {
      fail(req, res, err, session);
    }
  });

  app.get(PILOT_PATHS.authorizations, async (req, res) => {
    const session = requireSession(req, res, PILOT_PATHS.authorizations);
    if (!session) {
      return;
    }
    try {
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
      const flash =
        req.query.revoked === "keep"
          ? 'Autorización retirada. La aplicación puede conservar los datos ya recibidos. <span class="en">Authorization withdrawn. The app may keep data it already received.</span>'
          : req.query.revoked === "delete"
            ? 'Autorización retirada. Se pidió a la aplicación borrar los datos recibidos. <span class="en">Authorization withdrawn. The app was told to delete the data it received.</span>'
            : null;
      res.send(authorizationsPage(session, children, grants, flash));
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
      res.redirect(302, `${PILOT_PATHS.authorizations}?revoked=${encodeURIComponent(String(disposition))}`);
    } catch (err) {
      fail(req, res, err, session);
    }
  });

  return { consent, cuentaUnica, ready, registry };
}
