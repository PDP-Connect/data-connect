// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
// Closed vocabulary for Remote access. Nothing the owner reads outside
// Details → Diagnostics may contain: the old name "reachability", an
// underscore-joined code, a dotted capability flag or an ISO-8601 timestamp.
// Two scans enforce it: the string literals in the source files, and the text
// rendered for each main state (which also covers library and server values).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { mock } from "node:test";
import { JSDOM } from "jsdom";
import * as React from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import type { requestReachability } from "./reachability-actions.ts";
import { ERROR_MESSAGES, GENERIC_ERROR, genericErrorFor, publicError } from "./reachability-errors.ts";
import { ReachabilityFailure, toDisplayError } from "./diagnostics.tsx";
import { formatLocalTime, plain } from "./plain-text.ts";
import { ProviderSetup } from "./provider-setup.tsx";
import { RuntimeRouteConsentCard, SetupApprovalCard } from "./reachability-consent.tsx";
import { TurnOnCard } from "./turn-on.tsx";

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

const banned: Array<[string, RegExp]> = [
  ["reachability", /reachability/i],
  ["underscore-joined code", /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/i],
  ["dotted flag", /\b(?:installer|privilege|secrets|runtime|host)\.[a-z]/i],
  ["ISO timestamp", /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/],
];

export function bannedIn(text: string): string[] {
  return banned.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

function assertClean(label: string, text: string) {
  const hits = bannedIn(text);
  assert.deepEqual(hits, [], `${label} shows ${hits.join(", ")}:\n${text}`);
}

// ---------- 1. source literals ----------

const dir = new URL(".", import.meta.url);
const sourceFiles = [
  "remote-access-setting.tsx",
  "provider-setup.tsx",
  "reachability-consent.tsx",
  "route-display.ts",
  "on-card.tsx",
  "choose-way.tsx",
  "choose-way.ts",
  "reachability-actions.ts",
  "diagnostics.tsx",
  "page.tsx",
];
// JSX attributes whose value a person reads (or a screen reader announces).
const displayedAttributes = new Set(["aria-label", "placeholder", "title", "alt", "label"]);
const comparisonOperators = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);
const nonDisplayCalls = new Set(["getItem", "setItem", "removeItem", "includes", "hasOwn", "test", "startsWith", "parse"]);

