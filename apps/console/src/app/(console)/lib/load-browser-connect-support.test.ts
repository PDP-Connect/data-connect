// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mock, test } from "node:test";

// The loader reads the verdict through connector-install-client; replace only
// that read so each test chooses what the server answered.
let answer: () => Promise<unknown> = async () => null;

let loaded: Promise<{
  loadBrowserConnectSupport: typeof import("./load-browser-connect-support.ts").loadBrowserConnectSupport;
  ResourceServerHttpError: typeof import("./owner-token.ts").ResourceServerHttpError;
}> | null = null;

function load() {
  loaded ??= (async () => {
    mock.module("server-only", { namedExports: {} });
    mock.module(new URL("./connector-install-client.ts", import.meta.url).href, {
      namedExports: { getConnectorReadiness: () => answer() },
    });
    return {
      ...(await import("./load-browser-connect-support.ts")),
      ...(await import("./owner-token.ts")),
    };
  })();
  return loaded;
}

test("a 404 from the readiness endpoint means the server predates it, so the console defers", async () => {
  const { loadBrowserConnectSupport, ResourceServerHttpError } = await load();
  answer = async () => {
    throw new ResourceServerHttpError("/v1/owner/connector-install/readiness", 404, "not found");
  };
  const support = await loadBrowserConnectSupport("linkedin");
  assert.deepEqual(support, { browserBound: true, canAddAccount: true });
});

test("any other failure is rethrown, so the page shows its retry state instead of not-found", async () => {
  const { loadBrowserConnectSupport, ResourceServerHttpError } = await load();
  for (const status of [500, 502, 503]) {
    answer = async () => {
      throw new ResourceServerHttpError("/v1/owner/connector-install/readiness", status, "boom");
    };
    await assert.rejects(loadBrowserConnectSupport("linkedin"), ResourceServerHttpError, String(status));
  }
  answer = async () => {
    throw new Error("network down");
  };
  await assert.rejects(loadBrowserConnectSupport("linkedin"), /network down/);
});
