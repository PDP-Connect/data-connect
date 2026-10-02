// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildProxyHeaders, proxyReferenceRequest } from "./reference-proxy.ts";

const UNREACHABLE_AS = "http://127.0.0.1:1";
const STARTUP_RETRY_COPY = /This page will retry automatically/;
const ACTIVE_TUNNEL_PROVIDER_ENV = "PDPP_ACTIVE_TUNNEL_PROVIDER";
const PRIVATE_TUNNEL_CLIENT_IP_HEADER = "x-pdpp-owner-login-tunnel-client-ip";

function withActiveTunnelProvider(t: { after: (fn: () => void) => void }, provider: string | null): void {
  const previous = process.env[ACTIVE_TUNNEL_PROVIDER_ENV];
  if (provider === null) {
    delete process.env[ACTIVE_TUNNEL_PROVIDER_ENV];
  } else {
    process.env[ACTIVE_TUNNEL_PROVIDER_ENV] = provider;
  }
  t.after(() => {
    if (previous === undefined) {
      delete process.env[ACTIVE_TUNNEL_PROVIDER_ENV];
    } else {
      process.env[ACTIVE_TUNNEL_PROVIDER_ENV] = previous;
    }
  });
}

test("the console distinguishes reference startup from a failed service", async (t) => {
  const readyFile = path.join(mkdtempSync(path.join(tmpdir(), "pdpp-reference-proxy-")), "ready");
  const previousAsUrl = process.env.PDPP_AS_URL;
  const previousReadyFile = process.env.PDPP_REFERENCE_READY_FILE;
  process.env.PDPP_AS_URL = UNREACHABLE_AS;
  process.env.PDPP_REFERENCE_READY_FILE = readyFile;
  t.after(() => {
    if (previousAsUrl === undefined) {
      delete process.env.PDPP_AS_URL;
    } else {
      process.env.PDPP_AS_URL = previousAsUrl;
    }
    if (previousReadyFile === undefined) {
      delete process.env.PDPP_REFERENCE_READY_FILE;
    } else {
      process.env.PDPP_REFERENCE_READY_FILE = previousReadyFile;
    }
    try {
      unlinkSync(readyFile);
    } catch {
      // The marker is absent on the first half of the test.
    }
  });

  const browserRequest = new Request("http://console.test/owner/login", {
    headers: { accept: "text/html" },
  });
  const starting = await proxyReferenceRequest(browserRequest, "as", ["owner"]);
  assert.equal(starting.status, 503);
  assert.equal(starting.headers.get("retry-after"), "2");
  assert.match(await starting.text(), STARTUP_RETRY_COPY);

  writeFileSync(readyFile, "ready\n");
  const failed = await proxyReferenceRequest(browserRequest, "as", ["owner"]);
  assert.equal(failed.status, 502);
  const body = (await failed.json()) as { error?: { code?: unknown; detail?: unknown; message?: unknown } };
  assert.equal(body.error?.code, "reference_unreachable");
  assert.equal(typeof body.error?.detail, "string");
  assert.equal(body.error?.message, "Cannot reach PDPP AS service.");
});

test("owner login proxy stamps Cloudflare CF-Connecting-IP for the private limiter marker", (t) => {
  withActiveTunnelProvider(t, "cloudflare_tunnel");
  const headers = buildProxyHeaders(
    new Request("https://vault.example.com/owner/login", {
      headers: {
        "cf-connecting-ip": "198.51.100.10",
        host: "vault.example.com",
        "x-forwarded-for": "203.0.113.200",
      },
      method: "POST",
    }),
    new URL("https://vault.example.com/owner/login"),
    ["owner", "login"]
  );
  assert.equal(headers.get(PRIVATE_TUNNEL_CLIENT_IP_HEADER), "198.51.100.10");
});

test("owner login proxy strips caller-supplied private marker without Cloudflare CF-Connecting-IP", (t) => {
  withActiveTunnelProvider(t, "cloudflare_tunnel");
  const headers = buildProxyHeaders(
    new Request("https://vault.example.com/owner/login", {
      headers: {
        host: "vault.example.com",
        [PRIVATE_TUNNEL_CLIENT_IP_HEADER]: "198.51.100.10",
        "x-forwarded-for": "198.51.100.11",
      },
      method: "POST",
    }),
    new URL("https://vault.example.com/owner/login"),
    ["owner", "login"]
  );
  assert.equal(headers.get(PRIVATE_TUNNEL_CLIENT_IP_HEADER), null);
});

test("owner login proxy uses ngrok's last X-Forwarded-For entry for the private limiter marker", (t) => {
  withActiveTunnelProvider(t, "ngrok");
  const headers = buildProxyHeaders(
    new Request("https://vault.ngrok-free.app/owner/login", {
      headers: {
        host: "vault.ngrok-free.app",
        "x-forwarded-for": "198.51.100.10, 203.0.113.200",
      },
      method: "POST",
    }),
    new URL("https://vault.ngrok-free.app/owner/login"),
    ["owner", "login"]
  );
  assert.equal(headers.get(PRIVATE_TUNNEL_CLIENT_IP_HEADER), "203.0.113.200");
});

test("owner login proxy ignores invalid ngrok X-Forwarded-For values", (t) => {
  withActiveTunnelProvider(t, "ngrok");
  const headers = buildProxyHeaders(
    new Request("https://vault.ngrok-free.app/owner/login", {
      headers: {
        host: "vault.ngrok-free.app",
        "x-forwarded-for": "198.51.100.10, not-an-ip",
      },
      method: "POST",
    }),
    new URL("https://vault.ngrok-free.app/owner/login"),
    ["owner", "login"]
  );
  assert.equal(headers.get(PRIVATE_TUNNEL_CLIENT_IP_HEADER), null);
});

test("owner login proxy ignores missing provider client-IP headers", (t) => {
  withActiveTunnelProvider(t, "cloudflare_tunnel");
  const headers = buildProxyHeaders(
    new Request("https://vault.example.com/owner/login", {
      headers: { host: "vault.example.com" },
      method: "POST",
    }),
    new URL("https://vault.example.com/owner/login"),
    ["owner", "login"]
  );
  assert.equal(headers.get(PRIVATE_TUNNEL_CLIENT_IP_HEADER), null);
});

test("owner login proxy stamps private limiter markers only on the owner login route", (t) => {
  withActiveTunnelProvider(t, "ngrok");
  const headers = buildProxyHeaders(
    new Request("https://vault.ngrok-free.app/v1/connectors", {
      headers: {
        host: "vault.ngrok-free.app",
        "x-forwarded-for": "198.51.100.10, 203.0.113.200",
      },
    }),
    new URL("https://vault.ngrok-free.app/v1/connectors"),
    ["v1", "connectors"]
  );
  assert.equal(headers.get(PRIVATE_TUNNEL_CLIENT_IP_HEADER), null);
});
