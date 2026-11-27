// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// RAISE-RULES 4 and 8: render the sync page for each state a person can meet
// (needs a code, needs the browser, syncing, finished, failed, cancelled) and
// check the words shown outside the folded "Details". Server reads are
// replaced with timelines shaped like the ones the other tests in this folder
// and `stream/stream-page-terminal-state.test.ts` use.
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { JSDOM } from "jsdom";
import type * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { RunStatusEnvelope, SpineEvent, TimelineEnvelope } from "../../lib/ref-client.ts";

const NOW = Date.parse("2026-11-25T12:00:00.000Z");
const RUN_ID = "run_render_1";
const CONNECTION_ID = "conn_strava_1";
const CONNECTOR_ID = "https://registry.pdpp.org/connectors/strava";
const OPEN_BROWSER_RE = /Open the browser/;
const CANCEL_INTERACTION_RE = /Cancel interaction/;
const DONE_RE = /Done/;
const ANSWER_FORM_RE = /Answer this request/;
const WHAT_COLLECTED_RE = /What it collected/;
const ACTIVITIES_RE = /Activities/;
const COLLECTED_COUNT_RE = /8/;

function Link({ children, href, ...props }: React.ComponentProps<"a"> & { href: string }) {
  return createElement("a", { ...props, href }, children);
}

function IcButton({ children, size: _size, variant: _variant, ...props }: React.ComponentProps<"button"> & {
  size?: string;
  variant?: string;
}) {
  return createElement("button", { ...props, type: props.type ?? "button" }, children);
}

function IcInput(props: React.ComponentProps<"input">) {
  return createElement("input", props);
}

function PageHeader({ breadcrumbs, description, title }: {
  breadcrumbs?: { href?: string; label: string }[];
  description?: React.ReactNode;
  title: React.ReactNode;
}) {
  return createElement(
    "header",
    null,
    createElement(
      "nav",
      null,
      breadcrumbs?.map((item) =>
        item.href ? createElement(Link, { href: item.href, key: item.label }, item.label) : createElement("span", { key: item.label }, item.label),
      ),
    ),
    createElement("h1", null, title),
    description ? createElement("p", null, description) : null,
  );
}

function Callout({ action, children, description, title }: {
  action?: React.ReactNode;
  children?: React.ReactNode;
  description?: React.ReactNode;
  title: React.ReactNode;
}) {
  return createElement("section", null, createElement("h2", null, title), action, createElement("p", null, description), children);
}

function Section({ children, title }: { children?: React.ReactNode; title: React.ReactNode }) {
  return createElement("section", null, createElement("h3", null, title), children);
}

function StatusBadge({ status }: { status: string }) {
  return createElement("span", null, status);
}

function Passthrough({ children }: { children?: React.ReactNode }) {
  return createElement("div", null, children);
}

class ReferenceServerUnreachableError extends Error {}

let timeline: TimelineEnvelope | null = null;
let runStatus: RunStatusEnvelope | null = null;

mock.module("server-only", { namedExports: {} });
mock.module("next/navigation", {
  namedExports: {
    notFound: () => {
      throw new Error("unexpected notFound");
    },
    useRouter: () => ({ refresh() {} }),
  },
});
mock.module("next/link", { defaultExport: Link });
mock.module("@pdpp/brand-react", {
  namedExports: { IcButton, IcInput, buttonVariants: () => "button" },
});
mock.module("@pdpp/operator-ui/components/primitives", {
  namedExports: { Callout, PageHeader, Section, StatusBadge },
});
mock.module("@pdpp/operator-ui/components/timeline-view", {
  namedExports: { TimelineView: () => createElement("ol", { "data-testid": "timeline" }) },
});
mock.module("@pdpp/operator-ui/components/views/timeline-detail-view", {
  namedExports: { exploreHrefFromEnvelope: () => "/explore" },
});
mock.module(new URL("../../components/recordroom-shell-with-palette.tsx", import.meta.url).href, {
  namedExports: { RecordroomShellWithPalette: Passthrough },
});
mock.module(new URL("../../components/connector-mark.tsx", import.meta.url).href, {
  namedExports: { ConnectorMark: () => createElement("span", { "aria-hidden": true }) },
});
mock.module(new URL("../../lib/owner-token.ts", import.meta.url).href, {
  namedExports: { ReferenceServerUnreachableError },
});
mock.module(new URL("../../lib/ref-client.ts", import.meta.url).href, {
  namedExports: {
    getRunStatus: async () => runStatus,
    getRunTimeline: async () => timeline,
    getStaticSecretSetup: async () => null,
    listRunRecordRejectionReceipts: async () => ({ receipts: [], truncated: false }),
  },
});
mock.module(new URL("../../lib/rs-client.ts", import.meta.url).href, {
  namedExports: {
    listConnectorManifests: async () => [
      { connector_id: CONNECTOR_ID, connector_key: "strava", display_name: "Strava", icon: null },
    ],
  },
});
mock.module(new URL("./actions.ts", import.meta.url).href, {
  namedExports: {
    cancelRunAction: async () => ({ ok: true }),
    submitRunInteractionAction: async () => ({ error: null, status: "success" }),
  },
});

