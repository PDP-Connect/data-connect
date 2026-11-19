// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
// Which way is being prepared: it stays put across catalog polls, a change of
// way stops the old preparation, a change in flight locks the radios, and a
// Funnel setup blocked on an administrator demotes that way.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import test, { mock } from "node:test";
import { JSDOM } from "jsdom";
import * as React from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { recommendedWay, wayRow, wayUnusable } from "./choose-way.ts";
import { knownFalseConditions } from "./known-false-conditions.ts";
import { ConsentDisclosures, ConsentFacts } from "./reachability-consent.tsx";
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
type Handler = (call: Call) => Result | Promise<Result>;
const ok = (data: unknown): Result => ({ ok: true, data });
const fail = (code: string): Result => ({ ok: false, ...publicError(code, "server words") });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const available = { reason: "admitted", state: "available" };
// "present" here is a prerequisite the host observed with a version: positive evidence. The real catalog shape is in real-gozar-shapes.fixture.ts.
const prerequisite = (id: string, state: string) => ({ id, label: id, observedAt: "x", remedy: null, state, version: state === "present" ? { known: true, value: "1.80.0" } : { known: false, reason: "n" } });
const way = (providerId: string, over: Record<string, unknown> = {}) => ({
  providerId,
  label: `Label ${providerId}`,
  reach: providerId === "lan" ? "lan" : "public",
  transport: "https",
  availability: { session: available, durable: available },
  configuration: { revision: "r1", actions: [], inputRequirements: [], values: {}, credentials: {} },
  facts: [],
  prerequisites: [],
  ...over,
});
const ids = ["localhost-run", "tailscale-funnel", "cloudflare-named", "tailscale-private", "lan"];
const catalogWith = (setup: string | null) => ({
  catalogRevision: "c1",
  observedAt: "x",
  schemaVersion: 1,
  providers: ids.map((id) =>
    id.startsWith("tailscale-") && setup ? way(id, { prerequisites: [prerequisite("local-setup", setup)] }) : way(id)
  ),
});
// Without a Tailscale prerequisite at all, the temporary address is recommended.
const noTailscale = catalogWith("missing");
const tailscaleReady = catalogWith("present");
const tailscaleUnknown = catalogWith("unknown");

const configuration = (actions: unknown[] = []) => ({ revision: "r2", actions, inputRequirements: [], values: {}, credentials: {} });
const draftOf = (providerId: string, actions: unknown[] = []) => ({ draftId: `d-${providerId}`, configuration: configuration(actions) });
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
const signIn = action({ kind: "open-url", step: { actor: "owner", permission: { id: "p", label: "p" }, verification: "provider", purpose: "authorize" } });
const candidate = (providerId: string) => ({
  providerId,
  display: { label: providerId, description: "", needs: "" },
  consentFactsDigest: "d",
  expiresAt: "2999-01-01T00:00:00.000Z",
  eligible: true,
  facts: [],
  consent: {
    consentFactsDigest: "d",
    scope: { kind: "route", query: { target: "127.0.0.1:1", expectedOrigin: null, usage: { kind: "session", lifetimeMs: 3_600_000 } } },
    facts: [],
    disclosures: { traffic: { providerCanReadPayload: true }, cost: { kind: "free", summary: "Free" }, address: { stability: "ephemeral" } },
  },
});
const idleState = { routes: [], reasons: {}, starting: false, services: [] };

/** A host that answers every call; `over` replaces answers by path. */
function host(catalog: () => unknown, over: Record<string, Handler> = {}): Handler {
  return (call) => {
    const path = call.url.split("?")[0]!;
    if (over[path]) return over[path]!(call);
    if (path === "/catalog") return ok(catalog());
    if (path === "/state") return ok(idleState);
    if (path === "/host-settings") return ok({ known: false, reason: "unavailable" });
    if (path === "/host-capabilities") return ok({});
    if (path === "/drafts") return ok(draftOf(String(call.body?.providerId)));
    if (path.endsWith("/commit")) return ok(configuration());
    if (path.endsWith("/review")) {
      const providerId = path.split("/")[2]!.slice(2);
      return ok({ id: `rev-${providerId}`, kind: "route", candidate: candidate(providerId) });
    }
    return fail("route_not_found");
  };
}

