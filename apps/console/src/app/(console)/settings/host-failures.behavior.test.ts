// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
// Failures that carry a fix on the Remote access card: unsafe folder permissions,
// the background service, an address that may still be on, a stale configuration.
import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { JSDOM } from "jsdom";
import * as React from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { requestReachability } from "./reachability-actions.ts";
import { publicError } from "./reachability-errors.ts";
import { unsafeStateFolderError } from "./real-gozar-shapes.fixture.ts";
import { publicReachabilityError } from "../../../../../../reference-implementation/server/routes/owner-reachability.ts";

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
const fail = (code: string): Result => ({ ok: false, ...publicError(code, "The server's own words with host_code") });
const SNAKE = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/;

const fact = { id: "Cost", group: "cost", label: "Cost", known: true, value: "free", source: "provider", asOf: null };
const candidate = {
  providerId: "p-tunnel",
  display: { label: "Tunnel service", description: "", needs: "" },
  consentFactsDigest: "digest-1",
  expiresAt: "2999-01-01T00:00:00.000Z",
  eligible: true,
  facts: [fact],
  consent: {
    consentFactsDigest: "digest-1",
    scope: { kind: "route", query: { target: "127.0.0.1:1", expectedOrigin: null, usage: { kind: "session", lifetimeMs: 3_600_000 } } },
    facts: [fact],
    disclosures: { traffic: { providerCanReadPayload: true }, cost: { kind: "free", summary: "Free" }, address: { stability: "ephemeral" } },
  },
};
const review = { id: "rev-1", kind: "route", candidate };
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
const idleState = { routes: [], reasons: {}, starting: false, services: [] };

type Handler = (call: Call) => Result | Promise<Result>;
function host(over: Record<string, Result | Handler> = {}): Handler {
  const table: Record<string, Result | Handler> = {
    "/catalog": ok(catalog),
    "/state": ok(idleState),
    "/host-settings": ok({ known: false, reason: "unavailable" }),
    "/host-capabilities": ok({}),
    "/drafts": ok(draft),
    "/drafts/d-1/commit": ok(draft.configuration),
    "/drafts/d-1/review": ok(review),
    ...over,
  };
  return (call) => {
    const hit = table[call.url.split("?")[0]!];
    if (!hit) return fail("route_not_found");
    return typeof hit === "function" ? hit(call) : hit;
  };
}

