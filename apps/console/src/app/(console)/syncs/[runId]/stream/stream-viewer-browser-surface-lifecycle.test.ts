// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement, StrictMode, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import {
  type MountBrowserSurfaceViewerOptions,
  mountBrowserSurfaceViewer,
} from "./stream-viewer-browser-surface-lifecycle.ts";
import type { PdppRemoteSurfaceTransport } from "./stream-viewer-remote-surface-transport.ts";

type FakeViewer = {
  id: number;
  mount: () => Promise<void>;
  unmount: () => void;
  unmounts: number;
};
type CreateViewer = MountBrowserSurfaceViewerOptions["createViewer"];

const dom = new JSDOM("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
  Node: dom.window.Node,
  window: dom.window,
});

function makeHarness() {
  const viewers: FakeViewer[] = [];
  const mountedTransports: (PdppRemoteSurfaceTransport | null)[] = [];
  const mountedViewers: unknown[] = [];
  const transportRef: { current: PdppRemoteSurfaceTransport | null } = { current: null };
  const fetches: string[] = [];
  const createViewer = ((_options: unknown) => {
    const viewer: FakeViewer = {
      id: viewers.length + 1,
      mount: () => Promise.resolve(),
      unmount() {
        viewer.unmounts += 1;
      },
      unmounts: 0,
    };
    viewers.push(viewer);
    return viewer;
  }) as unknown as CreateViewer;
  const options = (overrides: Partial<MountBrowserSurfaceViewerOptions> = {}): MountBrowserSurfaceViewerOptions => ({
    clipboardUrlRef: { current: "/clipboard" },
    createViewer,
    inputUrlRef: { current: "/input" },
    logDebug: () => undefined,
    node: dom.window.document.createElement("div"),
    onTransportMounted: (transport) => {
      mountedTransports.push(transport);
    },
    onViewerMounted: (viewer) => {
      mountedViewers.push(viewer);
    },
    presentationAttachmentReadyRef: { current: true },
    transportRef,
    viewportUrlRef: { current: "/viewport" },
    ...overrides,
  });
  return { createViewer, fetches, mountedTransports, mountedViewers, options, transportRef, viewers };
}

async function withFetchLog<T>(fetches: string[], work: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: unknown) => {
    fetches.push(String(input));
    return Promise.resolve(new Response("{}", { status: 202 }));
  }) as typeof fetch;
  try {
    return await work();
  } finally {
    globalThis.fetch = original;
  }
}

function postsInput(transport: PdppRemoteSurfaceTransport | null, fetches: string[]): boolean {
  assert.ok(transport, "expected a transport");
  const before = fetches.length;
  transport.send({ text: "x", type: "text" });
  return fetches.length > before;
}

test("a throwing mount notification during cleanup still unmounts the viewer and disposes the transport", async () => {
  const h = makeHarness();
  let failNotifications = false;
  const cleanup = mountBrowserSurfaceViewer(
    h.options({
      onTransportMounted: (transport) => {
        if (failNotifications) {
          throw new Error("callback failed");
        }
        h.mountedTransports.push(transport);
      },
    })
  );
  const [transport] = h.mountedTransports;
  failNotifications = true;
  await withFetchLog(h.fetches, async () => {
    assert.throws(cleanup, /callback failed/);
    assert.equal(h.viewers[0]?.unmounts, 1, "the viewer is unmounted even when a notification throws");
    assert.equal(postsInput(transport ?? null, h.fetches), false, "the transport is disposed");
  });
});

test("a throwing viewer unmount still disposes the transport", async () => {
  const h = makeHarness();
  const cleanup = mountBrowserSurfaceViewer(h.options());
  const [transport] = h.mountedTransports;
  const [viewer] = h.viewers;
  assert.ok(viewer);
  viewer.unmount = () => {
    throw new Error("unmount failed");
  };
  await withFetchLog(h.fetches, async () => {
    assert.throws(cleanup, /unmount failed/);
    assert.equal(postsInput(transport ?? null, h.fetches), false);
  });
});