export function userFacingLiterals(fileName: string, code: string): string[] {
  const kind = fileName.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, kind);
  const found: string[] = [];
  const tagOf = (node: ts.Node) =>
    ts.isJsxElement(node) ? node.openingElement.tagName.getText(source) : undefined;

  function isDisplayed(node: ts.Node): boolean {
    let insideJsxExpression = false;
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (tagOf(parent) === "Diagnostics") return false; // Details may show codes.
      if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent) || ts.isCaseClause(parent)) return false;
      if (ts.isBinaryExpression(parent) && comparisonOperators.has(parent.operatorToken.kind)) return false;
      if (ts.isCallExpression(parent)) {
        const callee = parent.expression;
        const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : callee.getText(source);
        if (nonDisplayCalls.has(name) && parent.arguments.some((arg) => arg === node || node.pos >= arg.pos && node.end <= arg.end)) {
          return false;
        }
      }
      if (ts.isJsxAttribute(parent)) {
        return displayedAttributes.has(parent.name.getText(source));
      }
      if (ts.isJsxExpression(parent)) insideJsxExpression = true;
      if (ts.isTypeNode(parent)) return false;
    }
    return insideJsxExpression || /\s/.test(literalText(node));
  }
  function literalText(node: ts.Node): string {
    return ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node) ? node.text : "";
  }
  function visit(node: ts.Node) {
    if (tagOf(node) === "Diagnostics") return;
    if (ts.isJsxText(node)) {
      if (node.text.trim()) found.push(node.text.trim());
    } else if (ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node)) {
      if (!ts.isTypeNode(node.parent) && isDisplayed(node)) found.push(node.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return found;
}

// A literal that matches a banned shape can reach the screen through a
// variable or a lookup table, where `userFacingLiterals` cannot follow it. So
// every string literal that has a banned shape must be a comparison, a storage
// key, a code handed to the error table, or be listed here on purpose.
const nonDisplayCallsForCodes = new Set([...nonDisplayCalls, "publicError", "genericErrorFor"]);
const allowedBannedLiterals = new Set<string>([
  "reachability-errors.ts: reachability_unavailable",
  // The request path. It is a URL, never displayed.
  "reachability-actions.ts: /v1/owner/reachability",
]);

export function bannedLiteralsAnywhere(fileName: string, code: string): string[] {
  const kind = fileName.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, kind);
  const found: string[] = [];
  const excluded = (node: ts.Node): boolean => {
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (ts.isTypeNode(parent) || ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent) || ts.isCaseClause(parent)) return true;
      if (ts.isBinaryExpression(parent) && comparisonOperators.has(parent.operatorToken.kind)) return true;
      if (ts.isJsxElement(parent) && parent.openingElement.tagName.getText(source) === "Diagnostics") return true;
      if (ts.isCallExpression(parent)) {
        const callee = parent.expression;
        const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : callee.getText(source);
        if (nonDisplayCallsForCodes.has(name) && parent.arguments.some((arg) => node.pos >= arg.pos && node.end <= arg.end)) return true;
      }
      if (ts.isJsxAttribute(parent) && !displayedAttributes.has(parent.name.getText(source))) return true;
    }
    return false;
  };
  function visit(node: ts.Node) {
    if ((ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node)) && bannedIn(node.text).length > 0 && !excluded(node)) {
      if (!allowedBannedLiterals.has(`${fileName}: ${node.text}`)) found.push(node.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return found;
}

test("no source literal with a banned shape can reach the screen by another route", () => {
  for (const file of sourceFiles) {
    const literals = bannedLiteralsAnywhere(file, readFileSync(new URL(file, dir), "utf8"));
    assert.deepEqual(literals, [], `${file}: banned-shape literals that are not comparisons, storage keys or listed:\n${literals.join("\n")}`);
  }
});

test("the wide scan catches a code shown through a variable or a lookup table", () => {
  const sample = `
    const shown = "owner_password_required";
    const labels = { a: "installer.execute", b: "Proof 2026-11-18T13:05:42Z" };
    const ok = result.code === "owner_password_required";
    switch (code) { case "owner_password_required": break; }
    localStorage.getItem("reachability-draft");
    publicError("configuration_stale");
    export const view = () => (<p>{shown}{labels.a}</p>);`;
  assert.deepEqual(bannedLiteralsAnywhere("sample.tsx", sample), [
    "owner_password_required",
    "installer.execute",
    "Proof 2026-11-18T13:05:42Z",
  ]);
});

test("user-facing string literals in the Remote access files use the closed vocabulary", () => {
  for (const file of sourceFiles) {
    const literals = userFacingLiterals(file, readFileSync(new URL(file, dir), "utf8"));
    assert.ok(file === "route-display.ts" || file === "reachability-actions.ts" || literals.length > 0, `${file}: no literals found; the scanner is broken`);
    for (const literal of literals) assertClean(`${file}: "${literal}"`, literal);
  }
});

test("the scanner flags each banned shape and ignores codes used only in logic", () => {
  const sample = `
    const a = result.code === "owner_password_required";
    localStorage.getItem("reachability-draft");
    export const view = () => (
      <section aria-label="Remote access" className="grid gap-3 reachability">
        <p>owner_password_required</p>
        <p>{"installer.execute: false"}</p>
        <p>{cond ? "Off" : "Proof: 2026-11-18T13:05:42.477Z"}</p>
        <p>Reachability could not complete.</p>
        <Diagnostics><p>owner_password_required</p></Diagnostics>
      </section>
    );`;
  const found = userFacingLiterals("sample.tsx", sample);
  assert.deepEqual(found, [
    "Remote access",
    "owner_password_required",
    "installer.execute: false",
    "Off",
    "Proof: 2026-11-18T13:05:42.477Z",
    "Reachability could not complete.",
  ]);
  assert.deepEqual(bannedIn("owner_password_required"), ["underscore-joined code"]);
  assert.deepEqual(bannedIn("installer.execute: false"), ["dotted flag"]);
  assert.deepEqual(bannedIn("2026-11-18T13:05:42.477Z"), ["ISO timestamp"]);
  assert.deepEqual(bannedIn("Reachability"), ["reachability"]);
  assert.deepEqual(bannedIn("Works from the internet · checked 1:05 PM · 127.0.0.1:37807 · localhost.run"), []);
});

// ---------- 2. display boundary and error table ----------

test("plain() removes codes, flags, ISO times and the old name from library text", () => {
  const options = { locale: "en-US", timeZone: "UTC", now: Date.parse("2026-11-18T12:00:00Z") };
  assert.equal(plain("owner_password_required", options), "owner password required");
  assert.equal(plain("needs-provider-call", options), "needs provider call");
  assert.equal(plain("installer.execute: false", options), "installer execute: false");
  assert.equal(plain("Reachability choices", options), "Remote access choices");
  assert.match(plain("seen 2026-11-18T13:05:42.477Z", options), /^seen 1:05.PM$/);
  assert.match(plain("seen 2026-11-19T13:05:00Z", options), /^seen Nov 19, 1:05.PM$/);
  assert.equal(plain("Open https://owner.example.invalid/x and localhost.run", options), "Open https://owner.example.invalid/x and localhost.run");
  assert.equal(formatLocalTime("not a time"), "an unknown time");
});

test("plain() leaves URLs, host names, addresses, queries and commands alone", () => {
  const options = { locale: "en-US", timeZone: "UTC", now: Date.parse("2026-11-18T12:00:00Z") };
  for (const value of [
    "host.example.com",
    "secrets.example.com",
    "localhost.run",
    "127.0.0.1:37807",
    "https://owner.example.invalid/x?since=2026-11-18T13:05:42Z",
    "reset_password?client_id=abc&scope=read_only",
    "Open reset_password?client_id=abc in a browser",
    "Run ./install_helper --target=host.example.com",
    "user@host.example.com",
    "my_api_key_name=value",
  ]) {
    assert.equal(plain(value, options), value);
  }
  // A code on its own, or a whole word of one, is still rewritten.
  assert.equal(plain("Fix needs_provider_call now", options), "Fix needs provider call now");
});

test("instructions the owner must copy are shown exactly as given", async () => {
  const instructions = "Open reset_password?client_id=abc on host.example.com and run ./install_helper --target=127.0.0.1:37807";
  const copyRoute = {
    ...route,
    binding: { ...route.binding, remedy: { label: "Fix", instructions, disclosure: { text: "" } } },
    facts: [{ id: "v", group: "address", label: "Address", known: true, value: "host.example.com", source: "provider", asOf: null }],
  };
  await withScreen(world({ "/state": ok({ routes: [copyRoute], reasons: {}, lifecycle: lifecycle("stale"), starting: false }) }), async ({ container }) => {
    const text = visibleText(container);
    assert.ok(text.includes(instructions), text);
  });
  const html = renderToStaticMarkup(
    createElement(TurnOnCard, {
      busy: false,
      changed: null,
      review: { id: "r", kind: "route", candidate: {
        display: { label: "Service" },
        consent: {
          facts: [{ id: "v", group: "address", label: "Address", known: true, value: "host.example.com", source: "provider", asOf: null }],
          disclosures: {},
          consentFactsDigest: "d",
          scope: { kind: "route", query: { target: "127.0.0.1:37807", expectedOrigin: "https://abc.example.invalid" } },
        },
        consentFactsDigest: "d",
        facts: [],
      } } as never,
      onTurnOn: () => {},
    })
  );
  assert.ok(html.includes(">host.example.com<"), html);
});

test("every error message is plain, and an unknown code gets the generic message", () => {
  for (const [code, message] of Object.entries(ERROR_MESSAGES)) assertClean(`message for ${code}`, message);
  assertClean("generic message", GENERIC_ERROR);
  assert.equal(publicError("some_future_code", "server sentence").message, GENERIC_ERROR);
  assert.equal(publicError("some_future_code", "server sentence").serverMessage, "server sentence");
  assert.equal(publicError(undefined).message, GENERIC_ERROR);
  assert.equal(publicError("toString").message, GENERIC_ERROR);
  assert.equal(publicError("host_path_too_long").message, "DataConnect's data folder path is too long for remote access.");
});

// ---------- 3. rendered states ----------

type Result = Awaited<ReturnType<typeof requestReachability>>;
type Handler = (url: string, body?: Record<string, unknown>) => Result;
const ok = (data: unknown): Result => ({ ok: true, data });
const fail = (code: string, serverMessage = "The reachability operation could not complete. Review its current state before retrying."): Result => ({
  ok: false,
  ...publicError(code, serverMessage),
});

const isoA = "2026-11-18T13:00:01.000Z";
const isoB = "2026-11-18T13:05:42.477Z";
const provider = (providerId: string, label: string, reach: string) => ({
  providerId,
  label,
  reach,
  transport: "https_tunnel",
  availability: {
    session: { state: "available", reason: "" },
    durable: { state: "action-required", reason: "provider_action_required" },
    attached: { state: "detect-only", reason: "http-https-only-in-0.4; raw passthrough deferred" },
  },
  configuration: { revision: "r1", actions: [], inputRequirements: [], values: {}, credentials: {} },
  facts: [],
  prerequisites: [
    {
      id: "installer.execute",
      label: "installer_execute ready",
      state: "present",
      observedAt: isoA,
      remedy: { label: "Fix_it", instructions: "Install the helper, then check again.", disclosure: { text: "" } },
      version: { known: false, reason: "host-supervisor-unavailable" },
    },
  ],
});
const route = {
  handle: { id: "route-1", generation: 1, kind: "route" },
  origin: "https://abc.example.invalid",
  binding: {
    authority: "host_authority",
    remedy: { label: "Fix_binding", instructions: "Reconnect the helper.", disclosure: { text: "" } },
    target: { known: false, reason: "effective-target-not-observed" },
  },
  cleanup: { state: "none", nextAction: null },
  facts: [
    { id: "f1", group: "address_conditions", label: "tls_termination", known: false, reason: "needs-provider-call", source: "provider_library", asOf: isoA },
    { id: "f2", group: "cost", label: "Cost", known: true, value: "free", source: "provider", asOf: null },
  ],
  hostConfiguration: { target: { known: true, value: "127.0.0.1:37807" } },
  routeState: "verified",
  state: "usable",
  verification: {
    status: "verified",
    vantage: "public",
    observedAt: isoB,
    validUntil: { known: true, value: "2026-11-18T13:06:00.000Z" },
  },
};
const lifecycle = (phase: string) => ({ handle: route.handle, phase, confinement: { known: false }, cleanup: "none", stopRequested: false });
const host = {
  known: true,
  value: {
    revision: "h1",
    mode: "off",
    port: { known: true, value: 37807 },
    password: { known: true, value: false },
    target: { known: true, value: "127.0.0.1:37807" },
  },
};
function world(overrides: Partial<Record<string, Result>> = {}): Handler {
  const table: Record<string, Result> = {
    "/catalog": ok({
      catalogRevision: "c1",
      observedAt: isoA,
      schemaVersion: 1,
      providers: [
        provider("p-tunnel", "Tunnel for reachability", "public"),
        provider("p-lan", "Local network", "lan"),
      ],
    }),
    "/state": ok({
      routes: [route],
      reasons: { "route-1": "proof_refresh_unsupported" },
      lifecycle: lifecycle("stale"),
      operations: [
        { operationId: "op-1", stage: "unknown-possibly-live", failureCode: "host_path_too_long", recovery: { available: true, reason: "route_reconciliation_required" } },
      ],
      starting: false,
    }),
    "/host-settings": ok(host),
    "/host-capabilities": ok({
      "installer.execute": { known: true, value: false },
      "runtime.durable": { known: false, reason: "host-capability-undeclared" },
    }),
    ...overrides,
  };
  return (url) => table[url.split("?")[0]!] ?? fail("route_not_found");
}

const readyCandidate = {
  providerId: "p-tunnel",
  display: { label: "Tunnel service", description: "", needs: "" },
  consentFactsDigest: "digest-1",
  expiresAt: "2999-01-01T00:00:00.000Z",
  eligible: true,
  facts: [{ id: "cost", group: "cost", label: "Cost", known: true, value: "free", source: "provider", asOf: null }],
  consent: {
    consentFactsDigest: "digest-1",
    scope: {
      kind: "route",
      query: { target: "127.0.0.1:37807", expectedOrigin: null, usage: { kind: "session", lifetimeMs: 3_600_000 } },
    },
    facts: [{ id: "cost", group: "cost", label: "Cost", known: true, value: "free", source: "provider", asOf: null }],
    disclosures: {
      traffic: { providerCanReadPayload: true },
      cost: { kind: "free", summary: "Free" },
      address: { stability: "ephemeral" },
    },
  },
};
const readyDraft = { draftId: "d-1", configuration: { revision: "r2", actions: [], inputRequirements: [], values: {}, credentials: {} } };
// An idle host with a ready review, so the card opens at Turn on.
const readyWorld = (overrides: Partial<Record<string, Result>> = {}) =>
  world({
    "/state": ok({ routes: [], reasons: {}, starting: false }),
    "/drafts": ok(readyDraft),
    "/drafts/d-1/commit": ok(readyDraft.configuration),
    "/drafts/d-1/review": ok({ id: "rev-1", kind: "route", candidate: readyCandidate }),
    ...overrides,
  });

function visibleText(container: Element): string {
  const clone = container.cloneNode(true) as Element;
  for (const node of clone.querySelectorAll("[data-diagnostics]")) node.remove();
  const attributes = [...clone.querySelectorAll("[aria-label],[placeholder],[title]")].flatMap((node) =>
    ["aria-label", "placeholder", "title"].map((name) => node.getAttribute(name) ?? "")
  );
  return [clone.textContent ?? "", ...attributes].join("\n");
}

async function withScreen<T>(
  handler: Handler,
  run: (screen: { container: Element; act: typeof act; settle: () => Promise<void> }) => Promise<T>
): Promise<T> {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  Object.assign(globalThis, {
    React,
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
    localStorage: dom.window.localStorage,
    sessionStorage: dom.window.sessionStorage,
  });
  const { RemoteAccessSetting } = await import("./remote-access-setting.tsx");
  const container = dom.window.document.querySelector("#root")!;
  const root = createRoot(container);
  const request = (async (url: string, body?: Record<string, unknown>) => handler(url, body)) as typeof requestReachability;
  try {
    await act(async () => root.render(createElement(RemoteAccessSetting, { request, appVersion: "0.0.0-test" })));
    return await run({ container, act, settle: () => act(async () => {}) });
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
}

test("the main state, with library and server values full of codes, shows none", async () => {
  await withScreen(world(), async ({ container }) => {
    const text = visibleText(container);
    assertClean("main state", text);
    assert.match(text, /Remote access/);
    assert.match(text, /Needs your action/);
    assert.match(text, /We lost track of the address\. It may still be on\./);
    assert.match(text, /too long for remote access/);
    assert.match(text, /Works from the internet · checked (just now|\d+ (min|hr|days?) ago)/);
    assert.doesNotMatch(text, /Staged configuration|Reload draft|Commit and review route|Host settings/);
    // Host internals live under Details.
    const details = [...container.querySelectorAll("[data-diagnostics]")].map((node) => node.textContent).join("\n");
    assert.match(details, /installer\.execute: false/);
    assert.match(details, /Target: 127\.0\.0\.1:37807/);
  });
});

test("the default way opens at Turn on, in plain words, with no old setup screens", async () => {
  await withScreen(readyWorld(), async ({ container, settle }) => {
    await settle();
    const text = visibleText(container);
    assertClean("ready to turn on", text);
    assert.match(text, /Step 2 of 2 · Turn on/);
    assert.match(text, /Tunnel service can see what passes through\./);
    assert.match(text, /Turns off by itself\./);
    assert.doesNotMatch(text, /\b\d+\s*(seconds?|minutes?|hours?)\b|1 hour|15 minutes/);
    assert.match(text, /Turn on remote access/);
    assert.doesNotMatch(text, /Continue setup|Staged configuration|Reload|Start setup|Save and review|Discard|Review reachability|Apply reachability/);
    assert.doesNotMatch(text, /\b(draft|route|attached|session|durable)\b/i);
    assert.equal(container.querySelector('input[type="checkbox"]'), null, "there is no approval checkbox");
  });
});

test("a failed first load says what to do, keeps the code in Details, and clears on the next good load", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let healthy = false;
  const handler = world();
  await withScreen(
    (url, body) => (healthy ? handler(url, body) : fail("owner_password_required")),
    async ({ container, act: run }) => {
      const text = visibleText(container);
      assertClean("failed load", text);
      assert.match(text, /Set a password first/);
      assert.match(text, /Can't reach DataConnect's background service/);
      const details = container.querySelector("[role=alert] [data-diagnostics]")!.textContent!;
      assert.match(details, /Code: owner_password_required/);
      assert.match(details, /App version: 0\.0\.0-test/);
      assert.match(details, /Server message: The reachability operation/);
      assert.ok([...container.querySelectorAll("button")].some((node) => node.textContent === "Copy diagnostics"));
      healthy = true;
      await run(async () => t.mock.timers.tick(3000));
      assert.equal(container.querySelector("[role=alert]"), null, "the load error stays after a good load");
    }
  );
});

test("an unknown error code shows the generic message, and an action error survives a later load", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const handler = readyWorld({ "/operations": fail("brand_new_server_code") });
  await withScreen(handler, async ({ container, act: run, settle }) => {
    await failFirstAction(container, run, settle);
    const text = visibleText(container);
    assertClean("action error", text);
    assert.match(text, /Remote access couldn.t turn on\. Try again, or copy the details for support\./);
    assert.ok(container.querySelector("[role=alert] [data-diagnostics]")!.textContent!.includes("brand_new_server_code"));
    await run(async () => t.mock.timers.tick(3000));
    assert.ok(container.querySelector("[role=alert]"), "an action error should stay until the next action");
  });
});