function event(eventType: string, data: Record<string, unknown> = {}, extra: Partial<SpineEvent> = {}): SpineEvent {
  return {
    actor_id: CONNECTOR_ID,
    actor_type: "runtime",
    client_id: null,
    data: { connector_instance_id: CONNECTION_ID, ...data },
    event_id: `evt_${eventType}_${Math.random().toString(36).slice(2)}`,
    event_type: eventType,
    grant_id: "grt_1",
    interaction_id: null,
    object_id: RUN_ID,
    object_type: "run",
    occurred_at: "2026-11-25T11:58:00.000Z",
    recorded_at: "2026-11-25T11:58:00.000Z",
    request_id: null,
    run_id: RUN_ID,
    scenario_id: null,
    status: null,
    stream_id: null,
    subject_id: null,
    subject_type: null,
    token_id: null,
    trace_id: "trc_1",
    version: "1",
    ...extra,
  };
}

const started = event("run.started");
const progress = event("run.progress_reported", { count: 40, message: "Fetched activities", total: 80 });
const otpRequest = event("run.assistance_requested", {
  assistance_request_id: "assist_otp",
  input_schema: { properties: { code: { type: "string" } }, required: ["code"], type: "object" },
  kind: "otp",
  message: "Enter the code Strava sent to your phone.",
  owner_action: "provide_value",
  progress_posture: "blocked",
  response_contract: "response_required",
});
const browserRequest = event("run.assistance_requested", {
  assistance_request_id: "assist_browser",
  attachments: [{ kind: "browser_surface", ref: null, status: "pending" }],
  kind: "manual_action",
  message: "Sign in to Strava in the browser.",
  owner_action: "operate_attachment",
  progress_posture: "blocked",
  response_contract: "response_required",
});
// The one shape the runtime emits that reaches the sync page's Done answer: a
// schema-less `credentials` INTERACTION (runtime/index.ts
// buildAssistanceRequestedDataFromInteraction). `manual_action` always carries a
// browser attachment, and structured ASSISTANCE cannot be response_required.
const fieldlessRequest = event("run.assistance_requested", {
  assistance_request_id: "assist_done",
  kind: "credentials",
  message: "Confirm that you completed the step.",
  owner_action: "provide_value",
  progress_posture: "blocked",
  response_contract: "response_required",
});
const approvalRequest = event("run.assistance_requested", {
  assistance_request_id: "assist_approval",
  kind: "approval",
  message: "Approve the sign-in in the Strava app.",
  owner_action: "act_elsewhere",
  progress_posture: "running",
  response_contract: "none",
});

function statusFor(status: RunStatusEnvelope["status"], failure: RunStatusEnvelope["failure"] = null): RunStatusEnvelope {
  return {
    completed_at: null,
    connector_id: CONNECTOR_ID,
    connector_instance_id: CONNECTION_ID,
    failure,
    links: { timeline: `/_ref/runs/${RUN_ID}/timeline` },
    object: "run_status",
    record_outcomes: { permanently_rejected: 0, unaccounted_by_stream: {} },
    run_id: RUN_ID,
    started_at: "2026-11-25T11:58:00.000Z",
    status,
    terminal_reason: null,
    trace_id: "trc_1",
  };
}

interface Scenario {
  events: SpineEvent[];
  expect: RegExp[];
  status: RunStatusEnvelope;
  terminal: TimelineEnvelope["terminal_status"];
}

