// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// HTTP adapter for the AS owner device-verification UI route family.
//
// Behaviour-preserving extraction from `server/index.js` per the OpenSpec
// change `split-reference-server-by-route-family` (§6).
//
// Covers:
//   GET  /device          — owner-session-gated verification code entry / approval form
//   POST /device/approve  — owner-session + CSRF gated device-code approval
//   POST /device/deny     — owner-session + CSRF gated device-code denial
//
// Auth posture: all three routes require an owner session. /device/approve and
// /device/deny additionally require CSRF enforcement.
//
// Canonical operation:
//   operations/as-device-decision/index.ts → approve/deny semantics,
//     approval_id→user_code resolution, error mapping

import {
  type AsDeviceDecisionDependencies,
  executeAsDeviceDecision,
} from "../../operations/as-device-decision/index.ts";
import type { RouteArg } from "./_route-contract.ts";

// ─── Minimal structural types ────────────────────────────────────────────────

interface RouteRequest {
  readonly body?: Record<string, unknown> | null;
  readonly headers?: { readonly accept?: string };
  readonly query?: Readonly<Record<string, unknown>>;
}

interface RouteResponse {
  send: (body: string) => unknown;
  setHeader: (name: string, value: string) => unknown;
  status: (code: number) => RouteResponse;
}

type NextFn = () => void;
type MiddlewareFn = (req: RouteRequest, res: RouteResponse, next: NextFn) => Promise<void> | void;
type RouteHandler = (req: RouteRequest, res: RouteResponse) => Promise<void>;

interface AppLike {
  get: (path: string, ...args: RouteArg<RouteHandler | MiddlewareFn>[]) => AppLike;
  post: (path: string, ...args: RouteArg<RouteHandler | MiddlewareFn>[]) => AppLike;
}

function deviceErrorSentence(action: "approve" | "deny", code: string): string {
  if (code === "owner_session_required") {
    return "Sign in again to continue.";
  }
  if (code === "invalid_grant" || code === "not_found" || code === "expired_token") {
    return "This request is no longer available.";
  }
  return `We could not ${action} this request. Please try again.`;
}

function replyDeviceError(
  req: RouteRequest,
  res: RouteResponse,
  ctx: MountAsDeviceUiContext,
  status: number,
  code: string,
  message: string,
  action: "approve" | "deny"
): void {
  if (!req.headers?.accept?.includes("text/html")) {
    ctx.oauthError(res, status, code, message);
    return;
  }

  const safeMessage = ctx.ui.escapeHtml(deviceErrorSentence(action, code));
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.status(status).send(
    ctx.ui.renderHostedDocument({
      body: [
        ctx.ui.renderPageIntro({ title: "Connect a device" }),
        `<p class="hosted-ui-error" role="alert">${safeMessage}</p>`,
        // RAISE-RULES 6: a failed state offers "Try again".
        '<div class="hosted-ui-actions"><a class="hosted-ui-button" href="/device">Try again</a></div>',
      ].join("\n"),
      consoleStyle: true,
      providerName: ctx.providerName,
      title: "Connect a device",
    })
  );
}