test("setup, approval and consent cards show no codes, flags or ISO times", () => {
  const facts = [
    { id: "f", group: "tls_termination", label: "metadata_visible_to", known: false, reason: "needs-provider-call", source: "provider_library", asOf: isoA },
    { id: "g", group: "cost", label: "Cost", known: true, value: "free", source: "x", asOf: null },
  ];
  const disclosures = { requiresPrivilege: false, expires_at: isoB, "installer.execute": "needs_provider_call", note: "Reachability" };
  const consent = { facts, disclosures, consentFactsDigest: "d", scope: { kind: "route", query: { target: "127.0.0.1:37807", expectedOrigin: "https://abc.example.invalid" } } };
  const html = [
    renderToStaticMarkup(
      createElement(TurnOnCard, { busy: false, changed: null, review: { id: "r", kind: "route", candidate: { consent, consentFactsDigest: "d", facts: [], display: { label: "Service" } } } as never, onTurnOn: () => {} })
    ),
    renderToStaticMarkup(
      createElement(RuntimeRouteConsentCard, {
        review: { ...consent, scope: consent.scope, expiresAt: "2999-01-01T00:00:00.000Z" } as never,
        onApprove: () => {},
      })
    ),
    renderToStaticMarkup(
      createElement(SetupApprovalCard, {
        action: {
          id: "a",
          label: "Allocate_workshop",
          digest: "x",
          disclosure: { revision: "1", text: "", links: [] },
          consent: { ...consent, scope: { kind: "setup", actionId: "a", actionDigest: "x", disclosureRevision: "1" } },
        } as never,
        onApprove: () => {},
      })
    ),
  ];
  for (const markup of html) {
    const dom = new JSDOM(`<div id="r">${markup}</div>`);
    assertClean("consent card", visibleText(dom.window.document.querySelector("#r")!));
  }
});

