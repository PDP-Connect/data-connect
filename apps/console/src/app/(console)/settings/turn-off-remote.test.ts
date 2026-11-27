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
  run: (screen: {
    calls: Call[];
    press: (label: RegExp) => Promise<void>;
    /** Two clicks in one tick, before React renders the first one's `busy`. */
    pressTwiceAtOnce: (label: RegExp) => Promise<void>;
    text: () => string;
    has: (label: RegExp) => boolean;
  }) => Promise<T>
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
      pressTwiceAtOnce: async (label) => {
        const button = buttons().find((node) => label.test(node.textContent ?? ""));
        assert.ok(button, `no button matching ${label}`);
        await act(async () => {
          button.click();
          button.click();
        });
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

const UNCONFIRMED = "We couldn't confirm that remote access turned off.";

test("a far-away stop that dies with no answer says it could not confirm, and offers a read, not a retry", async () => {
  const table = {
    "/state": stateWith(route(REMOTE)),
    "/routes/route-1/stop": () => {
      throw new TypeError("Failed to fetch");
    },
  };
  await withScreen(REMOTE, table, async ({ calls, press, text, has }) => {
    await press(turnOffCase.label);
    await press(/^Turn off$/);
    assert.equal(stops(calls).length, 1);
    assert.ok(!text().includes(STOPPING), "'Turning off…' must not stay with no way out");
    assert.ok(text().includes(UNCONFIRMED), text());
    assert.ok(has(/^Check again$/));
    // The read sends no stop and never claims success: the host still lists the route as on.
    await press(/^Check again$/);
    assert.equal(stops(calls).length, 1, "a recheck is a read; it sends no second stop");
    assert.match(text(), /still on/i);
    assert.doesNotMatch(text(), /turned off\.|is off\./i);
    assert.ok(has(/^Turn off$/), "Turn off is available again");
  });
});

test("a far-away stop with no answer, then a read that gets no answer, still does not claim it is off", async () => {
  let reads = 0;
  const table = {
    "/state": () => (++reads <= 1 ? stateWith(route(REMOTE)) : fail("reachability_unavailable")),
    "/routes/route-1/stop": () => {
      throw new TypeError("Failed to fetch");
    },
  };
  await withScreen(REMOTE, table, async ({ press, text }) => {
    await press(turnOffCase.label);
    await press(/^Turn off$/);
    await press(/^Check again$/);
    assert.match(text(), /couldn.t reach the host/i);
    assert.ok(!text().includes(STOPPING));
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

test("the could-not-confirm notice never claims it is off because the page stopped loading", async () => {
  const table = {
    "/state": stateWith(route(REMOTE)),
    "/routes/route-1/stop": () => {
      throw new TypeError("Failed to fetch");
    },
  };
  await withScreen(REMOTE, table, async ({ press, text }) => {
    await press(turnOffCase.label);
    await press(/^Turn off$/);
    assert.ok(text().includes(UNCONFIRMED), text());
    assert.match(text(), /may still be on/i);
    assert.match(text(), /does not show it is off/i, "an unreachable page is not proof of the host's state");
    assert.doesNotMatch(text(), /stops loading, it is off/i);
  });
});

for (const late of ["a route", "no answer"] as const) {
  test(`a late ${late} from Check again does not restore the notice after a newer stop`, async () => {
    let held: ((result: Result) => void) | null = null;
    let hold = false;
    let stopsSent = 0;
    const table: Record<string, Entry> = {
      "/state": () => (hold ? new Promise<Result>((resolve) => (held = resolve)) : stateWith(route(REMOTE))),
      "/routes/route-1/stop": () => {
        stopsSent += 1;
        if (stopsSent === 1) throw new TypeError("Failed to fetch");
        return ok({ operationId: "op-2" });
      },
    };
    await withScreen(REMOTE, table, async ({ calls, press, text }) => {
      await press(turnOffCase.label);
      await press(/^Turn off$/);
      assert.ok(text().includes(UNCONFIRMED), text());
      // Check again is pending: its /state answer is held.
      hold = true;
      await press(/^Check again$/);
      assert.ok(held, "the recheck's read is waiting");
      const stale = held as (result: Result) => void;
      // The owner starts a newer stop before that answer arrives.
      hold = false;
      await press(turnOffCase.label);
      await press(/^Turn off$/);
      assert.equal(stops(calls).length, 2);
      assert.ok(!text().includes(UNCONFIRMED), "the newer stop cleared the notice");
      // The older answer arrives last: a route that still shows On, or no answer at all.
      await act(async () => stale(late === "a route" ? stateWith(route(REMOTE, { origin: "https://stale.example.test" })) : fail("reachability_unavailable")));
      assert.ok(!text().includes("stale.example.test"), "the older answer's route is not applied over the newer stop");
      assert.doesNotMatch(text(), /Checked just now: remote access|is still on|couldn.t reach the host|couldn.t confirm/i, text());
    });
  });
}

test("a superseded failed Check again read does not replace the later poll's notice", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let held: ((result: Result) => void) | null = null;
  let hold = false;
  const table: Record<string, Entry> = {
    "/state": () => (hold ? new Promise<Result>((resolve) => (held = resolve)) : stateWith(route(REMOTE))),
    "/routes/route-1/stop": () => { throw new TypeError("Failed to fetch"); },
  };
  await withScreen(REMOTE, table, async ({ press, text }) => {
    await press(turnOffCase.label);
    await press(/^Turn off$/);
    hold = true;
    await press(/^Check again$/);
    assert.ok(held, "Check again is waiting on its state read");

    hold = false;
    await act(async () => t.mock.timers.tick(3_000));
    await act(async () => (held as (result: Result) => void)(fail("reachability_unavailable")));

    assert.doesNotMatch(text(), /couldn.t reach the host/i, "the older failure must not replace the newer successful read");
  });
});

// The operation card's Try again reads the operation and /state together. The periodic poll reads
// /state too; whichever read started later is the newer one, whatever order the answers arrive in.
test("an older operation refresh that answers after a later poll does not overwrite it", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  const stuck = {
    operationId: "op-9",
    kind: "start",
    stage: "settled",
    failureCode: "provider_unavailable",
    handle: { id: "route-1" },
    recovery: { available: true, reason: "route_reconciliation_required" },
  };
  const withOperation = (origin: string) => {
    const result = stateWith(route(origin)) as { ok: true; data: Record<string, unknown> };
    return ok({ ...result.data, operations: [stuck] });
  };
  let mode: "now" | "hold" = "now";
  let current = "https://first.example.test";
  let release: ((result: Result) => void) | null = null;
  const table: Record<string, Entry> = {
    "/state": () => (mode === "hold" ? new Promise<Result>((resolve) => (release = resolve)) : withOperation(current)),
    "/operations/op-9/reconcile": ok({}),
    "/operations/op-9": ok(stuck),
  };
  try {
    await withScreen("http://localhost:3000", table, async ({ press, text }) => {
      assert.ok(text().includes("first.example.test"), text());
      // Try again starts the older read, and its /state answer is held.
      mode = "hold";
      await press(/^Try again$/);
      assert.ok(release, "the operation refresh's /state read is waiting");
      const older = release as (result: Result) => void;
      // A later poll reads /state and gets the newer address.
      mode = "now";
      current = "https://second.example.test";
      await act(async () => mock.timers.tick(3000));
      await act(async () => {});
      assert.ok(text().includes("second.example.test"), "the poll applied the newer state");
      // The older answer arrives last, with the older address. Applying the operation starts one more
      // /state read; it is held, so only the older answer itself can change what is on screen.
      mode = "hold";
      await act(async () => older(withOperation("https://older.example.test")));
      assert.ok(text().includes("second.example.test"), "the later poll's state stays");
      assert.ok(!text().includes("older.example.test"), "the older answer does not overwrite it");
      await act(async () => (release as unknown as (result: Result) => void)(withOperation(current)));
    });
  } finally {
    mock.timers.reset();
  }
});

// The same rule for the read that follows a finished operation.
test("the read after a finished operation, answering after a later poll, does not overwrite it", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  const done = { operationId: "op-9", kind: "start", stage: "settled", failureCode: null, handle: { id: "route-1" }, recovery: null };
  const withOperation = (origin: string) => {
    const result = stateWith(route(origin)) as { ok: true; data: Record<string, unknown> };
    return ok({ ...result.data, operations: [done] });
  };
  let stateReads = 0;
  let current = "https://first.example.test";
  let release: ((result: Result) => void) | null = null;
  const table: Record<string, Entry> = {
    // Read 1 is the page's first poll. The operation it reports starts read 2, which is held.
    "/state": () => (++stateReads === 2 ? new Promise<Result>((resolve) => (release = resolve)) : withOperation(current)),
  };
  try {
    await withScreen("http://localhost:3000", table, async ({ text }) => {
      assert.ok(release, "the post-operation read is waiting");
      const older = release as (result: Result) => void;
      current = "https://second.example.test";
      await act(async () => mock.timers.tick(3000));
      await act(async () => {});
      assert.ok(text().includes("second.example.test"), "the poll applied the newer state");
      await act(async () => older(withOperation("https://older.example.test")));
      assert.ok(text().includes("second.example.test"), "the later poll's state stays");
      assert.ok(!text().includes("older.example.test"), "the older answer does not overwrite it");
    });
  } finally {
    mock.timers.reset();
  }
});

test("two fast clicks on Turn off send one stop", async () => {
  const table = { "/state": stateWith(route(REMOTE)), "/routes/route-1/stop": ok({ operationId: "op-1" }) };
  await withScreen("http://localhost:3000", table, async ({ calls, pressTwiceAtOnce }) => {
    await pressTwiceAtOnce(turnOffCase.label);
    assert.equal(stops(calls).length, 1);
  });
});