async function withScreen<T>(
  handler: Handler,
  run: (screen: {
    calls: Call[];
    container: Element;
    press: (label: RegExp) => Promise<void>;
    pickRadio: (label: RegExp) => Promise<void>;
    text: () => string;
    settle: () => Promise<void>;
  }) => Promise<T>
): Promise<T> {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  Object.assign(globalThis, { React, window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, HTMLButtonElement: dom.window.HTMLButtonElement });
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
      calls,
      container,
      settle,
      text: () => container.textContent ?? "",
      press: async (label) => {
        const button = [...container.querySelectorAll("button")].find((node) => label.test(node.textContent ?? ""));
        assert.ok(button, `no button matching ${label}`);
        await act(async () => button.click());
        await settle();
      },
      pickRadio: async (label) => {
        const radio = [...container.querySelectorAll("label, section[aria-label='Recommended way']")]
          .find((node) => label.test(node.textContent ?? ""))
          ?.querySelector("input");
        assert.ok(radio, `no radio matching ${label}`);
        await act(async () => radio.click());
        await settle();
      },
    });
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
}

const draftsFor = (calls: Call[]) => calls.filter((call) => call.url === "/drafts").map((call) => call.body?.providerId);
const positiveFor = (calls: Call[], providerId: string) =>
  calls
    .filter((call) => call.url.startsWith(`/drafts/d-${providerId}/`) || call.url.startsWith("/setups"))
    .filter((call) => /\/(actions|commit|review)\b|^\/setups/.test(call.url) && (call.url.startsWith("/setups") ? call.body?.providerId === providerId : true))
    .map((call) => call.url);

// ---------- defect 1: polls do not switch the way ----------

test("catalog polls do not switch the way being prepared", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"] });
  let catalog: unknown = tailscaleReady;
  const slow = deferred<Result>();
  const handler = host(() => catalog, {
    "/drafts": (call) => (call.body?.providerId === "tailscale-funnel" ? slow.promise : ok(draftOf(String(call.body?.providerId)))),
  });
  await withScreen(handler, async ({ calls, container, settle, text }) => {
    assert.deepEqual(draftsFor(calls), ["tailscale-funnel"]);
    for (const next of [tailscaleUnknown, tailscaleReady, tailscaleUnknown, tailscaleReady]) {
      catalog = next;
      await act(async () => t.mock.timers.tick(3000));
      await settle();
    }
    await act(async () => slow.resolve(ok(draftOf("tailscale-funnel"))));
    await settle();
    assert.deepEqual(draftsFor(calls), ["tailscale-funnel"], "one preparation, for one way");
    assert.deepEqual(
      calls.filter((call) => call.url.endsWith("/review")).map((call) => call.url),
      ["/drafts/d-tailscale-funnel/review"]
    );
    assert.match(text(), /Turn on remote access/);
    assert.match(container.querySelector("[aria-label='Recommended way']")!.textContent!, /Tailscale/);
  });
});

test("a pinned way that truly becomes unusable is replaced, and the owner is told why", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"] });
  let catalog: unknown = tailscaleReady;
  await withScreen(host(() => catalog), async ({ calls, settle, text }) => {
    assert.deepEqual(draftsFor(calls), ["tailscale-funnel"]);
    catalog = noTailscale;
    await act(async () => t.mock.timers.tick(3000));
    await settle();
    assert.deepEqual(draftsFor(calls), ["tailscale-funnel", "localhost-run"]);
    assert.match(text(), /Tailscale · public address can't be used now: Needs the Tailscale app, signed in\. Using Temporary address instead\./);
  });
});

// ---------- defect 2: switching ways stops the old preparation ----------

test("choosing another way while the old draft is pending sends nothing further for the old way", async () => {
  for (const [name, actions] of [
    ["a sign-in step", [signIn]],
    ["no action", []],
    ["an action without effects", [action({ effects: { writes: [], networkOrigins: [], requiresPrivilege: false, restartRequired: false } })]],
  ] as const) {
    const slow = deferred<Result>();
    const handler = host(() => tailscaleReady, {
      "/drafts": (call) => (call.body?.providerId === "tailscale-funnel" ? slow.promise : ok(draftOf(String(call.body?.providerId)))),
    });
    await withScreen(handler, async ({ calls, press, pickRadio, settle }) => {
      await press(/^Other ways$/);
      await pickRadio(/^\s*Cloudflare/);
      await act(async () => slow.resolve(ok(draftOf("tailscale-funnel", [...actions]))));
      await settle();
      assert.deepEqual(positiveFor(calls, "tailscale-funnel"), [], name);
      assert.ok(draftsFor(calls).includes("cloudflare-named"), `${name}: the chosen way is prepared`);
    });
  }
});

