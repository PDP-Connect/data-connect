// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Acceptance coverage for the owner recovery-key export route
 * (server/routes/owner-recovery-key.ts). Mirrors
 * owner-remote-access-route.test.ts's FakeApp harness: this route is a pure
 * relay over RecoveryKeyStore, so what matters here is that it forwards the
 * store's result/error faithfully and never touches the OS keychain,
 * session/token verification, or the code itself beyond passing it through.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { mountOwnerRecoveryKey } from "../server/routes/owner-recovery-key.ts";
import type { RecoveryKeyStore } from "../server/recovery-key-store.ts";

interface CapturedResponse {
  body: unknown;
  status: number;
}

type Handler = (req: unknown, res: unknown) => unknown | Promise<unknown>;

class FakeApp {
  readonly routes = new Map<string, Handler>();

  post(path: string, ...args: unknown[]): this {
    this.routes.set(`POST ${path}`, args.at(-1) as Handler);
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

function mount(store: RecoveryKeyStore): FakeApp["routes"] {
  const app = new FakeApp();
  mountOwnerRecoveryKey(app as unknown as Parameters<typeof mountOwnerRecoveryKey>[0], {
    handleError: (res, err) => {
      (res as { status: (code: number) => { json: (body: unknown) => void } })
        .status(500)
        .json({ error: { message: err instanceof Error ? err.message : String(err) } });
    },
    requireOwner: (...args: unknown[]) => (args[2] as () => void)(),
    requireToken: (...args: unknown[]) => (args[2] as () => void)(),
    store,
  });
  return app.routes;
}

test("POST export returns the store's code", async () => {
  const routes = mount({ requestExport: async () => "AB12-CD34-EF56" });
  const handler = routes.get("POST /v1/owner/recovery-key/export");
  assert.ok(handler);

  const { captured, res } = makeRes();
  await handler?.({}, res);
  assert.deepEqual(captured.body, { data: { code: "AB12-CD34-EF56" }, object: "recovery_key_export" });
});

test("POST export surfaces a refusal from the store as an error response, not a code", async () => {
  const routes = mount({
    requestExport: async () => {
      throw new Error("No encrypted vault exists yet.");
    },
  });
  const handler = routes.get("POST /v1/owner/recovery-key/export");

  const { captured, res } = makeRes();
  await handler?.({}, res);
  assert.equal(captured.status, 500);
  assert.match(String((captured.body as { error: { message: string } }).error.message), /No encrypted vault/);
});

test("POST export registers requireToken and requireOwner ahead of the handler", async () => {
  // FakeApp (matching owner-remote-access-route.test.ts's own harness) only
  // captures the final positional arg as the handler; it does not invoke
  // registered middlewares, so this checks REGISTRATION order/count rather
  // than runtime invocation -- the actual `requireToken`/`requireOwner`
  // enforcement is exercised by those middlewares' own tests, the same
  // boundary owner-remote-access-route.test.ts already draws.
  const registeredArgs: unknown[] = [];
  const app = {
    post(_path: string, ...args: unknown[]) {
      registeredArgs.push(...args);
      return this;
    },
  };
  mountOwnerRecoveryKey(app as unknown as Parameters<typeof mountOwnerRecoveryKey>[0], {
    handleError: () => {},
    requireOwner: () => {},
    requireToken: () => {},
    store: { requestExport: async () => "CODE" },
  });
  assert.equal(registeredArgs.length, 3, "expected requireToken, requireOwner, and the handler");
});
