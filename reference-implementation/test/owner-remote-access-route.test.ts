// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Acceptance coverage for the owner remote-access routes
 * (server/routes/owner-remote-access.ts).
 *
 * These routes are the HTTP replacement for the four Tauri commands the
 * console used to call directly (get_remote_access_config /
 * set_remote_access_config / configure_remote_access / inspect_remote_access,
 * in src-tauri/src/remote_access.rs) -- unreachable from the console's
 * http://127.0.0.1:{port} window because Tauri never injects invoke() into
 * that origin (local/HOST-BRIDGE-DESIGN-0918.md). The property this file
 * protects: the routes validate and persist through the SAME store the
 * `user_supplied_origin` provider owns, reject the ngrok provider (desktop-only
 * scope fence), and never touch owner-session/token verification themselves --
 * that stays entirely in the injected `requireToken`/`requireOwner` middleware,
 * matching every other `/v1/owner/*` route.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { offRemoteAccessConfig, type RemoteAccessConfig } from "../server/remote-access-config.ts";
import { createRemoteAccessConfigStore } from "../server/remote-access-store.ts";
import { mountOwnerRemoteAccess } from "../server/routes/owner-remote-access.ts";

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

async function withMountedRoutes(
  fn: (routes: FakeApp["routes"]) => Promise<void>
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "owner-remote-access-route-"));
  try {
    const app = new FakeApp();
    mountOwnerRemoteAccess(app as unknown as Parameters<typeof mountOwnerRemoteAccess>[0], {
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
      store: createRemoteAccessConfigStore(dir),
    });
    await fn(app.routes);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("GET config returns the off default before anything is saved", async () => {
  await withMountedRoutes(async (routes) => {
    const handler = routes.get("GET /v1/owner/remote-access/config");
    assert.ok(handler);
    const { captured, res } = makeRes();
    await handler?.({}, res);
    assert.deepEqual(captured.body, { data: offRemoteAccessConfig(), object: "remote_access_config" });
  });
});

test("POST config persists a valid user_supplied_origin config and GET reflects it", async () => {
  await withMountedRoutes(async (routes) => {
    const postHandler = routes.get("POST /v1/owner/remote-access/config");
    const getHandler = routes.get("GET /v1/owner/remote-access/config");
    const config: RemoteAccessConfig = {
      fields: {
        PDPP_BIND_HOST: "127.0.0.1",
        PDPP_REFERENCE_ORIGIN: "https://vault.example.com",
        PDPP_TRUSTED_HOSTS: "vault.example.com",
        PDPP_TRUSTED_PROXIES: "",
      },
      posture: "public_url",
      provider: "user_supplied_origin",
    };

    const post = makeRes();
    await postHandler?.({ body: config }, post.res);
    assert.deepEqual(post.captured.body, { data: config, object: "remote_access_config" });

    const get = makeRes();
    await getHandler?.({}, get.res);
    assert.deepEqual(get.captured.body, { data: config, object: "remote_access_config" });
  });
});

test("POST config rejects a non-HTTPS origin with a 400 and does not persist it", async () => {
  await withMountedRoutes(async (routes) => {
    const postHandler = routes.get("POST /v1/owner/remote-access/config");
    const getHandler = routes.get("GET /v1/owner/remote-access/config");
    const invalid: RemoteAccessConfig = {
      fields: {
        PDPP_BIND_HOST: "127.0.0.1",
        PDPP_REFERENCE_ORIGIN: "http://vault.example.com",
        PDPP_TRUSTED_HOSTS: "vault.example.com",
        PDPP_TRUSTED_PROXIES: "",
      },
      posture: "public_url",
      provider: "user_supplied_origin",
    };

    const post = makeRes();
    await postHandler?.({ body: invalid }, post.res);
    assert.equal(post.captured.status, 400);

    const get = makeRes();
    await getHandler?.({}, get.res);
    assert.deepEqual(get.captured.body, { data: offRemoteAccessConfig(), object: "remote_access_config" });
  });
});

test("POST config rejects the ngrok provider — desktop-only scope fence", async () => {
  await withMountedRoutes(async (routes) => {
    const postHandler = routes.get("POST /v1/owner/remote-access/config");
    const ngrokConfig = {
      fields: offRemoteAccessConfig().fields,
      posture: "public_url",
      provider: "ngrok",
    };

    const post = makeRes();
    await postHandler?.({ body: ngrokConfig }, post.res);
    assert.equal(post.captured.status, 400);
    assert.match(
      String((post.captured.body as { error: { message: string } }).error.message),
      /user_supplied_origin/
    );
  });
});

test("POST config rejects a malformed body before it reaches the store", async () => {
  await withMountedRoutes(async (routes) => {
    const postHandler = routes.get("POST /v1/owner/remote-access/config");
    const post = makeRes();
    await postHandler?.({ body: { not: "a config" } }, post.res);
    assert.equal(post.captured.status, 400);
  });
});

test("GET inspect is a static capability probe, independent of the stored posture", async () => {
  // Matches Rust's inspect_remote_access(): a synthetic always-valid probe,
  // not a reflection of the current config. The console settings page relies
  // on this to keep the posture radios selectable even while remote access
  // is off -- otherwise there would be no way to turn it on.
  await withMountedRoutes(async (routes) => {
    const postHandler = routes.get("POST /v1/owner/remote-access/config");
    const inspectHandler = routes.get("GET /v1/owner/remote-access/inspect");

    const before = makeRes();
    await inspectHandler?.({}, before.res);
    assert.deepEqual(before.captured.body, {
      data: { availability: "available", authentication: "not_required", reason: null },
      object: "remote_access_inspection",
    });

    await postHandler?.(
      {
        body: {
          fields: {
            PDPP_BIND_HOST: "127.0.0.1",
            PDPP_REFERENCE_ORIGIN: "https://vault.example.com",
            PDPP_TRUSTED_HOSTS: "vault.example.com",
            PDPP_TRUSTED_PROXIES: "",
          },
          posture: "public_url",
          provider: "user_supplied_origin",
        },
      },
      makeRes().res
    );

    const after = makeRes();
    await inspectHandler?.({}, after.res);
    assert.deepEqual(after.captured.body, before.captured.body);
  });
});