// ---------- defect 3: no new selection while a change is in flight ----------

test("the recommended radio is disabled and inert while Turn on is in flight", async () => {
  const slow = deferred<Result>();
  const handler = host(() => noTailscale, { "/operations": () => slow.promise });
  await withScreen(handler, async ({ calls, container, press, pickRadio, text }) => {
    await press(/^Other ways$/);
    await pickRadio(/^\s*Cloudflare/);
    const before = draftsFor(calls).length;
    await press(/^Turn on remote access$/);
    const radio = container.querySelector("[aria-label='Recommended way'] input") as HTMLInputElement;
    assert.equal(radio.disabled, true);
    await act(async () => radio.click());
    assert.equal(draftsFor(calls).length, before, "no new preparation");
    assert.equal(draftsFor(calls).at(-1), "cloudflare-named");
    assert.equal(radio.checked, false);
    assert.match(text(), /Cloudflare/);
    await act(async () => slow.resolve(fail("route_not_found")));
  });
});

test("the recommended radio is disabled while Allow is in flight", async () => {
  const slow = deferred<Result>();
  const effectful = action({ effects: { writes: ["/opt/x"], networkOrigins: [], requiresPrivilege: false, restartRequired: false } });
  const handler = host(() => noTailscale, {
    "/drafts": (call) => ok(draftOf(String(call.body?.providerId), call.body?.providerId === "cloudflare-named" ? [effectful] : [])),
    "/drafts/d-cloudflare-named/actions/act-1": () => slow.promise,
  });
  await withScreen(handler, async ({ calls, container, press, pickRadio }) => {
    await press(/^Other ways$/);
    await pickRadio(/^\s*Cloudflare/);
    const before = draftsFor(calls).length;
    await press(/^Allow$/);
    const radio = container.querySelector("[aria-label='Recommended way'] input") as HTMLInputElement;
    assert.equal(radio.disabled, true);
    await act(async () => radio.click());
    assert.equal(draftsFor(calls).length, before);
    await act(async () => slow.resolve(fail("route_not_found")));
  });
});

// ---------- defect 4: Funnel not allowed ----------

const funnelService = {
  providerId: "tailscale-funnel",
  providerLabel: "Tailscale · public address",
  draftId: "d-tailscale-funnel",
  usage: "session",
  committed: false,
  setup: { operationId: "op-1", actionId: "act-1", expectedConfigurationRevision: "r2" },
};
const blockedView = (nextActionId: string, href = "https://login.tailscale.com/admin/acls") => ({
  operationId: "op-1",
  revision: 1,
  state: "blocked",
  scope: { registryId: "r", scopeId: "s", providerId: "tailscale-funnel", configurationRevision: "r2", draftId: "d-tailscale-funnel" },
  evidence: { known: false, reason: "n" },
  nextAction: action({ id: nextActionId, kind: "open-url", label: "Ask an administrator to allow Funnel on this exact node", href, instructions: "Allow the funnel attribute." }),
  resources: [],
});
const funnelHost = (view: unknown) =>
  host(() => tailscaleReady, {
    "/state": () => ok({ ...idleState, services: [funnelService] }),
    "/drafts/d-tailscale-funnel": () => ok(draftOf("tailscale-funnel", [signIn])),
    "/setup-operations/op-1": () => ok(view),
  });

test("a Funnel setup blocked on the administrator step demotes Funnel and recommends the temporary address", async () => {
  await withScreen(funnelHost(blockedView("tailscale-funnel-policy")), async ({ calls, container, press, text }) => {
    assert.match(container.querySelector("[aria-label='Recommended way']")!.textContent!, /Temporary address/);
    assert.ok(draftsFor(calls).includes("localhost-run"), "the temporary address is prepared");
    assert.match(text(), /Tailscale · public address can't be used now: Funnel isn't allowed on this Tailscale device yet\. Ask an administrator to allow it\. Using Temporary address instead\./);
    await press(/^Other ways$/);
    const row = [...container.querySelectorAll("label")].find((node) => /Tailscale · public address/.test(node.textContent ?? ""))!;
    assert.match(row.textContent!, /Ask an administrator to allow it/);
    assert.equal(row.querySelector("input")!.disabled, true);
    const link = row.querySelector("a")!;
    assert.equal(link.getAttribute("href"), "https://login.tailscale.com/admin/acls");
  });
});

