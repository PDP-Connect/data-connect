// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Acceptance coverage for the owner credential-reveal route
 * (server/routes/owner-credential-reveal.ts). Mirrors
 * owner-recovery-key-route.test.ts's FakeApp harness: this route is a pure
 * accessor over an in-memory password, so what matters here is that it
 * returns the configured password faithfully, refuses cleanly when owner
 * auth is disabled, and requires the same owner-bearer guards every other
 * `/v1/owner/*` route uses.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { mountOwnerCredentialReveal } from "../server/routes/owner-credential-reveal.ts";

interface CapturedResponse {
  body: unknown;
  status: number;
}

type Handler = (req: unknown, res: unknown) => unknown | Promise<unknown>;

class FakeApp {
  readonly routes = new Map<string, Handler>();

  get(path: string, ...args: unknown[]): this {
    this.routes.set(`GET ${path}`, args.at(-1) as Handler);
    return this;
  }
}

function makeRes(): { captured: CapturedResponse; res: unknown } {
  const captured: CapturedResponse = { body: undefined, status: 200 };
  const res = {
    json: (body: unknown) => {
      captured.body = body;
      return res;
    },
    status: (code: number) => {
      captured.status = code;
      return res;
    },
  };
  return { captured, res };
}

function mount(readOwnerPassword: () => string | null): FakeApp["routes"] {
  const app = new FakeApp();
  mountOwnerCredentialReveal(app as unknown as Parameters<typeof mountOwnerCredentialReveal>[0], {
    handleError: (res, err) => {
      (res as { status: (code: number) => { json: (body: unknown) => void } })
        .status(500)
        .json({ error: { message: err instanceof Error ? err.message : String(err) } });
    },
    isEligibleForReveal: () => true,
    readOwnerPassword,
    requireOwner: (...args: unknown[]) => (args[2] as () => void)(),
    requireToken: (...args: unknown[]) => (args[2] as () => void)(),
  });
  return app.routes;
}

test("GET reveal returns the configured owner password", async () => {
  const routes = mount(() => "correct-horse-battery-staple");
  const handler = routes.get("GET /v1/owner/credential/reveal");
  assert.ok(handler);

  const { captured, res } = makeRes();
  await handler?.({}, res);
  assert.deepEqual(captured.body, {
    data: { password: "correct-horse-battery-staple" },
    object: "owner_credential_reveal",
  });
  assert.equal(captured.status, 200);
});

test("GET reveal returns 404 when owner auth is disabled (no password configured)", async () => {
  const routes = mount(() => null);
  const handler = routes.get("GET /v1/owner/credential/reveal");

  const { captured, res } = makeRes();
  await handler?.({}, res);
  assert.equal(captured.status, 404);
  assert.equal(
    (captured.body as { error: { code: string } }).error.code,
    "owner_auth_disabled"
  );
});

test("GET reveal surfaces an accessor throw as an error response, not a password", async () => {
  const routes = mount(() => {
    throw new Error("keychain unavailable");
  });
  const handler = routes.get("GET /v1/owner/credential/reveal");

  const { captured, res } = makeRes();
  await handler?.({}, res);
  assert.equal(captured.status, 500);
  assert.match(String((captured.body as { error: { message: string } }).error.message), /keychain unavailable/);
});

test("GET reveal registers requireToken and requireOwner ahead of the handler", async () => {
  // FakeApp (matching owner-recovery-key-route.test.ts's own harness) only
  // captures the final positional arg as the handler; it does not invoke
  // registered middlewares, so this checks REGISTRATION order/count rather
  // than runtime invocation -- the actual `requireToken`/`requireOwner`
  // enforcement is exercised by those middlewares' own tests, the same
  // boundary owner-recovery-key-route.test.ts already draws.
  const registeredArgs: unknown[] = [];
  const app = {
    get(_path: string, ...args: unknown[]) {
      registeredArgs.push(...args);
      return this;
    },
  };
  mountOwnerCredentialReveal(app as unknown as Parameters<typeof mountOwnerCredentialReveal>[0], {
    handleError: () => {},
    isEligibleForReveal: () => true,
    readOwnerPassword: () => "irrelevant",
    requireOwner: () => {},
    requireToken: () => {},
  });
  assert.equal(registeredArgs.length, 3, "expected requireToken, requireOwner, and the handler");
});
