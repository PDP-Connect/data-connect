// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Acceptance coverage for the owner remote-access routes
 * (server/routes/owner-remote-access.ts).
 *
 * These routes are the HTTP replacement for the remote-access Tauri commands
 * the console used to call directly (src-tauri/src/remote_access.rs) --
 * unreachable from the console's http://127.0.0.1:{port} window because
 * Tauri never injects invoke() into that origin (Tauri Discussion #2650).
 * The property this file protects: the routes validate and persist through
 * the SAME store both providers own, seal ngrok's authtoken rather than
 * persisting it as plaintext, and never touch owner-session/token
 * verification themselves -- that stays entirely in the injected
 * `requireToken`/`requireOwner` middleware, matching every other
 * `/v1/owner/*` route.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { offRemoteAccessConfig, type RemoteAccessConfig } from "../server/remote-access-config.ts";
import { parseReachabilityContract } from "../server/reachability-contract.ts";
import { createRemoteAccessConfigStore } from "../server/remote-access-store.ts";
import { mountOwnerRemoteAccess } from "../server/routes/owner-remote-access.ts";
import { createCredentialCipherFromEnv } from "../server/stores/credential-encryption.ts";

const TEST_CREDENTIAL_ENCRYPTION_KEY = "test-owner-remote-access-route-credential-encryption-key";

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
  fn: (routes: FakeApp["routes"]) => Promise<void>,
  // No test but the dedicated remote-disconnect-risk ones below sends a
  // Host header, so isRemoteOriginRequest is false regardless of what this
  // contract declares unless a test opts into a real referenceOrigin --
  // an empty contract is the simplest honest default for everyone else.
  contract = parseReachabilityContract({ env: {} })
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "owner-remote-access-route-"));
  const previousKey = process.env.PDPP_CREDENTIAL_ENCRYPTION_KEY;
  process.env.PDPP_CREDENTIAL_ENCRYPTION_KEY = TEST_CREDENTIAL_ENCRYPTION_KEY;
  try {
    const app = new FakeApp();
    mountOwnerRemoteAccess(app as unknown as Parameters<typeof mountOwnerRemoteAccess>[0], {
      contract,
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
    if (previousKey === undefined) {
      delete process.env.PDPP_CREDENTIAL_ENCRYPTION_KEY;
    } else {
      process.env.PDPP_CREDENTIAL_ENCRYPTION_KEY = previousKey;
    }
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
      console_port: 4310,
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

test("POST config seals a submitted ngrok authtoken and never echoes it back", async () => {
  await withMountedRoutes(async (routes) => {
    const postHandler = routes.get("POST /v1/owner/remote-access/config");
    const getHandler = routes.get("GET /v1/owner/remote-access/config");
    const ngrokConfig = {
      fields: offRemoteAccessConfig().fields,
      ngrok: { endpoint_mode: "https_edge_termination", reserved_domain: null },
      posture: "public_url",
      provider: "ngrok",
    };

    const post = makeRes();
    await postHandler?.(
      { body: { ...ngrokConfig, providerCredential: "shhh-ngrok-authtoken" } },
      post.res
    );
    assert.equal(post.captured.status, 200);
    const postedBody = post.captured.body as { data: RemoteAccessConfig };
    assert.equal(postedBody.data.provider, "ngrok");
    // The response never carries the sealed or plaintext token.
    assert.equal((postedBody.data as { ngrok_authtoken_sealed?: unknown }).ngrok_authtoken_sealed, undefined);
    assert.doesNotMatch(JSON.stringify(post.captured.body), /shhh-ngrok-authtoken/);

    const get = makeRes();
    await getHandler?.({}, get.res);
    const storedBody = get.captured.body as { data: RemoteAccessConfig & { ngrok_authtoken_sealed?: string } };
    assert.equal(storedBody.data.provider, "ngrok");
    // Persisted on disk, but sealed -- not the plaintext token.
    assert.ok(storedBody.data.ngrok_authtoken_sealed);
    assert.doesNotMatch(storedBody.data.ngrok_authtoken_sealed ?? "", /shhh-ngrok-authtoken/);

    const cipher = createCredentialCipherFromEnv();
    assert.equal(cipher.open(storedBody.data.ngrok_authtoken_sealed ?? ""), "shhh-ngrok-authtoken");
  });
});

test("GET config surfaces a tunnel_error the Tauri supervisor persisted", async () => {
  // `apply_ngrok_tunnel_outcome` (src-tauri/src/unified.rs) writes a failed
  // tunnel start straight to remote-access.json, not through this route --
  // GET must still read it back so the console can render the failure.
  await withMountedRoutes(async (routes) => {
    const postHandler = routes.get("POST /v1/owner/remote-access/config");
    const getHandler = routes.get("GET /v1/owner/remote-access/config");
    const failed = {
      fields: offRemoteAccessConfig().fields,
      ngrok: { endpoint_mode: "tls_passthrough", reserved_domain: null },
      posture: "public_url",
      provider: "ngrok",
      tunnel_error: "ngrok TLS endpoint failed: ERR_NGROK_312",
    };

    await postHandler?.(
      { body: { ...failed, providerCredential: "shhh-ngrok-authtoken" } },
      makeRes().res
    );

    const get = makeRes();
    await getHandler?.({}, get.res);
    const body = get.captured.body as { data: RemoteAccessConfig };
    assert.equal(body.data.tunnel_error, "ngrok TLS endpoint failed: ERR_NGROK_312");
  });
});

test("POST config rejects a zero pinned port and does not persist it", async () => {
  await withMountedRoutes(async (routes) => {
    const postHandler = routes.get("POST /v1/owner/remote-access/config");
    const getHandler = routes.get("GET /v1/owner/remote-access/config");
    const invalid: RemoteAccessConfig = {
      fields: {
        PDPP_BIND_HOST: "127.0.0.1",
        PDPP_REFERENCE_ORIGIN: "https://vault.example.com",
        PDPP_TRUSTED_HOSTS: "vault.example.com",
        PDPP_TRUSTED_PROXIES: "",
      },
      posture: "public_url",
      provider: "user_supplied_origin",
      console_port: 0,
    };

    const post = makeRes();
    await postHandler?.({ body: invalid }, post.res);
    assert.equal(post.captured.status, 400);

    const get = makeRes();
    await getHandler?.({}, get.res);
    assert.deepEqual(get.captured.body, { data: offRemoteAccessConfig(), object: "remote_access_config" });
  });
});

test("POST config rejects an ngrok submission with no providerCredential", async () => {
  await withMountedRoutes(async (routes) => {
    const postHandler = routes.get("POST /v1/owner/remote-access/config");
    const ngrokConfig = {
      fields: offRemoteAccessConfig().fields,
      ngrok: { endpoint_mode: "https_edge_termination", reserved_domain: null },
      posture: "public_url",
      provider: "ngrok",
    };

    const post = makeRes();
    await postHandler?.({ body: ngrokConfig }, post.res);
    assert.equal(post.captured.status, 400);
    assert.match(
      String((post.captured.body as { error: { message: string } }).error.message),
      /providerCredential/
    );
  });
});

test("POST config rejects ngrok with a non-empty PDPP_REFERENCE_ORIGIN before a tunnel exists", async () => {
  await withMountedRoutes(async (routes) => {
    const postHandler = routes.get("POST /v1/owner/remote-access/config");
    const ngrokConfig = {
      fields: {
        PDPP_BIND_HOST: "127.0.0.1",
        PDPP_REFERENCE_ORIGIN: "https://not-yet-assigned.ngrok.app",
        PDPP_TRUSTED_HOSTS: "not-yet-assigned.ngrok.app",
        PDPP_TRUSTED_PROXIES: "",
      },
      ngrok: { endpoint_mode: "https_edge_termination", reserved_domain: null },
      posture: "public_url",
      provider: "ngrok",
      providerCredential: "shhh-ngrok-authtoken",
    };

    const post = makeRes();
    await postHandler?.({ body: ngrokConfig }, post.res);
    assert.equal(post.captured.status, 400);
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

test("POST config seals a submitted Cloudflare tunnel token and never echoes it back", async () => {
  await withMountedRoutes(async (routes) => {
    const postHandler = routes.get("POST /v1/owner/remote-access/config");
    const getHandler = routes.get("GET /v1/owner/remote-access/config");
    const cloudflareConfig = {
      cloudflare_tunnel: { hostname: "vault.example.com" },
      fields: {
        PDPP_BIND_HOST: "127.0.0.1",
        PDPP_REFERENCE_ORIGIN: "https://vault.example.com",
        PDPP_TRUSTED_HOSTS: "vault.example.com",
        PDPP_TRUSTED_PROXIES: "",
      },
      posture: "public_url",
      provider: "cloudflare_tunnel",
    };

    const post = makeRes();
    await postHandler?.(
      { body: { ...cloudflareConfig, providerCredential: "shhh-cloudflare-tunnel-token" } },
      post.res
    );
    assert.equal(post.captured.status, 200);
    const postedBody = post.captured.body as { data: RemoteAccessConfig };
    assert.equal(postedBody.data.provider, "cloudflare_tunnel");
    // The response never carries the sealed or plaintext token.
    assert.equal(
      (postedBody.data as { cloudflare_tunnel_token_sealed?: unknown }).cloudflare_tunnel_token_sealed,
      undefined
    );
    assert.doesNotMatch(JSON.stringify(post.captured.body), /shhh-cloudflare-tunnel-token/);

    const get = makeRes();
    await getHandler?.({}, get.res);
    const storedBody = get.captured.body as {
      data: RemoteAccessConfig & { cloudflare_tunnel_token_sealed?: string };
    };
    assert.equal(storedBody.data.provider, "cloudflare_tunnel");
    // Persisted on disk, but sealed -- not the plaintext token.
    assert.ok(storedBody.data.cloudflare_tunnel_token_sealed);
    assert.doesNotMatch(
      storedBody.data.cloudflare_tunnel_token_sealed ?? "",
      /shhh-cloudflare-tunnel-token/
    );

    const cipher = createCredentialCipherFromEnv();
    assert.equal(
      cipher.open(storedBody.data.cloudflare_tunnel_token_sealed ?? ""),
      "shhh-cloudflare-tunnel-token"
    );
  });
});

test("POST config rejects a cloudflare_tunnel submission with no providerCredential", async () => {
  await withMountedRoutes(async (routes) => {
    const postHandler = routes.get("POST /v1/owner/remote-access/config");
    const cloudflareConfig = {
      cloudflare_tunnel: { hostname: "vault.example.com" },
      fields: {
        PDPP_BIND_HOST: "127.0.0.1",
        PDPP_REFERENCE_ORIGIN: "https://vault.example.com",
        PDPP_TRUSTED_HOSTS: "vault.example.com",
        PDPP_TRUSTED_PROXIES: "",
      },
      posture: "public_url",
      provider: "cloudflare_tunnel",
    };

    const post = makeRes();
    await postHandler?.({ body: cloudflareConfig }, post.res);
    assert.equal(post.captured.status, 400);
    assert.match(
      String((post.captured.body as { error: { message: string } }).error.message),
      /providerCredential/
    );
  });
});

test("POST config rejects cloudflare_tunnel with no hostname configured", async () => {
  await withMountedRoutes(async (routes) => {
    const postHandler = routes.get("POST /v1/owner/remote-access/config");
    const cloudflareConfig = {
      fields: offRemoteAccessConfig().fields,
      posture: "public_url",
      provider: "cloudflare_tunnel",
      providerCredential: "shhh-cloudflare-tunnel-token",
    };

    const post = makeRes();
    await postHandler?.({ body: cloudflareConfig }, post.res);
    assert.equal(post.captured.status, 400);
  });
});

test("POST config derives PDPP_REFERENCE_ORIGIN and PDPP_TRUSTED_HOSTS from the hostname when the console submits neither -- the actual console payload", async () => {
  await withMountedRoutes(async (routes) => {
    const postHandler = routes.get("POST /v1/owner/remote-access/config");
    const getHandler = routes.get("GET /v1/owner/remote-access/config");
    // Matches apps/console's remote-access-setting.tsx exactly: the console
    // never fills PDPP_REFERENCE_ORIGIN/PDPP_TRUSTED_HOSTS for this
    // provider, since it has no way to compute them itself. Regression for
    // the live 400: "Public URL requires PDPP_REFERENCE_ORIGIN."
    const cloudflareConfig = {
      cloudflare_tunnel: { hostname: "vault.example.com" },
      fields: offRemoteAccessConfig().fields,
      posture: "public_url",
      provider: "cloudflare_tunnel",
      providerCredential: "shhh-cloudflare-tunnel-token",
    };

    const post = makeRes();
    await postHandler?.({ body: cloudflareConfig }, post.res);
    assert.equal(post.captured.status, 200);
    const postedBody = post.captured.body as { data: RemoteAccessConfig };
    assert.equal(postedBody.data.fields.PDPP_REFERENCE_ORIGIN, "https://vault.example.com");
    assert.equal(postedBody.data.fields.PDPP_TRUSTED_HOSTS, "vault.example.com");

    const get = makeRes();
    await getHandler?.({}, get.res);
    const storedBody = get.captured.body as { data: RemoteAccessConfig };
    assert.equal(storedBody.data.fields.PDPP_REFERENCE_ORIGIN, "https://vault.example.com");
    assert.equal(storedBody.data.fields.PDPP_TRUSTED_HOSTS, "vault.example.com");
  });
});

test("POST config rejects a cloudflare_tunnel submission whose explicit PDPP_REFERENCE_ORIGIN disagrees with the hostname", async () => {
  await withMountedRoutes(async (routes) => {
    const postHandler = routes.get("POST /v1/owner/remote-access/config");
    const cloudflareConfig = {
      cloudflare_tunnel: { hostname: "vault.example.com" },
      fields: {
        PDPP_BIND_HOST: "127.0.0.1",
        PDPP_REFERENCE_ORIGIN: "https://wrong.example.com",
        PDPP_TRUSTED_HOSTS: "wrong.example.com",
        PDPP_TRUSTED_PROXIES: "",
      },
      posture: "public_url",
      provider: "cloudflare_tunnel",
      providerCredential: "shhh-cloudflare-tunnel-token",
    };

    const post = makeRes();
    await postHandler?.({ body: cloudflareConfig }, post.res);
    assert.equal(post.captured.status, 400);
    assert.match(
      String((post.captured.body as { error: { message: string } }).error.message),
      /must match the configured Cloudflare tunnel hostname/
    );
  });
});

test("POST config accepts a cloudflare_tunnel submission even when the binary is confirmed missing, since it downloads automatically at spawn time", async () => {
  const previousHost = process.env.PDPP_MANAGED_DESKTOP_HOST;
  const previousBinary = process.env.PDPP_CLOUDFLARED_BINARY_PRESENT;
  try {
    // Download-on-first-use (`ensure_cloudflared_available`,
    // src-tauri/src/remote_access_cloudflare.rs) makes a missing binary a
    // non-blocking case: `start()` downloads and checksum-verifies a real
    // copy automatically the first time this provider actually runs, so
    // this route must not reject a submission just because
    // cloudflared_binary_present reads false at submit time -- that reading
    // only reflects whether a SYSTEM install exists on PATH right now, not
    // whether this provider can start. Rejecting here would tell the owner
    // to do something ("install it, then try again") the app is about to
    // do for them, and block the exact submission download-on-first-use
    // exists to make normal.
    process.env.PDPP_MANAGED_DESKTOP_HOST = "1";
    process.env.PDPP_CLOUDFLARED_BINARY_PRESENT = "0";
    await withMountedRoutes(async (routes) => {
      const postHandler = routes.get("POST /v1/owner/remote-access/config");
      const getHandler = routes.get("GET /v1/owner/remote-access/config");
      const cloudflareConfig = {
        cloudflare_tunnel: { hostname: "vault.example.com" },
        fields: {
          PDPP_BIND_HOST: "127.0.0.1",
          PDPP_REFERENCE_ORIGIN: "https://vault.example.com",
          PDPP_TRUSTED_HOSTS: "vault.example.com",
          PDPP_TRUSTED_PROXIES: "",
        },
        posture: "public_url",
        provider: "cloudflare_tunnel",
        providerCredential: "shhh-cloudflare-tunnel-token",
      };

      const post = makeRes();
      await postHandler?.({ body: cloudflareConfig }, post.res);
      assert.equal(post.captured.status, 200);

      const get = makeRes();
      await getHandler?.({}, get.res);
      const savedConfig = (get.captured.body as { data: { provider?: string } }).data;
      assert.equal(savedConfig.provider, "cloudflare_tunnel");
    });
  } finally {
    if (previousHost === undefined) {
      delete process.env.PDPP_MANAGED_DESKTOP_HOST;
    } else {
      process.env.PDPP_MANAGED_DESKTOP_HOST = previousHost;
    }
    if (previousBinary === undefined) {
      delete process.env.PDPP_CLOUDFLARED_BINARY_PRESENT;
    } else {
      process.env.PDPP_CLOUDFLARED_BINARY_PRESENT = previousBinary;
    }
  }
});

test("POST config accepts a cloudflare_tunnel submission when binary presence is unknown, not a false claim of missing", async () => {
  const previous = process.env.PDPP_CLOUDFLARED_BINARY_PRESENT;
  try {
    // Unset entirely -- inspectCloudflareTunnel reads this as null
    // ("unknown"), the same value an old build or a non-desktop deployment
    // would report. null must never be treated as "missing": that would
    // block a submission the owner has no way to explain or work around.
    delete process.env.PDPP_CLOUDFLARED_BINARY_PRESENT;
    await withMountedRoutes(async (routes) => {
      const postHandler = routes.get("POST /v1/owner/remote-access/config");
      const cloudflareConfig = {
        cloudflare_tunnel: { hostname: "vault.example.com" },
        fields: {
          PDPP_BIND_HOST: "127.0.0.1",
          PDPP_REFERENCE_ORIGIN: "https://vault.example.com",
          PDPP_TRUSTED_HOSTS: "vault.example.com",
          PDPP_TRUSTED_PROXIES: "",
        },
        posture: "public_url",
        provider: "cloudflare_tunnel",
        providerCredential: "shhh-cloudflare-tunnel-token",
      };

      const post = makeRes();
      await postHandler?.({ body: cloudflareConfig }, post.res);
      assert.equal(post.captured.status, 200);
    });
  } finally {
    if (previous === undefined) {
      delete process.env.PDPP_CLOUDFLARED_BINARY_PRESENT;
    } else {
      process.env.PDPP_CLOUDFLARED_BINARY_PRESENT = previous;
    }
  }
});

test("GET inspect/cloudflare_tunnel reports unavailable without a managed desktop host, and available with one", async () => {
  const previousHost = process.env.PDPP_MANAGED_DESKTOP_HOST;
  const previousBinary = process.env.PDPP_CLOUDFLARED_BINARY_PRESENT;
  try {
    delete process.env.PDPP_MANAGED_DESKTOP_HOST;
    delete process.env.PDPP_CLOUDFLARED_BINARY_PRESENT;
    await withMountedRoutes(async (routes) => {
      const handler = routes.get("GET /v1/owner/remote-access/inspect/cloudflare_tunnel");
      const { captured, res } = makeRes();
      await handler?.({}, res);
      const body = captured.body as {
        data: {
          availability: string;
          reason: string | null;
          cloudflared_binary_present: boolean | null;
        };
      };
      assert.equal(body.data.availability, "unavailable");
      assert.match(body.data.reason ?? "", /desktop app/i);
      // No desktop host means the binary check never ran either -- "unknown",
      // not a false claim that it is missing.
      assert.equal(body.data.cloudflared_binary_present, null);
    });

    process.env.PDPP_MANAGED_DESKTOP_HOST = "1";
    delete process.env.PDPP_CLOUDFLARED_BINARY_PRESENT;
    await withMountedRoutes(async (routes) => {
      const handler = routes.get("GET /v1/owner/remote-access/inspect/cloudflare_tunnel");
      const { captured, res } = makeRes();
      await handler?.({}, res);
      assert.deepEqual(captured.body, {
        data: {
          availability: "available",
          authentication: "not_required",
          cloudflared_binary_present: null,
          reason: null,
        },
        object: "remote_access_inspection",
      });
    });
  } finally {
    if (previousHost === undefined) {
      delete process.env.PDPP_MANAGED_DESKTOP_HOST;
    } else {
      process.env.PDPP_MANAGED_DESKTOP_HOST = previousHost;
    }
    if (previousBinary === undefined) {
      delete process.env.PDPP_CLOUDFLARED_BINARY_PRESENT;
    } else {
      process.env.PDPP_CLOUDFLARED_BINARY_PRESENT = previousBinary;
    }
  }
});

test("GET inspect/ngrok reports unavailable without a managed desktop host, and available with one", async () => {
  const previousHost = process.env.PDPP_MANAGED_DESKTOP_HOST;
  try {
    delete process.env.PDPP_MANAGED_DESKTOP_HOST;
    await withMountedRoutes(async (routes) => {
      const handler = routes.get("GET /v1/owner/remote-access/inspect/ngrok");
      const { captured, res } = makeRes();
      await handler?.({}, res);
      const body = captured.body as { data: { availability: string; reason: string | null } };
      assert.equal(body.data.availability, "unavailable");
      assert.match(body.data.reason ?? "", /desktop app/i);
    });

    process.env.PDPP_MANAGED_DESKTOP_HOST = "1";
    await withMountedRoutes(async (routes) => {
      const handler = routes.get("GET /v1/owner/remote-access/inspect/ngrok");
      const { captured, res } = makeRes();
      await handler?.({}, res);
      assert.deepEqual(captured.body, {
        data: { availability: "available", authentication: "not_required", reason: null },
        object: "remote_access_inspection",
      });
    });
  } finally {
    if (previousHost === undefined) {
      delete process.env.PDPP_MANAGED_DESKTOP_HOST;
    } else {
      process.env.PDPP_MANAGED_DESKTOP_HOST = previousHost;
    }
  }
});

// A remote-originated reconfiguration that could strand the owner: Tim's
// exact scenario, where the settings page is itself reachable only because
// remote access is already on. `remoteContract` below is the one place in
// this file that declares a real `referenceOrigin`, matched against the
// `host` header these tests send, so `isRemoteOriginRequest` genuinely
// evaluates true rather than being vacuously false the way every other test
// in this file leaves it.
const remoteContract = parseReachabilityContract({
  env: { PDPP_REFERENCE_ORIGIN: "https://vault.example.com" },
});

test("POST config refuses a remote-originated provider switch that could disconnect the owner, unless acknowledged", async () => {
  await withMountedRoutes(async (routes) => {
    const postHandler = routes.get("POST /v1/owner/remote-access/config");
    const cloudflareConfig = {
      cloudflare_tunnel: { hostname: "vault.example.com" },
      fields: {
        PDPP_BIND_HOST: "127.0.0.1",
        PDPP_REFERENCE_ORIGIN: "https://vault.example.com",
        PDPP_TRUSTED_HOSTS: "vault.example.com",
        PDPP_TRUSTED_PROXIES: "",
      },
      posture: "public_url",
      provider: "cloudflare_tunnel",
      providerCredential: "shhh-cloudflare-tunnel-token",
    };
    // Establish the "current" tunnel-serving config first -- a loopback
    // request, matching how the owner originally set this up.
    const initialPost = makeRes();
    await postHandler?.({ body: cloudflareConfig }, initialPost.res);
    assert.equal(initialPost.captured.status, 200);

    // Now the owner (reached THROUGH that tunnel) tries to switch provider.
    const ngrokConfig = {
      fields: offRemoteAccessConfig().fields,
      ngrok: { endpoint_mode: "https_edge_termination", reserved_domain: null },
      posture: "public_url",
      provider: "ngrok",
      providerCredential: "shhh-ngrok-authtoken",
    };
    const remoteReq = { body: ngrokConfig, headers: { host: "vault.example.com" }, get: (name: string) => (name.toLowerCase() === "host" ? "vault.example.com" : undefined) };
    const switchPost = makeRes();
    await postHandler?.(remoteReq, switchPost.res);
    assert.equal(switchPost.captured.status, 409);
    assert.match(
      String((switchPost.captured.body as { error: { message: string } }).error.message),
      /disconnect/i
    );

    // The risky change must not have been persisted.
    const getHandler = routes.get("GET /v1/owner/remote-access/config");
    const get = makeRes();
    await getHandler?.({}, get.res);
    const stored = (get.captured.body as { data: RemoteAccessConfig }).data;
    assert.equal(stored.provider, "cloudflare_tunnel");
  }, remoteContract);
});

test("POST config allows the same remote-originated change once acknowledged", async () => {
  await withMountedRoutes(async (routes) => {
    const postHandler = routes.get("POST /v1/owner/remote-access/config");
    const cloudflareConfig = {
      cloudflare_tunnel: { hostname: "vault.example.com" },
      fields: {
        PDPP_BIND_HOST: "127.0.0.1",
        PDPP_REFERENCE_ORIGIN: "https://vault.example.com",
        PDPP_TRUSTED_HOSTS: "vault.example.com",
        PDPP_TRUSTED_PROXIES: "",
      },
      posture: "public_url",
      provider: "cloudflare_tunnel",
      providerCredential: "shhh-cloudflare-tunnel-token",
    };
    const initialPost = makeRes();
    await postHandler?.({ body: cloudflareConfig }, initialPost.res);
    assert.equal(initialPost.captured.status, 200);

    const ngrokConfig = {
      fields: offRemoteAccessConfig().fields,
      ngrok: { endpoint_mode: "https_edge_termination", reserved_domain: null },
      posture: "public_url",
      provider: "ngrok",
      providerCredential: "shhh-ngrok-authtoken",
      acknowledgeRemoteDisconnectRisk: true,
    };
    const remoteReq = { body: ngrokConfig, headers: { host: "vault.example.com" }, get: (name: string) => (name.toLowerCase() === "host" ? "vault.example.com" : undefined) };
    const switchPost = makeRes();
    await postHandler?.(remoteReq, switchPost.res);
    assert.equal(switchPost.captured.status, 200);

    const getHandler = routes.get("GET /v1/owner/remote-access/config");
    const get = makeRes();
    await getHandler?.({}, get.res);
    const stored = (get.captured.body as { data: RemoteAccessConfig }).data;
    assert.equal(stored.provider, "ngrok");
  }, remoteContract);
});

test("POST config never refuses a LOOPBACK-originated change, even one that switches provider", async () => {
  // The desktop app's own console window, or the owner physically at the
  // machine -- never at risk of losing the connection it is using to make
  // the change, so this must never block.
  await withMountedRoutes(async (routes) => {
    const postHandler = routes.get("POST /v1/owner/remote-access/config");
    const cloudflareConfig = {
      cloudflare_tunnel: { hostname: "vault.example.com" },
      fields: {
        PDPP_BIND_HOST: "127.0.0.1",
        PDPP_REFERENCE_ORIGIN: "https://vault.example.com",
        PDPP_TRUSTED_HOSTS: "vault.example.com",
        PDPP_TRUSTED_PROXIES: "",
      },
      posture: "public_url",
      provider: "cloudflare_tunnel",
      providerCredential: "shhh-cloudflare-tunnel-token",
    };
    const initialPost = makeRes();
    await postHandler?.({ body: cloudflareConfig }, initialPost.res);
    assert.equal(initialPost.captured.status, 200);

    const ngrokConfig = {
      fields: offRemoteAccessConfig().fields,
      ngrok: { endpoint_mode: "https_edge_termination", reserved_domain: null },
      posture: "public_url",
      provider: "ngrok",
      providerCredential: "shhh-ngrok-authtoken",
    };
    // No Host header at all -- exactly like every other test in this file.
    const switchPost = makeRes();
    await postHandler?.({ body: ngrokConfig }, switchPost.res);
    assert.equal(switchPost.captured.status, 200);
  }, remoteContract);
});

test("GET inspect/my_devices_only reports availability tied to a real detected LAN interface", async () => {
  // Whether this test machine actually has a non-loopback interface is
  // environment-dependent (a CI sandbox may have none) -- this asserts the
  // route's contract shape, not a specific IP: available implies a real,
  // private (never loopback, never public) address in `reason`; unavailable
  // implies a reason string and no address.
  await withMountedRoutes(async (routes) => {
    const handler = routes.get("GET /v1/owner/remote-access/inspect/my_devices_only");
    const { captured, res } = makeRes();
    await handler?.({}, res);
    const body = captured.body as {
      data: { availability: string; authentication: string; reason: string | null };
    };
    assert.equal(body.data.authentication, "not_required");
    if (body.data.availability === "available") {
      assert.ok(body.data.reason);
      assert.doesNotMatch(body.data.reason ?? "", /^127\.|^0\.0\.0\.0$/);
    } else {
      assert.equal(body.data.availability, "unavailable");
      assert.match(body.data.reason ?? "", /no lan/i);
    }
  });
});

test("POST config with posture my_devices_only ignores any client-submitted lan_host and persists the server-detected one", async () => {
  await withMountedRoutes(async (routes) => {
    const inspectHandler = routes.get("GET /v1/owner/remote-access/inspect/my_devices_only");
    const { captured: inspected, res: inspectRes } = makeRes();
    await inspectHandler?.({}, inspectRes);
    const inspection = inspected.body as { data: { availability: string } };
    if (inspection.data.availability === "unavailable") {
      // No LAN interface on this machine/sandbox -- the POST branch must
      // fail closed the same way, not silently accept the posture.
      const postHandler = routes.get("POST /v1/owner/remote-access/config");
      const { captured, res } = makeRes();
      await postHandler?.(
        { body: { fields: offRemoteAccessConfig().fields, posture: "my_devices_only", provider: null } },
        res
      );
      assert.equal(captured.status, 400);
      return;
    }

    const postHandler = routes.get("POST /v1/owner/remote-access/config");
    const { captured, res } = makeRes();
    await postHandler?.(
      {
        body: {
          fields: offRemoteAccessConfig().fields,
          my_devices_only: { lan_host: "203.0.113.7" }, // attacker-supplied, must be ignored
          posture: "my_devices_only",
          provider: null,
        },
      },
      res
    );
    const body = captured.body as { data: RemoteAccessConfig };
    assert.equal(body.data.posture, "my_devices_only");
    assert.notEqual(body.data.my_devices_only?.lan_host, "203.0.113.7");
    assert.equal(body.data.fields.PDPP_BIND_HOST, body.data.my_devices_only?.lan_host);
  });
});