test("only the Funnel policy outcome demotes: another blocked step leaves Funnel recommended", async () => {
  await withScreen(funnelHost(blockedView("tailscale-install")), async ({ calls, container }) => {
    assert.match(container.querySelector("[aria-label='Recommended way']")!.textContent!, /Tailscale · public address/);
    assert.ok(!draftsFor(calls).includes("localhost-run"));
  });
});

test("an administrator link that is not https falls back to the Funnel help page", async () => {
  await withScreen(funnelHost(blockedView("tailscale-funnel-policy", "javascript:alert(1)")), async ({ container, press }) => {
    await press(/^Other ways$/);
    const row = [...container.querySelectorAll("label")].find((node) => /Tailscale · public address/.test(node.textContent ?? ""))!;
    assert.equal(row.querySelector("a")!.getAttribute("href"), "https://tailscale.com/kb/1223/funnel");
  });
});

// ---------- defect 5: the known-false 15-minute line ----------

// Resolved the way Node does from reference-implementation, so it works whether npm hoists the package or not.
const gozarDir = new URL(
  ".",
  pathToFileURL(
    createRequire(new URL("../../../../../../reference-implementation/package.json", import.meta.url)).resolve("@tnunamak/gozar/package.json")
  )
);
const falseLine = "the plan limits a session to 15 minutes";
const addressFact = (id: string, value: string) => ({
  id, group: "address", label: "address conditions", known: true as const, value, affectsConsent: false, source: "provider", asOf: null,
});
const html = (providerId: string, values: string[]) =>
  renderToStaticMarkup(createElement(ConsentFacts, { providerId, facts: values.map((value, index) => addressFact(`c-${index}`, value)) as never }));

test("the legacy condition suppression remains for saved views and is absent from the current definition", () => {
  const definition = JSON.parse(readFileSync(new URL("adapters/providers/localhost-run/definition.json", gozarDir), "utf8"));
  assert.ok(
    !JSON.stringify(definition).includes(`"${falseLine}"`),
    "the current provider must not repeat the legacy limit"
  );
  assert.deepEqual([...knownFalseConditions["localhost-run"]!], [falseLine]);
  assert.deepEqual(Object.keys(knownFalseConditions), ["localhost-run"]);
});

test("the 15-minute line is hidden for localhost.run only; retention and cost terms with times stay", () => {
  const others = ["Logs retained for 30 days", "Free for 7 days, then costs $10"];
  const hidden = html("localhost-run", [...others, falseLine]);
  assert.ok(!hidden.includes(falseLine));
  for (const text of others) assert.ok(hidden.includes(text), text);
  assert.ok(html("another-provider", [falseLine]).includes(falseLine), "another provider keeps its own text");
  assert.ok(html("localhost-run", [`${falseLine}.`]).includes(`${falseLine}.`), "exact text only, never a pattern");
  assert.ok(html("localhost-run", ["a session lasts up to 15 minutes"]).includes("15 minutes"));
});

test("typed disclosures hide only the exact localhost-run false condition", () => {
  const value = { address: { conditions: [falseLine, "Logs retained for 30 days"] } };
  for (const providerId of ["localhost-run", "another-provider", undefined]) {
    const markup = renderToStaticMarkup(createElement(ConsentDisclosures, { value, providerId }));
    assert.equal(markup.includes(falseLine), providerId !== "localhost-run");
    assert.ok(markup.includes("Logs retained for 30 days"));
  }
});

for (const alternative of [true, false]) {
  test("denied temporary prerequisite moves the pin only to a usable alternative: " + alternative, async (t) => {
    t.mock.timers.enable({ apis: ["setInterval", "Date"] });
    let catalog = { ...noTailscale, providers: [way("localhost-run"), ...(alternative ? [way("cloudflare-named")] : [])] };
    await withScreen(host(() => catalog), async ({ calls, settle, text }) => {
      assert.deepEqual(draftsFor(calls), ["localhost-run"]);
      catalog = { ...catalog, providers: catalog.providers.map((row) => row.providerId === "localhost-run"
        ? way("localhost-run", { prerequisites: [prerequisite("SSH permission", "denied")] }) : row) };
      for (let n = 0; n < 3; n++) {
        await act(async () => t.mock.timers.tick(3000));
        await settle();
      }
      assert.deepEqual(draftsFor(calls), alternative ? ["localhost-run", "cloudflare-named"] : ["localhost-run"]);
      assert.match(text(), /Needs SSH permission \(denied\)/);
      if (alternative) assert.match(text(), /Using Cloudflare instead/);
      else assert.doesNotMatch(text(), /Turn on remote access/);
    });
  });
}

