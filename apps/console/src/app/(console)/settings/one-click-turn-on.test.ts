// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
// One-click Turn on: the preparation chain, setup actions with effects, the
// review that the click approves, and the Cancel paths.
import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { JSDOM } from "jsdom";
import * as React from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { type Action, hasEffects, operationOutcome, prepareTurnOn } from "./prepare-remote-access.ts";
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

const fact = (id: string, value: string) => ({ id, group: "cost", label: id, known: true, value, source: "provider", asOf: null });
const candidate = (digest: string, facts = [fact("Cost", "free")], expiresAt = "2999-01-01T00:00:00.000Z") => ({
  providerId: "p-tunnel",
  display: { label: "Tunnel service", description: "", needs: "" },
  consentFactsDigest: digest,
  expiresAt,
  eligible: true,
  facts,
  consent: {
    consentFactsDigest: digest,
    scope: {
      kind: "route",
      query: { target: "127.0.0.1:37807", expectedOrigin: null, usage: { kind: "session", lifetimeMs: 3_600_000 } },
    },
    facts,
    disclosures: {
      traffic: { providerCanReadPayload: true },
      cost: { kind: "free", summary: "Free" },
      address: { stability: "ephemeral" },
    },
  },
});
const review = (id: string, digest: string, facts?: ReturnType<typeof fact>[], expiresAt?: string) => ({
  id,
  kind: "route",
  candidate: candidate(digest, facts, expiresAt),
});
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
const action = (over: Record<string, unknown> = {}) => ({
  id: "act-1",
  kind: "gozar-runs",
  label: "Check the SSH client",
  digest: "act-digest",
  disclosure: { revision: "1", text: "", links: [] },
  consent: {
    consentFactsDigest: "act-facts",
    facts: [],
    disclosures: { action: {} },
    scope: { kind: "setup", actionId: "act-1", actionDigest: "act-digest", disclosureRevision: "1" },
  },
  ...over,
});
const draftWith = (actions: unknown[] = [], inputRequirements: unknown[] = []) => ({
  draftId: "d-1",
  configuration: { revision: "r2", actions, inputRequirements, values: {}, credentials: {} },
});
const none = { writes: [], networkOrigins: [], requiresPrivilege: false, restartRequired: false };

// ---------- the chain ----------

function recorder(table: Record<string, Result | ((call: Call) => Result)>) {
  const calls: Call[] = [];
  const request = (async (url: string, body?: Record<string, unknown>) => {
    const call = { url, ...(body ? { body } : {}) };
    calls.push(call);
    const hit = table[url.split("?")[0]!];
    if (!hit) return fail("route_not_found");
    return typeof hit === "function" ? hit(call) : hit;
  }) as unknown as typeof requestReachability;
  return { request, calls, urls: () => calls.map((item) => item.url.split("?")[0]) };
}
const choice = { providerId: "p-tunnel", usage: "session" };
const baseTable = {
  "/catalog": ok(catalog),
  "/state": ok({ routes: [], reasons: {}, starting: false, services: [] }),
  "/drafts": ok(draftWith()),
  "/drafts/d-1/commit": ok(draftWith().configuration),
  "/drafts/d-1/review": ok(review("rev-1", "digest-1")),
};

test("the chain runs inventory, draft, commit, review in order and never applies or approves", async () => {
  const { request, urls } = recorder(baseTable);
  const result = await prepareTurnOn(request, choice);
  assert.equal(result.kind, "ready");
  assert.deepEqual(urls(), ["/catalog", "/state", "/drafts", "/drafts/d-1/commit", "/drafts/d-1/review"]);
  assert.ok(!urls().some((url) => url?.startsWith("/operations") || url?.includes("/approve") || url?.includes("/stop")));
});

test("the chain reuses the service's draft by id and skips the commit when it is committed", async () => {
  const services = [{ providerId: "p-tunnel", providerLabel: "T", draftId: "d-1", usage: "session", committed: true, setup: null }];
  const { request, urls } = recorder({
    ...baseTable,
    "/state": ok({ routes: [], reasons: {}, starting: false, services }),
    "/drafts/d-1": ok(draftWith()),
  });
  await prepareTurnOn(request, choice);
  assert.deepEqual(urls(), ["/catalog", "/state", "/drafts/d-1", "/drafts/d-1/review"]);
});

