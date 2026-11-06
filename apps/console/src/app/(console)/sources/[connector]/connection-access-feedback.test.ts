// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { JSDOM } from "jsdom";
import React, { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { AccessProposal, BindingAccessState } from "../../lib/binding-access-client.ts";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
Object.assign(globalThis, {
  React,
  document: dom.window.document,
  window: dom.window,
  self: dom.window,
  Event: dom.window.Event,
  HTMLElement: dom.window.HTMLElement,
  Node: dom.window.Node,
  IS_REACT_ACT_ENVIRONMENT: true,
});
Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });

const revalidated: string[] = [];
mock.module("next/navigation", {
  namedExports: {
    usePathname: () => "/sources/cin_1",
    useRouter: () => ({ refresh: () => undefined }),
  },
});
mock.module("next/cache", {
  namedExports: { revalidatePath: (path: string) => revalidated.push(path) },
});
mock.module(new URL("../../lib/dashboard-access.ts", import.meta.url).href, {
  namedExports: { requireDashboardAccess: () => Promise.resolve() },
});
mock.module(new URL("../../lib/verify-session.ts", import.meta.url).href, {
  namedExports: { verifyDashboardSession: () => Promise.resolve() },
});
mock.module(new URL("../../lib/owner-token.ts", import.meta.url).href, {
  namedExports: {
    getOwnerToken: () => Promise.resolve("fictional-owner-bearer"),
    getAsInternalUrl: () => "http://reference.invalid",
    withOwnerSessionCookie: (init: RequestInit) => Promise.resolve(init),
    ReferenceServerUnreachableError: class extends Error {},
  },
});
mock.module(new URL("./install-connector-action.ts", import.meta.url).href, {
  namedExports: { installConnectorForSourceAction: () => Promise.reject(new Error("not used by this journey")) },
});
const components = Promise.all([import("./connection-access-review.tsx"), import("./sync-now-button.tsx")]);

function proposal(): AccessProposal {
  return {
    proposalId: "p1",
    revision: 1,
    baseEpoch: 0,
    snapshotDigest: "digest-1",
    status: "proposed",
    snapshot: {
      connectionId: "cin_1",
      phase: "PREPARED",
      policyIdentity: "policy-1",
      expiresAt: Date.now() + 60_000,
      instances: [
        {
          instanceKey: "browser",
          kind: "browser",
          availability: "prepared",
          accessIdentity: "access-1",
          accessRevision: "r1",
          effectiveReach: { reach: "Unrestricted browser navigation" },
          effectiveConstraints: {},
          requestedDeclaration: { required: true },
          mechanism: "fictional-resource",
          mechanismVersion: "1",
          purpose: "Collect records",
          consequentialActions: ["Read signed-in pages"],
          remainingAmbientAccess: ["Network connections"],
          channels: [{ name: "browser.navigate", coverage: "not_observable" }],
        },
      ],
    },
  };
}

function button(container: HTMLElement, text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((item) => item.textContent === text);
  assert.ok(found, `missing button ${text}`);
  return found;
}

for (const outcome of ["started", "owner_action_required"] as const) {
  test(`approval then ${outcome} keeps the real Sync control and feedback after refreshed server props`, async () => {
    const [{ ConnectionAccessReview }, { SyncNowButton }] = await components;
    const original = globalThis.fetch;
    dom.window.sessionStorage.clear();
    revalidated.length = 0;
    const p = proposal();
    const approved = { ...p, status: "confirmed" as const };
    let current: BindingAccessState = { active: null, proposal: p, epoch: 0, revision: 1 };
    let syncRequests = 0;
    globalThis.fetch = (url, init) => {
      if (String(url).endsWith("/confirm")) {
        current = { active: approved, proposal: approved, epoch: 1, revision: 1 };
        return Promise.resolve(Response.json(approved));
      }
      if (String(url).endsWith("/run")) {
        syncRequests += 1;
        if (outcome === "owner_action_required") {
          current = {
            active: approved,
            epoch: 1,
            revision: 2,
            proposal: {
              ...p,
              proposalId: "p2",
              revision: 2,
              baseEpoch: 1,
              snapshotDigest: "digest-2",
              snapshot: {
                ...p.snapshot,
                instances: p.snapshot.instances.map((instance) => ({
                  ...instance,
                  accessRevision: "r2",
                  effectiveReach: { reach: "Changed network access" },
                })),
              },
            },
          };
        }
        return Promise.resolve(
          Response.json(
            {
              status: outcome,
              run_id: "run_1",
              trace_id: "trace_1",
              ...(outcome === "owner_action_required"
                ? {
                    owner_action: { kind: "confirm_browser_access", connectionId: "cin_1", proposalId: "p2" },
                  }
                : {}),
            },
            { status: 202 }
          )
        );
      }
      assert.equal(init?.method ?? "GET", "GET");
      return Promise.resolve(Response.json(current));
    };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const render = (initialState: BindingAccessState, initialRunning = false) =>
      act(async () =>
        root.render(
          createElement(
            React.Fragment,
            null,
            // The page's ordinary Sync control is outside the keyed access review.
            createElement(SyncNowButton, {
              connectionId: "cin_1",
              connectorId: "gmail",
              displayName: "Mail",
              initialRunning,
            }),
            createElement(ConnectionAccessReview, {
              connectionId: "cin_1",
              initialState,
            })
          )
        )
      );
    try {
      await render(current);
      const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]');
      assert.ok(checkbox);
      await act(async () => checkbox.click());
      await act(async () => button(container, "Approve access").click());
      assert.equal(syncRequests, 0, "approval must not start collection");
      // On the old UI this chooses its extra in-section control, reproducing F1.
      const controls = [...container.querySelectorAll<HTMLButtonElement>("button")].filter(
        (item) => item.textContent === "Sync now"
      );
      const clicked = controls.at(-1);
      assert.ok(clicked);
      await act(async () => clicked.click());
      assert.equal(syncRequests, 1);
      const feedback = outcome === "started" ? "Sync started." : "Sync did not start. Review this connection's access";
      assert.ok(container.textContent?.includes(feedback));
      assert.ok(revalidated.includes("/sources/cin_1"));
      // Next sends updated page props after the real server action invalidates it.
      await render(current, outcome === "started");
      assert.ok(container.contains(clicked), "the control the owner clicked must survive refreshed review props");
      assert.ok(container.textContent?.includes(feedback), "sync feedback must survive refreshed review props");
      assert.equal(
        [...container.querySelectorAll("button")].filter(
          (item) => item.textContent === "Sync now" || item.textContent === "Syncing…"
        ).length,
        1
      );
      assert.equal(clicked.textContent, outcome === "started" ? "Syncing…" : "Sync now");
      assert.equal(syncRequests, 1, "a new server render must not retry collection");
      if (outcome === "owner_action_required") {
        const fresh = container.querySelector<HTMLInputElement>('input[type="checkbox"]');
        assert.ok(fresh);
        assert.equal(fresh.checked, false, "a repeated request needs a fresh acknowledgment");
      }
    } finally {
      await act(async () => root.unmount());
      container.remove();
      globalThis.fetch = original;
    }
  });
}
