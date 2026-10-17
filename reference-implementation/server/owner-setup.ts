// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash, timingSafeEqual } from "node:crypto";
import { createOwnerLoginRateLimiter, type OwnerLoginRateLimitRequest } from "./owner-login-rate-limit.ts";
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
    res
      .status(200)
      .send(
        '<!doctype html><html><meta charset="utf-8"><title>Set owner password</title><h1>Set owner password</h1><form method="post"><label>Setup token <input name="token" required autocomplete="off"></label><label>New password (15 characters minimum) <input type="password" name="password" required minlength="15" autocomplete="new-password"></label><button type="submit">Claim this install</button></form></html>'
      );
  });

  app.post("/setup", async (req, res) => {
    const retryAfter = attempts.check(req);
    if (retryAfter !== null) {
      res.setHeader("Retry-After", String(retryAfter));
      res.status(429).send("Too many setup attempts.");
      return;
    }
    if (tokenConsumed || (await passwordStore.read())) {
      res.status(403).send("Setup is no longer available.");
      return;
    }

    const submittedToken = typeof req.body?.token === "string" ? req.body.token : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (!matchesToken(submittedToken, token)) {
      res.status(403).send("Invalid setup token.");
      return;
    }
    if (Array.from(password).length < 15) {
      res.status(400).send("Password must contain at least 15 characters.");
      return;
    }

    tokenConsumed = true;
    try {
      const verifier = await createOwnerPasswordVerifier(password);
      if (!(await passwordStore.writeIfMissing(verifier))) {
        res.status(403).send("Setup is no longer available.");
        return;
      }
      ownerAuth.setPasswordVerifier(verifier);
      attempts.recordSuccess(req);
      res.status(201).send("Owner password set. You can now sign in.");
    } catch {
      tokenConsumed = false;
      res.status(500).send("Unable to save the owner password.");
    }
  });
}
