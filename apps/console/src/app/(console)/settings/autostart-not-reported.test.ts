// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { JSDOM } from "jsdom";
import * as React from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

class ResourceServerHttpError extends Error {
  constructor(
    readonly path: string,
    readonly status: number,
    readonly body: string
  ) {
    super(`RS ${path} failed (${status}): ${body}`);
  }
}

mock.module(new URL("../lib/owner-token.ts", import.meta.url).href, {
  namedExports: {
    getOwnerToken: async () => "test-token",
    getRsInternalUrl: () => "http://resource-server",
    ReferenceServerUnreachableError: class extends Error {},
    ResourceServerHttpError,
  },
});
mock.module(new URL("../lib/verify-session.ts", import.meta.url).href, {
  namedExports: { verifyDashboardSession: async () => undefined },
});

test("unreported autostart state is returned as unknown and shown without an error", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({ error: { message: "Autostart state is not available yet. The DataConnect desktop app has not reported its autostart state." } }),
      { status: 500, headers: { "content-type": "application/json" } }
    );

  const never = async () => {
    throw new Error("the default server action must not be used in this test");
  };
  mock.module(new URL("./desktop-settings-actions.ts", import.meta.url).href, {
    namedExports: {
      loadAppConfigAction: never,
      loadAutostartAction: never,
      saveAppConfigFieldAction: never,
      setAutostartAction: never,
    },
  });
  mock.module(new URL("../lib/live-channel-actions.ts", import.meta.url).href, {
    namedExports: { mintLiveChannelAction: never },
  });

  let root: ReturnType<typeof createRoot> | undefined;
  let queryClient: QueryClient | undefined;
  let container: HTMLElement | undefined;
  try {
    const { getAutostart } = await import("../lib/autostart-client.ts");
    assert.deepEqual(await getAutostart(), { enabled: false, error: null, known: false });

    Object.assign(globalThis, { React });
    const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
    Object.assign(globalThis, {
      document: dom.window.document,
      Event: dom.window.Event,
      HTMLElement: dom.window.HTMLElement,
      IS_REACT_ACT_ENVIRONMENT: true,
      MouseEvent: dom.window.MouseEvent,
      Node: dom.window.Node,
      window: dom.window,
    });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
    const { DesktopSettingsSetting } = await import("./desktop-settings-setting.tsx");
    const props = {
      loadAppConfig: async () => ({ closeToTray: true, startMinimized: false }),
      loadAutostart: getAutostart,
      saveAppConfigField: async () => ({ config: {}, ok: true }),
      setAutostart: async (enabled: boolean) => ({ enabled, ok: true }),
    } as unknown as NonNullable<Parameters<typeof DesktopSettingsSetting>[0]>;
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
    container = dom.window.document.createElement("div");
    dom.window.document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root?.render(createElement(QueryClientProvider, { client: queryClient as QueryClient }, createElement(DesktopSettingsSetting, props)))
    );
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });

    assert.match(container.textContent ?? "", /Not known yet/);
    assert.doesNotMatch(container.textContent ?? "", /Desktop settings could not be read/);
    assert.equal(container.querySelector<HTMLInputElement>("#autostart-enabled")?.disabled, true);
    assert.equal(container.querySelector<HTMLInputElement>("#start-minimized")?.disabled, false);
  } finally {
    if (root) await act(async () => root?.unmount());
    queryClient?.clear();
    container?.remove();
    globalThis.fetch = originalFetch;
  }
});