async function withScreen<T>(
  handler: Handler,
  run: (screen: {
    calls: Call[];
    press: (label: RegExp) => Promise<void>;
    settle: () => Promise<void>;
    text: () => string;
    mainText: () => string;
    alerts: () => number;
    buttons: () => string[];
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
      calls,
      settle,
      text: () => container.textContent ?? "",
      mainText: () => {
        const copy = container.cloneNode(true) as Element;
        for (const node of copy.querySelectorAll("[data-diagnostics]")) node.remove();
        return copy.textContent ?? "";
      },
      alerts: () => container.querySelectorAll("[role=alert]").length,
      buttons: () => [...container.querySelectorAll("button")].map((node) => node.textContent ?? ""),
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

// ---------- folder permissions ----------

const UNSAFE_WORDS = /A DataConnect folder can be changed by other accounts on this computer\. Fix its permissions to continue\./;

test("unsafe folder permissions offer a fix, and after it the card moves on with no reload", async () => {
  let fixed = false;
  const handler = host({
    "/catalog": () => (fixed ? ok(catalog) : fail("unsafe_state_path")),
    "/state-paths": ok({ paths: [{ path: "/data", reason: "writable-by-others", fixable: true }], command: null }),
    "/state-paths/fix": () => {
      fixed = true;
      return ok({ paths: [], command: null });
    },
  });
  await withScreen(handler, async ({ calls, press, mainText, text, buttons }) => {
    assert.match(mainText(), UNSAFE_WORDS);
    assert.match(mainText(), /Needs your action/);
    assert.doesNotMatch(mainText(), SNAKE);
    assert.ok(buttons().includes("Fix permissions"));
    assert.equal(calls.filter((call) => call.url === "/state-paths/fix").length, 0, "nothing is changed before the click");
    await press(/^Fix permissions$/);
    assert.deepEqual(calls.filter((call) => call.url === "/state-paths/fix").map((call) => call.body), [{}]);
    assert.doesNotMatch(text(), UNSAFE_WORDS);
    assert.match(text(), /Turn on remote access/, "step 2 shows without a reload");
  });
});

test("a folder outside DataConnect's own directory shows the command to copy and sends no change", async () => {
  const command = "chmod go-w -- '/home/someone'";
  const handler = host({
    "/catalog": fail("unsafe_state_path"),
    "/state-paths": ok({ paths: [{ path: "/home/someone", reason: "writable-by-others", fixable: false }], command }),
  });
  await withScreen(handler, async ({ calls, mainText, buttons }) => {
    assert.match(mainText(), UNSAFE_WORDS);
    assert.ok(mainText().includes(command));
    assert.ok(!buttons().includes("Fix permissions"));
    assert.ok(buttons().includes("Copy command"));
    assert.ok(!calls.some((call) => call.url === "/state-paths/fix"));
  });
});

test("when the fix leaves a folder outside the data directory, the card shows its command", async () => {
  const command = "chmod go-w -- '/home/someone'";
  const handler = host({
    "/catalog": fail("unsafe_state_path"),
    "/state-paths": ok({
      paths: [
        { path: "/data", reason: "writable-by-others", fixable: true },
        { path: "/home/someone", reason: "writable-by-others", fixable: false },
      ],
      command,
    }),
    "/state-paths/fix": ok({ paths: [{ path: "/home/someone", reason: "writable-by-others", fixable: false }], command }),
  });
  await withScreen(handler, async ({ press, mainText, buttons }) => {
    await press(/^Fix permissions$/);
    assert.match(mainText(), UNSAFE_WORDS);
    assert.ok(mainText().includes(command));
    assert.ok(!buttons().includes("Fix permissions"));
  });
});

// ---------- the background service ----------

test("a background service that is down says so, copies diagnostics, and shows no code outside Details", async () => {
  await withScreen(host({ "/catalog": fail("host_supervisor_unavailable") }), async ({ mainText, text, buttons }) => {
    assert.match(mainText(), /DataConnect's background service isn't running\. Quit and reopen DataConnect\./);
    assert.doesNotMatch(mainText(), SNAKE);
    assert.ok(buttons().includes("Copy diagnostics"));
    assert.match(text(), /Code: host_supervisor_unavailable/);
    assert.match(text(), /Server message: The server's own words with host_code/);
  });
});

test("a path that is too long says so and copies diagnostics", async () => {
  await withScreen(host({ "/catalog": fail("host_path_too_long") }), async ({ mainText, buttons }) => {
    assert.match(mainText(), /data folder path is too long for remote access\./);
    assert.doesNotMatch(mainText(), SNAKE);
    assert.ok(buttons().includes("Copy diagnostics"));
  });
});

// ---------- errors clear ----------

test("a failed load, then a successful one, leaves no error on screen", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let loads = 0;
  const handler = host({ "/catalog": () => (++loads === 1 ? fail("host_supervisor_unavailable") : ok(catalog)) });
  await withScreen(handler, async ({ mainText, alerts, settle }) => {
    assert.equal(alerts(), 1);
    await act(async () => t.mock.timers.tick(3000));
    await settle();
    assert.equal(alerts(), 0);
    assert.match(mainText(), /Turn on remote access/);
  });
});

test("a failed state read shows its words and clears when the next read succeeds", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let reads = 0;
  const handler = host({ "/state": () => (++reads === 1 ? fail("host_runtime_unavailable") : ok(idleState)) });
  await withScreen(handler, async ({ alerts, settle }) => {
    assert.equal(alerts(), 1);
    await act(async () => t.mock.timers.tick(3000));
    await settle();
    assert.equal(alerts(), 0);
  });
});

// ---------- stale configuration ----------

test("a stale configuration retries once on its own, then shows the error and stays Off", async () => {
  let approvals = 0;
  const handler = host({
    "/operations": () => {
      approvals += 1;
      return fail("configuration_stale");
    },
  });
  await withScreen(handler, async ({ press, mainText, buttons }) => {
    await press(/^Turn on remote access$/);
    assert.equal(approvals, 2, "one retry, no more");
    assert.match(mainText(), /Something changed while we were connecting\. Try again\./);
    assert.doesNotMatch(mainText(), SNAKE);
    assert.ok(buttons().includes("Try again"));
    assert.ok(buttons().includes("Turn on remote access"), "still Off with step 2 ready");
  });
});

test("a stale configuration that clears on the retry turns on without an error", async () => {
  let approvals = 0;
  const handler = host({
    "/operations": () => (++approvals === 1 ? fail("configuration_stale") : ok({ operationId: "op-1" })),
  });
  await withScreen(handler, async ({ press, mainText }) => {
    await press(/^Turn on remote access$/);
    assert.equal(approvals, 2);
    assert.doesNotMatch(mainText(), /Something changed/);
  });
});

// ---------- an address that may still be on ----------

const unknownLive = {
  ...idleState,
  operations: [{ operationId: "op-1", kind: "start", stage: "unknown-possibly-live", failureCode: null, handle: null, recovery: null }],
};
const unconfirmed = { cleanup: { state: "unconfirmed" } };

test("an address that may still be on offers Turn off, and stays Needs your action until cleanup is confirmed", async () => {
  const handler = host({ "/state": ok(unknownLive), "/operations/op-1/reconcile": ok(unconfirmed) });
  await withScreen(handler, async ({ calls, press, mainText, buttons }) => {
    assert.match(mainText(), /We lost track of the address\. It may still be on\./);
    assert.ok(buttons().includes("Turn off"));
    await press(/^Turn off$/);
    assert.deepEqual(calls.filter((call) => call.url === "/operations/op-1/reconcile").map((call) => call.body?.action), ["stop"]);
    assert.match(mainText(), /Couldn't confirm remote access is off\. This address may still work\./);
    assert.ok(buttons().includes("Check and turn off"));
    assert.doesNotMatch(mainText(), /Off · Only this computer/);
  });
});

test("a confirmed cleanup returns to Off", async () => {
  let confirmed = false;
  const handler = host({
    "/state": () => ok(confirmed ? idleState : unknownLive),
    "/operations/op-1/reconcile": () => {
      confirmed = true;
      return ok({ cleanup: { state: "confirmed" } });
    },
  });
  await withScreen(handler, async ({ press, mainText }) => {
    await press(/^Turn off$/);
    assert.match(mainText(), /Turn on remote access/);
    assert.doesNotMatch(mainText(), /We lost track/);
  });
});

// The error the real host throws, through the server's own mapping, reaches the card as the fix.
test("the real host's unsafe-folder error becomes the permissions card with its fix button", async () => {
  const code = publicReachabilityError(unsafeStateFolderError).code;
  assert.equal(code, "unsafe_state_path");
  const handler = host({
    "/catalog": fail(code),
    "/state-paths": ok({ paths: [{ path: "/data", reason: "writable-by-others", fixable: true }], command: null }),
  });
  await withScreen(handler, async ({ mainText, buttons }) => {
    assert.match(mainText(), UNSAFE_WORDS);
    assert.doesNotMatch(mainText(), /setup required|A step is needed/);
    assert.ok(buttons().includes("Fix permissions"));
  });
});