function formatDeviceExpiry(value: unknown): string {
  let expiresAt: number;
  if (typeof value === "number") {
    expiresAt = value < 10_000_000_000 ? value * 1000 : value;
  } else {
    expiresAt = Date.parse(String(value ?? ""));
  }
  if (!Number.isFinite(expiresAt)) {
    return "Time unavailable";
  }

  const seconds = Math.ceil((expiresAt - Date.now()) / 1000);
  if (seconds <= 0) {
    return "Expired";
  }
  if (seconds < 60) {
    return "in less than a minute";
  }
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) {
    return `in ${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  }
  const hours = Math.ceil(minutes / 60);
  if (hours < 24) {
    return `in ${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  const days = Math.ceil(hours / 24);
  return `in ${days} ${days === 1 ? "day" : "days"}`;
}

// ─── Hosted-UI rendering surface (injected to avoid importing .js directly) ──

export interface HostedUiRenderer {
  escapeHtml: (input: unknown) => string;
  renderEmptyState: (opts: {
    form?: {
      method: string;
      action: string;
      submitLabel: string;
      fields: Array<{
        name: string;
        label: string;
        value: string;
        autofocus?: boolean;
        autocomplete?: string;
      }>;
    };
  }) => string;
  renderHostedDocument: (opts: { title: string; providerName: string; body: string; consoleStyle?: boolean }) => string;
  renderKeyValueList: (items: Array<{ label: string; value?: unknown; html?: string }>) => string;
  renderPageIntro: (opts: { eyebrow?: string; title: string; lede?: string }) => string;
  renderResultState: (opts: { tone: string; title: string; body: string }) => string;
  renderSurface: (opts: { surface?: string; children: string }) => string;
}

// ─── Injected capabilities ───────────────────────────────────────────────────

export interface OwnerDeviceAuthPendingRow {
  readonly client_id: string;
  readonly expires_at: unknown;
  readonly user_code: string;
}

export interface MountAsDeviceUiContext {
  /** Device-decision store capabilities. */
  deviceDecision: AsDeviceDecisionDependencies;
  /** Generates a fresh CSRF token and sets it in the response. */
  ensureCsrfToken: (req: RouteRequest, res: RouteResponse) => string;
  /** Looks up a pending device-auth record by user_code; null if not found. */
  getByUserCode: (userCode: string) => Promise<OwnerDeviceAuthPendingRow | null> | OwnerDeviceAuthPendingRow | null;
  /** Writes an OAuth error envelope (`error` / `error_description`). */
  oauthError: (res: unknown, status: number, code: string, message: string) => unknown;
  /** Default subject ID used when owner-auth is disabled and no subject_id in form body. */
  ownerAuthDefaultSubjectId: string;
  /** Whether owner-session auth is enabled on this server instance. */
  ownerAuthEnabled: boolean;
  /** Reads the active owner session hash and credential revision from server state. */
  readOwnerAuthorizationFence: (
    req: RouteRequest
  ) => Promise<{ credentialRevision?: string | null; sessionIdHash?: string } | null>;
  /** Test seam for holding the request after authorization capture and before approval persistence. */
  beforeOwnerDeviceApproval?: () => Promise<void> | void;
  /** The subject ID of the currently signed-in owner. Only valid when ownerAuthEnabled is true. */
  ownerSubjectId: string;
  /** Human-readable display name for the provider (shown in page titles). */
  providerName: string;
  /** Renders a hidden CSRF input field for the given token. */
  renderCsrfField: (token: string) => string;
  /** CSRF enforcement middleware. */
  requireCsrf: MiddlewareFn;
  /** Owner-session enforcement middleware. */
  requireOwnerSession: MiddlewareFn;
  /** Attaches a trace-id header to the response. */
  setReferenceTraceId: (res: unknown, traceId: string) => void;
  /** Hosted-UI rendering helpers injected to avoid a direct .js import. */
  ui: HostedUiRenderer;
}

// ─── Route mount ─────────────────────────────────────────────────────────────

export function mountAsDeviceUi(app: AppLike, ctx: MountAsDeviceUiContext): void {
  const getHandler: RouteHandler = async (req, res): Promise<void> => {
    const { ui } = ctx;
    const userCode = typeof req.query?.user_code === "string" ? req.query.user_code : "";
    const pending = userCode ? await ctx.getByUserCode(userCode) : null;

    if (!(userCode && pending)) {
      const emptyBody = [
        ui.renderPageIntro({
          lede: "Enter the code shown on your device.",
          title: "Connect a device",
        }),
        ui.renderEmptyState({
          form: {
            action: "/device",
            fields: [
              {
                autocomplete: "one-time-code",
                autofocus: true,
                label: "Code",
                name: "user_code",
                value: userCode || "",
              },
            ],
            method: "GET",
            submitLabel: "Continue",
          },
        }),
      ].join("\n");
      res.send(
        ui.renderHostedDocument({
          body: emptyBody,
          consoleStyle: true,
          providerName: ctx.providerName,
          title: "Connect a device",
        })
      );
      return;
    }

    const facts = ui.renderKeyValueList([
      { label: "App", value: pending.client_id },
      { html: `<span class="hosted-ui-code">${ui.escapeHtml(pending.user_code)}</span>`, label: "Code" },
      { label: "Expires", value: formatDeviceExpiry(pending.expires_at) },
    ]);

    const ownerBlock = ctx.ownerAuthEnabled
      ? // RAISE-RULES 1: the signed-in account ID stays reachable in a folded "Details".
        `<details class="hosted-ui-details"><summary>Details</summary>
${ui.renderKeyValueList([{ html: `<code>${ui.escapeHtml(ctx.ownerSubjectId)}</code>`, label: "Account ID" }])}
</details>`
      : `<div class="hosted-ui-field">
  <label for="hosted-ui-subject_id">Account name</label>
  <input id="hosted-ui-subject_id" name="subject_id" value="owner_local" type="text" />
</div>`;

    const csrfToken = ctx.ensureCsrfToken(req, res);
    const csrfField = ctx.renderCsrfField(csrfToken);
    const formOpen = `<form class="hosted-ui-surface" method="POST" action="/device/approve"
  data-surface="human" aria-label="Connect a device">
  ${csrfField}
  <input type="hidden" name="user_code" value="${ui.escapeHtml(pending.user_code)}" />
  ${facts}
  ${ownerBlock}
  <div class="hosted-ui-actions">
    <button type="submit" class="hosted-ui-button" data-variant="primary">Approve</button>
    <button type="submit" class="hosted-ui-button" formaction="/device/deny">Deny</button>
  </div>
</form>`;

    const body = [
      ui.renderPageIntro({
        lede: "Approve only if you started this on a device you trust.",
        title: "Connect a device",
      }),
      formOpen,
    ].join("\n");

    res.send(
      ui.renderHostedDocument({
        body,
        consoleStyle: true,
        providerName: ctx.providerName,
        title: "Connect a device",
      })
    );
  };

  // Device approve/deny decision semantics (approval_id → user_code
  // resolution behind the owner-session + CSRF gate, store call, error
  // mapping) live in the canonical `as.device.decision` operation
  // (operations/as-device-decision). The host adapter owns owner-session
  // + CSRF enforcement, subject-id resolution, and the hosted-UI HTML
  // result rendering.
  const approveHandler: RouteHandler = async (req, res): Promise<void> => {
    const { ui } = ctx;
    const subjectId = ctx.ownerAuthEnabled
      ? ctx.ownerSubjectId
      : (req.body?.subject_id as string) || ctx.ownerAuthDefaultSubjectId;
    const authorizationFence = ctx.ownerAuthEnabled ? await ctx.readOwnerAuthorizationFence(req) : null;
    if (ctx.ownerAuthEnabled && !authorizationFence) {
      replyDeviceError(
        req,
        res,
        ctx,
        401,
        "owner_session_required",
        "Sign in again to approve device access.",
        "approve"
      );
      return;
    }
    await ctx.beforeOwnerDeviceApproval?.();
    const outcome = await executeAsDeviceDecision(
      {
        action: "approve",
        ...(authorizationFence === null ? {} : { authorizationFence }),
        approvalId: req.body?.approval_id as string | null | undefined,
        subjectId,
        userCode: req.body?.user_code as string | null | undefined,
      },
      ctx.deviceDecision
    );
    if (outcome.outcome === "success") {
      res.send(
        ui.renderHostedDocument({
          body: [
            ui.renderPageIntro({ title: "Connect a device" }),
            ui.renderSurface({
              children: ui.renderResultState({
                body: "Your device can finish signing in.",
                title: "Approved",
                tone: "neutral",
              }),
              surface: "human",
            }),
          ].join("\n"),
          consoleStyle: true,
          providerName: ctx.providerName,
          title: "Connect a device",
        })
      );
      return;
    }
    if (outcome.requestId) {
      res.setHeader("Request-Id", outcome.requestId);
    }
    if (outcome.traceId) {
      ctx.setReferenceTraceId(res, outcome.traceId);
    }
    replyDeviceError(req, res, ctx, outcome.status, outcome.errorCode, outcome.errorMessage, "approve");
  };

  const denyHandler: RouteHandler = async (req, res): Promise<void> => {
    const { ui } = ctx;
    const subjectId = ctx.ownerAuthEnabled
      ? ctx.ownerSubjectId
      : (req.body?.subject_id as string) || ctx.ownerAuthDefaultSubjectId;
    const outcome = await executeAsDeviceDecision(
      {
        action: "deny",
        approvalId: req.body?.approval_id as string | null | undefined,
        subjectId,
        userCode: req.body?.user_code as string | null | undefined,
      },
      ctx.deviceDecision
    );
    if (outcome.outcome === "success") {
      res.send(
        ui.renderHostedDocument({
          body: [
            ui.renderPageIntro({ title: "Connect a device" }),
            ui.renderSurface({
              children: ui.renderResultState({
                body: "The request was denied. You can return to your device.",
                title: "Denied",
                tone: "neutral",
              }),
            }),
          ].join("\n"),
          consoleStyle: true,
          providerName: ctx.providerName,
          title: "Connect a device",
        })
      );
      return;
    }
    if (outcome.requestId) {
      res.setHeader("Request-Id", outcome.requestId);
    }
    if (outcome.traceId) {
      ctx.setReferenceTraceId(res, outcome.traceId);
    }
    replyDeviceError(req, res, ctx, outcome.status, outcome.errorCode, outcome.errorMessage, "deny");
  };

  app.get("/device", ctx.requireOwnerSession as RouteArg<RouteHandler | MiddlewareFn>, getHandler);
  app.post(
    "/device/approve",
    ctx.requireOwnerSession as RouteArg<RouteHandler | MiddlewareFn>,
    ctx.requireCsrf as RouteArg<RouteHandler | MiddlewareFn>,
    approveHandler
  );
  app.post(
    "/device/deny",
    ctx.requireOwnerSession as RouteArg<RouteHandler | MiddlewareFn>,
    ctx.requireCsrf as RouteArg<RouteHandler | MiddlewareFn>,
    denyHandler
  );
}
