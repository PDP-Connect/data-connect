// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
// Turn off from far away: one confirm when this page is open through the
// address, none from this computer, and a dropped request is not an error.
import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { JSDOM } from "jsdom";
import * as React from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { requestReachability } from "./reachability-client.ts";
import { publicError } from "./reachability-errors.ts";

mock.module(new URL("./owner-password-first-setup-actions.ts", import.meta.url).href, {
  namedExports: { requestOwnerPasswordWindowAction: async () => ({ ok: true }) },
});
mock.module(new URL("./reachability-client.ts", import.meta.url).href, {
  namedExports: {
    requestReachability: async () => {
      throw new Error("Use the test transport");
    },
  },
});

type Result = Awaited<ReturnType<typeof requestReachability>>;
type Call = { url: string; body?: Record<string, unknown> };
const ok = (data: unknown): Result => ({ ok: true, data });
const fail = (code: string): Result => ({ ok: false, ...publicError(code, "server words") });

const REMOTE = "https://one.example.test";
const CONFIRM = "You're using this address now. Turning it off will close this page.";
const STOPPING = "Turning off… this page will stop working in a moment.";

const iso = (ms: number) => new Date(ms).toISOString();
function route(origin: string | null, over: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    handle: { id: "route-1", generation: 1, kind: "session" },
    origin,
    binding: { authority: "host", remedy: null, target: { known: false, reason: "x" } },
    cleanup: { state: "none", nextAction: null },
    expiresAt: { known: true, value: iso(now + 3_600_000) },
    facts: [],
    hostConfiguration: { target: { known: true, value: "127.0.0.1:37807" } },
    published: origin,
    routeState: "verified",
    state: "usable",
    verification: {
      status: "verified",
      vantage: "public",
      observedAt: iso(now),
      validUntil: { known: true, value: iso(now + 600_000) },
    },
    ...over,
  };
}
const lifecycle = (phase: string) => ({
  handle: { id: "route-1", generation: 1, kind: "session" },
  phase,
  confinement: { known: false },
  cleanup: "none",
  stopRequested: false,
  reason: null,
});
const stateWith = (r: unknown, phase = "verified") =>
  ok({ routes: [r], reasons: {}, starting: false, services: [], lifecycle: lifecycle(phase), operations: [] });

const provider = {
  providerId: "p-tunnel",
  label: "Tunnel service",
  reach: "public",
  transport: "https",
  availability: { session: { state: "available", reason: "" } },
  configuration: { revision: "r1", actions: [], inputRequirements: [], values: {}, credentials: {} },
  facts: [],
  prerequisites: [],
};
const catalog = { catalogRevision: "c1", observedAt: "x", schemaVersion: 1, providers: [provider] };

