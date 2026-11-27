// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { mock, test } from "node:test";
import type * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { sourceStateSentence, sourceStatusWords, type SourceStatusRow } from "../../lib/source-status-words.ts";
import { AGREEMENT_STATES, agreementPractice } from "./agreement-practice.ts";
import { buildRecoveryDemoModel } from "./source-detail-demo-data.ts";

const NONE_YET = /None yet/;
const NO_SEND_FAILURE = /could not send/;
const NOW = new Date("2026-11-24T12:00:00.000Z");

function Link({ children, href, ...props }: React.ComponentProps<"a"> & { href: string }) {
  return createElement("a", { ...props, href }, children);
}

function IcButton({ children, className, size: _size, variant = "default", ...props }: React.ComponentProps<"button"> & {
  size?: string;
  variant?: string;
}) {
  return createElement("button", { ...props, className: [className, `variant-${variant}`].filter(Boolean).join(" "), "data-variant": variant, type: props.type ?? "button" }, children);
}

function IcInput({ className, ...props }: React.ComponentProps<"input"> & { className?: string }) {
  return createElement("input", { ...props, className });
}

function Section({ action, children, description, id, title }: {
  action?: React.ReactNode;
  children?: React.ReactNode;
  description?: React.ReactNode;
  id?: string;
  title: React.ReactNode;
}) {
  return createElement("section", { id },
    createElement("header", null, createElement("h2", null, title), action),
    description ? createElement("p", null, description) : null,
    children
  );
}

function PageHeader({ actions, breadcrumbs, count, description, title }: {
  actions?: React.ReactNode;
  breadcrumbs?: { href: string; label: string }[];
  count?: string;
  description?: React.ReactNode;
  title: React.ReactNode;
}) {
  return createElement("header", null,
    createElement("nav", null, breadcrumbs?.map((item) => createElement(Link, { href: item.href, key: item.href }, item.label))),
    createElement("h1", null, title),
    description ? createElement("p", null, description) : null,
    count ? createElement("p", null, count) : null,
    actions
  );
}

function DataList({ ariaLabel, children }: { ariaLabel?: string; children: React.ReactNode }) {
  return createElement("ul", { "aria-label": ariaLabel }, children);
}

function StatusBadge({ status, vocabulary }: { status: string; vocabulary: Record<string, { label: string }> }) {
  return createElement("span", { "data-status-badge": status }, vocabulary[status]?.label ?? status);
}

function IcTimestamp({ value }: { value: string }) {
  return createElement("time", { dateTime: value }, value);
}

function Shell({ children }: { children: React.ReactNode }) {
  return createElement("div", { "data-testid": "shell" }, children);
}

function ConnectorMark() {
  return createElement("span", { "aria-hidden": true, "data-testid": "connector-mark" });
}

function SourceStatusText({ status }: { status: { words: string } }) {
  return createElement("span", null, status.words);
}

