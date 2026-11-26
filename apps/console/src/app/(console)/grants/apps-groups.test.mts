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
let response: {ok:boolean;message:string|null;failedGrantIds?:string[]}={ok:true,message:null};
mock.module("./remove-app-action.ts", {
  namedExports: {
    removeAppAction: (input: unknown) => {
      calls.push(input);
      return Promise.resolve(response);
    },
  },
});
const { AppsGroups } = await import("./apps-groups.tsx");
const { PendingApprovalRow } = await import("./pending-approval-row.tsx");
const { buildAppPractice } = await import("./app-practice.ts");
afterEach(() => {
  cleanup();
  calls = [];
  response={ok:true,message:null};
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
test("bulk removal starts empty and names exactly the chosen apps", async () => {
  const { apps } = buildAppPractice("forty-eight");
  const view = render(React.createElement(AppsGroups, { apps }));
  fireEvent.click(view.getByRole("button", { name: "Choose apps to remove" }));
  const ticks = view.getAllByRole("checkbox");
  assert.ok(ticks.every(tick => !(tick as HTMLInputElement).checked));
  assert.equal((view.getByRole("button", { name: "Remove access for 0 apps" }) as HTMLButtonElement).disabled, true);
  fireEvent.click(ticks[0]!);
  fireEvent.click(ticks[2]!);
  fireEvent.click(view.getByRole("button", { name: "Remove access for 2 apps" }));
  const question = view.getByRole("alertdialog");
  const chosen = [ticks[0]!,ticks[2]!].map(tick=>apps.find(app=>app.hrefId===(tick as HTMLInputElement).value)!);
  for (const app of chosen) { assert.ok(question.textContent?.includes(app.name)); }
  assert.equal(question.querySelectorAll("li").length,2);
  assert.equal(calls.length,0);
  await React.act(async()=>fireEvent.click(question.querySelector("button")!));
  assert.deepEqual(calls,[{client_ids:chosen.flatMap(app=>app.clientIds)}]);
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
  assert.ok(view.getByRole("link",{name:"2 more requests"}));
  assert.equal(view.queryByRole("link",{name:"Review request 2"}),null);
  fireEvent.click(view.getByRole("button", { name: "Don't allow" }));
  const question = view.getByRole("alertdialog");
  assert.ok(question.contains(view.getByRole("button", { name: "Cancel" })));
  assert.equal(JSON.parse(question.querySelector<HTMLInputElement>('input[name="requests"]')!.value).length, 3);
});

test("partial failure names remaining access and retry always reopens the named question",async()=>{
  const {apps}=buildAppPractice("forty-eight");
  const view=render(React.createElement(AppsGroups,{apps}));
  fireEvent.click(view.getByRole("button",{name:"Choose apps to remove"}));
  const ticks=view.getAllByRole("checkbox");
  fireEvent.click(ticks[0]!);fireEvent.click(ticks[1]!);
  const failed=apps.find(app=>app.hrefId===(ticks[0] as HTMLInputElement).value)!;
  response={ok:false,message:"Some access could not be removed.",failedGrantIds:failed.grantIds};
  fireEvent.click(view.getByRole("button",{name:"Remove access for 2 apps"}));
  await React.act(async()=>fireEvent.click(view.getByRole("alertdialog").querySelector("button")!));
  assert.ok(view.getByRole("alert").textContent?.includes(failed.name));
  const question=view.getByRole("alertdialog");
  const cancel=[...question.querySelectorAll("button")].find(button=>button.textContent==="Cancel")!;
  fireEvent.click(cancel);
  assert.equal(view.queryByRole("alertdialog"),null);
  await React.act(async()=>fireEvent.click(view.getByRole("button",{name:"Try again"})));
  assert.equal(calls.length,1);
  assert.ok(view.getByRole("alertdialog"));
});