test("setup status cards show no codes in any state", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  Object.assign(globalThis, { React, window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true, localStorage: dom.window.localStorage, sessionStorage: dom.window.sessionStorage });
  const container = dom.window.document.querySelector("#root")!;
  const reservation = {
    operationId: "o-1",
    providerId: "p-1",
    draftId: "d-1",
    providerLabel: "Tunnel for reachability",
    actionId: "a",
    expectedConfigurationRevision: "c",
    usage: "session",
  };
  const states = ["authorization-required", "pending", "denied", "expired", "blocked", "reconciling", "complete", "cancelled"];
  try {
    for (const state of states) {
      const request = (async () =>
        ok({
          operationId: "o-1",
          revision: 1,
          state,
          resources: [{ handle: "h", label: "dns_record", ownership: "created_by_setup", removal: "required" }],
          scope: { draftId: "d-1", configurationRevision: "c" },
          evidence: { known: true, value: { summary: `Checked ${isoA}` } },
          nextAction: null,
        })) as unknown as typeof requestReachability;
      const root = createRoot(container);
      await act(async () =>
        root.render(createElement(ProviderSetup, { reservation, request, disabled: false, acknowledgeDisconnect: false, onChange: async () => {}, onReadiness: () => {} }))
      );
      assertClean(`setup state ${state}`, visibleText(container));
      await act(async () => root.unmount());
    }
    const root = createRoot(container);
    const failing = (async () => fail("setup_required")) as unknown as typeof requestReachability;
    await act(async () =>
      root.render(createElement(ProviderSetup, { reservation, request: failing, disabled: false, acknowledgeDisconnect: false, onChange: async () => {}, onReadiness: () => {} }))
    );
    const text = visibleText(container);
    assertClean("setup error", text);
    assert.match(text, /A step is needed before remote access can turn on/);
    await act(async () => root.unmount());
  } finally {
    dom.window.close();
  }
});