mock.module("server-only", { namedExports: {} });
mock.module("next/navigation", {
  namedExports: {
    notFound: () => { throw new Error("unexpected notFound"); },
    redirect: (href: string) => { throw new Error(`unexpected redirect: ${href}`); },
    useRouter: () => ({ refresh() {} }),
  },
});
mock.module("next/link", { namedExports: { default: Link } });
mock.module("@pdpp/brand-react", {
  namedExports: {
    IcButton,
    IcInput,
    IcTimestamp,
    buttonVariants: ({ size, variant }: { size?: string; variant?: string } = {}) =>
      `button-size-${size ?? "md"} variant-${variant ?? "default"}`,
  },
});
mock.module("@pdpp/operator-ui/components/primitives", {
  namedExports: { DataList, IcTimestamp, PageHeader, Section, StatusBadge },
});
mock.module("@pdpp/operator-ui/components/copy-button", {
  namedExports: {
    CopyButton: ({ ariaLabel }: { ariaLabel: string }) => createElement("button", { "aria-label": ariaLabel, type: "button" }, "Copy"),
  },
});
mock.module(new URL("../../components/recordroom-shell-with-palette.tsx", import.meta.url).href, {
  namedExports: { RecordroomShellWithPalette: Shell },
});
mock.module(new URL("../../components/connector-mark.tsx", import.meta.url).href, { namedExports: { ConnectorMark } });
mock.module(new URL("../../components/source-status-text.tsx", import.meta.url).href, { namedExports: { SourceStatusText } });
mock.module("../../components/server-unreachable.tsx", {
  namedExports: { ServerUnreachable: () => null },
});
mock.module(new URL("../actions.ts", import.meta.url).href, {
  namedExports: { runConnectorNowAction: async () => ({ ok: true }) },
});
mock.module(new URL("./actions.ts", import.meta.url).href, {
  namedExports: {
    deleteConnectionAction: async () => {},
    pauseConnectionAction: async () => {},
    renameConnectionAction: async () => ({ ok: true, display_name: "Name" }),
    resetAndSyncConnectionAction: async () => ({ ok: true }),
    resumeConnectionAction: async () => {},
    resumeConnectorScheduleAction: async () => {},
    resumeSetupConnectionAction: async () => {},
    revokeConnectionAction: async () => {},
  },
});
mock.module(new URL("./confirmation-actions.ts", import.meta.url).href, {
  namedExports: { acknowledgeConnectionLossAction: async () => {}, confirmCoverageHorizonAction: async () => {} },
});
mock.module(new URL("./config-actions.ts", import.meta.url).href, {
  namedExports: { confirmConfigAction: async () => {}, proposeConfigAction: async () => {} },
});
mock.module(new URL("./install-connector-action.ts", import.meta.url).href, {
  namedExports: { installConnectorForSourceAction: async () => ({ ok: true }) },
});
mock.module(new URL("../add/connector-install-actions.ts", import.meta.url).href, {
  namedExports: { updateConnectorAction: async () => ({ ok: true }) },
});
mock.module(new URL("./source-update-view-model.ts", import.meta.url).href, {
  namedExports: { buildSourceUpdateModel: () => null },
});

const renderedPage = (async () => {
  const { default: ConnectorPage } = await import("./page.tsx");
  return ConnectorPage;
})();

async function renderDemo(demo: string): Promise<JSDOM> {
  const ConnectorPage = await renderedPage;
  const page = await ConnectorPage({ params: Promise.resolve({ connector: "cin_demo_claude_code_workstation" }), searchParams: Promise.resolve({ demo }) });
  return new JSDOM(renderToStaticMarkup(page));
}

function visibleOutsideDetails(dom: JSDOM): string {
  const document = dom.window.document.cloneNode(true) as Document;
  for (const details of [...document.querySelectorAll("details")]) details.remove();
  return (document.body.textContent ?? "").replace(/\s+/gu, " ").trim();
}

test("unresolved device commands do not offer an empty steps panel", async () => {
  const dom = await renderDemo("device-no-steps");
  assert.doesNotMatch(visibleOutsideDetails(dom), /Command unavailable/);
  assert.ok(![...dom.window.document.querySelectorAll("button")].some((node) => node.textContent === "See what to do on that computer"));
});



test("all 24 status rows keep the shared state choice and their actions", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  for (let row = 1; row <= 24; row++) {
    const dom = await renderDemo(`status-${row}`);
    assert.equal(dom.window.document.querySelector('[data-status-row]')?.getAttribute("data-status-row"), String(row));
    const model = buildRecoveryDemoModel(row as SourceStatusRow);
    const sentence = sourceStateSentence(model.source, { now: NOW, name: model.source.connector_display_name ?? model.manifest.display_name ?? model.displayName });
    if (![11, 14, 15, 16, 19, 20].includes(row)) assert.ok(dom.window.document.querySelector('[data-testid="source-state-sentence"]')?.textContent?.startsWith(sentence.text), `row ${row}`);
    assert.ok(dom.window.document.querySelector('a[href*="/technical"]'));
    assert.equal(dom.window.document.querySelector('details[data-testid="source-details"]'), null);
  }
});

