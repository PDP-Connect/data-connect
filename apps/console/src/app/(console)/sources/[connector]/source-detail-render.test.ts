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
  const page = await ConnectorPage({
    params: Promise.resolve({ connector: "cin_demo_claude_code_workstation" }),
    searchParams: Promise.resolve({ demo }),
  });
  return new JSDOM(renderToStaticMarkup(page));
}

function visibleOutsideDetails(dom: JSDOM): string {
  const document = dom.window.document.cloneNode(true) as Document;
  for (const details of [...document.querySelectorAll("details")]) details.remove();
  return (document.body.textContent ?? "").replace(/\s+/g, " ").trim();
}

test("each status row renders the shared sentence and only the controls for that status", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  for (let row = 1; row <= 24; row += 1) {
    const model = buildRecoveryDemoModel(row as SourceStatusRow);
    const status = sourceStatusWords(model.source, { now: NOW });
    const sentence = sourceStateSentence(model.source, { now: NOW, name: model.displayName });
    const dom = await renderDemo(`status-${row}`);
    const document = dom.window.document;
    const visibleText = visibleOutsideDetails(dom);
    const renderedSentence = document.querySelector('[data-testid="source-state-sentence"]')?.textContent ?? "";
    const filled = [...document.querySelectorAll("button, a")].filter((element) =>
      element.classList.contains("variant-default") || element.getAttribute("data-variant") === "default"
    );

    assert.equal(status.row, row, `fixture row ${row}`);
    assert.ok(renderedSentence.includes(sentence.text), `shared sentence rendered for row ${row}: ${renderedSentence}`);
    assert.equal(document.querySelector('[data-status-row]')?.getAttribute("data-status-row"), String(row));
    assert.ok(filled.length <= 1, `row ${row} has no more than one filled action`);
    assert.match(visibleText, /Browse records/);
    assert.match(visibleText, /Latest syncs/);
    assert.match(visibleText, /All sync history/);
    assert.match(visibleText, /Schedule/);
    assert.match(visibleText, /This data source/);
    assert.match(visibleText, /Rename/);
    assert.match(visibleText, /Remove or reset/);
    assert.match(visibleText, /Delete data source and erase its records/);
    if (row !== 2) {
      assert.match(visibleText, /Sync again from the start/);
      assert.match(visibleText, /Disconnect/);
    } else {
      assert.doesNotMatch(visibleText, /Sync again from the start|Disconnect/);
    }

    if (status.action && status.action.kind !== "view_device") {
      const actionCount = [...document.querySelectorAll("button, a")].filter((element) =>
        element.textContent?.trim() === status.action?.label
      ).length;
      assert.equal(actionCount, 1, `row ${row} status action appears once: ${status.action.label}`);
    }

    if ([5, 6, 7].includes(row)) {
      const actionLabel = status.action?.label;
      assert.ok(actionLabel);
      assert.equal(visibleText.split(actionLabel).length - 1, 1, `row ${row} action appears exactly once`);
    }
    if (row === 3) {
      const setupActions = [...document.querySelectorAll("a, button")].filter((element) => element.textContent?.trim() === "Set up again");
      assert.equal(setupActions.length, 1, "revoked source has one Set up again control");
    }
    if (row === 6) {
      const retryControl = [...document.querySelectorAll("button, a")].find((element) => element.textContent?.trim() === "Retry first sync");
      assert.equal(retryControl?.tagName, "BUTTON", "without an owner action, Retry first sync starts a sync like the list page");
    }
    if (row === 10) {
      assert.equal(visibleText.split("Resume").length - 1, 1, "ordinary paused source has one Resume action");
      assert.match(visibleText, /Syncing is paused\. Your records, schedule, and sign-in are kept\./);
    }
    if (row === 11) assert.match(visibleText, /Active sync/);
    if (row === 12) {
      const details = document.querySelector('details[data-testid="source-details"]');
      assert.ok(document.querySelector('[data-testid="auto-paused-banner"]'), "backoff banner renders with a recent sync");
      assert.ok(details?.querySelector('[data-testid="auto-pause-reason"]'), "raw backoff reason stays folded");
      assert.ok(!visibleText.includes("retry"), "raw backoff reason does not appear outside Details");
    }

    // The shared sentence is checked where it is written (lib/source-status-words); this checks the page's own words.
    assert.doesNotMatch(
      visibleText.replace(sentence.text, ""),
      /\b(verdict|coverage|fleet|projection|grants?|bearer|manifest|connectors?|runs?|streams?|gaps?|retryable|dead-letter|outbox|cadence|queued|client|scope|token|cursor|trace|subscription|exporter|oauth|pkce|dcr|jwks)\b/i,
      `operator terms stay folded for row ${row}`
    );
  }
});

test("pending details replace the up-to-date wording on rows 19 and 20", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  for (const row of [19, 20] as const) {
    const dom = await renderDemo(row === 20 ? "pending-details" : "pending-details-19");
    const text = dom.window.document.querySelector('[data-testid="source-state-sentence"]')?.textContent ?? "";
    assert.match(text, /^Synced .*\. Some details are still being fetched\.$/);
    assert.doesNotMatch(text, /Up to date|next in|has not checked this against the source/);
  }
});

test("coverage and recovery facts render inside folded Details", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const dom = await renderDemo("atlas");
  const details = dom.window.document.querySelector('details[data-testid="source-details"]');
  const visibleText = visibleOutsideDetails(dom);
  assert.ok(details);
  assert.ok(details.querySelector('[data-testid="stream-collection-facts"]'));
  assert.ok(details.querySelector("#history-confirmation form [name=earliest_available]"));
  assert.ok(details.querySelector("#history-confirmation form [name=acknowledged_by]"));
  assert.ok(details.querySelector('[data-testid="sync-details"] code')?.textContent?.includes("local collector outbox has dead-lettered rows"));
  // Brief decision 7: event counts leave the row but remain reachable in Details.
  assert.match(details.querySelector('[data-testid="sync-details"]')?.textContent ?? "", /14 events/);
  assert.doesNotMatch(visibleText, /14 events/);
  assert.ok(details.querySelector('[data-testid="diagnostics-recovery-panel"]'));
  assert.ok(details.querySelector('[data-testid="diagnostics-details"]'));
});

test("the update-ready demos show single-source and shared-source copy", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const single = await renderDemo("update-ready");
  const shared = await renderDemo("update-ready-shared");
  assert.match(single.window.document.querySelector('[data-testid="source-update-demo"]')?.textContent ?? "", /Version 1\.5\.0 is ready \(you have 1\.4\.0\)\./);
  assert.doesNotMatch(single.window.document.body.textContent ?? "", /It also updates/);
  assert.match(shared.window.document.querySelector('[data-testid="source-update-demo"]')?.textContent ?? "", /It also updates Claude Code personal and Claude Code work\./);
});

test("a local-device pause has no Resume action", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const dom = await renderDemo("status-10-local-device");
  const document = dom.window.document;
  const controls = [...document.querySelectorAll("button, a")].map((element) => element.textContent?.trim());
  assert.equal(document.querySelector("[data-status-row]")?.getAttribute("data-status-row"), "10");
  assert.ok(!controls.includes("Resume"), "a local-device pause offers no Resume");
  // DIRECTION.md row 10: a paused local-device source's one action is "View this device".
  const deviceLinks = [...document.querySelectorAll("header a")].filter((element) => element.textContent?.trim() === "View this device");
  assert.equal(deviceLinks.length, 1, "the header keeps the status action View this device");
});
