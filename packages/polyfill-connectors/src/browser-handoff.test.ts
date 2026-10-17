// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { resolveBrowserLaunchSource } from "./connector-runtime.ts";
import { prepareBrowserInteractionTarget } from "./browser-handoff.ts";

const page = {
  title: async () => "Connector page",
  url: () => "https://example.test/login",
} as never;

test("host CDP handoff registers the exact leased page target", async () => {
  let registered: Record<string, unknown> | null = null;
  const result = await prepareBrowserInteractionTarget({
    env: {
      PDPP_BROWSER_SURFACE_REMOTE_CDP_URL: "http://127.0.0.1:9222",
      PDPP_BROWSER_SURFACE_REQUIRED: "host",
    },
    interactionId: "int_host_page",
    page,
    resolveStreamingRegistration: async () => ({
      register: async (input) => {
        registered = input as unknown as Record<string, unknown>;
        return true;
      },
      runId: "run_host_page",
    }),
    resolveWsUrl: async (_page, endpoint) => {
      assert.deepEqual(endpoint, { host: "127.0.0.1", port: 9222, protocol: "ws" });
      return `ws://${endpoint.host}:${String(endpoint.port)}/devtools/page/leased-page`;
    },
  });

  assert.deepEqual(result, { interactionId: "int_host_page", registered: true });
  assert.equal(registered?.wsUrl, "ws://127.0.0.1:9222/devtools/page/leased-page");
  assert.equal(registered?.backend, undefined, "host pages register as exact CDP targets, not n.eko descriptors");
});

test("host CDP leases remain distinct from managed n.eko launch sources", () => {
  assert.deepEqual(
    resolveBrowserLaunchSource({ profileName: "chatgpt" }, {
      PDPP_BROWSER_SURFACE_REMOTE_CDP_URL: "http://127.0.0.1:9222",
      PDPP_BROWSER_SURFACE_REQUIRED: "host",
    }),
    { kind: "managed_host_cdp", remoteCdpUrl: "http://127.0.0.1:9222" }
  );
  assert.deepEqual(
    resolveBrowserLaunchSource({ profileName: "chatgpt" }, {
      PDPP_BROWSER_SURFACE_REMOTE_CDP_URL: "http://neko:9222",
      PDPP_BROWSER_SURFACE_REQUIRED: "neko",
    }),
    {
      kind: "managed_neko",
      remoteCdpUrl: "http://neko:9222",
    }
  );
});