test("the chain stops at a sign-in step and does not commit", async () => {
  const step = action({ kind: "open-url", step: { actor: "owner", permission: { id: "p", label: "p" }, verification: "provider", purpose: "authorize" } });
  const { request, urls } = recorder({ ...baseTable, "/drafts": ok(draftWith([step])) });
  const result = await prepareTurnOn(request, choice);
  assert.equal(result.kind, "sign-in");
  assert.deepEqual(urls(), ["/catalog", "/state", "/drafts"]);
});

test("the chain waits while the service's own setup is open", async () => {
  const services = [
    { providerId: "p-tunnel", providerLabel: "T", draftId: "d-1", usage: "session", committed: false, setup: { operationId: "op", actionId: "a", expectedConfigurationRevision: "r" } },
  ];
  const { request, urls } = recorder({
    ...baseTable,
    "/state": ok({ routes: [], reasons: {}, starting: false, services }),
    "/drafts/d-1": ok(draftWith()),
    "/setup-operations/op": ok({ state: "pending" }),
  });
  const result = await prepareTurnOn(request, choice);
  assert.equal(result.kind, "setup-pending");
  assert.ok(!urls().includes("/drafts/d-1/commit"));
});

test("a setup action with effects waits for Allow; the chain runs nothing", async () => {
  for (const effectful of [
    action({ kind: "install-artifact", effects: { ...none, writes: ["/opt/x"] }, artifact: { url: "https://x.invalid/a", sha256: "s", platform: "linux", architecture: "x64" } }),
    action({ effects: { ...none, requiresPrivilege: true } }),
    action({ effects: { ...none, networkOrigins: ["https://x.invalid"] } }),
  ]) {
    const { request, urls } = recorder({ ...baseTable, "/drafts": ok(draftWith([effectful])) });
    const result = await prepareTurnOn(request, choice);
    assert.equal(result.kind, "allow");
    assert.ok(!urls().some((url) => url?.includes("/actions/") || url?.includes("/commit")), `ran ${urls().join(",")}`);
  }
});

test("an action that declares no effects runs on its own, then the chain goes on", async () => {
  const quiet = action({ effects: none });
  const { request, urls, calls } = recorder({
    ...baseTable,
    "/drafts": ok(draftWith([quiet])),
    "/drafts/d-1/actions/act-1": ok(draftWith().configuration),
  });
  const result = await prepareTurnOn(request, choice);
  assert.equal(result.kind, "ready");
  assert.deepEqual(urls(), ["/catalog", "/state", "/drafts", "/drafts/d-1/actions/act-1", "/drafts/d-1/commit", "/drafts/d-1/review"]);
  const sent = calls.find((item) => item.url.includes("/actions/"))!.body!;
  assert.deepEqual(sent.approval, { kind: "setup", digest: "act-digest", disclosureRevision: "1", consentFactsDigest: "act-facts" });
});

test("when the library does not say whether an action has effects, it counts as having effects", () => {
  assert.equal(hasEffects(action() as unknown as Action), true, "no effects field");
  assert.equal(hasEffects(action({ kind: "instructions", effects: none }) as unknown as Action), true, "a step the owner does");
  assert.equal(hasEffects(action({ effects: none }) as unknown as Action, true), true, "it needs input");
  assert.equal(hasEffects(action({ effects: none }) as unknown as Action), false, "declared empty");
  const { request, urls } = recorder({ ...baseTable, "/drafts": ok(draftWith([action()])) });
  return prepareTurnOn(request, choice).then((result) => {
    assert.equal(result.kind, "allow");
    assert.ok(!urls().some((url) => url?.includes("/actions/")));
  });
});

test("a draft the host no longer holds restarts the chain once from a new draft", async () => {
  let reviews = 0;
  const { request, urls } = recorder({
    ...baseTable,
    "/drafts/d-1/review": () => (++reviews === 1 ? fail("draft_not_found") : ok(review("rev-2", "digest-1"))),
    "/drafts/d-1/discard": ok({ discarded: true }),
  });
  const result = await prepareTurnOn(request, choice);
  assert.equal(result.kind, "ready");
  assert.ok(urls().includes("/drafts/d-1/discard"));
});