test("a final review arriving after Funnel policy demotion cannot start the old way", async () => {
  const lateReview = deferred<Result>();
  const policy = deferred<Result>();
  const initial = candidate("tailscale-funnel");
  let reviews = 0;
  const handler = host(() => tailscaleReady, {
    "/state": () => ok({ ...idleState, services: [{ ...funnelService, committed: true }] }),
    "/drafts/d-tailscale-funnel": () => ok(draftOf("tailscale-funnel")),
    "/drafts/d-tailscale-funnel/review": () => ++reviews === 1
      ? ok({ id: "initial-review", kind: "route", candidate: initial }) : lateReview.promise,
    "/setup-operations/op-1": () => policy.promise,
    "/operations": () => { throw new Error("stale way must not start"); },
  });
  await withScreen(handler, async ({ calls, press, settle, container }) => {
    assert.equal(reviews, 1);
    initial.expiresAt = "2000-01-01T00:00:00.000Z";
    await press(/^Turn on remote access$/);
    assert.equal(reviews, 2, "the final refresh is actually pending");
    await act(async () => policy.resolve(ok(blockedView("tailscale-funnel-policy"))));
    await settle();
    assert.match(container.querySelector("[aria-label='Recommended way']")!.textContent!, /Temporary address/);
    await act(async () => lateReview.resolve(ok({ id: "late-review", kind: "route", candidate: candidate("tailscale-funnel") })));
    await settle();
    assert.equal(calls.filter((call) => call.url === "/operations").length, 0);
    const other = [...container.querySelectorAll("button")].find((node) => node.textContent === "Other ways")!;
    assert.equal(other.disabled, false, "stale return clears busy");
  });
});

test("recommendation, rows and pinned usability agree on every provider prerequisite", () => {
  for (const providerId of ["localhost-run", "cloudflare-named"]) {
    for (const state of ["missing", "denied", "unknown", "present"]) {
      const provider = way(providerId, { prerequisites: [prerequisite("Client", state)] });
      const inventory = { ...noTailscale, providers: [provider] } as unknown as Parameters<typeof recommendedWay>[0];
      const row = inventory.providers[0]!;
      const blocked = state === "missing" || state === "denied";
      assert.equal(wayUnusable(row, {}), blocked);
      assert.equal(wayRow(row, {}).usable, !blocked);
      assert.equal(recommendedWay(inventory, {})?.providerId, blocked ? undefined : providerId);
    }
  }
});

for (const initialFailure of [false, true]) test(`setup polling survives ${initialFailure ? "an initial dashboard rejection" : "a hung dashboard refresh"}`, async t => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"] });
  let capabilityReads = 0, setupReads = 0, finished = false;
  const never = deferred<Result>();
  const browser = action({ id: "tailscale-browser", kind: "open-url",
    step: { browser: { expiresAt: "2999-01-01T00:00:00.000Z", pollAfterMs: 2000 } } });
  const setupView = () => ({
    operationId: "setup-poll", revision: finished ? 9 : 1, state: finished ? "complete" : "pending",
    resources: [], evidence: { known: false }, nextAction: finished ? null : browser,
    scope: { providerId: "tailscale-funnel", draftId: null, configurationRevision: "r2" },
  });
  const handler = host(() => tailscaleReady, {
    "/host-capabilities": () => {
      capabilityReads++;
      if (initialFailure && capabilityReads === 1) return Promise.reject(new Error("offline"));
      if (!initialFailure && capabilityReads > 1) return never.promise;
      return ok({});
    },
    "/state": () => ok({ ...idleState, services: [{
      providerId: "tailscale-funnel", providerLabel: "Tailscale", draftId: null, usage: "session", committed: true,
      setup: { operationId: "setup-poll", actionId: "tailscale-browser", expectedConfigurationRevision: "r2" },
    }] }),
    "/setup-operations/setup-poll": () => { setupReads++; return ok(setupView()); },
  });
  await withScreen(handler, async ({ container, settle }) => {
    if (initialFailure) { await act(async () => t.mock.timers.tick(3000)); await settle(); }
    // The card reads its setup once; the way's preparation reads it too.
    assert.ok(setupReads >= 1);
    assert.match(container.textContent ?? "", /Sign in to Tailscale to finish/);
    const before = setupReads;
    finished = true;
    await act(async () => t.mock.timers.tick(3000));
    await settle();
    assert.ok(setupReads > before, "the setup tick still reads the setup");
    assert.equal(container.querySelector('[aria-label="Sign in to Tailscale"]'), null);
  });
});
