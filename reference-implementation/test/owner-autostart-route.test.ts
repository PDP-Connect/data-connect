// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Acceptance coverage for the owner autostart routes
 * (server/routes/owner-autostart.ts).
 *
 * These routes are the HTTP replacement for the two Tauri commands the
 * console used to call directly (get_autostart_enabled /
 * set_autostart_enabled, in src-tauri/src/commands/desktop_settings.rs) --
 * unreachable from the console's http://127.0.0.1:{port} window. Unlike
 * app-config, autostart is an imperative OS action only the Tauri/Rust
 * process can perform, so POST here hands off to a request/ack file the
 * desktop app's spawn_autostart_watcher polls and applies -- these tests use
 * a fake AutostartStore rather than the real file-backed one, since
 * autostart-store.test.ts already covers that store's file-polling
 * contract directly.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { AutostartState, AutostartStore } from "../server/autostart-store.ts";
import { mountOwnerAutostart } from "../server/routes/owner-autostart.ts";

interface CapturedResponse {
  body: unknown;
  status: number;
}

type Handler = (req: unknown, res: unknown) => unknown | Promise<unknown>;

class FakeApp {
  readonly routes = new Map<string, Handler>();

  private register(method: string, path: string, args: unknown[]): this {
    this.routes.set(`${method} ${path}`, args.at(-1) as Handler);
    return this;
  }

  get(path: string, ...args: unknown[]): this {
    return this.register("GET", path, args);
  }

  post(path: string, ...args: unknown[]): this {
    return this.register("POST", path, args);
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

function fakeStore(initial: AutostartState): AutostartStore & { state: AutostartState } {
  const store = {
    load: async () => store.state,
    requestChange: async (desiredEnabled: boolean) => {
      store.state = {
        ...store.state,
        appliedRequestId: store.state.requestId + 1,
        desiredEnabled,
        enabled: desiredEnabled,
        error: null,
        requestId: store.state.requestId + 1,
      };
      return store.state;
    },
    state: initial,
  };
  return store;
}

function mountWithStore(store: AutostartStore): FakeApp["routes"] {
  const app = new FakeApp();
  mountOwnerAutostart(app as unknown as Parameters<typeof mountOwnerAutostart>[0], {
    handleError: (res, err) => {
      (res as { status: (code: number) => { json: (body: unknown) => void } })
        .status(500)
        .json({ error: { message: err instanceof Error ? err.message : String(err) } });
    },
    pdppError: (res, status, code, message) => {
      res.status(status).json({ error: { code, message } });
    },
    requireOwner: (...args: unknown[]) => (args[2] as () => void)(),
    requireToken: (...args: unknown[]) => (args[2] as () => void)(),
    store,
  });
  return app.routes;
}

test("GET autostart projects only enabled/error/pending, not request bookkeeping", async () => {
  const routes = mountWithStore(
    fakeStore({ appliedRequestId: 2, desiredEnabled: true, enabled: true, error: null, requestId: 2 })
  );
  const handler = routes.get("GET /v1/owner/autostart");
  assert.ok(handler);
  const { captured, res } = makeRes();
  await handler?.({}, res);
  assert.deepEqual(captured.body, { data: { enabled: true, error: null, pending: false }, object: "autostart_state" });
});

test("GET autostart reports a requested change the desktop app has not applied yet as pending", async () => {
  const routes = mountWithStore(
    fakeStore({ appliedRequestId: 2, desiredEnabled: true, enabled: false, error: null, requestId: 3 })
  );
  const { captured, res } = makeRes();
  await routes.get("GET /v1/owner/autostart")?.({}, res);
  assert.deepEqual(captured.body, { data: { enabled: false, error: null, pending: true }, object: "autostart_state" });
});

test("GET autostart surfaces a load failure (desktop app not seeded yet) via handleError", async () => {
  const store: AutostartStore = {
    load: async () => {
      throw new Error("Autostart state is not available yet.");
    },
    requestChange: async () => {
      throw new Error("unused");
    },
  };
  const routes = mountWithStore(store);
  const handler = routes.get("GET /v1/owner/autostart");
  const { captured, res } = makeRes();
  await handler?.({}, res);
  assert.equal(captured.status, 500);
});

test("POST autostart requests a change and returns the applied result", async () => {
  const routes = mountWithStore(
    fakeStore({ appliedRequestId: 0, desiredEnabled: false, enabled: false, error: null, requestId: 0 })
  );
  const handler = routes.get("POST /v1/owner/autostart");
  const { captured, res } = makeRes();
  await handler?.({ body: { enabled: true } }, res);
  assert.deepEqual(captured.body, { data: { enabled: true, error: null, pending: false }, object: "autostart_state" });
});

test("POST autostart rejects a malformed body before it reaches the store", async () => {
  const routes = mountWithStore(
    fakeStore({ appliedRequestId: 0, desiredEnabled: false, enabled: false, error: null, requestId: 0 })
  );
  const handler = routes.get("POST /v1/owner/autostart");
  const { captured, res } = makeRes();
  await handler?.({ body: { enabled: "yes" } }, res);
  assert.equal(captured.status, 400);
});

test("POST autostart returns a 409 when the watcher never applies the request within the timeout", async () => {
  const store: AutostartStore = {
    load: async () => ({ appliedRequestId: 0, desiredEnabled: false, enabled: false, error: null, requestId: 0 }),
    requestChange: async () => {
      throw new Error("Autostart change was not applied by the desktop app within 5s");
    },
  };
  const routes = mountWithStore(store);
  const handler = routes.get("POST /v1/owner/autostart");
  const { captured, res } = makeRes();
  await handler?.({ body: { enabled: true } }, res);
  assert.equal(captured.status, 409);
  assert.match(String((captured.body as { error: { message: string } }).error.message), /was not applied/);
});