test("a finished operation reads as Off only when it failed before any effect", () => {
  assert.equal(operationOutcome({ stage: "settled", failureCode: "provider_unavailable", handle: null }), "did-not-turn-on");
  assert.equal(operationOutcome({ stage: "settled", failureCode: "provider_unavailable", handle: { id: "r" } }), "needs-action");
  assert.equal(operationOutcome({ stage: "settled", failureCode: "verification_failed", handle: null }), "needs-action");
  assert.equal(operationOutcome({ stage: "settled", failureCode: "reachability_unavailable", handle: null }), "needs-action");
  assert.equal(operationOutcome({ stage: "unknown-possibly-live" }), "needs-action");
  assert.equal(operationOutcome({ stage: "applying" }), "turning-on");
  assert.equal(operationOutcome({ stage: "settled" }), "done");
});

// ---------- the screen ----------

type Handler = (call: Call) => Result | Promise<Result>;
async function withScreen<T>(
  handler: Handler,
  run: (screen: {
    container: Element;
    calls: Call[];
    press: (label: RegExp) => Promise<void>;
    settle: () => Promise<void>;
    text: () => string;
  }) => Promise<T>
): Promise<T> {
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
      settle,
      text: () => container.textContent ?? "",
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

const idleState = { routes: [], reasons: {}, starting: false, services: [] };
function host(over: Record<string, Result | ((call: Call) => Result)> = {}): Handler {
  const table: Record<string, Result | ((call: Call) => Result)> = {
    "/catalog": ok(catalog),
    "/state": ok(idleState),
    "/host-settings": ok({ known: false, reason: "unavailable" }),
    "/host-capabilities": ok({}),
    "/drafts": ok(draftWith()),
    "/drafts/d-1/commit": ok(draftWith().configuration),
    "/drafts/d-1/review": ok(review("rev-1", "digest-1")),
    ...over,
  };
  return (call) => {
    const hit = table[call.url.split("?")[0]!];
    if (!hit) return fail("route_not_found");
    return typeof hit === "function" ? hit(call) : hit;
  };
}
const approvals = (calls: Call[]) => calls.filter((call) => call.url === "/operations");

test("opening step 2 prepares a review without applying anything", async () => {
  await withScreen(host(), async ({ calls, text }) => {
    assert.match(text(), /Turn on remote access/);
    assert.deepEqual(approvals(calls), []);
    assert.ok(!calls.some((call) => call.url.includes("/approve") || call.url.includes("/stop")));
  });
});

test("the Turn on click sends the review id and digest whose facts are on screen", async () => {
  await withScreen(host({ "/operations": ok({ operationId: "op-1" }) }), async ({ calls, press, text }) => {
    assert.match(text(), /Tunnel service can see what passes through\./);
    await press(/^Turn on remote access$/);
    assert.deepEqual(approvals(calls).map((call) => call.body), [
      { reviewId: "rev-1", kind: "route", consentFactsDigest: "digest-1", acknowledgeDisconnect: true },
    ]);
  });
});

test("a new review with the same facts replaces the shown one silently, and the click uses it", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let reviews = 0;
  const handler = host({
    "/drafts/d-1/review": () =>
      ++reviews === 1 ? ok(review("rev-1", "digest-1", undefined, "2000-01-01T00:00:00.000Z")) : ok(review("rev-2", "digest-1")),
    "/operations": ok({ operationId: "op-1" }),
  });
  await withScreen(handler, async ({ calls, press, text, container, settle }) => {
    await act(async () => t.mock.timers.tick(1000));
    await settle();
    assert.equal(reviews, 2, "the expired review ran again");
    assert.doesNotMatch(text(), /changed/);
    const button = [...container.querySelectorAll("button")].find((node) => node.textContent === "Turn on remote access")!;
    assert.equal(button.disabled, false);
    await press(/^Turn on remote access$/);
    assert.deepEqual(approvals(calls).map((call) => call.body?.reviewId), ["rev-2"]);
    assert.deepEqual(approvals(calls).map((call) => call.body?.consentFactsDigest), ["digest-1"]);
  });
});