test("a stale cleanup disposes only its own mount and leaves the newer mount live", async () => {
  const h = makeHarness();
  const cleanupOld = mountBrowserSurfaceViewer(h.options());
  const cleanupNew = mountBrowserSurfaceViewer(h.options());
  const [oldTransport, newTransport] = h.mountedTransports;
  assert.equal(h.transportRef.current, newTransport);
  await withFetchLog(h.fetches, async () => {
    cleanupOld();
    assert.equal(h.transportRef.current, newTransport, "a stale cleanup must not clear the newer mount");
    assert.equal(h.mountedTransports.length, 2, "a stale cleanup must not notify the host");
    assert.equal(postsInput(oldTransport ?? null, h.fetches), false);
    assert.equal(postsInput(newTransport ?? null, h.fetches), true, "the newer mount's transport stays live");
    assert.deepEqual(
      h.viewers.map((viewer) => viewer.unmounts),
      [1, 0]
    );
    cleanupNew();
    assert.equal(postsInput(newTransport ?? null, h.fetches), false);
  });
});

function Harness({ h, version }: { h: ReturnType<typeof makeHarness>; version: number }) {
  const nodeRef = useRef<HTMLDivElement | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` stands in for any dependency change that remounts the viewer.
  useEffect(() => {
    const node = nodeRef.current;
    if (!node) {
      return;
    }
    return mountBrowserSurfaceViewer(h.options({ node }));
  }, [h, version]);
  return createElement("div", { ref: nodeRef });
}

test("React StrictMode mount, cleanup and remount leaves exactly one live viewer and transport", async () => {
  const h = makeHarness();
  const container = dom.window.document.createElement("div");
  const root = createRoot(container);
  await withFetchLog(h.fetches, async () => {
    await act(async () => {
      root.render(createElement(StrictMode, null, createElement(Harness, { h, version: 1 })));
    });
    assert.equal(h.viewers.length, 2, "StrictMode mounted, cleaned up and remounted the effect");
    assert.deepEqual(
      h.viewers.map((viewer) => viewer.unmounts),
      [1, 0]
    );
    const transports = h.mountedTransports.filter((transport) => transport !== null);
    assert.equal(transports.length, 2);
    assert.equal(h.mountedTransports.at(-1), transports[1], "the host holds the remounted transport");
    assert.equal(postsInput(transports[0] ?? null, h.fetches), false, "the first mount's transport is disposed");
    assert.equal(postsInput(transports[1] ?? null, h.fetches), true, "the remounted transport is live");
    await act(async () => {
      root.unmount();
    });
    assert.equal(h.viewers[1]?.unmounts, 1);
    assert.equal(postsInput(transports[1] ?? null, h.fetches), false);
    assert.equal(h.mountedTransports.at(-1), null);
  });
});

test("a fast remount disposes the old transport and keeps the new mount's transport live", async () => {
  const h = makeHarness();
  const container = dom.window.document.createElement("div");
  const root = createRoot(container);
  await withFetchLog(h.fetches, async () => {
    await act(async () => {
      root.render(createElement(Harness, { h, version: 1 }));
    });
    await act(async () => {
      root.render(createElement(Harness, { h, version: 2 }));
    });
    await act(async () => {
      root.render(createElement(Harness, { h, version: 3 }));
    });
    const transports = h.mountedTransports.filter((transport) => transport !== null);
    assert.equal(transports.length, 3);
    assert.equal(postsInput(transports[0] ?? null, h.fetches), false);
    assert.equal(postsInput(transports[1] ?? null, h.fetches), false);
    assert.equal(postsInput(transports[2] ?? null, h.fetches), true, "the latest mount's transport must stay live");
    assert.equal(h.transportRef.current, transports[2]);
    assert.deepEqual(
      h.viewers.map((viewer) => viewer.unmounts),
      [1, 1, 0]
    );
    await act(async () => {
      root.unmount();
    });
  });
});
