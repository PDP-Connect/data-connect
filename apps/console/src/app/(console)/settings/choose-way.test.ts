// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
// The recommended way and the Other ways list: a projection of the catalog.
import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { JSDOM } from "jsdom";
import * as React from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { otherWays, recommendedWay } from "./choose-way.ts";
import { tailscaleFacts } from "./real-gozar-shapes.fixture.ts";
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

// The closed-vocabulary scan of remote-access-copy.test.ts, plus raw status words.
const bannedPatterns = [/reachability/i, /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/i, /\b(?:installer|privilege|secrets|runtime|host)\.[a-z]/i, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, /detect-only|deferred|admitted|action-required/i];
const bannedIn = (text: string) => bannedPatterns.filter((pattern) => pattern.test(text)).map(String);

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
const tailscale = (setup: string, extra: string[] = []) => [
  prerequisite("local-setup", setup),
  ...extra.map((state) => prerequisite("funnel", state)),
];
const ids = [
  "localhost-run",
  "tailscale-funnel",
  "cloudflare-named",
  "ngrok-https-edge",
  "tailscale-private",
  "lan",
  "own-address",
  "ngrok-tls-passthrough",
  "tunnl-gg",
];
const detectOnly = way("ngrok-tcp-passthrough", {
  availability: { session: { reason: "deferred by Lead", state: "detect-only" } },
});
function catalogWith(tailscaleState: { setup: string; extra?: string[] }) {
  const providers = ids.map((id) =>
    id.startsWith("tailscale-") ? way(id, { prerequisites: tailscale(tailscaleState.setup, tailscaleState.extra) }) : way(id)
  );
  return { catalogRevision: "c1", observedAt: "x", schemaVersion: 1, providers: [...providers, detectOnly] };
}
const noTailscale = catalogWith({ setup: "missing" });
const tailscaleReady = catalogWith({ setup: "present" });
const funnelBlocked = catalogWith({ setup: "present", extra: ["denied"] });
const caps = {};
type Inv = Parameters<typeof recommendedWay>[0];
const inv = (value: unknown) => value as Inv;

test("without Tailscale the temporary address is recommended", () => {
  assert.equal(recommendedWay(inv(noTailscale), caps)?.providerId, "localhost-run");
});

test("Tailscale installed, signed in and not blocked is recommended", () => {
  assert.equal(recommendedWay(inv(tailscaleReady), caps)?.providerId, "tailscale-funnel");
});

// The real catalog cannot tell a signed-out daemon from a signed-in one, so only a way the owner already set up is recommended.
function withTailscaleFacts(prerequisites: unknown[]) {
  const providers = ids.map((id) => (id.startsWith("tailscale-") ? way(id, { prerequisites }) : way(id)));
  return inv({ catalogRevision: "c1", observedAt: "x", schemaVersion: 1, providers });
}
test("with real Tailscale facts, a way that needs a sign-in is not recommended over one that needs none", () => {
  for (const [name, facts] of [
    ["not running", tailscaleFacts.notRunning],
    ["not installed", tailscaleFacts.notInstalled],
    ["running, signed out", tailscaleFacts.signedOut],
  ] as const) {
    assert.equal(recommendedWay(withTailscaleFacts([...facts]), caps)?.providerId, "localhost-run", name);
  }
});

test("with real Tailscale facts, a Tailscale the owner already set up is recommended", () => {
  const signedIn = withTailscaleFacts([...tailscaleFacts.signedIn]);
  assert.equal(recommendedWay(signedIn, caps, {}, new Set(["tailscale-funnel"]))?.providerId, "tailscale-funnel");
  assert.equal(recommendedWay(signedIn, caps, {}, new Set())?.providerId, "localhost-run");
});