test("changed facts show what changed and need a new click on the new facts", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let reviews = 0;
  const handler = host({
    "/drafts/d-1/review": () =>
      ++reviews === 1
        ? ok(review("rev-1", "digest-1", [fact("Cost", "free")], "2000-01-01T00:00:00.000Z"))
        : ok(review("rev-2", "digest-2", [fact("Cost", "paid")])),
    "/operations": ok({ operationId: "op-1" }),
  });
  await withScreen(handler, async ({ calls, press, text, settle }) => {
    await act(async () => t.mock.timers.tick(1000));
    await settle();
    assert.match(text(), /Details of this connection changed: Cost\./);
    assert.deepEqual(approvals(calls), [], "nothing is approved without a click");
    await press(/^Turn on remote access$/);
    assert.deepEqual(approvals(calls).map((call) => [call.body?.reviewId, call.body?.consentFactsDigest]), [["rev-2", "digest-2"]]);
  });
});

test("a click on an expired review refreshes it first and never sends the old digest for new facts", async () => {
  let reviews = 0;
  const handler = host({
    "/drafts/d-1/review": () =>
      ++reviews === 1
        ? ok(review("rev-1", "digest-1", [fact("Cost", "free")], "2000-01-01T00:00:00.000Z"))
        : ok(review("rev-2", "digest-2", [fact("Cost", "paid")])),
    "/operations": ok({ operationId: "op-1" }),
  });
  await withScreen(handler, async ({ calls, press, text }) => {
    await press(/^Turn on remote access$/);
    assert.deepEqual(approvals(calls), [], "the facts changed, so the click approves nothing");
    assert.match(text(), /Details of this connection changed: Cost\./);
  });
});

test("a click on an expired review with the same facts approves the new id with the shown digest", async () => {
  let reviews = 0;
  const handler = host({
    "/drafts/d-1/review": () =>
      ++reviews === 1 ? ok(review("rev-1", "digest-1", undefined, "2000-01-01T00:00:00.000Z")) : ok(review("rev-2", "digest-1")),
    "/operations": ok({ operationId: "op-1" }),
  });
  await withScreen(handler, async ({ calls, press }) => {
    await press(/^Turn on remote access$/);
    assert.deepEqual(approvals(calls).map((call) => [call.body?.reviewId, call.body?.consentFactsDigest]), [["rev-2", "digest-1"]]);
  });
});

test("the host refusing an expired review gets one silent retry on the new review", async () => {
  let reviews = 0;
  let sends = 0;
  const handler = host({
    "/drafts/d-1/review": () => (++reviews === 1 ? ok(review("rev-1", "digest-1")) : ok(review("rev-2", "digest-1"))),
    "/operations": () => (++sends === 1 ? fail("consent_expired") : ok({ operationId: "op-1" })),
  });
  await withScreen(handler, async ({ calls, press, text }) => {
    await press(/^Turn on remote access$/);
    assert.deepEqual(approvals(calls).map((call) => call.body?.reviewId), ["rev-1", "rev-2"]);
    assert.doesNotMatch(text(), /couldn.t turn on/);
  });
});

test("an effectful setup action waits for Allow, and Allow runs it with its own approval", async () => {
  const effectful = action({ effects: { ...none, writes: ["/opt/x"] } });
  let allowed = false;
  const handler = host({
    "/drafts": () => ok(draftWith(allowed ? [] : [effectful])),
    "/drafts/d-1/actions/act-1": () => {
      allowed = true;
      return ok(draftWith().configuration);
    },
  });
  await withScreen(handler, async ({ calls, press, text }) => {
    assert.match(text(), /Check the SSH client/);
    assert.match(text(), /Changes \/opt\/x\./);
    assert.ok(!calls.some((call) => call.url.includes("/actions/")), "nothing ran before Allow");
    assert.match(text(), /Choose another way/);
    await press(/^Allow$/);
    assert.ok(calls.some((call) => call.url === "/drafts/d-1/actions/act-1"));
    assert.match(text(), /Turn on remote access/);
  });
});