const scenarios: Record<string, Scenario> = {
  "needs-code": {
    events: [started, progress, otpRequest],
    expect: [/Waiting for your response\./, /Submit code/, /Cancel interaction/],
    status: statusFor("active"),
    terminal: null,
  },
  "needs-browser": {
    events: [started, browserRequest],
    expect: [/Waiting for you to use the browser\./, /Open the browser/],
    status: statusFor("active"),
    terminal: null,
  },
  "needs-done": {
    events: [started, fieldlessRequest],
    expect: [/Done/, /Confirm that you completed the step\./],
    status: statusFor("active"),
    terminal: null,
  },
  "needs-approval": {
    events: [started, approvalRequest],
    expect: [/Waiting for you to approve the request\./],
    status: statusFor("active"),
    terminal: null,
  },
  running: {
    events: [started, progress],
    expect: [/Syncing now\./],
    status: statusFor("active"),
    terminal: null,
  },
  done: {
    events: [started, progress, event("run.completed", {
      collection_facts: { streams: [{ collected: 8, stream: "activities" }] },
    }, { status: "succeeded" })],
    expect: [/This sync finished\./],
    status: statusFor("completed"),
    terminal: "completed",
  },
  failed: {
    events: [
      started,
      progress,
      event("run.failed", {
        collection_facts: { streams: [{ collected: 4, stream: "posts" }, { collected: 0, stream: "comments" }] },
        connector_error_message: "Strava returned 500",
        failure_origin: "connector",
        reason: "connector_error",
      }),
    ],
    expect: [/This sync did not finish\./, /Collected before it stopped/, /Posts/, /4 records/],
    status: statusFor("failed", { connector_error_message: "Strava returned 500", message: null, origin: "connector", reason: "connector_error" }),
    terminal: "failed",
  },
  cancelled: {
    events: [started, progress, event("run.cancelled", {
      collection_facts: { streams: [{ collected: 2, stream: "comments" }] },
    }, { status: "cancelled" })],
    expect: [/This sync was cancelled\./, /Collected before it stopped/, /2 records/],
    status: statusFor("cancelled"),
    terminal: "cancelled",
  },
  "all-zero": {
    events: [started, event("run.completed", {
      collection_facts: { streams: [{ collected: 0, stream: "activities" }, { collected: 0, stream: "posts" }] },
    }, { status: "succeeded" })],
    expect: [/Nothing was collected\./],
    status: statusFor("completed"),
    terminal: "completed",
  },
  "unknown-count": {
    events: [started, event("run.completed", {
      collection_facts: { streams: [{ collected: 0, stream: "activities" }, { stream: "posts" }] },
    }, { status: "succeeded" })],
    expect: [/This sync finished\./],
    status: statusFor("completed"),
    terminal: "completed",
  },
  "no-kinds": {
    events: [started, event("run.completed", { collection_facts: { streams: [] } }, { status: "succeeded" })],
    expect: [/This sync finished\./],
    status: statusFor("completed"),
    terminal: "completed",
  },
};

// RAISE-RULES 4 and PAGE-RULES 6: none of these outside a folded "Details".
const BANNED: [string, RegExp][] = [
  ["run", /\bruns?\b/i],
  ["stream", /\bstreams?\b/i],
  ["connector", /\bconnectors?\b/i],
  ["grant", /\bgrants?\b/i],
  ["client", /\bclients?\b/i],
  ["bearer", /\bbearer\b/i],
  ["scope", /\bscopes?\b/i],
  ["token", /\btokens?\b/i],
  ["manifest", /\bmanifests?\b/i],
  ["projection", /\bprojections?\b/i],
  ["cursor", /\bcursors?\b/i],
  ["trace", /\btraces?\b/i],
  ["verdict", /\bverdicts?\b/i],
  ["coverage", /\bcoverage\b/i],
  ["fleet", /\bfleet\b/i],
  ["instance", /\binstances?\b/i],
  ["reference server", /reference server/i],
  ["raw ISO date", /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/],
  ["raw id", /\b(?:run|conn|assist|evt|grt|trc)_[a-z0-9_]+/i],
];