// ---------- 4. polls and actions ----------

// Presses Turn on, which the test host refuses.
async function failFirstAction(container: Element, run: typeof act, settle: () => Promise<void>) {
  await settle();
  const turnOn = [...container.querySelectorAll("button")].find((node) => node.textContent === "Turn on remote access")!;
  await run(async () => turnOn.click());
  await settle();
}
const alertText = (container: Element) => container.querySelector("[role=alert]")?.textContent ?? "";

test("a failed background poll does not replace an action error, and a good poll does not erase it", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let catalog: Result | null = null;
  const base = readyWorld({ "/operations": fail("brand_new_server_code") });
  const handler: Handler = (url, body) => (url === "/catalog" && catalog ? catalog : base(url, body));
  await withScreen(handler, async ({ container, act: run, settle }) => {
    await failFirstAction(container, run, settle);
    assert.match(alertText(container), /couldn.t turn on/);
    catalog = fail("owner_password_required");
    await run(async () => t.mock.timers.tick(3000));
    await settle();
    assert.match(alertText(container), /couldn.t turn on/, "the poll failure took over the action error");
    assert.doesNotMatch(alertText(container), /Set a password first/);
    catalog = null;
    await run(async () => t.mock.timers.tick(3000));
    await settle();
    assert.match(alertText(container), /couldn.t turn on/, "a good poll erased the action error");
  });
});