test("Choose another way drops the step without running it", async () => {
  const effectful = action({ effects: { ...none, requiresPrivilege: true } });
  await withScreen(host({ "/drafts": ok(draftWith([effectful])) }), async ({ calls, press, text }) => {
    await press(/^Choose another way$/);
    assert.ok(!calls.some((call) => call.url.includes("/actions/")));
    assert.doesNotMatch(text(), /Check the SSH client/);
    assert.match(text(), /Other ways/);
  });
});

test("a failed preparation says so and Try again runs it again", async () => {
  let drafts = 0;
  const handler = host({ "/drafts": () => (++drafts === 1 ? fail("brand_new_server_code") : ok(draftWith())) });
  await withScreen(handler, async ({ press, text, container }) => {
    assert.match(text(), /Remote access couldn.t turn on\. Try again/);
    assert.ok(container.querySelector("[role=alert] [data-diagnostics]")!.textContent!.includes("brand_new_server_code"));
    await press(/^Try again$/);
    assert.match(text(), /Turn on remote access/);
  });
});

// ---------- Turning on, Cancel, failures ----------

const applying = (operationId = "op-1") => ({ operationId, stage: "applying", kind: "start", failureCode: null, recovery: null });
const turningOn = (over: Record<string, unknown> = {}) =>
  ok({ routes: [], reasons: {}, starting: false, services: [], lifecycle: { handle: null, phase: "applying", confinement: { known: false }, cleanup: "none", stopRequested: false }, operations: [applying()], ...over });

test("Turning on shows the three steps in place of the operation card", async () => {
  await withScreen(host({ "/state": turningOn() }), async ({ text }) => {
    assert.match(text(), /Turning on/);
    assert.match(text(), /Checked this computer/);
    assert.match(text(), /Connecting to Tunnel service/);
    assert.match(text(), /Checking it works from the internet/);
    assert.doesNotMatch(text(), /Working on it|Check again|Turn on remote access/);
  });
});

test("Cancel records a stop, says Turning off, and shows Off only after cleanup is confirmed", async () => {
  let confirmed = false;
  let stops = 0;
  const handler = host({
    "/state": () => (confirmed ? ok(idleState) : turningOn()),
    "/operations/op-1/reconcile": () => {
      stops += 1;
      confirmed = true;
      return ok({ cleanup: { state: "confirmed" } });
    },
  });
  await withScreen(handler, async ({ calls, press, text }) => {
    await press(/^Cancel$/);
    const stop = calls.find((call) => call.url === "/operations/op-1/reconcile")!;
    assert.deepEqual(stop.body, { action: "stop", acknowledgeDisconnect: true });
    assert.equal(stops, 1);
    assert.match(text(), /Off · Only this computer can open DataConnect\./);
    assert.doesNotMatch(text(), /Needs your action/);
  });
});