test("Tailscale with Funnel blocked is not recommended and its row shows the missing step", () => {
  assert.equal(recommendedWay(inv(funnelBlocked), caps)?.providerId, "localhost-run");
  const lasting = otherWays(inv(funnelBlocked), caps, "localhost-run").find((group) => group.id === "lasting")!;
  const row = lasting.rows.find((item) => item.providerId === "tailscale-funnel")!;
  assert.equal(row.usable, false);
  assert.match(row.missing!.text, /Funnel isn't allowed/);
  assert.equal(lasting.rows.at(-1)!.providerId, "tailscale-funnel", "a way that cannot run comes last");
});

test("a missing Tailscale app shows Get Tailscale", () => {
  const row = otherWays(inv(noTailscale), caps, "localhost-run")
    .flatMap((group) => group.rows)
    .find((item) => item.providerId === "tailscale-funnel")!;
  assert.match(row.missing!.text, /Needs the Tailscale app/);
  assert.equal(row.missing!.link!.label, "Get Tailscale");
});

test("Other ways has three groups, no development row, and no code in any text", () => {
  const groups = otherWays(inv(tailscaleReady), caps, "tailscale-funnel");
  assert.deepEqual(groups.map((group) => group.title), ["Lasting address for AI apps", "Only my own devices", "Advanced"]);
  const rows = groups.flatMap((group) => group.rows);
  assert.ok(!rows.some((row) => row.providerId === "ngrok-tcp-passthrough"), "detect-only row hidden");
  assert.ok(!rows.some((row) => row.providerId === "tailscale-funnel"), "the recommended way is not repeated");
  for (const row of rows) {
    const text = [row.title, row.line, row.missing?.text ?? ""].join(" ");
    assert.deepEqual(bannedIn(text), [], text);
    assert.doesNotMatch(text, /detect-only|deferred|admitted|action-required|unsupported|[a-z]+-[a-z]+-[a-z]+/);
  }
});

test("a way the host cannot run says so in plain words", () => {
  const broken = way("ngrok-https-edge", { availability: { session: { reason: "usage-not-supported", state: "unsupported" } } });
  const row = otherWays(inv({ ...noTailscale, providers: [broken] }), caps, null)[0]!.rows[0]!;
  assert.equal(row.usable, false);
  assert.equal(row.missing!.text, "Can't run on this computer.");
});

// ---------- the screen ----------

async function withScreen<T>(
  catalog: unknown,
  run: (screen: {
    calls: Call[];
    container: Element;
    press: (label: RegExp) => Promise<void>;
    text: () => string;
    settle: () => Promise<void>;
  }) => Promise<T>
): Promise<T> {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  Object.assign(globalThis, { React, window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const { RemoteAccessSetting } = await import("./remote-access-setting.tsx");
  const container = dom.window.document.querySelector("#root")!;
  const root = createRoot(container);
  const calls: Call[] = [];
  const draft = (id: string) => ({ draftId: id, configuration: { revision: "r2", actions: [], inputRequirements: [], values: {}, credentials: {} } });
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
  const request = (async (url: string, body?: Record<string, unknown>) => {
    calls.push({ url, ...(body ? { body } : {}) });
    const path = url.split("?")[0]!;
    if (path === "/catalog") return ok(catalog);
    if (path === "/state") return ok({ routes: [], reasons: {}, starting: false, services: [] });
    if (path === "/host-settings") return ok({ known: false, reason: "unavailable" });
    if (path === "/host-capabilities") return ok({});
    if (path === "/drafts") return ok(draft(`d-${String(body?.providerId)}`));
    if (path.endsWith("/commit")) return ok(draft("x").configuration);
    if (path.endsWith("/review")) {
      const providerId = path.split("/")[2]!.slice(2);
      return ok({ id: `rev-${providerId}`, kind: "route", candidate: candidate(providerId) });
    }
    return fail("route_not_found");
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
    });
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
}
const mutating = (calls: Call[]) => calls.filter((call) => call.url.startsWith("/operations") || call.url.includes("/approve"));
// Every request that changes the host for one way: its draft, actions, commit and setup.
const changesHostFor = (calls: Call[], providerId: string) =>
  calls.filter(
    (call) =>
      /^\/(setups|drafts)$|\/(actions|commit)\b/.test(call.url.split("?")[0]!) &&
      (call.body?.providerId === providerId || call.url.includes(`d-${providerId}/`))
  );

test("the card recommends the temporary address and Other ways opens in three groups", async () => {
  await withScreen(noTailscale, async ({ container, press, text }) => {
    const card = container.querySelector("[aria-label='Recommended way']")!;
    assert.match(card.textContent!, /Temporary address/);
    assert.match(card.textContent!, /Recommended/);
    assert.match(card.textContent!, /Free, no account, ready in seconds\. Good for a quick test\./);
    assert.doesNotMatch(text(), /Needs the Tailscale app/, "Other ways is closed");
    await press(/^Other ways$/);
    const headings = [...container.querySelectorAll("fieldset h4, fieldset summary")].map((node) => node.textContent);
    assert.deepEqual(headings, ["Lasting address for AI apps", "Only my own devices", "Advanced"]);
    assert.match(text(), /Needs the Tailscale app, signed in\. Get Tailscale/);
    assert.equal((container.querySelector("fieldset details") as HTMLDetailsElement).open, false, "Advanced starts closed");
    const shown = container.querySelector("fieldset")!.textContent!;
    assert.doesNotMatch(shown, /Label |ngrok-tcp|detect-only|deferred|admitted/);
    assert.deepEqual(bannedIn(shown), []);
  });
});

test("choosing another way prepares that way and never approves without the click", async () => {
  await withScreen(tailscaleReady, async ({ calls, container, press, text, settle }) => {
    assert.match(container.querySelector("[aria-label='Recommended way']")!.textContent!, /Tailscale · public address/);
    await press(/^Other ways$/);
    const radio = [...container.querySelectorAll("label")].find((node) => /^\s*Cloudflare/.test(node.textContent ?? ""))!.querySelector("input")!;
    const before = calls.filter((call) => call.url === "/drafts").length;
    await act(async () => radio.click());
    await settle();
    const drafts = calls.filter((call) => call.url === "/drafts");
    assert.equal(drafts.length, before + 1, "one new draft for the chosen way");
    assert.equal(drafts.at(-1)!.body?.providerId, "cloudflare-named");
    assert.deepEqual(mutating(calls), []);
    // After the click, nothing positive goes to the way that was left.
    const afterClick = calls.slice(calls.findIndex((call) => call.body?.providerId === "cloudflare-named"));
    assert.deepEqual(changesHostFor(afterClick, "tailscale-funnel"), []);
    assert.match(text(), /Turn on remote access/);
    await act(async () => radio.click());
    await settle();
    assert.deepEqual(mutating(calls), []);
  });
});
