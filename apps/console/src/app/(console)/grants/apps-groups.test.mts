/* biome-ignore-all lint/style/noNonNullAssertion: These fixed practice fixtures have the asserted rows and controls. */
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { after, afterEach, mock, test } from "node:test";
import { JSDOM } from "jsdom";

const THREE_REQUESTS_RE = /3 requests/;

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/grants",
  pretendToBeVisual: true,
});
for (const name of [
  "window",
  "self",
  "document",
  "navigator",
  "HTMLElement",
  "Element",
  "Node",
  "Text",
  "Event",
  "KeyboardEvent",
  "MouseEvent",
  "CustomEvent",
  "MutationObserver",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
]) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value: name === "window" || name === "self" ? dom.window : dom.window[name],
  });
}
const React = await import("react");
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
// biome-ignore lint/correctness/noUndeclaredDependencies: The workspace root supplies the same React test tools used by the existing consent runtime tests.
const { render, fireEvent, cleanup } = await import("@testing-library/react");
mock.module("next/navigation", {
  namedExports: {
    useRouter: () => ({
      refresh() {
        return 0;
      },
    }),
    usePathname: () => "/grants",
  },
});
let calls: unknown[] = [];
mock.module("./remove-app-action.ts", {
  namedExports: {
    removeAppAction: (input: unknown) => {
      calls.push(input);
      return Promise.resolve({ ok: true, message: null });
    },
  },
});
const { AppsGroups } = await import("./apps-groups.tsx");
const { PendingApprovalRow } = await import("./pending-approval-row.tsx");
const { buildAppPractice } = await import("./app-practice.ts");
afterEach(() => {
  cleanup();
  calls = [];
});
after(() => dom.window.close());

test("one search filters unused, stopped and waiting apps", () => {
  const { apps } = buildAppPractice("forty-eight");
  const stopped = { ...apps[0]!, name: "Stopped practice", hrefId: "stopped", state: "stopped" as const };
  const view = render(
    React.createElement(AppsGroups, {
      apps: [...apps, stopped],
      waiting: [
        { name: "Waiting practice", place: "waiting.example", node: React.createElement("p", {}, "Waiting practice") },
      ],
    })
  );
  fireEvent.change(view.getByRole("textbox", { name: "Find an app" }), { target: { value: "Stopped practice" } });
  assert.ok(view.getByText("Stopped practice"));
  assert.equal(view.queryByText("Waiting practice"), null);
  assert.equal(view.queryByText("ChatGPT"), null);
});
test("bulk removal waits for confirmation and sends exactly the unused group", async () => {
  const { apps } = buildAppPractice("forty-eight");
  const view = render(React.createElement(AppsGroups, { apps }));
  fireEvent.click(view.getByRole("button", { name: "Remove access for all 34" }));
  assert.equal(calls.length, 0);
  await React.act(async () => fireEvent.click(view.getByRole("button", { name: "Remove access for 34 apps" })));
  assert.deepEqual(calls, [
    {
      client_ids: apps
        .filter((app) => !app.lastRead || Date.parse(app.lastRead) < Date.now() - 30 * 86_400_000)
        .flatMap((app) => app.clientIds),
    },
  ]);
});
test("merged waiting requests put Cancel and every request in the same question", () => {
  const { approvals } = buildAppPractice("waiting-three");
  const view = render(
    React.createElement(PendingApprovalRow, {
      approval: approvals[0]!,
      requests: approvals,
      appName: "ChatGPT",
      denyAction: () => Promise.resolve(),
    })
  );
  assert.ok(view.getByText(THREE_REQUESTS_RE));
  fireEvent.click(view.getByRole("button", { name: "Don't allow" }));
  const question = view.getByRole("alertdialog");
  assert.ok(question.contains(view.getByRole("button", { name: "Cancel" })));
  assert.equal(JSON.parse(question.querySelector<HTMLInputElement>('input[name="requests"]')!.value).length, 3);
});
