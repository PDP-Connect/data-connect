// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { JSDOM } from "jsdom";
import React, { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { AccessProposal, BindingAccessState } from "../../lib/binding-access-client.ts";

// Console node:test/JSDOM lane; real actions + client, fetch is the fault seam.
// Response shapes are from owner-binding-access-policy.ts and its store.
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
Object.assign(globalThis, {
  React,
  document: dom.window.document,
  window: dom.window,
  HTMLElement: dom.window.HTMLElement,
  Node: dom.window.Node,
  IS_REACT_ACT_ENVIRONMENT: true,
});
Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
let authCalls = 0;
let sessionCalls = 0;
mock.module(new URL("../../lib/dashboard-access.ts", import.meta.url).href, {
  namedExports: {
    requireDashboardAccess: () => {
      authCalls += 1;
      return Promise.resolve();
    },
  },
});
mock.module(new URL("../../lib/verify-session.ts", import.meta.url).href, {
  namedExports: {
    verifyDashboardSession: () => {
      sessionCalls += 1;
      return Promise.resolve();
    },
  },
});
mock.module(new URL("../../lib/owner-token.ts", import.meta.url).href, {
  namedExports: { getOwnerToken: async () => "test-bearer", getAsInternalUrl: () => "http://reference.invalid" },
});
const modules = Promise.all([
  import("./connection-access-review.tsx"),
  import("./access-actions.ts"),
  import("../../lib/binding-access-client.ts"),
]);
function proposal(): AccessProposal {
  return {
    proposalId: "proposal/1",
    revision: 7,
    baseEpoch: 2,
    snapshotDigest: "digest-a",
    status: "proposed",
    snapshot: {
      phase: "PREPARED",
      connectionId: "cin/1",
      policyIdentity: "policy-1",
      expiresAt: Date.now() + 60_000,
      instances: [
        {
          instanceKey: "browser",
          kind: "browser",
          availability: "prepared",
          accessIdentity: "access-1",
          accessRevision: "r1",
          requestedDeclaration: { required: true, constraints: { origins: ["https://example.test"] } },
          effectiveReach: { browser: "all destinations available to this browser" },
          effectiveConstraints: {},
          mechanism: "test-reservation",
          mechanismVersion: "1",
          purpose: "Collect records",
          consequentialActions: ["Read signed-in pages"],
          remainingAmbientAccess: ["Existing signed-in sessions"],
          channels: [
            { name: "browser.navigate", coverage: "recorded" },
            { name: "browser.connect", coverage: "not_observable" },
          ],
        },
      ],
    },
  };
}
function state(p = proposal()): BindingAccessState {
  return { active: null, epoch: 2, revision: p.revision, proposal: p };
}

for (const status of ["rejected", "withdrawn", "superseded"] as const) {
  test(`${status} row retained by the store never offers reuse of its approval`, async () => {
    const p = { ...proposal(), status };
    const view = await mount({ active: null, proposal: p, epoch: 3, revision: p.revision });
    try {
      assert.ok(!view.container.textContent?.includes("You can reuse an approval"));
      assert.ok(!view.container.textContent?.includes("If you approve"));
    } finally {
      await view.close();
    }
  });
}
function button(container: HTMLElement, label: string): HTMLButtonElement {
  const result = [...container.querySelectorAll("button")].find((item) => item.textContent === label);
  assert.ok(result, `missing button ${label}`);
  return result;
}
function boxes(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
}
async function mount(initialState: BindingAccessState | null) {
  const [{ ConnectionAccessReview }] = await modules;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = async (value: BindingAccessState | null, connectionId = "cin/1") =>
    act(async () =>
      root.render(
        createElement(ConnectionAccessReview, {
          connectionId,
          initialState: value,
        })
      )
    );
  await render(initialState);
  return {
    container,
    render,
    close: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test("changing connection clears a review loaded after the initial render", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve(Response.json(state()));
  const view = await mount(null);
  try {
    await act(async () => button(view.container, "Refresh access review").click());
    assert.ok(view.container.textContent?.includes("all destinations available to this browser"));
    assert.equal(boxes(view.container).length, 2);
    await view.render(null, "cin/2");
    assert.ok(
      !view.container.textContent?.includes("all destinations available to this browser"),
      "another connection must not display the previously loaded access"
    );
    assert.equal(boxes(view.container).length, 0);
  } finally {
    await view.close();
    globalThis.fetch = original;
  }
});

test("every weak channel starts unchecked; real action/client sends immutable facts; approval never auto-syncs", async () => {
  const original = globalThis.fetch;
  const p = proposal();
  let current = state(p);
  const requests: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (url, init) => {
    requests.push({ url: String(url), init });
    if (init?.method === "POST") {
      const approved = { ...p, status: "confirmed" as const };
      current = { active: approved, proposal: approved, epoch: 3, revision: 7 };
      return Promise.resolve(Response.json(approved));
    }
    return Promise.resolve(Response.json(current));
  };
  const view = await mount(current);
  try {
    const inputs = boxes(view.container);
    assert.equal(inputs.length, 2);
    assert.ok(inputs.every((box) => !box.checked));
    const approve = button(view.container, "Approve access");
    assert.equal(approve.disabled, true);
    await act(async () => inputs[0]?.click());
    assert.equal(approve.disabled, true);
    await act(async () => inputs[1]?.click());
    assert.equal(approve.disabled, false);
    await act(async () => approve.click());
    const writes = requests.filter((request) => request.init?.method === "POST");
    assert.equal(writes.length, 1);
    assert.equal(
      writes[0]?.url,
      "http://reference.invalid/v1/owner/connections/cin%2F1/binding-access-policy/proposals/proposal%2F1/confirm"
    );
    assert.deepEqual(JSON.parse(String(writes[0]?.init?.body)), {
      revision: 7,
      baseEpoch: 2,
      snapshotDigest: "digest-a",
      acknowledgments: [
        {
          instanceKey: "browser",
          channel: "browser.navigate",
          coverage: "recorded",
          accessIdentity: "access-1",
          accessRevision: "r1",
        },
        {
          instanceKey: "browser",
          channel: "browser.connect",
          coverage: "not_observable",
          accessIdentity: "access-1",
          accessRevision: "r1",
        },
      ],
    });
    for (const request of requests) {
      assert.equal(request.init?.cache, "no-store");
      assert.equal(new Headers(request.init?.headers).get("authorization"), "Bearer test-bearer");
    }
    assert.ok(authCalls > 0 && sessionCalls > 0);
    assert.ok(view.container.textContent?.includes("Approval recorded"));
    assert.equal(document.activeElement?.getAttribute("role"), "status");
    assert.ok(!view.container.innerHTML.includes("test-bearer"));
    assert.ok(view.container.textContent?.includes("Use the sync controls at the top of this page"));
    assert.equal(
      [...view.container.querySelectorAll("button")].filter((item) => item.textContent === "Sync now").length,
      0
    );
    assert.ok(view.container.textContent?.includes("does not stop a sync already running"));
  } finally {
    await view.close();
    globalThis.fetch = original;
  }
});

test("HTTP 409 after concurrent access change clears acknowledgments, preserves old request and never rebases or retries", async () => {
  const original = globalThis.fetch;
  const p = proposal();
  const changed = { ...p, snapshotDigest: "digest-b", revision: 8 };
  const writes: { snapshotDigest: string }[] = [];
  globalThis.fetch = (_url, init) => {
    if (init?.method === "POST") {
      writes.push(JSON.parse(String(init.body)));
      return Promise.resolve(
        Response.json({ error: { code: "binding_access_stale", message: "private diagnostic" } }, { status: 409 })
      );
    }
    return Promise.resolve(Response.json(state(changed)));
  };
  const view = await mount(state(p));
  try {
    act(() => {
      for (const box of boxes(view.container)) {
        box.click();
      }
    });
    await act(async () => button(view.container, "Approve access").click());
    assert.equal(writes.length, 1);
    assert.equal(writes[0]?.snapshotDigest, "digest-a");
    assert.ok(boxes(view.container).every((box) => !box.checked));
    assert.equal(button(view.container, "Approve access").disabled, true);
    assert.ok(!view.container.textContent?.includes("private diagnostic"));
    assert.ok(view.container.textContent?.includes("changed or expired"));
    act(() => {
      for (const box of boxes(view.container)) {
        box.click();
      }
    });
    await act(async () => button(view.container, "Approve access").click());
    assert.equal(writes.length, 2);
    assert.equal(writes[1]?.snapshotDigest, "digest-b");
  } finally {
    await view.close();
    globalThis.fetch = original;
  }
});

test("changed render resets choices; unsupported required/expired access has no approval workaround; optional unprovided resources need no acknowledgment", async () => {
  const p = proposal();
  const view = await mount(state(p));
  try {
    act(() => {
      for (const box of boxes(view.container)) {
        box.click();
      }
    });
    await view.render(state({ ...p, snapshotDigest: "new" }));
    assert.ok(boxes(view.container).every((box) => !box.checked));
    const [instance] = p.snapshot.instances;
    assert.ok(instance);
    const unavailable = { ...instance, instanceKey: "files", kind: "filesystem", availability: "unsupported" as const };
    await view.render(state({ ...p, snapshot: { ...p.snapshot, instances: [instance, unavailable] } }));
    assert.ok(!view.container.textContent?.includes("Approve access"));
    assert.ok(
      view.container.textContent?.includes("filesystem") && view.container.textContent?.includes("unsupported")
    );
    await view.render(
      state({
        ...p,
        snapshot: {
          ...p.snapshot,
          instances: [instance, { ...unavailable, requestedDeclaration: { required: false } }],
        },
      })
    );
    assert.equal(boxes(view.container).length, 2);
    await view.render(state({ ...p, snapshot: { ...p.snapshot, expiresAt: Date.now() - 1 } }));
    assert.ok(!view.container.textContent?.includes("Approve access"));
    assert.ok(view.container.textContent?.includes("expired"));
    await view.render({ active: null, proposal: null, epoch: 0, revision: 0 });
    assert.ok(view.container.textContent?.includes("There is no access review or approval saved for this connection"));
    await view.render(null);
    assert.ok(view.container.querySelector('[role="alert"]'));
  } finally {
    await view.close();
  }
});

test("decline and withdraw use exact fields while active; pending disables duplicates; withdrawal never says stopped", async () => {
  const original = globalThis.fetch;
  const p = proposal();
  let release: (() => void) | undefined;
  const writes: { url: string; body: Record<string, unknown> }[] = [];
  globalThis.fetch = async (url, init) => {
    if (init?.method === "POST") {
      writes.push({ url: String(url), body: JSON.parse(String(init.body)) });
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return Response.json({ ...p, status: String(url).endsWith("withdraw") ? "withdrawn" : "rejected" });
    }
    return Response.json({
      active: null,
      proposal: { ...p, status: writes.at(-1)?.url.endsWith("withdraw") ? "withdrawn" : "rejected" },
      epoch: 4,
      revision: 7,
    });
  };
  const view = await mount(state(p));
  try {
    await act(async () => button(view.container, "Decline").click());
    assert.equal(button(view.container, "Decline").disabled, true);
    assert.equal(writes.length, 1);
    await act(async () => release?.());
    assert.ok(view.container.textContent?.includes("Access declined"));
    const active = { ...p, status: "confirmed" as const };
    await view.render({ active, proposal: active, epoch: 3, revision: 7 });
    await act(async () => button(view.container, "Withdraw approval").click());
    assert.deepEqual(writes[1]?.body, { revision: 7, baseEpoch: 3, snapshotDigest: "digest-a" });
    await act(async () => release?.());
    assert.ok(view.container.textContent?.includes("An active sync may continue"));
    assert.ok(!view.container.textContent?.includes("Stopped"));
    globalThis.fetch = () => Promise.reject(new Error("private transport diagnostic"));
    await act(async () => button(view.container, "Refresh access review").click());
    assert.ok(view.container.textContent?.includes("could not be loaded"));
    assert.equal(writes.length, 2);
  } finally {
    await view.close();
    globalThis.fetch = original;
  }
});

test("owner reads encode proposal namespace; foreign IDs and unknown decision fields are refused", async () => {
  const [, actions, client] = await modules;
  const original = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (url) => {
    urls.push(String(url));
    return Promise.resolve(Response.json(state()));
  };
  try {
    await client.getBindingAccessState("cin/1", "proposal/1");
    assert.ok(urls[0]?.endsWith("/proposals/proposal%2F1"));
    await assert.rejects(client.getBindingAccessState("foreign"), client.BindingAccessHttpError);
    const input = {
      connectionId: "cin/1",
      proposalId: "proposal/1",
      decision: "confirm" as const,
      revision: 7,
      baseEpoch: 2,
      snapshotDigest: "digest-a",
      acknowledgments: [],
      ownerId: "forged",
    };
    const before = urls.length;
    assert.equal((await actions.decideAccessAction(input)).ok, false);
    assert.equal(urls.length, before);
  } finally {
    globalThis.fetch = original;
  }
});
