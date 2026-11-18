// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
// The On card, the automatic proof re-check, route loss, Turn on again, the
// facts list in Details and Try again.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { mock, type TestContext } from "node:test";
import { JSDOM } from "jsdom";
import * as React from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import ts from "typescript";
import { formatLocalTime } from "./plain-text.ts";
import type { requestReachability } from "./reachability-actions.ts";
import { publicError } from "./reachability-errors.ts";

mock.module(new URL("./owner-password-first-setup-actions.ts", import.meta.url).href, {
  namedExports: { requestOwnerPasswordWindowAction: async () => ({ ok: true }) },
});
mock.module(new URL("./reachability-actions.ts", import.meta.url).href, {
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

const T0 = Date.parse("2026-11-18T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const fact = (id: string, value: string | null, known = true) => ({
  id,
  group: "cost",
  label: id,
  known,
  ...(known ? { value } : { value: null, reason: "needs-provider-call" }),
  source: "provider",
  asOf: null,
});

type RouteOver = { providerId?: string | null; id?: string; origin?: string; observedAt?: number; validUntil?: number | null; expiresAt?: number | null; facts?: unknown[]; state?: string };
function routeAt(over: RouteOver = {}) {
  const observedAt = over.observedAt ?? T0;
  const validUntil = over.validUntil === undefined ? observedAt + 30_000 : over.validUntil;
  const expiresAt = over.expiresAt === undefined ? T0 + 3_600_000 : over.expiresAt;
  return {
    providerId: over.providerId ?? null,
    handle: { id: over.id ?? "route-1", generation: 1, kind: "session" },
    origin: over.origin ?? "https://one.example.invalid",
    binding: { authority: "host", remedy: null, target: { known: false, reason: "x" } },
    cleanup: { state: "none", nextAction: null },
    expiresAt: expiresAt === null ? { known: false, reason: "not-observed" } : { known: true, value: iso(expiresAt) },
    facts: over.facts ?? [],
    hostConfiguration: { target: { known: true, value: "127.0.0.1:37807" } },
    published: "https://one.example.invalid",
    routeState: "verified",
    state: over.state ?? "usable",
    verification: {
      status: "verified",
      vantage: "public",
      observedAt: iso(observedAt),
      validUntil: validUntil === null ? { known: false, reason: "x" } : { known: true, value: iso(validUntil) },
    },
  };
}
const lifecycle = (phase: string, over: Record<string, unknown> = {}) => ({
  handle: { id: "route-1", generation: 1, kind: "session" },
  phase,
  confinement: { known: false },
  cleanup: "none",
  stopRequested: false,
  reason: null,
  ...over,
});
const onState = (route = routeAt(), phase = "verified") => ok({ routes: [route], reasons: {}, starting: false, services: [], lifecycle: lifecycle(phase), operations: [] });
const offState = ok({ routes: [], reasons: {}, starting: false, services: [] });

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
const draft = { draftId: "d-1", configuration: { revision: "r2", actions: [], inputRequirements: [], values: {}, credentials: {} } };
const review = (id: string, digest = "digest-1") => ({
  id,
  kind: "route",
  candidate: {
    providerId: "p-tunnel",
    display: { label: "Tunnel service", description: "", needs: "" },
    consentFactsDigest: digest,
    expiresAt: "2999-01-01T00:00:00.000Z",
    eligible: true,
    facts: [fact("Cost", "free")],
    consent: {
      consentFactsDigest: digest,
      scope: { kind: "route", query: { target: "127.0.0.1:37807", expectedOrigin: null, usage: { kind: "session", lifetimeMs: 3_600_000 } } },
      facts: [fact("Cost", "free")],
      disclosures: { traffic: { providerCanReadPayload: true }, cost: { kind: "free", summary: "Free" }, address: { stability: "ephemeral" } },
    },
  },
});

type Handler = (call: Call) => Result | Promise<Result>;
type Entry = Result | ((call: Call) => Result | Promise<Result>);
function host(table: Record<string, Entry> = {}): Handler {
  const all: Record<string, Entry> = {
    "/catalog": ok(catalog),
    "/state": offState,
    "/host-settings": ok({ known: false, reason: "unavailable" }),
    "/host-capabilities": ok({}),
    "/drafts": ok(draft),
    "/drafts/d-1/commit": ok(draft.configuration),
    "/drafts/d-1/review": ok(review("rev-1")),
    ...table,
  };
  return (call) => {
    const hit = all[call.url.split("?")[0]!];
    if (!hit) return fail("route_not_found");
    return typeof hit === "function" ? hit(call) : hit;
  };
}

async function withScreen<T>(
  handler: Handler,
  run: (screen: {
    container: Element;
    calls: Call[];
    press: (label: RegExp) => Promise<void>;
    tick: (ms: number) => Promise<void>;
    text: () => string;
    allText: () => string;
  }) => Promise<T>,
  t?: TestContext
): Promise<T> {
  try {
    t?.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"], now: T0 });
  } catch {
    // A test that opens a second screen keeps the clock it already has.
  }
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  Object.assign(globalThis, { React, window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const { RemoteAccessSetting } = await import("./remote-access-setting.tsx");
  const container = dom.window.document.querySelector("#root")!;
  const root = createRoot(container);
  const calls: Call[] = [];
  const request = (async (url: string, body?: Record<string, unknown>) => {
    const call = { url, ...(body ? { body } : {}) };
    calls.push(call);
    return handler(call);
  }) as typeof requestReachability;
  const settle = () => act(async () => {});
  try {
    await act(async () => root.render(createElement(RemoteAccessSetting, { request, appVersion: "0.0.0-test" })));
    await settle();
    return await run({
      container,
      calls,
      tick: async (ms) => {
        await act(async () => t?.mock.timers.tick(ms));
        await settle();
      },
      text: () => {
        const clone = container.cloneNode(true) as Element;
        for (const node of clone.querySelectorAll("[data-diagnostics]")) node.remove();
        return clone.textContent ?? "";
      },
      allText: () => container.textContent ?? "",
      press: async (label) => {
        const button = [...container.querySelectorAll("button")].find((node) => label.test(node.textContent ?? ""));
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
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const checks = (calls: Call[]) => calls.filter((call) => call.url === "/routes/route-1/check");

// ---------- the card ----------

test("On shows the address, Copy, the check age, the server's end time and Turn off, and a link on", async (t) => {
  const route = routeAt({ expiresAt: T0 + 5 * 60_000 + 3_600_000 });
  await withScreen(host({ "/state": onState(route) }), async ({ container, text }) => {
    const visible = text();
    assert.match(visible, /^Remote access/);
    assert.match(visible, /On/);
    assert.match(visible, /Your address: https:\/\/one\.example\.invalid/);
    assert.ok([...container.querySelectorAll("button")].some((node) => node.textContent === "Copy address"));
    assert.match(visible, /Works from the internet · checked just now/);
    assert.ok(visible.includes(`Turns off at ${formatLocalTime(T0 + 5 * 60_000 + 3_600_000)}`), visible);
    assert.ok([...container.querySelectorAll("button")].some((node) => node.textContent === "Turn off"));
    const link = [...container.querySelectorAll("a")].find((node) => /connect ChatGPT or Claude/.test(node.textContent ?? ""));
    assert.equal(link?.textContent, "Next: connect ChatGPT or Claude");
    assert.equal(link?.getAttribute("href"), "/connect");
    assert.doesNotMatch(visible, /connected to|is connected|QR/i);
    assert.doesNotMatch(visible, /\b1 hour\b|15 minutes/);
  }, t);
});

test("the end time is the server's, not a fixed length: a 7-minute route shows 7 minutes from now", async (t) => {
  const route = routeAt({ expiresAt: T0 + 7 * 60_000 });
  await withScreen(host({ "/state": onState(route) }), async ({ text }) => {
    assert.ok(text().includes(`Turns off at ${formatLocalTime(T0 + 7 * 60_000)}`), text());
  }, t);
});

test("with no end time from the server, a temporary address says so and shows no time", async (t) => {
  await withScreen(host({ "/state": onState(routeAt({ expiresAt: null })) }), async ({ text }) => {
    assert.match(text(), /Temporary address; it may turn off or change/);
    assert.doesNotMatch(text(), /Turns off at/);
  }, t);
});

test("Copy address writes the address to the clipboard", async (t) => {
  const written: string[] = [];
  const dom = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { value: { clipboard: { writeText: async (value: string) => void written.push(value) } }, configurable: true });
  try {
    await withScreen(host({ "/state": onState() }), async ({ press, text }) => {
      await press(/^Copy address$/);
      assert.deepEqual(written, ["https://one.example.invalid"]);
      assert.match(text(), /Copied/);
    }, t);
  } finally {
    if (dom) Object.defineProperty(globalThis, "navigator", dom);
    else Reflect.deleteProperty(globalThis, "navigator");
  }
});

// ---------- the automatic re-check ----------

test("the proof is re-checked before its window ends; the status stays On and 'checked' refreshes", async (t) => {
  let phase = "verified";
  let route = routeAt();
  let finish: (() => void) | null = null;
  const handler = host({
    "/state": () => onState(route, phase),
    "/routes/route-1/check": () => {
      phase = "checking";
      return new Promise<Result>((resolve) => {
        finish = () => {
          phase = "verified";
          route = routeAt({ observedAt: Date.now(), validUntil: Date.now() + 30_000 });
          resolve(ok(route));
        };
      });
    },
  });
  await withScreen(handler, async ({ calls, tick, text }) => {
    assert.equal(checks(calls).length, 0, "not before it is due");
    await tick(19_000);
    assert.equal(checks(calls).length, 0, "the window is 30 s and a third of it is the margin: due at 20 s");
    await tick(1_500);
    assert.equal(checks(calls).length, 1);
    assert.deepEqual(checks(calls)[0]!.body, { generation: 1 });
    // While the check runs the host reports "checking" and a poll lands: the owner still reads On.
    await tick(3_000);
    assert.match(text(), /On/);
    assert.match(text(), /Next: connect ChatGPT or Claude/);
    assert.doesNotMatch(text(), /Turning on|Needs your action|stale/i);
    await act(async () => finish?.());
    assert.match(text(), /On/);
    assert.match(text(), /Works from the internet · checked just now/);
    // The next window is renewed the same way.
    await tick(21_000);
    assert.equal(checks(calls).length, 2);
    await act(async () => finish?.());
    assert.doesNotMatch(text(), /Needs your action|stale/i);
  }, t);
});

test("a proof the host already calls stale is re-checked after a bounded delay and never shown as stale", async (t) => {
  let phase = "stale";
  const handler = host({
    "/state": () => onState(routeAt({ observedAt: T0 - 60_000, validUntil: T0 - 30_000 }), phase),
    "/routes/route-1/check": () => {
      phase = "verified";
      return ok(routeAt());
    },
  });
  await withScreen(handler, async ({ calls, tick, text }) => {
    await tick(1_999);
    assert.equal(checks(calls).length, 0);
    await tick(1);
    assert.equal(checks(calls).length, 1, "minimum positive delay");
    assert.doesNotMatch(text(), /Needs your action|stale/i);
  }, t);
});

test("a re-check that fails becomes Needs your action with Turn on again", async (t) => {
  const handler = host({
    "/state": () => onState(),
    "/routes/route-1/check": () => fail("verification_failed"),
  });
  await withScreen(handler, async ({ calls, tick, text, container }) => {
    await tick(21_000);
    assert.equal(checks(calls).length, 1);
    assert.match(text(), /Needs your action/);
    assert.match(text(), /We can't confirm the address still works\. Turn it on again to get a fresh one\./);
    assert.ok([...container.querySelectorAll("button")].some((node) => node.textContent === "Turn on again"));
    assert.doesNotMatch(text(), /Turns off at|Next: connect/);
    await tick(60_000);
    assert.equal(checks(calls).length, 1, "a failed route is not re-checked in a loop");
  }, t);
});

test("a re-check that returns an unverified route is a failure too", async (t) => {
  const handler = host({
    "/state": () => onState(),
    "/routes/route-1/check": () => ok({ ...routeAt(), published: null, verification: { ...routeAt().verification, status: "unverified" } }),
  });
  await withScreen(handler, async ({ tick, text }) => {
    await tick(21_000);
    assert.match(text(), /Needs your action/);
  }, t);
});

test("a route the host lost is Needs your action within one poll, with Turn on again", async (t) => {
  let lost = false;
  const handler = host({
    "/state": () =>
      lost
        ? ok({
            routes: [{ ...routeAt({ state: "released" }), cleanup: { state: "confirmed", nextAction: null }, verification: { ...routeAt().verification, status: "unverified" } }],
            reasons: {},
            starting: false,
            services: [],
            lifecycle: lifecycle("stopping", { reason: "agent-exited" }),
            operations: [],
          })
        : onState(),
  });
  await withScreen(handler, async ({ tick, text, container }) => {
    assert.match(text(), /Next: connect ChatGPT or Claude/);
    lost = true;
    await tick(3_000);
    assert.match(text(), /Needs your action/);
    assert.match(text(), /Your address stopped working\. Tunnel service closed the connection\./);
    assert.match(text(), /update it wherever you pasted the old one/);
    assert.doesNotMatch(text(), /Next: connect|Turns off at/);
    assert.ok([...container.querySelectorAll("button")].some((node) => node.textContent === "Turn on again"));
  }, t);
});

// A browser clock that differs from the server's must not change when proofs
// are renewed: the schedule uses the window length the server reports.
for (const skew of [120_000, -120_000]) {
  test(`with the browser clock ${skew > 0 ? "ahead" : "behind"} by 120 s, each proof window is re-checked once, even with slow responses`, async (t) => {
    t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"], now: T0 + skew });
    const serverNow = () => Date.now() - skew;
    let route = routeAt({ observedAt: serverNow(), validUntil: serverNow() + 30_000 });
    let release: (() => void) | null = null;
    const handler = host({
      "/state": () => onState(route),
      "/routes/route-1/check": () =>
        new Promise<Result>((resolve) => {
          release = () => {
            route = routeAt({ observedAt: serverNow(), validUntil: serverNow() + 30_000 });
            resolve(ok(route));
          };
        }),
    });
    await withScreen(handler, async ({ calls, tick, text }) => {
      for (let second = 0; second < 100; second += 1) {
        await tick(1_000);
        // Every response takes 2 s.
        if (release && second % 2 === 1) {
          await act(async () => release?.());
          release = null;
        }
      }
      const count = checks(calls).length;
      assert.ok(count >= 3 && count <= 6, `one check per window, not a loop: ${count} checks in 100 s`);
      assert.doesNotMatch(text(), /Needs your action/);
    }, t);
  });

  test(`with the browser clock ${skew > 0 ? "ahead" : "behind"} by 120 s, a host report of stale is checked with a bounded delay and a failure needs the owner within one poll`, async (t) => {
    t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"], now: T0 + skew });
    let phase = "verified";
    const route = routeAt({ observedAt: Date.now() - skew, validUntil: Date.now() - skew + 30_000 });
    const handler = host({
      "/state": () => onState(route, phase),
      "/routes/route-1/check": () => fail("verification_failed"),
    });
    await withScreen(handler, async ({ calls, tick, text }) => {
      phase = "stale";
      await tick(3_000);
      await tick(2_000);
      assert.equal(checks(calls).length, 1, "a stale report is checked promptly, whatever the browser clock says");
      assert.match(text(), /Needs your action/);
    }, t);
  });
}

test("a delayed state read after a re-check cannot bring back a route that was turned off", async (t) => {
  let stage: "on" | "off" = "on";
  let holdNext = false;
  const late = deferred<Result>();
  const releasedRoute = { ...routeAt({ state: "released" }), cleanup: { state: "confirmed", nextAction: null }, verification: { ...routeAt().verification, status: "unverified" } };
  const handler = host({
    "/state": () => {
      if (holdNext) {
        holdNext = false;
        return late.promise;
      }
      return stage === "on" ? onState() : ok({ routes: [releasedRoute], reasons: {}, starting: false, services: [], operations: [] });
    },
    "/routes/route-1/check": () => {
      holdNext = true;
      return ok(routeAt());
    },
    "/routes/route-1/stop": () => {
      stage = "off";
      return ok({ operationId: "op-2" });
    },
    "/operations/op-2": ok({ operationId: "op-2", stage: "settled", kind: "stop", failureCode: null, recovery: null }),
  });
  await withScreen(handler, async ({ calls, press, tick, text }) => {
    await tick(20_500);
    assert.equal(checks(calls).length, 1);
    await press(/^Turn off$/);
    await tick(3_000);
    assert.match(text(), /Your address no longer works\./);
    await act(async () => late.resolve(onState()));
    await tick(1);
    assert.match(text(), /Your address no longer works\./, "the late reply is dropped");
    assert.doesNotMatch(text(), /Next: connect|Turns off at|Works from the internet/);
  }, t);
});

// A stop the host refuses must leave the card where it was, with the error shown
// and automatic re-checks still running.
for (const label of ["Turn on again", "Turn off"]) {
  test(`${label}: a refused stop keeps Needs your action, shows the error and keeps re-checking`, async (t) => {
    let phase = "stale";
    let stopAccepted = false;
    let stops = 0;
    let route = routeAt({ observedAt: T0 - 60_000, validUntil: T0 - 30_000 });
    const handler = host({
      "/state": () => stopAccepted ? offState : onState(route, phase),
      "/routes/route-1/check": () => ok(routeAt()),
      "/routes/route-1/stop": () => {
        if (++stops === 1) return fail("service_unreachable");
        stopAccepted = true;
        return ok({ operationId: "op-stop" });
      },
      "/operations/op-stop": ok({ operationId: "op-stop", kind: "stop", stage: "settled", recovery: null }),
    });
    await withScreen(handler, async ({ calls, press, tick, text, container }) => {
      await tick(3_000);
      assert.equal(checks(calls).length, 1);
      assert.match(text(), /Needs your action/, "the host still calls the proof stale after the check");
      await press(new RegExp(`^${label}$`));
      assert.ok(calls.some((call) => call.url === "/routes/route-1/stop"));
      assert.match(text(), /Needs your action/);
      assert.ok(container.querySelector('[role="alert"]'), "the error is shown");
      // The host renews the proof; the next window must be re-checked.
      phase = "verified";
      route = routeAt({ observedAt: Date.now(), validUntil: Date.now() + 30_000 });
      await tick(3_000);
      const before = checks(calls).length;
      await tick(30_000);
      assert.ok(checks(calls).length > before, "re-checks continue after the refused stop");
      phase = "failed";
      await tick(3_000);
      await press(new RegExp(`^${label}$`));
      await tick(3_000);
      assert.equal(stops, 2, "the second click reaches the host");
      assert.equal(stopAccepted, true);
      // The fixture's unknown host settings print the same sentence as a status line, so the error itself is the alert.
      assert.equal(container.querySelector('[role="alert"]'), null, "the error is gone once the stop is accepted");
      assert.doesNotMatch(text(), /Needs your action/);
    }, t);
  });
}

// ---------- Turn on again and the new address ----------

test("Turn on again turns off, turns on with the facts already approved, and says the address changed", async (t) => {
  // Off -> the owner turns on -> On (address one) -> the host loses it -> Turn on again -> On (address two).
  let stage: "off" | "on1" | "lost" | "off2" | "on2" = "off";
  const lostRoute = { ...routeAt({ state: "released" }), cleanup: { state: "confirmed", nextAction: null }, verification: { ...routeAt().verification, status: "unverified" } };
  const world = (): Result => {
    if (stage === "off") return offState;
    if (stage === "on1") return onState(routeAt());
    if (stage === "lost") return ok({ routes: [lostRoute], reasons: {}, starting: false, services: [], lifecycle: lifecycle("stopping", { reason: "agent-exited" }), operations: [] });
    if (stage === "off2") return ok({ routes: [lostRoute], reasons: {}, starting: false, services: [], operations: [] });
    return ok({ routes: [lostRoute, routeAt({ id: "route-2", origin: "https://two.example.invalid", observedAt: Date.now(), validUntil: Date.now() + 30_000 })], reasons: {}, starting: false, services: [], lifecycle: lifecycle("verified", { handle: { id: "route-2", generation: 1, kind: "session" } }), operations: [] });
  };
  const handler = host({
    "/state": () => world(),
    "/operations": () => {
      stage = stage === "off" ? "on1" : "on2";
      return ok({ operationId: stage === "on1" ? "op-1" : "op-3" });
    },
    "/operations/op-1": ok({ operationId: "op-1", stage: "settled", kind: "start", failureCode: null, recovery: null }),
    "/operations/op-3": ok({ operationId: "op-3", stage: "settled", kind: "start", failureCode: null, recovery: null }),
    "/routes/route-1/stop": () => {
      stage = "off2";
      return ok({ operationId: "op-2" });
    },
    "/operations/op-2": ok({ operationId: "op-2", stage: "settled", kind: "stop", failureCode: null, recovery: null }),
  });
  await withScreen(handler, async ({ calls, press, tick, text }) => {
    await press(/^Turn on remote access$/);
    await tick(3_000);
    assert.match(text(), /Your address: https:\/\/one\.example\.invalid/);
    assert.doesNotMatch(text(), /Your address changed/);
    stage = "lost";
    await tick(3_000);
    assert.match(text(), /Needs your action/);
    await press(/^Turn on again$/);
    await tick(3_000);
    const approvals = calls.filter((call) => call.url === "/operations");
    assert.equal(approvals.length, 2, "Turn on again approves once, with no second click");
    assert.equal(approvals[1]!.body?.consentFactsDigest, "digest-1", "on the facts the owner already approved");
    assert.ok(calls.some((call) => call.url === "/routes/route-1/stop"));
    await tick(3_000);
    assert.match(text(), /Your address: https:\/\/two\.example\.invalid/);
    assert.match(text(), /Your address changed\. Update it wherever you pasted the old one, like ChatGPT\./);
    const copy = [...document.querySelectorAll("button")].find((node) => node.textContent === "Copy address");
    assert.ok(copy, "Copy is offered for the new address");
    assert.doesNotMatch(text(), /Your address: https:\/\/one/, "the replaced route is not a second card");
  }, t);
});

test("Turn on again waits for a click when the facts changed since the owner approved", async (t) => {
  let stage: "off" | "on1" | "lost" | "off2" = "off";
  const lostRoute = { ...routeAt({ state: "released" }), cleanup: { state: "confirmed", nextAction: null }, verification: { ...routeAt().verification, status: "unverified" } };
  let digest = "digest-1";
  const handler = host({
    "/state": () =>
      stage === "off"
        ? offState
        : stage === "on1"
          ? onState()
          : stage === "lost"
            ? ok({ routes: [lostRoute], reasons: {}, starting: false, services: [], lifecycle: lifecycle("stopping", { reason: "agent-exited" }), operations: [] })
            : ok({ routes: [lostRoute], reasons: {}, starting: false, services: [], operations: [] }),
    "/drafts/d-1/review": () => ok(review(`rev-${digest}`, digest)),
    "/operations": () => {
      stage = "on1";
      return ok({ operationId: "op-1" });
    },
    "/operations/op-1": ok({ operationId: "op-1", stage: "settled", kind: "start", failureCode: null, recovery: null }),
    "/routes/route-1/stop": () => {
      stage = "off2";
      digest = "digest-2";
      return ok({ operationId: "op-2" });
    },
    "/operations/op-2": ok({ operationId: "op-2", stage: "settled", kind: "stop", failureCode: null, recovery: null }),
  });
  await withScreen(handler, async ({ calls, press, tick, text }) => {
    await press(/^Turn on remote access$/);
    await tick(3_000);
    stage = "lost";
    await tick(3_000);
    await press(/^Turn on again$/);
    await tick(3_000);
    assert.equal(calls.filter((call) => call.url === "/operations").length, 1, "nothing is approved on changed facts");
    assert.match(text(), /Details of this connection changed/);
    assert.match(text(), /Turn on remote access/);
  }, t);
});

// ---------- Details ----------

test("Details show facts with a value, known-empty facts as None, and one count for facts the service doesn't publish", async (t) => {
  const facts = [
    fact("Cost", "free"),
    fact("Account", null),
    fact("Region", null, false),
    fact("Speed limit", null, false),
    fact("Uptime", null, false),
  ];
  await withScreen(host({ "/state": onState(routeAt({ facts })) }), async ({ allText }) => {
    const text = allText();
    assert.match(text, /Cost\s*free/);
    assert.match(text, /Account\s*None/);
    assert.match(text, /3 facts Tunnel service doesn't publish\./);
    assert.doesNotMatch(text, /needs.provider.call|Region|Uptime|Speed limit/);
  }, t);
});

test("one unknown fact is a singular count, and none is no line", async (t) => {
  await withScreen(host({ "/state": onState(routeAt({ facts: [fact("Region", null, false)] })) }), async ({ allText }) => {
    assert.match(allText(), /1 fact Tunnel service doesn't publish\./);
  }, t);
  await withScreen(host({ "/state": onState(routeAt({ facts: [fact("Cost", "free")] })) }), async ({ allText }) => {
    assert.doesNotMatch(allText(), /doesn't publish/);
  }, t);
});

test("the Turn on card lists known-empty facts as None and counts only unknown ones", async () => {
  const withFacts = review("rev-1");
  const facts = [fact("Cost", "free"), fact("Account", null), fact("Region", null, false)];
  withFacts.candidate.consent.facts = facts;
  await withScreen(host({ "/drafts/d-1/review": ok(withFacts) }), async ({ allText }) => {
    assert.match(allText(), /Account\s*None/);
    assert.match(allText(), /1 fact Tunnel service doesn't publish\./);
    assert.doesNotMatch(allText(), /Region/);
  });
});

for (const source of ["facts", "disclosures"] as const) {
test(`time-stating conditions from ${source} alone stay visible in Turn on approval`, async () => {
  const withConditions = review("rev-1");
  const conditions = ["Logs retained for 30 days", "Free for 7 days, then costs $10", "the plan limits a session to 15 minutes"];
  const facts = conditions.map((value, index) => ({ ...fact(`address-conditions-${index}`, value), group: "address", label: "address conditions" }));
  withConditions.candidate.consent.facts = source === "facts" ? facts : [];
  (withConditions.candidate.consent.disclosures as Record<string, unknown>).address = { stability: "ephemeral", ...(source === "disclosures" ? { conditions } : {}) };
  await withScreen(host({ "/drafts/d-1/review": ok(withConditions) }), async ({ allText }) => {
    for (const text of conditions) {
      assert.ok(allText().includes(text), `"${text}" is shown`);
    }
  });
});
}

// ---------- Try again ----------

const failedOp = (recovery: unknown, over: Record<string, unknown> = {}) => ({
  operationId: "op-1",
  stage: "settled",
  kind: "start",
  failureCode: "verification_failed",
  handle: { id: "route-1" },
  recovery,
  ...over,
});
const withOperation = (operation: unknown) => ok({ routes: [], reasons: {}, starting: false, services: [], operations: [operation] });

test("where the host says recovery is available, Try again resumes the same operation and starts no new one", async () => {
  const handler = host({
    "/state": withOperation(failedOp({ available: true, reason: "route_reconciliation_required" })),
    "/operations/op-1/reconcile": ok({ cleanup: { state: "none" } }),
    "/operations/op-1": ok(failedOp(null)),
  });
  await withScreen(handler, async ({ calls, press, text }) => {
    assert.match(text(), /Needs your action/);
    await press(/^Try again$/);
    const resumed = calls.filter((call) => call.url === "/operations/op-1/reconcile");
    assert.deepEqual(resumed.map((call) => call.body), [{ action: "check", acknowledgeDisconnect: true }]);
    assert.ok(!calls.some((call) => call.url === "/operations"), "no second operation id");
    assert.ok(!calls.some((call) => call.url.endsWith("/stop")));
  });
});

test("where the host does not say a retry is safe, only Check and turn off is offered", async () => {
  for (const operation of [failedOp(null), failedOp({ available: false, reason: "public_operation_recovery_unavailable" })]) {
    await withScreen(host({ "/state": withOperation(operation) }), async ({ container }) => {
      const labels = [...container.querySelectorAll("button")].map((node) => node.textContent);
      assert.ok(labels.includes("Check and turn off"), labels.join(","));
      assert.ok(!labels.includes("Try again"), labels.join(","));
    });
  }
});

// ---------- no fixed lifetime in any user string ----------

test("no source string the owner can read states a fixed lifetime", () => {
  const dir = new URL(".", import.meta.url);
  const files = ["remote-access-setting.tsx", "on-card.tsx", "turn-on.tsx", "route-display.ts", "prepare-remote-access.ts", "reachability-consent.tsx"];
  const claim = /\b\d+\s*(?:seconds?|minutes?|hours?|days?)\b|\b(?:an?|one) (?:hour|minute)\b|\blifetime\b/i;
  const found: string[] = [];
  for (const file of files) {
    const source = ts.createSourceFile(file, readFileSync(new URL(file, dir), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (node: ts.Node) => {
      const text = ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node) ? node.text : ts.isJsxText(node) ? node.text : "";
      if (text && !/ ago$/.test(text) && claim.test(text)) found.push(`${file}: ${text}`);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  assert.deepEqual(found, []);
});

test("distinct one-second proof windows stay rate bounded over thirty seconds", async (t) => {
  let route = routeAt({ observedAt: T0, validUntil: T0 + 1_000 });
  const pending: Array<() => void> = [];
  const handler = host({
    "/state": () => onState(route),
    "/routes/route-1/check": () => new Promise<Result>((resolve) => {
      pending.push(() => {
        route = routeAt({ observedAt: Date.now(), validUntil: Date.now() + 1_000 });
        resolve(ok(route));
      });
    }),
  });
  await withScreen(handler, async ({ calls, tick }) => {
    for (let elapsed = 1_000; elapsed <= 30_000; elapsed += 1_000) {
      await tick(1_000);
      assert.ok(checks(calls).length <= Math.floor(elapsed / 2_000), "no faster than one check per two seconds");
      await act(async () => {
        for (const finish of pending.splice(0)) finish();
      });
    }
    assert.ok(checks(calls).length >= 5, "renewal actually continues across distinct windows");
  }, t);
});

// An unidentified route must never borrow identity from the catalog selection.
for (const providerId of ["localhost-run", "cloudflare-named"]) {
  test(`live-route facts remain unfiltered when the catalog selects ${providerId}`, async (t) => {
    const line = "the plan limits a session to 15 minutes";
    const live = routeAt({
      providerId: null,
      facts: [{ ...fact("address conditions", line), group: "address", affectsConsent: false }],
    });
    const selectedCatalog = {
      ...catalog,
      providers: [{ ...provider, providerId }],
    };
    await withScreen(host({
      "/catalog": ok(selectedCatalog),
      "/state": onState(live),
    }), async ({ container, calls }) => {
      assert.ok(calls.some((call) => call.url === "/catalog"));
      const address = container.querySelector("[aria-label='Your address']");
      assert.ok(address, "the live route is mounted");
      assert.ok(
        [...address.querySelectorAll("dd")].some((node) => node.textContent === line),
        "an unidentified route keeps its own condition, regardless of the selected way"
      );
    }, t);
  });
}

test("live localhost.run facts use the creating provider, not the selected way", async (t) => {
  const line = "the plan limits a session to 15 minutes";
  const retained = "Another provider condition";
  const live = routeAt({
    providerId: "localhost-run",
    facts: [line, retained].map((value, index) => ({
      ...fact("address condition " + index, value), group: "address", affectsConsent: false,
    })),
  });
  await withScreen(host({
    "/catalog": ok({ ...catalog, providers: [{ ...provider, providerId: "cloudflare-named" }] }),
    "/state": onState(live),
  }), async ({ container }) => {
    const address = container.querySelector("[aria-label='Your address']");
    assert.ok(address, "the live route is mounted");
    const values = [...address.querySelectorAll("dd")].map((node) => node.textContent);
    assert.ok(!values.includes(line), "known-false localhost.run condition is removed");
    assert.ok(values.includes(retained), "other route facts remain visible");
  }, t);
});