test("record kinds use human names, known counts, and dates", async () => {
  const dom = await renderDemo("atlas");
  const row = dom.window.document.querySelector('a[href$="/messages"]');
  assert.match(row?.textContent ?? "", /Messages/);
  assert.match(row?.textContent ?? "", /428/);
  assert.match(row?.textContent ?? "", /newest/);
});

test("technical page keeps the two acknowledgement journeys and original evidence", async () => {
  const { SourceTechnicalDetails } = await import("./source-page.tsx");
  const dom = new JSDOM(renderToStaticMarkup(createElement(SourceTechnicalDetails, { model: buildRecoveryDemoModel(16, true), now: NOW.toISOString() })));
  assert.ok(dom.window.document.querySelector("#history-confirmation form [name=earliest_available]"));
  assert.ok(dom.window.document.querySelector("#history-confirmation form [name=acknowledged_by]"));
  assert.ok(dom.window.document.querySelector('[data-testid="stream-collection-facts"]'));
  assert.match(dom.window.document.body.textContent ?? "", /14 events/);
  assert.ok(dom.window.document.querySelector('[data-testid="diagnostics-details"]'));
});

test("a source without recent syncs has no history section", async () => {
  for (const state of ["status-19", "status-20", "status-22", "status-22-failed-last-run"]) {
    const dom = await renderDemo(state);
    assert.doesNotMatch(visibleOutsideDetails(dom), /Recent syncs|No syncs yet|Recent syncs are not listed here/);
  }
});

test("a paused device has no remote Resume action", async () => {
  const dom = await renderDemo("status-10-local-device");
  const controls = [...dom.window.document.querySelectorAll("button, a")].map((element) => element.textContent?.trim());
  assert.ok(!controls.includes("Resume"));
  assert.ok(controls.includes("View this device"));
});

// The main page's words are tested against every development state, using the
// actual controls, update component, settings editor and management dialogs.
test("every practice state obeys the words and folds contract", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const { SOURCE_PRACTICE_STATES } = await import("./source-page-practice.ts");
  const { bannedCopyProblems, visibleText } = await import("../add/banned-copy.ts");
  const extra = /\b(?:details|diagnostics|version|collector|retained|coverage|covered|considered|fetched|gaps?|retryable|dead-lettered|outbox|heartbeat|posture|freshness|backoff|configuration|revision|events|run)\b|\bsync position\b|\bsaved browser session\b|\bnot measured\b|\bnobody has described\b|\b(?:cin|run|conn|dsi|dev)_[a-z0-9_]+\b|\b(?:PDPP|interaction|assistance|surface|stream)\b|close this tab/iu;
  const problems: string[] = [];
  for (const state of SOURCE_PRACTICE_STATES) {
    const dom = await renderDemo(state);
    const document = dom.window.document;
    const technicalLinks = [...document.querySelectorAll('a[href*="/technical"]')].filter((node) => node.textContent === "Technical details");
    assert.equal(technicalLinks.length, 1, state);
    assert.equal(technicalLinks[0]?.textContent, "Technical details");
    technicalLinks[0]?.parentElement?.remove();
    const html = document.body.innerHTML;
    problems.push(...bannedCopyProblems(html, { allowWords: ["install"] }).map((problem) => `${state}: ${problem}`));
    const own = html.replace(/<details\b[^>]*>\s*<summary\b[^>]*>\s*What went wrong\s*<\/summary>[\s\S]*?<\/details>/gu, "");
    const hit = visibleText(own).replaceAll("sign-in details", "sign-in").match(extra);
    if (hit) problems.push(`${state}: ${hit[0]}`);
    for (const details of document.querySelectorAll("details")) assert.equal(details.querySelector("summary")?.textContent?.trim(), "What went wrong", state);
    const headings = [...document.querySelectorAll("h2")].map((heading) => heading.textContent);
    if (headings.includes("Schedule")) {
      assert.ok(headings.indexOf("What is here") < headings.indexOf("Schedule"), state);
      assert.ok(headings.indexOf("Schedule") < headings.indexOf("Manage"), state);
    }
    if (headings.includes("Settings")) assert.ok(headings.indexOf("Settings") < headings.indexOf("Manage"), state);
  }
  assert.deepEqual(problems, []);
});

