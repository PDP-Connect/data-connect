// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash, timingSafeEqual } from "node:crypto";
import { escapeHtml, renderActionRow, renderHostedDocument, renderPageIntro } from "./hosted-ui.ts";
import { createOwnerLoginRateLimiter, type OwnerLoginRateLimitRequest } from "./owner-login-rate-limit.ts";
import { isBlockedOwnerPassword } from "./owner-password-blocklist.ts";
import { createOwnerPasswordVerifier } from "./owner-password-verifier.ts";
import type { OwnerPasswordVerifierStore } from "./stores/owner-password-verifier-store.ts";

interface SetupRequest extends OwnerLoginRateLimitRequest {
  readonly body?: Record<string, unknown>;
}

interface SetupResponse {
  setHeader: (name: string, value: string) => void;
  status: (code: number) => { send: (body: string) => unknown };
}

interface SetupApp {
  get: (path: string, handler: (_req: unknown, res: SetupResponse) => unknown) => void;
  post: (path: string, handler: (req: SetupRequest, res: SetupResponse) => unknown) => void;
}

interface SetupOwnerAuth {
  setPasswordVerifier: (verifier: Awaited<ReturnType<typeof createOwnerPasswordVerifier>>) => void;
}

function matchesToken(submitted: string, expected: string): boolean {
  const submittedDigest = createHash("sha256").update(submitted).digest();
  const expectedDigest = createHash("sha256").update(expected).digest();
  return timingSafeEqual(submittedDigest, expectedDigest);
}

function renderSetupPage(
  { error, errorField, success = false }: { error?: string; errorField?: "token" | "password"; success?: boolean } = {}
): string {
  const fieldError = (field: "token" | "password") =>
    error && errorField === field ? `<div class="hosted-ui-error" role="alert">${escapeHtml(error)}</div>` : "";
  const body = success
    ? [
        renderPageIntro({
          lede: "Your password is set. You can sign in now.",
          title: "Set up DataConnect",
        }),
        renderActionRow([{ href: "/owner/login", label: "Sign in", variant: "primary" }]),
      ].join("\n")
    : [
        renderPageIntro({
          lede: "Use your setup code to choose a password.",
          title: "Set up DataConnect",
        }),
        `<form class="hosted-ui-surface" method="post" aria-label="Set up DataConnect">
  <div class="hosted-ui-field">
    <label for="setup-token">Setup code</label>
    <input id="setup-token" name="token" required autocomplete="off" />
    ${fieldError("token")}
  </div>
  <div class="hosted-ui-field">
    <label for="setup-password">Password (15 characters minimum)</label>
    <input id="setup-password" type="password" name="password" required minlength="15"
      autocomplete="new-password" />
    ${fieldError("password")}
  </div>
  ${error && !errorField ? `<div class="hosted-ui-error" role="alert">${escapeHtml(error)}</div>` : ""}
  <div class="hosted-ui-actions">
    <button type="submit" class="hosted-ui-button" data-variant="primary">Set up DataConnect</button>
  </div>
</form>`,
      ].join("\n");

  return renderHostedDocument({
    body,
    consoleStyle: true,
    providerName: "DataConnect",
    title: "Set up DataConnect",
  });
}

function renderSetupUnavailablePage(): string {
  return renderHostedDocument({
    body: renderPageIntro({
      lede: "This setup page is no longer available.",
      title: "Set up DataConnect",
    }),
    consoleStyle: true,
    providerName: "DataConnect",
    title: "Set up DataConnect",
  });
}

/** Mount the first-run claim page. The store's insert-if-missing is the durable claim race gate. */
export function mountOwnerSetupRoutes(
  app: SetupApp,
  {
    ownerAuth,
    passwordStore,
    rateLimit,
    token,
  }: {
    ownerAuth: SetupOwnerAuth;
    passwordStore: OwnerPasswordVerifierStore;
    rateLimit: { max?: number; maxLocal?: number; trustedProxies?: string | null; windowMs?: number };
    token: string;
  }
): void {
  let tokenConsumed = false;
  const attempts = createOwnerLoginRateLimiter(rateLimit);

  app.get("/setup", (_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.status(200).send(renderSetupPage());
  });

  app.post("/setup", async (req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    const retryAfter = attempts.check(req);
    if (retryAfter !== null) {
      res.setHeader("Retry-After", String(retryAfter));
      res.status(429).send(
        renderSetupPage({ error: "Too many attempts. Try again in a little while.", errorField: "password" })
      );
      return;
    }
    if (tokenConsumed || (await passwordStore.read())) {
      res.status(403).send(renderSetupUnavailablePage());
      return;
    }

    const submittedToken = typeof req.body?.token === "string" ? req.body.token : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (!matchesToken(submittedToken, token)) {
      res.status(403).send(renderSetupPage({ error: "That setup code did not work.", errorField: "token" }));
      return;
    }
    if (Array.from(password).length < 15) {
      res
        .status(400)
        .send(renderSetupPage({ error: "Use a password with at least 15 characters.", errorField: "password" }));
      return;
    }

    if (isBlockedOwnerPassword(password)) {
      res.status(400).send(renderSetupPage({ error: "Choose a less common password.", errorField: "password" }));
      return;
    }

    tokenConsumed = true;
    try {
      const verifier = await createOwnerPasswordVerifier(password);
      if (!(await passwordStore.writeIfMissing(verifier))) {
        res.status(403).send(renderSetupUnavailablePage());
        return;
      }
      ownerAuth.setPasswordVerifier(verifier);
      attempts.recordSuccess(req);
      res.status(201).send(renderSetupPage({ success: true }));
    } catch {
      tokenConsumed = false;
      res
        .status(500)
        .send(renderSetupPage({ error: "We could not save your password. Try again.", errorField: "password" }));
    }
  });
}