type Entry = Result | ((call: Call) => Result | Promise<Result>);
async function withScreen<T>(
  pageUrl: string,
  table: Record<string, Entry>,
  run: (screen: { calls: Call[]; press: (label: RegExp) => Promise<void>; text: () => string; has: (label: RegExp) => boolean }) => Promise<T>
): Promise<T> {
  const dom = new JSDOM('<div id="root"></div>', { url: pageUrl });
  Object.assign(globalThis, { React, window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, HTMLButtonElement: dom.window.HTMLButtonElement });
  const { RemoteAccessSetting } = await import("./remote-access-setting.tsx");
  const container = dom.window.document.querySelector("#root")!;
  const root = createRoot(container);
  const calls: Call[] = [];
  const all: Record<string, Entry> = {
    "/catalog": ok(catalog),
    "/host-settings": ok({ known: false, reason: "unavailable" }),
    "/host-capabilities": ok({}),
    ...table,
  };
  const request = (async (url: string, body?: Record<string, unknown>) => {
    const call = { url, ...(body ? { body } : {}) };
    calls.push(call);
    const hit = all[url.split("?")[0]!];
    if (!hit) return fail("route_not_found");
    return typeof hit === "function" ? hit(call) : hit;
  }) as typeof requestReachability;
  const settle = () => act(async () => {});
  try {
    await act(async () => root.render(createElement(RemoteAccessSetting, { request, appVersion: "0.0.0-test" })));
    await settle();
    const buttons = () => [...container.querySelectorAll("button")];
    return await run({
      calls,
      text: () => container.textContent ?? "",
      has: (label) => buttons().some((node) => label.test(node.textContent ?? "")),
      press: async (label) => {
        const button = buttons().find((node) => label.test(node.textContent ?? ""));
        assert.ok(button, `no button matching ${label}`);
        await act(async () => button.click());
        await settle();
      },
    });
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
}

const stops = (calls: Call[]) => calls.filter((call) => call.url === "/routes/route-1/stop");
const stopBody = { generation: 1, acknowledgeDisconnect: true };

// The Turn off button on the On card, then the one on a route that needs the owner.
const turnOffCase = { label: /^Turn off$/ };

test("from the remote address, Turn off asks first; Cancel sends nothing", async () => {
  await withScreen(REMOTE, { "/state": stateWith(route(REMOTE)), "/routes/route-1/stop": ok({ operationId: "op-1" }) }, async ({ calls, press, text, has }) => {
    await press(turnOffCase.label);
    assert.ok(text().includes(CONFIRM));
    assert.equal(stops(calls).length, 0, "nothing sent before the owner confirms");
    await press(/^Cancel$/);
    assert.ok(!text().includes(CONFIRM));
    assert.ok(!text().includes(STOPPING));
    assert.equal(stops(calls).length, 0);
    assert.ok(has(/^Turn off$/), "still On with Turn off available");
  });
});

test("from the remote address, confirming sends exactly one stop with the acknowledgment", async () => {
  await withScreen(REMOTE, { "/state": stateWith(route(REMOTE)), "/routes/route-1/stop": ok({ operationId: "op-1" }) }, async ({ calls, press, text }) => {
    await press(turnOffCase.label);
    // The dialog also has a Turn off button; it is the last one.
    const confirm = async () => press(/^Turn off$/);
    await confirm();
    assert.equal(stops(calls).length, 1);
    assert.deepEqual(stops(calls)[0]!.body, stopBody);
    assert.ok(!text().includes(CONFIRM));
  });
});

test("from this computer, there is no dialog and one stop is sent", async () => {
  for (const page of ["http://localhost:3000", "http://127.0.0.1:3000"]) {
    await withScreen(page, { "/state": stateWith(route(REMOTE)), "/routes/route-1/stop": ok({ operationId: "op-1" }) }, async ({ calls, press, text }) => {
      await press(turnOffCase.label);
      assert.ok(!text().includes(CONFIRM), page);
      assert.equal(stops(calls).length, 1, page);
      assert.deepEqual(stops(calls)[0]!.body, stopBody);
    });
  }
});

test("with the route's address unknown, there is no dialog even on a remote-looking page", async () => {
  await withScreen(REMOTE, { "/state": stateWith(route(null)), "/routes/route-1/stop": ok({ operationId: "op-1" }) }, async ({ calls, press, text }) => {
    await press(turnOffCase.label);
    assert.ok(!text().includes(CONFIRM));
    assert.equal(stops(calls).length, 1);
  });
});

test("the route's address with a path or default port still matches the page", async () => {
  await withScreen(REMOTE, { "/state": stateWith(route("https://ONE.example.test:443/console")) }, async ({ press, text }) => {
    await press(turnOffCase.label);
    assert.ok(text().includes(CONFIRM));
  });
});

test("a stop that dies because the tunnel closed is the expected end, not an error", async () => {
  const table = {
    "/state": stateWith(route(REMOTE)),
    "/routes/route-1/stop": () => {
      throw new TypeError("Failed to fetch");
    },
  };
  await withScreen(REMOTE, table, async ({ calls, press, text }) => {
    await press(turnOffCase.label);
    await press(/^Turn off$/);
    assert.equal(stops(calls).length, 1);
    assert.ok(text().includes(STOPPING), text());
    assert.doesNotMatch(text(), /couldn't|Couldn't|Something went wrong|alert/i);
  });
});

test("from far away, a refusal the host sends back is still an error", async () => {
  const table = { "/state": stateWith(route(REMOTE)), "/routes/route-1/stop": fail("brand_new_server_code") };
  await withScreen(REMOTE, table, async ({ press, text }) => {
    await press(turnOffCase.label);
    await press(/^Turn off$/);
    assert.ok(!text().includes(STOPPING), "no stale 'will stop working' after a refusal");
    assert.match(text(), /couldn.t|Try again/i);
  });
});

test("from this computer, a stop that fails shows its error and no far-away message", async () => {
  const table = {
    "/state": stateWith(route(REMOTE)),
    "/routes/route-1/stop": () => {
      throw new TypeError("Failed to fetch");
    },
  };
  await withScreen("http://localhost:3000", table, async ({ press, text }) => {
    await press(turnOffCase.label);
    assert.ok(!text().includes(STOPPING));
  });
});

test("Turn on again from far away follows the same rule", async () => {
  const stale = route(REMOTE, { state: "unusable", verification: { status: "failed", vantage: "public", observedAt: iso(Date.now()), validUntil: { known: false, reason: "x" } } });
  const table = { "/state": stateWith(stale, "stale"), "/routes/route-1/stop": ok({ operationId: "op-1" }) };
  await withScreen(REMOTE, table, async ({ calls, press, text, has }) => {
    assert.ok(has(/^Turn on again$/), "the route needs the owner and offers Turn on again");
    await press(/^Turn on again$/);
    assert.ok(text().includes(CONFIRM));
    assert.equal(stops(calls).length, 0);
    await press(/^Cancel$/);
    assert.equal(stops(calls).length, 0);
    await press(/^Turn on again$/);
    // The dialog's Turn off is the first button with this label after the dialog opens.
    await press(/^Turn off$/);
    assert.equal(stops(calls).length, 1);
    assert.deepEqual(stops(calls)[0]!.body, stopBody);
  });
  await withScreen("http://localhost:3000", table, async ({ calls, press, text }) => {
    await press(/^Turn on again$/);
    assert.ok(!text().includes(CONFIRM));
    assert.equal(stops(calls).length, 1);
  });
});