test("Cancel with cleanup not confirmed is Needs your action, never Off, and Try again resumes the same operation", async () => {
  const handler = host({
    "/state": turningOn(),
    "/operations/op-1/reconcile": ok({ cleanup: { state: "unconfirmed" } }),
  });
  await withScreen(handler, async ({ calls, press, text }) => {
    await press(/^Cancel$/);
    assert.match(text(), /Needs your action/);
    assert.match(text(), /Couldn't confirm remote access is off\. This address may still work\./);
    assert.doesNotMatch(text(), /Off · Only this computer/);
    await press(/^Check and turn off$/);
    const stops = calls.filter((call) => call.url === "/operations/op-1/reconcile");
    assert.equal(stops.length, 2);
    assert.ok(!calls.some((call) => call.url === "/operations"), "no second operation started");
  });
});

test("Cancel that the host refuses is Needs your action, never Off", async () => {
  const handler = host({ "/state": turningOn(), "/operations/op-1/reconcile": fail("brand_new_server_code") });
  await withScreen(handler, async ({ press, text }) => {
    await press(/^Cancel$/);
    assert.match(text(), /Needs your action/);
    assert.match(text(), /This address may still work/);
  });
});

test("a failure before any effect says remote access did not turn on and offers Try again", async () => {
  const failed = { operationId: "op-1", stage: "settled", kind: "start", failureCode: "provider_unavailable", handle: null, recovery: null };
  await withScreen(host({ "/state": ok({ ...idleState, operations: [failed] }) }), async ({ text, press }) => {
    assert.match(text(), /Remote access did not turn on/);
    await press(/^Try again$/);
  });
});

test("a failure after an effect, or an uncertain one, is Needs your action and never Off", async () => {
  const uncertain = { operationId: "op-1", stage: "unknown-possibly-live", kind: "start", failureCode: null, handle: null, recovery: { available: true, reason: "route_reconciliation_required" } };
  const afterEffect = { operationId: "op-1", stage: "settled", kind: "start", failureCode: "verification_failed", handle: { id: "r" }, recovery: null };
  for (const operation of [uncertain, afterEffect]) {
    await withScreen(host({ "/state": ok({ ...idleState, operations: [operation] }) }), async ({ text }) => {
      assert.match(text(), /Needs your action/);
      assert.doesNotMatch(text(), /did not turn on|Off · Only this computer/);
      assert.match(text(), /Check and turn off/);
    });
  }
});

// ---------- no positive action without a password ----------

const positive = (call: Call) =>
  call.url === "/operations" ||
  call.url.includes("/actions/") ||
  call.url.includes("/commit") ||
  call.url === "/drafts" ||
  call.url.startsWith("/setups");

test("with no password, a saved draft and its setup action cannot be approved or run", async () => {
  const effectful = action({ effects: { ...none, writes: ["/opt/x"] } });
  const services = [{ providerId: "p-tunnel", providerLabel: "Tunnel service", draftId: "d-1", usage: "session", committed: false, setup: null }];
  const handler = host({
    "/state": ok({ ...idleState, passwordSet: false, services }),
    "/drafts/d-1": ok(draftWith([effectful])),
  });
  await withScreen(handler, async ({ calls, text, container }) => {
    assert.match(text(), /Step 1: Set a password/);
    assert.ok(!calls.some(positive), `ran ${calls.filter(positive).map((call) => call.url).join(",")}`);
    const labels = [...container.querySelectorAll("button")].map((node) => node.textContent);
    assert.ok(!labels.some((label) => /Allow|Turn on remote access|Approve|Save and review/.test(label ?? "")), labels.join(","));
    assert.equal(container.querySelector('[aria-label="Setup approval"]'), null);
  });
});

test("an open review cannot be approved once the password is reported missing", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let passwordSet = true;
  const handler = host({
    "/state": () => ok({ ...idleState, passwordSet }),
    "/operations": ok({ operationId: "op-1" }),
  });
  await withScreen(handler, async ({ calls, text, container, settle }) => {
    assert.match(text(), /Turn on remote access/);
    passwordSet = false;
    await act(async () => t.mock.timers.tick(3000));
    await settle();
    assert.match(text(), /Step 1: Set a password/);
    const labels = [...container.querySelectorAll("button")].map((node) => node.textContent);
    assert.ok(!labels.includes("Turn on remote access"));
    assert.deepEqual(approvals(calls), []);
  });
});

test("with no password the chain runs no setup action, even one that declares no effects", async () => {
  const quiet = action({ effects: none });
  const { request, urls } = recorder({ ...baseTable, "/drafts": ok(draftWith([quiet])) });
  const result = await prepareTurnOn(request, choice, { mayRunActions: () => false });
  assert.equal(result.kind, "allow");
  assert.ok(!urls().some((url) => url?.includes("/actions/") || url?.includes("/commit")));
});

test("with no password, Cancel and Turn off stay available", async () => {
  const handler = host({
    "/state": turningOn({ passwordSet: false }),
    "/operations/op-1/reconcile": ok({ cleanup: { state: "confirmed" } }),
  });
  await withScreen(handler, async ({ calls, press }) => {
    await press(/^Cancel$/);
    assert.ok(calls.some((call) => call.url === "/operations/op-1/reconcile"));
  });
});
