// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { mock, test } from "node:test";
import type * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { sourceStateSentence, sourceStatusWords, type SourceStatusRow } from "../../lib/source-status-words.ts";
import { buildRecoveryDemoModel } from "./source-detail-demo-data.ts";

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

function SourceUpdateSlot({ demoModel }: {
  demoModel: { currentVersion: string; otherSources: string[]; targetVersion: string } | null;
}) {
  return demoModel
    ? createElement("section", { "data-testid": "source-update-demo" },
        createElement("h2", null, "Update"),
        createElement("p", null, `Version ${demoModel.targetVersion} is ready (you have ${demoModel.currentVersion}).`),
        demoModel.otherSources.length > 0 ? createElement("p", null, `It also updates ${demoModel.otherSources.join(" and ")}.`) : null,
        createElement("button", { type: "button" }, "Update")
      )
    : null;
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
mock.module(new URL("./source-update-section.tsx", import.meta.url).href, {
  namedExports: { SourceUpdateSlot },
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

test("all 24 status rows keep the shared state choice and their actions", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  for (let row = 1; row <= 24; row++) {
    const dom = await renderDemo(`status-${row}`);
    assert.equal(dom.window.document.querySelector('[data-status-row]')?.getAttribute("data-status-row"), String(row));
    const model = buildRecoveryDemoModel(row as SourceStatusRow);
    const sentence = sourceStateSentence(model.source, { now: NOW, name: model.displayName });
    assert.ok(dom.window.document.querySelector('[data-testid="source-state-sentence"]')?.textContent?.startsWith(sentence.text));
    assert.ok(dom.window.document.querySelector('a[href$="/technical"]'));
    assert.equal(dom.window.document.querySelector('details[data-testid="source-details"]'), null);
  }
});

test("record kinds use human names, known counts, and dates", async () => {
  const dom = await renderDemo("atlas");
  const row = dom.window.document.querySelector('a[href$="/messages"]');
  assert.match(row?.textContent ?? "", /Messages/);
  assert.match(row?.textContent ?? "", /428 records/);
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
