// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Acceptance coverage for the owner open-external-url route
 * (server/routes/owner-open-external-url.ts).
 *
 * This is the HTTP replacement for the console's dead
 * `@tauri-apps/plugin-shell` `open()` call (`OpenExternalLink`,
 * apps/console/src/app/(console)/components/open-external-link.tsx) --
 * unreachable because the console's http://127.0.0.1:{port} window never
 * gets Tauri's invoke() bridge. These tests use a fake OpenExternalUrlStore
 * rather than the real file-backed one, since open-external-url-store.test.ts
 * already covers that store's file-append contract directly.
 *
 * Scheme validation is the security-critical behavior here -- this route is
 * reachable from the console origin, and the console is reachable over the
 * owner's public tunnel when remote access is on. Only https: URLs may be
 * queued; file:/javascript:/data:/http: must be rejected before they ever
 * reach the store (and therefore before they could ever reach Rust's
 * open::that_detached).
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { OpenExternalUrlRequest, OpenExternalUrlStore } from "../server/open-external-url-store.ts";
import { mountOwnerOpenExternalUrl, validateExternalUrl } from "../server/routes/owner-open-external-url.ts";

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

function fakeStore(): OpenExternalUrlStore & { enqueued: string[] } {
  const store = {
    enqueue: async (url: string): Promise<OpenExternalUrlRequest> => {
      store.enqueued.push(url);
      return { id: store.enqueued.length, url };
    },
    enqueued: [] as string[],
  };
  return store;
}

function mountWithStore(store: OpenExternalUrlStore): FakeApp["routes"] {
  const app = new FakeApp();
  mountOwnerOpenExternalUrl(app as unknown as Parameters<typeof mountOwnerOpenExternalUrl>[0], {
    handleError: (res, err) => {
      (res as { status: (code: number) => { json: (body: unknown) => void } })
        .status(500)
        .json({ error: { message: err instanceof Error ? err.message : String(err) } });
    },
    pdppError: (res, status, code, message, param) => {
      res.status(status).json({ error: { code, message, param } });
    },
    requireOwner: (...args: unknown[]) => (args[2] as () => void)(),
    requireToken: (...args: unknown[]) => (args[2] as () => void)(),
    store,
  });
  return app.routes;
}

test("POST open-external-url enqueues a valid https URL and echoes it back", async () => {
  const store = fakeStore();
  const routes = mountWithStore(store);
  const handler = routes.get("POST /v1/owner/open-external-url");
  const { captured, res } = makeRes();
  await handler?.({ body: { url: "https://example.com/docs" } }, res);
  assert.deepEqual(captured.body, {
    data: { id: 1, url: "https://example.com/docs" },
    object: "open_external_url_request",
  });
  assert.deepEqual(store.enqueued, ["https://example.com/docs"]);
});

test("POST open-external-url rejects an http: URL before it reaches the store", async () => {
  const store = fakeStore();
  const routes = mountWithStore(store);
  const handler = routes.get("POST /v1/owner/open-external-url");
  const { captured, res } = makeRes();
  await handler?.({ body: { url: "http://example.com" } }, res);
  assert.equal(captured.status, 400);
  assert.deepEqual(store.enqueued, []);
});

test("POST open-external-url rejects a file: URL before it reaches the store", async () => {
  const store = fakeStore();
  const routes = mountWithStore(store);
  const handler = routes.get("POST /v1/owner/open-external-url");
  const { captured, res } = makeRes();
  await handler?.({ body: { url: "file:///etc/passwd" } }, res);
  assert.equal(captured.status, 400);
  assert.deepEqual(store.enqueued, []);
});

test("POST open-external-url rejects a javascript: URL before it reaches the store", async () => {
  const store = fakeStore();
  const routes = mountWithStore(store);
  const handler = routes.get("POST /v1/owner/open-external-url");
  const { captured, res } = makeRes();
  await handler?.({ body: { url: "javascript:alert(1)" } }, res);
  assert.equal(captured.status, 400);
  assert.deepEqual(store.enqueued, []);
});

test("POST open-external-url rejects a data: URL before it reaches the store", async () => {
  const store = fakeStore();
  const routes = mountWithStore(store);
  const handler = routes.get("POST /v1/owner/open-external-url");
  const { captured, res } = makeRes();
  await handler?.({ body: { url: "data:text/html,<script>alert(1)</script>" } }, res);
  assert.equal(captured.status, 400);
  assert.deepEqual(store.enqueued, []);
});

test("POST open-external-url rejects a missing url field", async () => {
  const store = fakeStore();
  const routes = mountWithStore(store);
  const handler = routes.get("POST /v1/owner/open-external-url");
  const { captured, res } = makeRes();
  await handler?.({ body: {} }, res);
  assert.equal(captured.status, 400);
  assert.deepEqual(store.enqueued, []);
});

test("POST open-external-url rejects a malformed URL string", async () => {
  const store = fakeStore();
  const routes = mountWithStore(store);
  const handler = routes.get("POST /v1/owner/open-external-url");
  const { captured, res } = makeRes();
  await handler?.({ body: { url: "not a url" } }, res);
  assert.equal(captured.status, 400);
  assert.deepEqual(store.enqueued, []);
});

test("validateExternalUrl accepts https and rejects everything else directly", () => {
  assert.deepEqual(validateExternalUrl("https://example.com"), { ok: true, url: "https://example.com/" });
  assert.equal(validateExternalUrl("http://example.com").ok, false);
  assert.equal(validateExternalUrl("file:///etc/passwd").ok, false);
  assert.equal(validateExternalUrl("javascript:alert(1)").ok, false);
  assert.equal(validateExternalUrl(42).ok, false);
  assert.equal(validateExternalUrl(undefined).ok, false);
});