test("practice states cover partial copies, missing kinds, settings, accounts and each confirmation", async () => {
  const cases = [
    ["partly-more-coming", /24 records so far\. Some didn't come at the last sync\./],
    ["partly-some-lost", /24 records so far\. Some didn't come at the last sync\./],
    ["didnt-come", /Didn't come at the last sync\./],
    ["settings-choices", /Settings[\s\S]*Increase this to copy older messages\./],
    ["settings-question", /Awaiting your confirmation/],
    ["other-accounts", /Also connected: Northwind \(work\)/],
    ["device-healthy", /It runs on Work computer, last heard from/],
  ] as const;
  for (const [state, pattern] of cases) assert.match((await renderDemo(state)).window.document.body.textContent ?? "", pattern, state);
  for (const state of ["dialog-reset", "dialog-disconnect", "dialog-delete", "dialog-delete-running"]) assert.ok((await renderDemo(state)).window.document.querySelector('[role="alertdialog"]'), state);
});

test("the technical practice route has its heading, explanation and way back", async () => {
  const { default: TechnicalPage } = await import("./technical/page.tsx");
  const html = await TechnicalPage({ params: Promise.resolve({ connector: "cin_demo_claude_code_workstation" }), searchParams: Promise.resolve({ demo: "technical" }) });
  const document = new JSDOM(renderToStaticMarkup(html)).window.document;
  assert.equal(document.querySelector("h1")?.textContent, "Technical details for Claude Code workstation");
  assert.match(document.body.textContent ?? "", /Ids, logs and measurements for whoever is helping you with a problem\./);
  assert.ok(document.querySelector('nav a[href="/sources/cin_demo_claude_code_workstation"]'));
  assert.doesNotMatch(document.body.textContent ?? "", /Back to/);
});

test("the main device steps keep exactly the technical page's resolved commands", async () => {
  const { SourceTechnicalDetails } = await import("./source-page.tsx");
  const { ConnectionDeviceRecoverySteps } = await import("./connection-diagnostics.tsx");
  const { bannedCopyProblems } = await import("../add/banned-copy.ts");
  const model = buildRecoveryDemoModel(16, true);
  const technical = new JSDOM(renderToStaticMarkup(createElement(SourceTechnicalDetails, { model, now: NOW.toISOString() }))).window.document;
  const main = new JSDOM(renderToStaticMarkup(createElement(ConnectionDeviceRecoverySteps, {
    connectionHealth: model.connectionHealth, connectionId: model.connectorInstanceId ?? model.connectionId,
    connectorId: model.connectorId, localDeviceProgress: model.overview.localDeviceProgress ?? null,
    providerOrigin: model.providerOrigin, renderedVerdict: model.connectionRenderedVerdict, sourceInstances: model.sourceInstances,
  }))).window.document;
  const selector = '[data-testid="diagnostics-outbox-remediation-command"]';
  const commands = (document: Document) => [...document.querySelectorAll(selector)].map((node) => node.textContent);
  assert.ok(commands(main).length > 0);
  assert.deepEqual(commands(main), commands(technical));
  for (const command of main.querySelectorAll(selector)) command.remove();
  assert.deepEqual(bannedCopyProblems(main.body.innerHTML), []);
  assert.equal(main.querySelector("details"), null);
});


test("unknown counts are omitted while known zero remains a fact", async () => {
  const document = (await renderDemo("unknown-count")).window.document;
  assert.doesNotMatch(document.querySelector('a[href$="/messages"]')?.textContent ?? "", /999|count unavailable|not measured/);
  assert.match(document.querySelector('a[href$="/sessions"]')?.textContent ?? "", NONE_YET);
  assert.match(document.body.textContent ?? "", /SessionsNone yet/);
});

test("a device without server steps says what to look for and offers no empty panel", async () => {
  const document = (await renderDemo("status-8-owner-device")).window.document;
  const control = [...document.querySelectorAll("a, button")].find((node) => node.textContent?.trim() === "See what to do on that computer");
  assert.equal(control, undefined);
  assert.match(document.querySelector('[data-testid="source-state-sentence"]')?.textContent ?? "", /Open DataConnect on/);
});

test("an overdue real schedule never prints a next check", async () => {
  const { ScheduleSummary } = await import("./source-page.tsx");
  const model = buildRecoveryDemoModel(19);
  const html = renderToStaticMarkup(createElement(ScheduleSummary, { displayName: model.displayName, schedule: model.schedule, scheduleError: null, sourceInstances: [], now: new Date("2027-01-01") }));
  assert.doesNotMatch(html, /Next check/);
});

test("state-specific sections, counts and sentences do not contradict each other", async () => {
  for (const state of ["status-3", "status-1", "status-18"]) {
    const document = (await renderDemo(state)).window.document;
    const text = document.body.textContent ?? "";
    assert.doesNotMatch(text, /Copy everything again|Disconnect and keep the records|Pause syncing/, state);
    if (state === "status-3") assert.match(text, /Not checked while disconnected\./);
    else assert.ok(![...document.querySelectorAll("h2")].some((node) => node.textContent === "Schedule"));
  }
  for (const state of ["partly-more-coming", "partly-some-lost", "didnt-come", "dialog-delete-running"]) {
    const document = (await renderDemo(state)).window.document;
    assert.doesNotMatch(document.querySelector('[data-testid="source-state-sentence"]')?.textContent ?? "", /Up to date/);
  }
  const more = (await renderDemo("partly-more-coming")).window.document;
  assert.doesNotMatch(more.body.textContent ?? "", /Northwind could not send/);
  assert.match(more.querySelector("header")?.textContent ?? "", /60 records/);
  const empty = (await renderDemo("status-7")).window.document;
  assert.match(empty.querySelector("header")?.textContent ?? "", /0 records/);
  const unknown = (await renderDemo("unknown-count")).window.document;
  assert.doesNotMatch(unknown.querySelector("header")?.textContent ?? "", /records/);
  const install = (await renderDemo("status-4")).window.document.body.textContent ?? "";
  assert.equal(install.split("DataConnect needs to install Claude Code again before it can sync.").length, 2);
  assert.equal([...((await renderDemo("status-10")).window.document.querySelectorAll("a, button"))].filter((node) => /Resume/.test(node.textContent ?? "")).length, 1);
});

test("a source that never connected offers only retry and removal", async () => {
  const document = (await renderDemo("status-2")).window.document;
  const text = document.body.textContent ?? "";
  assert.match(text, /Claude Code was never connected\./);
  assert.match(text, /Set up again/);
  assert.match(text, /Takes Claude Code off your list\. There is nothing to erase\./);
  assert.doesNotMatch(text, /What is here|Schedule|Add another|Rename|Delete and erase|Copy everything again|Manage|Apps that can read this|Also connected/);
});

test("management questions show their sentence once with compact confirmation controls", async () => {
  for (const state of ["dialog-reset", "dialog-disconnect", "dialog-delete"]) {
    const document = (await renderDemo(state)).window.document;
    const panel = document.querySelector('[role="alertdialog"]');
    assert.ok(panel);
    assert.match(panel.className, /max-w-xl/);
    const sentence = panel.querySelector('[id$="-sentence"]')?.textContent;
    assert.ok(sentence);
    assert.equal((document.body.textContent ?? "").split(sentence).length, 2, state);
    const buttons = [...panel.querySelectorAll("button")];
    assert.equal(buttons.at(-1)?.textContent, "Cancel");
    assert.equal(buttons.at(-1)?.parentElement, buttons[0]?.parentElement);
    assert.match(buttons[0]?.parentElement?.className ?? "", /flex-row-reverse/);
    if (state === "dialog-delete") assert.equal(buttons[0]?.getAttribute("data-variant"), "destructive");
    if (state === "dialog-disconnect") assert.equal(buttons[0]?.getAttribute("data-variant"), "ghost");
  }
});

test("settings show one explanation per choice, a narrow number, and only useful controls", async () => {
  const document = (await renderDemo("settings-choices")).window.document;
  const settings = document.querySelector("#configuration");
  assert.ok(settings);
  assert.equal((settings.textContent ?? "").split("Increase this to copy older messages.").length, 2);
  assert.match(settings.textContent ?? "", /Last changed/);
  assert.ok(![...settings.querySelectorAll("button")].some((node) => node.textContent === "Cancel"));
  assert.match(settings.querySelector('input[type="number"]')?.className ?? "", /!w-28/);
  const pending = (await renderDemo("settings-question")).window.document.querySelector("#configuration");
  assert.match(pending?.textContent ?? "", /ChatGPT asked to change this/);
  assert.ok([...pending?.querySelectorAll("button") ?? []].some((node) => node.textContent === "Don't change"));
});


test("the unmeasured-completeness practice state uses the shared plain sentence and sync button", async () => {
  const document = (await renderDemo("unmeasured-completeness")).window.document;
  assert.match(document.querySelector('[data-testid="source-state-sentence"]')?.textContent ?? "", /DataConnect can't yet tell whether it got everything/);
  assert.ok([...document.querySelectorAll("button")].some((node) => node.textContent?.trim() === "Sync now"));
});


test("real-data shapes never expose raw errors or actionless waiting states", async () => {
  const raw = await renderDemo("raw-error");
  assert.doesNotMatch(visibleOutsideDetails(raw), /offset=|refusing_to_advance|machine_failure/);
  assert.match(visibleOutsideDetails(raw), /Didn't come at the last sync/);
  const waiting = await renderDemo("waiting-unknown");
  assert.match(visibleOutsideDetails(waiting), /Something stopped Northwind from syncing/);
  assert.ok([...waiting.window.document.querySelectorAll("button")].some((node) => node.textContent === "Try again"));
  const code = await renderDemo("waiting-for-code");
  assert.match(visibleOutsideDetails(code), /Northwind is waiting for a security code\./);
  assert.ok([...code.window.document.querySelectorAll("a")].some((node) => node.textContent === "Enter the code" && node.getAttribute("href") === "/syncs/run-code"));
  const archive = await renderDemo("archive-leftover");
  assert.doesNotMatch(visibleOutsideDetails(archive), /Sync now|Update sign-in details|Still checking/);
  const strong = await renderDemo("strong-state-pending");
  assert.doesNotMatch(strong.window.document.querySelector('[data-testid="source-state-sentence"]')?.textContent ?? "", /Still checking/);
});

test("pending settings summarize codes and hide machine changes", async () => {
  const machine = await renderDemo("settings-machine-change");
  assert.doesNotMatch(visibleOutsideDetails(machine), /Awaiting your confirmation|migration:|C000/);
  const explicit = await renderDemo("settings-migration-choice");
  assert.doesNotMatch(visibleOutsideDetails(explicit), /DataConnect asked to change this|Awaiting your confirmation/);
  assert.doesNotMatch(visibleOutsideDetails(explicit), /C000|migration:/);
  const app = await renderDemo("settings-long-list");
  assert.match(visibleOutsideDetails(app), /250 channels/);
  assert.doesNotMatch(visibleOutsideDetails(app), /C000|migration:/);
  assert.match(visibleOutsideDetails(app), /Sample app asked to change this/);
});


test("empty kinds collapse and missing measurement never claims permanent loss", async () => {
  const document = (await renderDemo("records-zero-one")).window.document;
  assert.match(document.body.textContent ?? "", /1 record/);
  assert.doesNotMatch(document.body.textContent ?? "", /1 records|0 records/);
  assert.match(document.body.textContent ?? "", /SessionsNone yet/);
  assert.match(document.querySelector('a[href$="/sessions"]')?.textContent ?? "", NONE_YET);
  assert.doesNotMatch(visibleOutsideDetails(await renderDemo("measurement-shortfall")), /Some could not be copied|Some of it didn't come/);
  assert.match(visibleOutsideDetails(await renderDemo("partly-some-lost")), /Some didn't come at the last sync/);
});

test("short service names stay in sentences and other accounts exclude this source", async () => {
  const document = (await renderDemo("long-account-name")).window.document;
  assert.match(document.querySelector("h1")?.textContent ?? "", /deliberately long account/);
  const schedule = [...document.querySelectorAll("section")].find((node) => node.querySelector("h2")?.textContent === "Schedule");
  assert.doesNotMatch(schedule?.textContent ?? "", /deliberately/);
  const others = (await renderDemo("own-account")).window.document;
  assert.equal(others.querySelectorAll('a[href="/sources/cin_demo_claude_code_workstation"]').length, 0);
});


test("timing and controls follow disconnected, paused and running states", async () => {
  const signedIn = (await renderDemo("status-8")).window.document;
  assert.equal((signedIn.body.textContent ?? "").match(/Last updated|Last successful sync/gu)?.length, 1);
  const disconnected = (await renderDemo("status-3")).window.document;
  const schedule = [...disconnected.querySelectorAll("section")].find((node) => node.querySelector("h2")?.textContent === "Schedule");
  assert.doesNotMatch(schedule?.textContent ?? "", /Change/);
  assert.equal([...disconnected.querySelectorAll("a")].filter((node) => node.textContent === "Set up again").length, 2);
  assert.match(visibleOutsideDetails(await renderDemo("status-10")), /Not checked while paused/);
  const running = visibleOutsideDetails(await renderDemo("status-11"));
  assert.equal(running.match(/Syncing now/gu)?.length, 1);
  assert.doesNotMatch(running, /Syncing…/);
});


test("raw gap evidence stays intact under What went wrong on the technical page", async () => {
  const { default: TechnicalPage } = await import("./technical/page.tsx");
  const page = await TechnicalPage({ params: Promise.resolve({ connector: "cin_demo_claude_code_workstation" }), searchParams: Promise.resolve({ demo: "raw-error" }) });
  const document = new JSDOM(renderToStaticMarkup(page)).window.document;
  const evidence = document.querySelector('[data-testid="raw-source-errors"]');
  assert.equal(evidence?.querySelector("summary")?.textContent, "What went wrong");
  assert.match(evidence?.textContent ?? "", /offset=480/);
  assert.match(evidence?.textContent ?? "", /machine_failure_/);
});

test("positive kinds never carry the whole-kind failure sentence", async () => {
  for (const state of ["atlas", "partly-some-lost"]) {
    const dom = await renderDemo(state);
    const row = dom.window.document.querySelector('a[href$="/messages"]');
    assert.doesNotMatch(row?.textContent ?? "", /Didn't come at the last sync/);
    if (state === "partly-some-lost") assert.match(row?.textContent ?? "", /Some didn't come at the last sync/);
  }
});

 test("archives carry no sync timeline", async () => { assert.doesNotMatch(visibleOutsideDetails(await renderDemo("archive-leftover")), /Last updated|Recent syncs/); });

test("polished controls give disconnected setup one filled action and device navigation one home", async () => {
  const disconnected = (await renderDemo("status-3")).window.document;
  assert.match([...disconnected.querySelectorAll("header a")].find((node) => node.textContent === "Set up again")?.className ?? "", /variant-default/);
  const device = (await renderDemo("status-10-local-device")).window.document;
  assert.equal([...device.querySelectorAll("a")].filter((node) => node.textContent === "View this device").length, 1);
  assert.equal((visibleOutsideDetails(await renderDemo("status-19")).match(/Rename/g) ?? []).length, 1);
});

test("real-shaped count and device practice states preserve positive holdings and suppress empty repairs", async () => {
  const { buildSourcePracticeModel } = await import("./source-page-practice.ts");
  const held = buildSourcePracticeModel("summary-zero-held");
  assert.ok(held);
  assert.equal(held.source.total_records, 0);
  assert.equal(held.source.stream_records?.[0]?.retained_record_count, 41);
  const text = visibleOutsideDetails(await renderDemo("summary-zero-held"));
  assert.match(text, /44 records/);
  assert.doesNotMatch(text, /Nothing in|\b0 records/);
  assert.match(text, /can't yet tell whether it got everything/);
  const zero = (await renderDemo("device-zero-pending")).window.document;
  assert.doesNotMatch(zero.querySelector('[data-testid="source-state-sentence"]')?.textContent ?? "", NO_SEND_FAILURE);
  assert.ok(![...zero.querySelectorAll("button")].some((node) => node.textContent === "See what to do on that computer"));
});

test("a source that syncs only when pressed never offers Pause syncing",async()=>{
  const document=(await renderDemo("manual-only")).window.document;
  assert.ok(![...document.querySelectorAll("button")].some(node=>node.textContent === "Pause syncing"));
});

for(const state of AGREEMENT_STATES) {
  test(`the actual source page keeps the agreement answer and main action: ${state}`,async(t)=>{
    t.mock.timers.enable({apis:["Date"],now:NOW});
    const model=agreementPractice(state);assert.ok(model);
    const status=sourceStatusWords(model.source,{now:NOW});
    const sentence=sourceStateSentence(model.source,{now:NOW,name:"Northwind"});
    const dom=await renderDemo(`agreement-${state}`);
    const element=dom.window.document.querySelector('[data-testid="source-state-sentence"]');assert.ok(element);
    assert.equal(element.getAttribute("data-source-words"),status.words);
    assert.equal(element.getAttribute("data-source-action"),status.action?.label ?? "");
    assert.ok(element.textContent?.startsWith(sentence.text));
    const primaryLabels=new Set(["Try again","Sign in again","Install again","Resume schedule","See what to do on that computer","View this device"]);
    if(status.action?.label === "Sync now") {primaryLabels.add("Sync now");}
    const actual=[...dom.window.document.querySelectorAll("header a, header button")].map(node=>node.textContent?.trim() ?? "").filter(label=>primaryLabels.has(label));
    assert.deepEqual(actual,status.action ? [status.action.label] : []);
    dom.window.close();
  });
}

test("a connector that must be installed again gives no schedule promise", async () => {
  const { ScheduleSummary } = await import("./source-page.tsx");
  const model = buildRecoveryDemoModel(19);
  const html = renderToStaticMarkup(createElement(ScheduleSummary, { displayName: "Steam", notInstalled: true, schedule: model.schedule, scheduleError: null, sourceInstances: [], now: new Date("2027-01-01") }));
  assert.match(html, /Not checked until Steam is installed again\./);
  assert.doesNotMatch(html, /checks Steam|Next check/);
});

test("Pause syncing is the button only, not also a heading above it", async () => {
  let seen = 0;
  for (const state of ["row-11-syncing", "atlas", "unknown-count", "status-8-owner-device", "status-10-local-device", "device-no-steps"]) {
    const document = (await renderDemo(state)).window.document;
    if (!document.querySelector('[data-testid="detail-action-pause-connection"]')) continue;
    seen += 1;
    assert.ok(![...document.querySelectorAll("p, h2, h3")].some((node) => node.textContent === "Pause syncing"), state);
  }
  assert.ok(seen > 0, "no sampled state shows the pause control");
});

// Round 7 (F25): a section with nothing under it must not draw its heading.
test("a Schedule section with nothing to say draws no heading and no Change link", async () => {
  const { ScheduleSummary } = await import("./source-page.tsx");
  const unread = renderToStaticMarkup(createElement(ScheduleSummary, { displayName: "Venmo", schedule: null, scheduleError: "The schedule could not be read.", sourceInstances: [], now: new Date("2027-01-01") }));
  assert.doesNotMatch(unread, /Schedule/);
  assert.doesNotMatch(unread, /Change/);
  const none = renderToStaticMarkup(createElement(ScheduleSummary, { displayName: "Venmo", schedule: null, scheduleError: null, sourceInstances: [], now: new Date("2027-01-01") }));
  assert.match(none, /DataConnect checks Venmo only when you ask\./);
});