test("a poll that started before an action cannot overwrite the action's error when it lands late", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let release: (value: Result) => void = () => {};
  let hold = false;
  const base = readyWorld({ "/operations": fail("brand_new_server_code") });
  const handler = ((url: string, body?: Record<string, unknown>) => {
    if (hold && url === "/catalog") {
      hold = false;
      return new Promise<Result>((resolve) => {
        release = resolve;
      });
    }
    return base(url, body);
  }) as unknown as Handler;
  await withScreen(handler, async ({ container, act: run, settle }) => {
    hold = true;
    await run(async () => t.mock.timers.tick(3000)); // poll starts and waits
    await failFirstAction(container, run, settle); // the action fails meanwhile
    assert.match(alertText(container), /couldn.t turn on/);
    await run(async () => release(fail("owner_password_required"))); // the old poll lands late, as a failure
    await settle();
    assert.match(alertText(container), /couldn.t turn on/);
    assert.doesNotMatch(alertText(container), /Set a password first/);
  });
});

test("polls that finish out of order apply the newest answer only", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const releases: Array<(value: Result) => void> = [];
  let stateCalls = 0;
  // No ways, so the page runs no preparation of its own to confuse the poll count.
  const base = world({ "/state": ok({ routes: [], reasons: {}, starting: false }), "/catalog": ok({ catalogRevision: "c1", observedAt: isoA, schemaVersion: 1, providers: [] }) });
  const closed = ok({
    routes: [],
    reasons: {},
    lifecycle: { handle: null, phase: "idle", confinement: { known: false }, cleanup: "unconfirmed", stopRequested: false },
    starting: false,
  });
  const handler = ((url: string, body?: Record<string, unknown>) => {
    if (url !== "/state") return base(url, body);
    stateCalls += 1;
    if (stateCalls === 2) return new Promise<Result>((resolve) => releases.push(resolve)); // older poll, slow
    if (stateCalls === 3) return closed; // newer poll, fast
    return base(url, body);
  }) as unknown as Handler;
  await withScreen(handler, async ({ container, act: run, settle }) => {
    await run(async () => t.mock.timers.tick(3000)); // poll 2 starts and waits
    await run(async () => t.mock.timers.tick(3000)); // poll 3 finishes first
    await settle();
    assert.match(visibleText(container), /couldn.t confirm your address is closed/);
    await run(async () => releases[0]!(ok({ routes: [], reasons: {}, starting: false }))); // the older answer lands last
    await settle();
    assert.match(visibleText(container), /couldn.t confirm your address is closed/, "an older poll overwrote a newer one");
  });
});

