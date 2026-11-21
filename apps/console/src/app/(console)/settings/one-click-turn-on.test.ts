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
import { type Action, type FactLine, MAX_PREPARATION_RESTARTS, PreparationStopped, hasEffects, operationOutcome, prepareTurnOn, shortFactLines } from "./prepare-remote-access.ts";
import type { requestReachability } from "./reachability-client.ts";
import { publicError } from "./reachability-errors.ts";
import { trialConsentAction } from "./real-gozar-shapes.fixture.ts";

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

// Real shape: the temporary address's only setup action is an owner step that the route approval satisfies.
// The host refuses to run it (an `instructions` step has no run), so the chain must not stop on it.
test("the temporary address's trial-consent step does not stop the chain; its facts travel with the review", async () => {
  const { request, urls } = recorder({ ...baseTable, "/drafts": ok(draftWith([trialConsentAction])) });
  const result = await prepareTurnOn(request, choice);
  assert.equal(result.kind, "ready");
  assert.deepEqual(urls(), ["/catalog", "/state", "/drafts", "/drafts/d-1/commit", "/drafts/d-1/review"]);
  assert.deepEqual(result.kind === "ready" ? result.steps.map((step) => step.id) : [], ["trial-consent"]);
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

test("a blocked setup that holds nothing is cancelled, and the chain goes on", async () => {
  const services = [
    { providerId: "p-tunnel", providerLabel: "T", draftId: "d-1", usage: "session", committed: false, setup: { operationId: "op", actionId: "a", expectedConfigurationRevision: "r" } },
  ];
  const { request, urls } = recorder({
    ...baseTable,
    "/state": ok({ routes: [], reasons: {}, starting: false, services }),
    "/drafts/d-1": ok(draftWith()),
    "/setup-operations/op": ok({ state: "blocked" }),
    "/setup-operations/op/cancel": ok({ state: "cancelled", resources: [] }),
  });
  const result = await prepareTurnOn(request, choice);
  assert.equal(result.kind, "ready");
  assert.ok(urls().includes("/setup-operations/op/cancel"));
});

test("a blocked setup that still holds a resource is shown as pending, never dropped", async () => {
  const services = [
    { providerId: "p-tunnel", providerLabel: "T", draftId: "d-1", usage: "session", committed: false, setup: { operationId: "op", actionId: "a", expectedConfigurationRevision: "r" } },
  ];
  const { request, urls } = recorder({
    ...baseTable,
    "/state": ok({ routes: [], reasons: {}, starting: false, services }),
    "/drafts/d-1": ok(draftWith()),
    "/setup-operations/op": ok({ state: "blocked" }),
    "/setup-operations/op/cancel": ok({ state: "cancelled", resources: [{ removal: "required" }] }),
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

test("an input the draft already holds is not asked for again; the next input is", async () => {
  const secret = action({ id: "act-secret", kind: "provide-secret" });
  const label = action({ id: "act-label", kind: "provide-value" });
  const fields = [
    { actionId: "act-secret", id: "act-secret", label: "Credential", secret: true },
    { actionId: "act-label", id: "act-label", label: "Label", secret: false },
  ];
  const held = (credentials: Record<string, unknown>, values: Record<string, unknown>) => ({
    draftId: "d-1",
    configuration: { revision: "r2", actions: [secret, label], inputRequirements: fields, values, credentials },
  });
  const next = async (credentials: Record<string, unknown>, values: Record<string, unknown> = {}) => {
    const { request } = recorder({ ...baseTable, "/drafts": ok(held(credentials, values)) });
    return prepareTurnOn(request, choice);
  };
  const first = await next({});
  assert.equal(first.kind === "allow" && first.action.id, "act-secret");
  const second = await next({ "act-secret": { known: true, value: true } });
  assert.equal(second.kind === "allow" && second.action.id, "act-label");
  const done = await next({ "act-secret": { known: true, value: true } }, { "act-label": "x" });
  assert.equal(done.kind, "ready");
  const forget = action({ id: "act-forget", kind: "clear-input", label: "Forget configured input" });
  const { request: withForget } = recorder({
    ...baseTable,
    "/drafts": ok({ draftId: "d-1", configuration: { revision: "r2", actions: [secret, forget, label], inputRequirements: fields, values: { "act-label": "x" }, credentials: { "act-secret": { known: true, value: true } } } }),
  });
  assert.equal((await prepareTurnOn(withForget, choice)).kind, "ready");
  const unknown = await next({ "act-secret": { known: false, reason: "locked" } });
  assert.equal(unknown.kind === "allow" && unknown.action.id, "act-secret");
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

test("a draft the host no longer holds restarts the chain from a new draft without discarding it", async () => {
  let reviews = 0;
  const { request, urls } = recorder({
    ...baseTable,
    "/drafts/d-1/review": () => (++reviews === 1 ? fail("draft_not_found") : ok(review("rev-2", "digest-1"))),
    "/drafts/d-1/discard-if-stale": ok({ discarded: true }),
  });
  const result = await prepareTurnOn(request, choice);
  assert.equal(result.kind, "ready");
  assert.ok(!urls().includes("/drafts/d-1/discard-if-stale"), "the host's state does not name this draft, so it is not ours to drop");
});

test("a draft another preparer committed is not discarded by a restart", async () => {
  const committed = [{ providerId: "p-tunnel", providerLabel: "T", draftId: "d-1", usage: "session", committed: true, setup: null }];
  let commits = 0;
  const { request, urls } = recorder({
    ...baseTable,
    "/state": () => ok({ routes: [], reasons: {}, starting: false, services: commits > 0 ? committed : [] }),
    "/drafts/d-1/commit": () => (++commits === 1 ? fail("configuration_stale") : ok(draftWith().configuration)),
    "/drafts/d-1": ok(draftWith()),
    "/drafts/d-1/discard-if-stale": ok({ discarded: true }),
  });
  const result = await prepareTurnOn(request, choice);
  assert.equal(result.kind, "ready");
  assert.ok(!urls().includes("/drafts/d-1/discard-if-stale"));
});

test("an uncommitted draft the host still names is discarded once when it is stale, so the restart starts fresh", async () => {
  const uncommitted = [{ providerId: "p-tunnel", providerLabel: "T", draftId: "d-1", usage: "session", committed: false, setup: null }];
  let discarded = false;
  let commits = 0;
  const { request, urls } = recorder({
    ...baseTable,
    "/state": () => ok({ routes: [], reasons: {}, starting: false, services: discarded ? [] : uncommitted }),
    "/drafts/d-1": ok(draftWith()),
    "/drafts/d-1/commit": () => (++commits === 1 ? fail("configuration_stale") : ok(draftWith().configuration)),
    "/drafts/d-1/discard-if-stale": () => {
      discarded = true;
      return ok({ discarded: true });
    },
  });
  const result = await prepareTurnOn(request, choice);
  assert.equal(result.kind, "ready");
  assert.equal(urls().filter((url) => url === "/drafts/d-1/discard-if-stale").length, 1);
});

test("a declined stale discard re-reads the winner's committed state", async () => {
  let committed = false;
  const entry = () => [{ providerId: "p-tunnel", providerLabel: "T", draftId: "d-1", usage: "session", committed, setup: null }];
  const { request, urls } = recorder({
    ...baseTable,
    "/state": () => ok({ routes: [], reasons: {}, starting: false, services: entry() }),
    "/drafts/d-1": ok(draftWith()),
    "/drafts/d-1/commit": fail("configuration_stale"),
    "/drafts/d-1/discard-if-stale": ({ body }) => {
      assert.equal(body?.revision, draftWith().configuration.revision);
      committed = true;
      return ok({ discarded: false, reason: "committed" });
    },
  });
  assert.equal((await prepareTurnOn(request, choice)).kind, "ready");
  assert.equal(urls().filter(url => url === "/drafts/d-1/discard-if-stale").length, 1);
  assert.equal(urls().filter(url => url === "/drafts/d-1/commit").length, 1);
});

test("restarts are bounded: a host that always answers stale ends in the failure", async () => {
  const { request, urls } = recorder({ ...baseTable, "/drafts/d-1/commit": fail("configuration_stale") });
  await assert.rejects(prepareTurnOn(request, choice), (failure: { detail?: { code?: string } }) => failure.detail?.code === "configuration_stale");
  assert.equal(urls().filter((url) => url === "/drafts/d-1/commit").length, MAX_PREPARATION_RESTARTS + 1);
});

test("a finished operation reads as Off only when it failed before any effect", () => {
  assert.equal(operationOutcome({ stage: "settled", failureCode: "provider_unavailable", handle: null }), "did-not-turn-on");
  assert.equal(operationOutcome({ stage: "settled", failureCode: "provider_unavailable", handle: { id: "r" } }), "needs-action");
  // A refusal the host settled with its cleanup confirmed left nothing live.
  assert.equal(operationOutcome({ stage: "settled", failureCode: "consent_mismatch", handle: { id: "r" }, cleanupConfirmed: true }), "did-not-turn-on");
  assert.equal(operationOutcome({ stage: "settled", failureCode: "route_conflict", handle: { id: "r" }, cleanupConfirmed: true }), "needs-action");
  assert.equal(operationOutcome({ stage: "settled", failureCode: "verification_failed", handle: null }), "needs-action");
  assert.equal(operationOutcome({ stage: "settled", failureCode: "reachability_unavailable", handle: null }), "needs-action");
  assert.equal(operationOutcome({ stage: "unknown-possibly-live" }), "needs-action");
  assert.equal(operationOutcome({ stage: "applying" }), "turning-on");
  assert.equal(operationOutcome({ stage: "settled" }), "done");
});

// ---------- one line per kind ----------

test("one line per kind: the sign-in line, the payload reading, the deal fragments joined; a missing kind fails closed", () => {
  const lines: FactLine[] = [
    { kind: "access", text: "People who open the address must sign in with your password. Apps also need your permission." },
    { kind: "access", text: "People can reach the sign-in page over the internet." },
    { kind: "traffic", text: "These can read your traffic: localhost relay." },
    { kind: "traffic", text: "Workshop can see what passes through." },
    { kind: "deal", text: "Free." },
    { kind: "deal", text: "The address changes each time." },
    { kind: "deal", text: "Turns off by itself." },
  ];
  const short = shortFactLines(lines);
  assert.ok(short, "every kind has a line");
  assert.deepEqual(short.shown.map((line) => [line.kind, line.text]), [
    ["access", "People who open the address must sign in with your password. Apps also need your permission."],
    ["traffic", "Workshop can see what passes through."],
    ["deal", "Free. The address changes each time and turns off by itself."],
  ]);
  assert.deepEqual(short.rest.map((line) => line.text), [
    "People can reach the sign-in page over the internet.",
    "These can read your traffic: localhost relay.",
  ]);
  // Every other line stays above the button when a kind has no line: fail closed.
  for (const kind of ["access", "traffic", "deal"] as const) {
    assert.equal(shortFactLines(lines.filter((line) => line.kind !== kind)), null, `no ${kind} line`);
  }
  // Two deal fragments stay two sentences; a lone fragment keeps its own sentence.
  const two = shortFactLines([...lines.slice(0, 4), { kind: "deal", text: "We can't tell what this costs." }]);
  assert.ok(two, "a shorter deal kind still reduces");
  assert.equal(two.shown.at(-1)?.text, "We can't tell what this costs.");
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
    unmount: () => Promise<void>;
  }) => Promise<T>
): Promise<T> {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  Object.assign(globalThis, {
    React,
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
    // The shared Button reads these as globals when it mounts.
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    HTMLButtonElement: dom.window.HTMLButtonElement,
  });
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
  let mounted = true;
  const unmount = async () => {
    if (!mounted) return;
    mounted = false;
    await act(async () => root.unmount());
  };
  try {
    await act(async () => root.render(createElement(RemoteAccessSetting, { request, appVersion: "0.0.0-test" })));
    await settle();
    return await run({
      container,
      calls,
      settle,
      unmount,
      text: () => container.textContent ?? "",
      press: async (label) => {
        const button = [...container.querySelectorAll("button")].find((node) => label.test(node.textContent ?? ""));
        assert.ok(button, `no button matching ${label}`);
        await act(async () => button.click());
        await settle();
      },
    });
  } finally {
    await unmount();
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

test("the recommended way's radio has a name and every way's radio carries its provider id", async () => {
  await withScreen(host(), async ({ container }) => {
    const recommended = container.querySelector('[aria-label="Recommended way"] input[type="radio"]');
    assert.ok(recommended);
    assert.equal(recommended.getAttribute("aria-label"), "Tunnel service");
    assert.equal((recommended as HTMLInputElement).value, "p-tunnel");
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
  await withScreen(handler, async ({ calls, press, text, container }) => {
    // Nothing turned on yet, so the sentence must not say turning on failed.
    assert.match(text(), /We couldn.t get this way ready\. Try again/);
    assert.doesNotMatch(text(), /couldn.t turn on/);
    assert.deepEqual(approvals(calls), []);
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
      // An address that may still be on offers Turn off; a failure after an effect keeps Check and turn off.
      assert.match(text(), operation === uncertain ? /Turn off/ : /Check and turn off/);
    });
  }
});

test("a refused start whose cleanup the host confirmed says it did not turn on, not that the address was lost", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let answered = false;
  const refused = { ...applying(), stage: "settled", failureCode: "consent_mismatch", handle: { id: "r" }, cleanupConfirmed: true };
  const handler = host({
    "/state": () => (answered ? ok(idleState) : turningOn()),
    "/operations/op-1": () => {
      answered = true;
      return ok(refused);
    },
  });
  await withScreen(handler, async ({ settle, text }) => {
    assert.match(text(), /Turning on/);
    await act(async () => t.mock.timers.tick(1000));
    await settle();
    assert.ok(answered);
    assert.match(text(), /Remote access did not turn on/);
    assert.doesNotMatch(text(), /Needs your action|We lost track of the address/);
  });
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
  const services = [{ providerId: "p-tunnel", providerLabel: "T", draftId: "d-1", usage: "session", committed: false, setup: null }];
  const { request, urls } = recorder({
    ...baseTable,
    "/state": ok({ routes: [], reasons: {}, starting: false, services }),
    "/drafts/d-1": ok(draftWith([quiet])),
  });
  await assert.rejects(prepareTurnOn(request, choice, { mayRunActions: () => false }), PreparationStopped);
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

// ---------- hardening: one preparation at a time, no stale positive request ----------

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const positives = (calls: Call[]) =>
  calls.filter((call) => positive(call) || call.url.endsWith("/review")).map((call) => call.url);

test("an expired review is refreshed once, however long the refresh takes", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const slow = deferred<Result>();
  let reviews = 0;
  const handler = host({
    "/drafts/d-1/review": () => {
      reviews += 1;
      if (reviews === 1) return ok(review("rev-1", "digest-1", undefined, "2000-01-01T00:00:00.000Z"));
      return slow.promise as unknown as Result;
    },
    "/operations": ok({ operationId: "op-1" }),
  });
  await withScreen(handler, async ({ calls, press, settle }) => {
    for (let tick = 0; tick < 5; tick += 1) {
      await act(async () => t.mock.timers.tick(1000));
      await settle();
    }
    assert.equal(reviews, 2, "one refresh is in flight; the timer started no other");
    assert.equal(calls.filter((call) => call.url === "/drafts").length, 2, "one chain per refresh");
    await act(async () => slow.resolve(ok(review("rev-2", "digest-1"))));
    await settle();
    await press(/^Turn on remote access$/);
    assert.deepEqual(approvals(calls).map((call) => call.body?.reviewId), ["rev-2"]);
    assert.equal(reviews, 2);
  });
});

test("password lost while the draft read is slow: no commit, review or setup follows", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const step = action({ kind: "open-url", step: { actor: "owner", permission: { id: "p", label: "p" }, verification: "provider", purpose: "authorize" } });
  for (const [name, draft] of [["no action", draftWith()], ["a sign-in step", draftWith([step])]] as const) {
    let passwordSet = true;
    const slow = deferred<Result>();
    const services = [{ providerId: "p-tunnel", providerLabel: "Tunnel service", draftId: "d-1", usage: "session", committed: false, setup: null }];
    const handler = host({
      "/state": () => ok({ ...idleState, passwordSet, services }),
      "/drafts/d-1": () => slow.promise as unknown as Result,
    });
    await withScreen(handler, async ({ calls, settle }) => {
      passwordSet = false;
      await act(async () => t.mock.timers.tick(3000));
      await settle();
      await act(async () => slow.resolve(ok(draft)));
      await settle();
      assert.deepEqual(positives(calls), [], `${name}: ${positives(calls).join(",")}`);
    });
  }
});

test("a preparation that finds its own state without a password creates no draft", async () => {
  const { request, urls } = recorder({ ...baseTable, "/state": ok({ routes: [], reasons: {}, starting: false, services: [], passwordSet: false }) });
  await assert.rejects(prepareTurnOn(request, choice), PreparationStopped);
  assert.deepEqual(urls(), ["/catalog", "/state"]);
});

test("with the guard closed, an actionless draft is not committed and a sign-in step is not returned", async () => {
  const step = action({ kind: "open-url", step: { actor: "owner", permission: { id: "p", label: "p" }, verification: "provider", purpose: "authorize" } });
  const services = [{ providerId: "p-tunnel", providerLabel: "T", draftId: "d-1", usage: "session", committed: false, setup: null }];
  for (const draft of [draftWith(), draftWith([step])]) {
    const { request, urls } = recorder({ ...baseTable, "/state": ok({ routes: [], reasons: {}, starting: false, services }), "/drafts/d-1": ok(draft) });
    await assert.rejects(prepareTurnOn(request, choice, { mayRunActions: () => false }), PreparationStopped);
    assert.ok(!urls().some((url) => url?.endsWith("/commit") || url?.endsWith("/review")), urls().join(","));
  }
});

test("a preparation that stops being current sends nothing further after each awaited step", async () => {
  const services = [{ providerId: "p-tunnel", providerLabel: "T", draftId: "d-1", usage: "session", committed: false, setup: null }];
  const quiet = action({ effects: none });
  const table = {
    ...baseTable,
    "/state": ok({ routes: [], reasons: {}, starting: false, services }),
    "/drafts/d-1": ok(draftWith([quiet])),
    "/drafts/d-1/actions/act-1": ok(draftWith().configuration),
  };
  // Close the guard after the Nth request; the chain must send nothing positive after it.
  for (const after of ["/catalog", "/state", "/drafts/d-1", "/drafts/d-1/actions/act-1", "/drafts/d-1/commit"]) {
    let current = true;
    const calls: string[] = [];
    const request = (async (url: string, body?: Record<string, unknown>) => {
      const path = url.split("?")[0]!;
      calls.push(path);
      const hit = (table as Record<string, Result>)[path] ?? ok({});
      if (path === after) current = false;
      return hit;
    }) as unknown as typeof requestReachability;
    await assert.rejects(prepareTurnOn(request, choice, { isCurrent: () => current }), PreparationStopped, after);
    const at = calls.indexOf(after);
    const later = calls.slice(at + 1).filter((path) => path === "/drafts" || path.includes("/actions/") || path.endsWith("/commit") || path.endsWith("/review"));
    assert.deepEqual(later, [], `after ${after}: ${later.join(",")}`);
  }
});

test("unmounting mid-chain stops the chain: no setup, commit or review follows", async () => {
  const step = action({ kind: "open-url", step: { actor: "owner", permission: { id: "p", label: "p" }, verification: "provider", purpose: "authorize" } });
  for (const draft of [draftWith(), draftWith([step])]) {
    const slow = deferred<Result>();
    const handler = host({ "/drafts": () => slow.promise as unknown as Result });
    await withScreen(handler, async ({ calls, unmount, settle }) => {
      await unmount();
      await slow.resolve(ok(draft));
      await settle();
      assert.deepEqual(positives(calls).filter((url) => url !== "/drafts"), []);
    });
  }
});

test("two overlapping preparations send one POST /drafts", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let passwordSet = true;
  let created = false;
  const slow = deferred<Result>();
  const handler = host({
    "/state": () =>
      ok({
        ...idleState,
        passwordSet,
        services: created
          ? [{ providerId: "p-tunnel", providerLabel: "Tunnel service", draftId: "d-1", usage: "session", committed: false, setup: null }]
          : [],
      }),
    "/drafts": () => slow.promise.then((result) => {
      created = true;
      return result;
    }) as unknown as Result,
    "/drafts/d-1": ok(draftWith()),
  });
  await withScreen(handler, async ({ calls, settle }) => {
    // The first chain waits on POST /drafts. The password drops and returns, so
    // a second chain starts while the first is still in flight.
    passwordSet = false;
    await act(async () => t.mock.timers.tick(3000));
    await settle();
    passwordSet = true;
    await act(async () => t.mock.timers.tick(3000));
    await settle();
    await act(async () => slow.resolve(ok(draftWith())));
    await settle();
    assert.equal(calls.filter((call) => call.url === "/drafts").length, 1);
  });
});

test("a review that expires between the console's check and the approve is refused, refreshed silently and approved on one click", async () => {
  // The host side of this is tested in reachability-approve-precheck.test.ts:
  // an expired review is refused before the 202 with consent_expired.
  let serverNow = 0;
  const issued = new Map<string, number>();
  let n = 0;
  const handler = host({
    "/drafts/d-1/review": () => {
      const id = `rev-${++n}`;
      issued.set(id, serverNow + 60_000);
      return ok(review(id, "digest-1"));
    },
    "/operations": (call) => {
      const expiry = issued.get(String(call.body?.reviewId)) ?? 0;
      return serverNow >= expiry ? fail("consent_expired") : ok({ operationId: "op-1" });
    },
  });
  await withScreen(handler, async ({ calls, press, text }) => {
    serverNow = 120_000; // the host clock passed the expiry; the console has not noticed
    await press(/^Turn on remote access$/);
    assert.deepEqual(approvals(calls).map((call) => call.body?.reviewId), ["rev-1", "rev-2"]);
    assert.doesNotMatch(text(), /couldn.t turn on|Needs your action/);
    assert.match(text(), /Turning on/);
  });
});

test("a hung old draft does not block preparation of a newly selected way", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const never = deferred<Result>();
  const other = { ...provider, providerId: "cloudflare-named", label: "Cloudflare" };
  const nextDraft = { ...draftWith(), draftId: "d-next" };
  const nextReview = review("rev-next", "digest-next");
  nextReview.candidate.providerId = other.providerId;
  const handler = host({
    "/catalog": ok({ ...catalog, providers: [provider, other] }),
    "/drafts": (call) => call.body?.providerId === other.providerId ? ok(nextDraft) : never.promise as unknown as Result,
    "/drafts/d-next/commit": ok(nextDraft.configuration),
    "/drafts/d-next/review": ok(nextReview),
  });
  await withScreen(handler, async ({ container, calls, press, settle, text }) => {
    assert.equal(calls.filter((call) => call.url === "/drafts").length, 1);
    await press(/^Other ways$/);
    const radio = [...container.querySelectorAll("label")].find((node) => /Cloudflare/.test(node.textContent ?? ""))!.querySelector("input")!;
    await act(async () => radio.click());
    await settle();
    assert.ok(calls.some((call) => call.url === "/drafts/d-next/review"), "new selection prepares before old request settles");
    assert.match(text(), /Turn on remote access/);
    await act(async () => t.mock.timers.tick(15_001));
    await settle();
    assert.ok(!calls.some((call) => call.url === "/drafts/d-1/commit" || call.url === "/drafts/d-1/review"));
    assert.match(text(), /Turn on remote access/, "old timeout cannot replace the new card");
  });
});

test("a private missing-password observation restarts preparation after a true poll without a click", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const privateState = deferred<Result>();
  let states = 0;
  const handler = host({
    "/state": () => ++states === 2 ? privateState.promise as unknown as Result : ok({ ...idleState, passwordSet: true }),
  });
  await withScreen(handler, async ({ calls, settle, text }) => {
    assert.equal(states, 2, "initial poll followed by the chain's private read");
    await act(async () => privateState.resolve(ok({ ...idleState, passwordSet: false })));
    await settle();
    assert.match(text(), /Step 1: Set a password/);
    assert.equal(calls.filter((call) => call.url === "/drafts").length, 0);
    await act(async () => t.mock.timers.tick(3_000));
    await settle();
    assert.match(text(), /Turn on remote access/);
    assert.equal(calls.filter((call) => call.url === "/drafts").length, 1);
  });
});

// The transport ends every request at its own deadline (reachability-client.test.ts), so a request
// that outlives it reaches the chain as this failure. The chain has no timer of its own.
test("a request that outlives the transport's deadline ends the preparation with Try again and sends nothing more", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  let drafts = 0;
  const lateFailure = () =>
    new Promise<Result>((resolve) => setTimeout(() => resolve(fail("reachability_unavailable")), 15_000));
  const handler = host({ "/drafts": () => (++drafts === 1 ? (lateFailure() as unknown as Result) : ok(draftWith())) });
  await withScreen(handler, async ({ calls, settle, text, press }) => {
    await act(async () => t.mock.timers.tick(15_001));
    await settle();
    assert.match(text(), /Try again/);
    assert.ok(!calls.some((call) => call.url.endsWith("/commit")));
    await press(/^Try again$/);
    assert.match(text(), /Turn on remote access/);
  });
});

test("real trial-consent action: Turn on shows the trial's own facts, and one click sends one route approval", async () => {
  const handler = host({
    "/drafts": ok(draftWith([trialConsentAction])),
    "/operations": ok({ operationId: "op-1" }),
  });
  await withScreen(handler, async ({ calls, press, text, container }) => {
    const card = container.querySelector('section[aria-label="Turn on"]');
    assert.ok(card, "the turn-on card is on screen");
    const button = [...container.querySelectorAll("button")].find((node) => node.textContent === "Turn on remote access");
    assert.ok(button, "the Turn on button is on screen");
    // One line per kind above the button, under the caption naming the way.
    assert.match(text(), /For Tunnel service:/);
    const factLines = [...card.querySelectorAll("ul > li")].map((node) => node.textContent ?? "");
    assert.equal(factLines.length, 3, `exactly one line per kind: ${factLines.join("|")}`);
    assert.match(factLines[0] ?? "", /🔒/);
    assert.match(factLines[0] ?? "", /must sign in with your password\. Apps also need your permission\./);
    assert.match(factLines[1] ?? "", /👁/);
    assert.match(factLines[1] ?? "", /Tunnel service can see what passes through\./);
    assert.match(factLines[2] ?? "", /⏱/);
    assert.match(factLines[2] ?? "", /Free\. The address changes each time and turns off by itself\./);
    // The trial's own review heading and paragraph moved into the closed Details below the button.
    const details = card.querySelector("details");
    assert.ok(details, "the card has one Details");
    assert.equal(details.hasAttribute("open"), false, "nothing is unreadable, so Details starts closed");
    assert.ok(button.compareDocumentPosition(details) & 4, "Details sits below the button");
    assert.match(details.textContent ?? "", /Review the public HTTPS trial/);
    assert.match(details.textContent ?? "", /Start a public HTTPS trial through the relay/);
    const outsideDetails = card.cloneNode(true) as Element;
    for (const node of outsideDetails.querySelectorAll("details")) node.remove();
    assert.doesNotMatch(outsideDetails.textContent ?? "", /Review the public HTTPS trial|Start a public HTTPS trial/);
    assert.equal(button.disabled, false);
    assert.ok(!calls.some((call) => call.url === "/setups"), "no setup is started for a consent-only step");
    await press(/^Turn on remote access$/);
    assert.deepEqual(
      calls.map((call) => call.url).filter((url) => url === "/operations" || url.includes("/actions/") || url === "/setups"),
      ["/operations"]
    );
    assert.deepEqual(approvals(calls).map((call) => call.body), [
      { reviewId: "rev-1", kind: "route", consentFactsDigest: "digest-1", acknowledgeDisconnect: true },
    ]);
  });
});

// A step the page cannot show as a sign-in must not leave a blank card.
test("an owner step with no setup card says its details did not load and offers Try again, never nothing", async () => {
  const unknownStep = { ...trialConsentAction, id: "other-step", step: { ...trialConsentAction.step, actor: "administrator", purpose: "configure" } };
  const handler = host({
    "/drafts": ok(draftWith([unknownStep])),
    "/setups": ok({ operationId: "op-x" }),
  });
  await withScreen(handler, async ({ calls, text, container }) => {
    assert.match(text(), /We couldn't load this service's details\. Try again\./);
    assert.doesNotMatch(text(), /couldn't turn on/);
    assert.deepEqual(approvals(calls), []);
    assert.ok([...container.querySelectorAll("button")].some((node) => node.textContent === "Try again"));
  });
});

// ---------- a slow catalog must not starve Turn on ----------

// The console used to reach the service through Server Actions. Next.js runs one
// client's actions one at a time (next/dist/client/components/app-router-instance.js
// keeps one action queue), so a request waited behind every earlier one. This lane
// keeps that property on purpose: a transport that serializes must still get Turn on ready.
function serialLane(handler: Handler): Handler {
  let tail: Promise<unknown> = Promise.resolve();
  return (call) => {
    const run = tail.then(() => handler(call));
    tail = run.catch(() => undefined);
    return run;
  };
}

test("Turn on is prepared while the page polls a catalog that takes seconds to answer", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const after = <T>(ms: number, value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));
  // Slow like a computer whose provider probes are slow; the rest answer at once.
  const handler = serialLane(
    host({
      "/catalog": () => after(4_000, ok(catalog)) as unknown as Result,
      "/drafts": () => after(4_000, ok(draftWith())) as unknown as Result,
    })
  );
  await withScreen(handler, async ({ settle, text }) => {
    // 3 minutes of the page's own clock, in steps; stop as soon as Turn on is ready or has failed.
    for (let elapsed = 0; elapsed < 180_000; elapsed += 250) {
      if (/Turn on remote access/.test(text()) || /couldn.t get this way ready/.test(text())) break;
      await act(async () => t.mock.timers.tick(250));
      await settle();
    }
    assert.doesNotMatch(text(), /couldn.t get this way ready/);
    assert.match(text(), /Turn on remote access/);
  });
});

test("the page polls the fast reads every 3 s, and reads a catalog that is slow to answer one at a time and rarely", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"] });
  const after = <T>(ms: number, value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));
  const handler = host({ "/catalog": () => after(8_000, ok(catalog)) as unknown as Result });
  await withScreen(handler, async ({ calls, settle, text }) => {
    for (let elapsed = 0; elapsed < 90_000; elapsed += 500) {
      await act(async () => t.mock.timers.tick(500));
      await settle();
    }
    const count = (url: string) => calls.filter((call) => call.url === url).length;
    assert.ok(count("/state") >= 25, `/state kept its pace: ${count("/state")} reads in 90 s`);
    // The first read, then one when the held one is old: eight times its 8 s, capped at a minute.
    assert.ok(count("/catalog") <= 5, `/catalog was read ${count("/catalog")} times in 90 s`);
    assert.doesNotMatch(text(), /couldn.t get this way ready|couldn.t check/);
    assert.match(text(), /Turn on remote access/);
  });
});

test("a catalog read that fails at once is tried again on the poll, 3 s on, never in a loop", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"] });
  const handler = host({ "/catalog": fail("service_unreachable") });
  await withScreen(handler, async ({ calls, settle, text }) => {
    for (let elapsed = 0; elapsed < 30_000; elapsed += 500) {
      await act(async () => t.mock.timers.tick(500));
      await settle();
    }
    const reads = calls.filter((call) => call.url === "/catalog").length;
    assert.ok(reads >= 5 && reads <= 12, `/catalog was read ${reads} times in 30 s`);
    assert.match(text(), /couldn.t check remote access|background service isn.t running/i);
  });
});
