// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mock, test } from "node:test";

// The loader reads the verdict through connector-install-client; replace only
// that read so each test chooses what the server answered.
let answer: () => Promise<unknown> = async () => null;

let loaded: Promise<{
  loadBrowserBoundVerdict: typeof import("./load-browser-connect-support.ts").loadBrowserBoundVerdict;
  loadBrowserConnectSupport: typeof import("./load-browser-connect-support.ts").loadBrowserConnectSupport;
  ReferenceServerUnreachableError: typeof import("./owner-token.ts").ReferenceServerUnreachableError;
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

test("a described connector is browser-bound only when the server says so", async () => {
  const { loadBrowserBoundVerdict } = await load();
  answer = async () => ({ action: "connect", browserBound: true, connectorKey: "linkedin" });
  assert.equal(await loadBrowserBoundVerdict("linkedin"), true);
  answer = async () => ({ action: "connect", browserBound: false, connectorKey: "linkedin" });
  assert.equal(await loadBrowserBoundVerdict("linkedin"), false);
  answer = async () => null;
  assert.equal(await loadBrowserBoundVerdict("linkdin"), null);
});

test("no verdict is unknown: an older server, a refused read or an outage does not reject or defer", async () => {
  const { loadBrowserBoundVerdict, ReferenceServerUnreachableError, ResourceServerHttpError } = await load();
  for (const status of [404, 500, 503]) {
    answer = async () => {
      throw new ResourceServerHttpError("/v1/owner/connector-install/readiness", status, "boom");
    };
    assert.equal(await loadBrowserBoundVerdict("linkdin"), null, String(status));
  }
  answer = async () => {
    throw new ReferenceServerUnreachableError("unreachable", new Error("ECONNREFUSED"));
  };
  assert.equal(await loadBrowserBoundVerdict("linkedin"), null);
});

test("an unrelated error still propagates from the verdict read", async () => {
  const { loadBrowserBoundVerdict } = await load();
  answer = async () => {
    throw new Error("NEXT_REDIRECT");
  };
  await assert.rejects(loadBrowserBoundVerdict("linkedin"), /NEXT_REDIRECT/);
});