async function renderScenario(name: string): Promise<{ details: string; visible: string }> {
  const scenario = scenarios[name];
  assert.ok(scenario, name);
  timeline = {
    event_count: scenario.events.length,
    events: scenario.events,
    object: "run_timeline",
    terminal_status: scenario.terminal,
    truncated: false,
  } as TimelineEnvelope;
  runStatus = scenario.status;
  const { default: RunDetailPage } = await import("./technical-page.tsx");
  const realNow = Date.now;
  Date.now = () => NOW;
  try {
    const element = await RunDetailPage({
      params: Promise.resolve({ runId: RUN_ID }),
      searchParams: Promise.resolve({}),
    });
    const { document } = new JSDOM(renderToStaticMarkup(element)).window;
    const details = document.querySelector('[data-testid="sync-details"]');
    assert.ok(details, `${name}: the page has one folded Details`);
    const detailsText = details.textContent ?? "";
    details.remove();
    const attributes = [...document.querySelectorAll("[aria-label],[placeholder],[title]")].flatMap((node) =>
      ["aria-label", "placeholder", "title"].map((attr) => node.getAttribute(attr) ?? ""),
    );
    return { details: detailsText, visible: [document.body.textContent ?? "", ...attributes].join("\n") };
  } finally {
    Date.now = realNow;
  }
}

for (const name of Object.keys(scenarios)) {
  test(`sync page, ${name}: plain words outside Details`, async () => {
    const { details, visible } = await renderScenario(name);
    for (const pattern of scenarios[name]?.expect ?? []) {
      assert.match(visible, pattern, `${name}: expected ${pattern}`);
    }
    assert.match(visible, /Strava sync/);
    assert.match(visible, /Started 2 minutes ago\./);
    const hits = BANNED.filter(([, pattern]) => pattern.test(visible)).map(([word]) => word);
    assert.deepEqual(hits, [], `${name} shows ${hits.join(", ")} outside Details:\n${visible}`);
    // The technical facts are folded, not removed.
    assert.match(details, /Timeline/);
    assert.match(details, /Reference CLI/);
  });
}

test("sync page, needs-browser: remote browser steps link to the browser page", async () => {
  const { visible } = await renderScenario("needs-browser");
  assert.match(visible, OPEN_BROWSER_RE);
  assert.doesNotMatch(visible, CANCEL_INTERACTION_RE);
});

test("sync page, fieldless request: non-browser steps have a Done answer", async () => {
  const { visible } = await renderScenario("needs-done");
  assert.match(visible, DONE_RE);
  assert.match(visible, ANSWER_FORM_RE);
});

test("sync page, finished: collected kinds and counts are shown", async () => {
  const { visible } = await renderScenario("done");
  assert.match(visible, WHAT_COLLECTED_RE);
  assert.match(visible, ACTIVITIES_RE);
  assert.match(visible, COLLECTED_COUNT_RE);
});

test("sync page, failed partial collection omits kinds with zero records", async () => {
  const { visible } = await renderScenario("failed");
  assert.match(visible, /Collected before it stopped/);
  assert.match(visible, /Posts/);
  assert.match(visible, /4 records/);
  assert.doesNotMatch(visible, /Comments/);
});

test("sync page, cancelled collection reports what arrived before it stopped", async () => {
  const { visible } = await renderScenario("cancelled");
  assert.match(visible, /Collected before it stopped/);
  assert.match(visible, /Comments/);
  assert.match(visible, /2 records/);
});

test("sync page, all-zero collection says nothing was collected", async () => {
  const { visible } = await renderScenario("all-zero");
  assert.match(visible, /Nothing was collected\./);
  assert.doesNotMatch(visible, /Activities|Posts/);
});

test("sync page never says nothing was collected unless every count is known and zero", async () => {
  for (const name of ["unknown-count", "no-kinds"] as const) {
    const { visible } = await renderScenario(name);
    assert.doesNotMatch(visible, /Nothing was collected/, name);
    assert.doesNotMatch(visible, WHAT_COLLECTED_RE, name);
  }
});

test("the technical practice address renders the real technical page without a live read", async () => {
  const { default: Page } = await import("./technical-page.tsx");
  const element = await Page({params:Promise.resolve({runId:"practice-sync"}),searchParams:Promise.resolve({demo:"technical"})});
  const document = new JSDOM(renderToStaticMarkup(element)).window.document;
  assert.match(document.body.textContent ?? "",/Technical details for this sync/);
  assert.match(document.body.textContent ?? "",/Northwind/);
  assert.match(document.body.textContent ?? "",/14/);
});
