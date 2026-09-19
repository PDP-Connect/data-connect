// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Acceptance coverage for the owner app-config routes
 * (server/routes/owner-app-config.ts).
 *
 * These routes are the HTTP replacement for the two Tauri commands the
 * console used to call directly (get_app_config / set_app_config, in
 * src-tauri/src/commands/file_ops.rs) -- unreachable from the console's
 * http://127.0.0.1:{port} window because Tauri never injects invoke() into
 * that origin. The property this file protects: the routes read/write
 * through the SAME store the file-based AppConfig owns, reject a
 * malformed body before it reaches the store, and never touch owner-
 * session/token verification themselves -- that stays entirely in the
 * injected requireToken/requireOwner middleware, matching every other
 * /v1/owner/* route (see owner-remote-access-route.test.ts for the
 * precedent this mirrors).
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createAppConfigStore } from "../server/app-config-store.ts";
import { mountOwnerAppConfig } from "../server/routes/owner-app-config.ts";

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

async function withMountedRoutes(fn: (routes: FakeApp["routes"], homeDir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "owner-app-config-route-home-"));
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  try {
    const app = new FakeApp();
    mountOwnerAppConfig(app as unknown as Parameters<typeof mountOwnerAppConfig>[0], {
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
      store: createAppConfigStore(),
    });
    await fn(app.routes, dir);
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = originalUserProfile;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

const DEFAULT_CONFIG = {
  closeToTray: true,
  selfHostedUrl: null,
  serverMode: "cloud",
  startMinimized: false,
  storageProvider: "local",
};

test("GET app-config returns the default before anything is saved", async () => {
  await withMountedRoutes(async routes => {
    const handler = routes.get("GET /v1/owner/app-config");
    assert.ok(handler);
    const { captured, res } = makeRes();
    await handler?.({}, res);
    assert.deepEqual(captured.body, { data: DEFAULT_CONFIG, object: "app_config" });
  });
});

test("POST app-config persists a full config and GET reflects it", async () => {
  await withMountedRoutes(async routes => {
    const postHandler = routes.get("POST /v1/owner/app-config");
    const getHandler = routes.get("GET /v1/owner/app-config");
    const config = {
      closeToTray: false,
      selfHostedUrl: null,
      serverMode: "cloud",
      startMinimized: true,
      storageProvider: "local",
    };

    const post = makeRes();
    await postHandler?.({ body: config }, post.res);
    assert.deepEqual(post.captured.body, { data: config, object: "app_config" });

    const get = makeRes();
    await getHandler?.({}, get.res);
    assert.deepEqual(get.captured.body, { data: config, object: "app_config" });
  });
});

test("POST app-config rejects a malformed body before it reaches the store", async () => {
  await withMountedRoutes(async routes => {
    const postHandler = routes.get("POST /v1/owner/app-config");
    const getHandler = routes.get("GET /v1/owner/app-config");

    const post = makeRes();
    await postHandler?.({ body: { not: "a config" } }, post.res);
    assert.equal(post.captured.status, 400);

    const get = makeRes();
    await getHandler?.({}, get.res);
    assert.deepEqual(get.captured.body, { data: DEFAULT_CONFIG, object: "app_config" });
  });
});