test("the fallback error names the action that failed", async () => {
  assert.match(publicError("brand_new", undefined, "turn-off").message, /couldn.t turn off\. It may still be on/);
  assert.match(publicError("brand_new", undefined, "check").message, /couldn.t check remote access/);
  assert.match(publicError("brand_new").message, /couldn.t turn on/);
  for (const action of ["turn-on", "turn-off", "check", "change"] as const) assertClean(`fallback ${action}`, genericErrorFor(action));
  // A known code keeps its own sentence whatever the action.
  assert.equal(publicError("host_path_too_long", undefined, "turn-off").message, ERROR_MESSAGES.host_path_too_long);
  // A fallback fixed before the action was known is reworded for it.
  const fixed = toDisplayError(new ReachabilityFailure({ ...publicError("brand_new"), serverMessage: "x" }), "action", undefined, "turn-off");
  assert.match(fixed.message, /turn off/);
  assert.match(toDisplayError(new Error("boom"), "action", undefined, "check").message, /check remote access/);
});

test("a failed turn off says so on screen", async () => {
  const stop = fail("brand_new_server_code");
  const handler: Handler = (url, body) =>
    url.endsWith("/stop") ? stop : world()(url, body);
  await withScreen(handler, async ({ container, act: run, settle }) => {
    const press = async (label: RegExp) => {
      const button = [...container.querySelectorAll("button")].find((node) => label.test(node.textContent ?? ""));
      assert.ok(button, `no button matching ${label}`);
      await run(async () => button.click());
      await settle();
    };
    const ack = container.querySelector<HTMLInputElement>('input[type="checkbox"]');
    if (ack) await run(async () => ack.click());
    await press(/^Turn off$/);
    assert.match(alertText(container), /couldn.t turn off\. It may still be on/);
  });
});
