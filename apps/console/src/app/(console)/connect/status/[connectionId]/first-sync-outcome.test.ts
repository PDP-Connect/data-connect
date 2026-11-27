// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test, { mock } from "node:test";
import * as navigation from "next/navigation";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { bannedCopyProblems, visibleText } from "../../../sources/add/banned-copy.ts";
import type { ConnectionSetupStatus } from "../../../lib/ref-client.ts";
import { type FirstSyncFacts, firstSyncOutcome, headlineFor, scheduleSentence } from "./first-sync-outcome.ts";

Object.assign(globalThis, { React });
mock.module("server-only", { namedExports: {} });
mock.module("next/navigation", { namedExports: { ...navigation, useRouter: () => ({ refresh() {}, replace() {} }) } });

const bodyModule = import("./first-sync-body.tsx");

function bodyProps(outcome: ReturnType<typeof firstSyncOutcome>) {
  return { connectionId: "conn_1", connectorId: "amazon", name: "Amazon", outcome, resumeAction: () => {} };
}

function status(overrides: Partial<ConnectionSetupStatus> = {}): ConnectionSetupStatus {
  return {
    account_identity: null,
    connection_id: "conn_1",
    connector_id: "amazon",
    created_at: null,
    credential: { captured_at: null, credential_kind: null, present: false, rotated_at: null },
    display_name: null,
    health_state: "healthy",
    import_receipt: null,
    last_error: null,
    object: "connection_setup_status",
    pending: false,
    run: { finished_at: null, records_emitted: null, reported_records_emitted: null, run_id: "run_1", started_at: null, status: "completed" },
    running: false,
    setup_kind: "browser_session",
    setup_material: { captured_at: null, kind: "browser_session", label: "Sign-in", present: false },
    setup_state: "active",
    status: "active",
    terminal_setup_disposition: null,
    updated_at: null,
    ...overrides,
  } as ConnectionSetupStatus;
}

const hourly: FirstSyncFacts["schedule"] = { effective_mode: "automatic", enabled: true, interval_seconds: 3600 };
const withOrders: FirstSyncFacts = { kinds: [{ count: 1204, kind: "orders" }, { count: 0, kind: "returns" }], schedule: hourly };

const STATES: { label: string; facts: FirstSyncFacts; status: ConnectionSetupStatus }[] = [
  { facts: withOrders, label: "worked", status: status() },
  { facts: { kinds: [], schedule: hourly }, label: "empty (active, run reported zero)", status: status() },
  { facts: withOrders, label: "empty (zero yield)", status: status({ setup_state: "first_sync_zero_yield" }) },
  { facts: withOrders, label: "running", status: status({ running: true, setup_state: "first_sync_running" }) },
  { facts: withOrders, label: "needs you", status: status({ setup_state: "awaiting_browser_login" }) },
  {
    facts: withOrders,
    label: "failed",
    status: status({
      last_error: { reason: "HTTP 429 from provider", remediation: "Wait a few minutes and try again." },
      setup_state: "first_sync_failed",
    }),
  },
  { facts: withOrders, label: "paused", status: status({ setup_state: "paused" }) },
  { facts: withOrders, label: "revoked", status: status({ setup_state: "revoked" }) },
];

// Design Page 3, "Worked": each kind with its count, the schedule sentence, two buttons.
test("worked: kinds with counts, the schedule sentence, and the two buttons", () => {
  const outcome = firstSyncOutcome(status(), "Amazon", withOrders);
  assert.equal(outcome.kind, "worked");
  if (outcome.kind !== "worked") return;
  assert.deepEqual(outcome.collected, [{ count: 1204, label: "Orders", stream: "orders" }]);
  assert.equal(outcome.schedule, "DataConnect checks Amazon every hour.");
  assert.equal(outcome.primary.label, "See your Amazon data");
  assert.equal(outcome.secondary.label, "Add another data source");
});

// Design Page 3: the sentence reads the same schedule the Data sources list shows, word for word.
test("schedule sentence follows the Data sources list: hourly, daily, manual, none, and unknown", () => {
  const at = (seconds: number) => scheduleSentence("Amazon", { effective_mode: "automatic", enabled: true, interval_seconds: seconds });
  assert.equal(at(3600), "DataConnect checks Amazon every hour.");
  assert.equal(at(86_400), "DataConnect checks Amazon every day.");
  assert.equal(at(7200), "DataConnect checks Amazon every 2 hours.");
  const manual = "DataConnect checks Amazon only when you ask.";
  assert.equal(scheduleSentence("Amazon", { effective_mode: "manual", enabled: true, interval_seconds: 3600 }), manual);
  assert.equal(scheduleSentence("Amazon", { effective_mode: "automatic", enabled: false, interval_seconds: 3600 }), manual);
  // The server has no schedule: the list says Manual, so the sentence does too.
  assert.equal(scheduleSentence("Amazon", null), manual);
  // The read failed: say nothing rather than guess.
  assert.equal(scheduleSentence("Amazon", undefined), null);
});

// Design Page 3, "Worked, nothing came": never say "connected" with counts of zero as success.
test("a finished sync that reported zero records is the empty outcome, with Try again", () => {
  assert.equal(firstSyncOutcome(status(), "Amazon", { kinds: [{ count: 0, kind: "orders" }], schedule: hourly }).kind, "empty");
  assert.equal(firstSyncOutcome(status({ setup_state: "first_sync_zero_yield" }), "Amazon", withOrders).kind, "empty");
});

// Honest states: unknown counts are not "nothing came".
test("a finished sync with no count facts is worked, not empty", () => {
  assert.equal(firstSyncOutcome(status(), "Amazon", { kinds: null, schedule: undefined }).kind, "worked");
});

// Design Page 3, "Failed": the right retry for the kind of service.
test("failed: the retry button matches the kind of service", () => {
  const failed = { last_error: { reason: "x", remediation: "y" }, setup_state: "first_sync_failed" as const };
  const label = (kind: ConnectionSetupStatus["setup_kind"]) => {
    const outcome = firstSyncOutcome(status({ ...failed, setup_kind: kind }), "Amazon", withOrders);
    return outcome.kind === "failed" ? outcome.retry : null;
  };
  assert.equal(label("manual_upload")?.label, "Choose another file");
  assert.match(label("manual_upload")?.href ?? "", /^\/connect\/manual-upload\/amazon\?connection_id=conn_1/);
  assert.equal(label("static_secret")?.label, "Enter the key again");
  assert.match(label("static_secret")?.href ?? "", /^\/connect\/static-secret\/amazon\?connection_id=conn_1/);
  assert.equal(label("browser_session")?.label, "Try again");
  assert.match(label("browser_session")?.href ?? "", /^\/connect\/browser-session\/amazon\/launch/);
});

test("running links to the live view and needs-you continues sign-in", () => {
  const running = firstSyncOutcome(status({ running: true, setup_state: "first_sync_running" }), "Amazon", withOrders);
  assert.equal(running.kind === "running" && running.watch.href, "/syncs/run_1/stream");
  const needs = firstSyncOutcome(status({ setup_state: "awaiting_browser_login" }), "Amazon", withOrders);
  assert.equal(needs.kind === "needs-you" && needs.next.label, "Continue");
});

// Design Page 3 + banned list: every outcome, rendered, is free of banned words, badges, folds, ids.
test("every outcome renders with none of the banned words, badges or folds", async () => {
  const { FirstSyncBody } = await bodyModule;
  for (const state of STATES) {
    const outcome = firstSyncOutcome(state.status, "Amazon", state.facts);
    const html = renderToStaticMarkup(createElement(FirstSyncBody, bodyProps(outcome)));
    assert.deepEqual(bannedCopyProblems(html, { allowedFold: "What went wrong" }), [], `banned copy on "${state.label}"`);
    assert.doesNotMatch(visibleText(html), /conn_1|run_1/, state.label);
  }
});

test("failed shows its reason under the headline and the server message only in the fold", async () => {
  const { FirstSyncBody } = await bodyModule;
  const failedState = STATES.find((state) => state.label === "failed");
  assert.ok(failedState);
  const outcome = firstSyncOutcome(failedState.status, "Amazon", withOrders);
  const html = renderToStaticMarkup(createElement(FirstSyncBody, bodyProps(outcome)));
  assert.match(html, /Amazon didn&#x27;t connect\./);
  assert.match(html, /Something went wrong while copying your data\./);
  // A run id exists: the raw reason lives on the technical page, not in a fold.
  assert.doesNotMatch(html, /HTTP 429 from provider/);
  assert.match(html, /\/syncs\/run_1\/technical/);
  const noRun = firstSyncOutcome({ ...failedState.status, run: null }, "Amazon", withOrders);
  const noRunHtml = renderToStaticMarkup(createElement(FirstSyncBody, bodyProps(noRun)));
  assert.match(noRunHtml, /<details/);
  assert.match(noRunHtml, /What went wrong/);
});

// Design Page 3: the result is the heading beside one logo; arrivals are a "What is here" style list;
// the schedule sentence follows; at most two buttons; no "Back to Data sources".
test("worked: heading, one logo, the arrived list, the schedule, and two buttons only", async () => {
  const { FirstSyncBody } = await bodyModule;
  const html = renderToStaticMarkup(createElement(FirstSyncBody, bodyProps(firstSyncOutcome(status(), "Amazon", withOrders))));
  const text = visibleText(html).replace(/\s+/g, " ");
  assert.match(html, /<h1[^>]*>[\s\S]*Amazon is connected\.[\s\S]*<\/h1>/);
  assert.match(text, /Orders 1,204 records/);
  assert.match(text, /DataConnect checks Amazon every hour\./);
  assert.match(html, /href="\/sources\/conn_1\/orders"/);
  assert.equal((html.match(/class="[^"]*min-h-11/g) ?? []).length, 2, "exactly the two buttons");
  assert.doesNotMatch(text, /Back to Data sources/);
  assert.match(text, /See your Amazon data/);
  assert.match(text, /Add another data source/);
});

test("worked with no schedule on the server says the data source is checked only when asked", async () => {
  const { FirstSyncBody } = await bodyModule;
  const outcome = firstSyncOutcome(status(), "Amazon", { kinds: [{ count: 3, kind: "orders" }], schedule: null });
  const html = renderToStaticMarkup(createElement(FirstSyncBody, bodyProps(outcome)));
  assert.match(visibleText(html), /DataConnect checks Amazon only when you ask\./);
});

// Design Page 3 "Paused": same Resume action as the Data sources list, and at most two buttons.
test("paused: Resume posts the connection id to the resume action, beside one link", async () => {
  const { FirstSyncBody } = await bodyModule;
  const html = renderToStaticMarkup(createElement(FirstSyncBody, bodyProps(firstSyncOutcome(status({ setup_state: "paused" }), "Amazon", withOrders))));
  assert.match(html, /Amazon is paused\./);
  assert.match(html, /<form[\s\S]*name="connection_id"[^>]*value="conn_1"[\s\S]*>Resume</);
  assert.equal((html.match(/class="[^"]*min-h-11/g) ?? []).length, 2, "Resume and one link");
  assert.doesNotMatch(visibleText(html), /Back to Data sources/);
});

// Second-half design: report missing kinds and only promise a retry with explicit evidence.
test("missing kinds remain visible, informational notes are excluded, and retry needs an explicit flag", () => {
  const facts = { ...withOrders, gaps: [{ kind: "skip_result", stream: "returns", reason: "not_available", message: "Northwind could not send returns.", recovery_hint: { retryable: true } }, { kind: "note", reason: "nothing_new", severity: "informational" as const }] };
  const outcome = firstSyncOutcome(status(), "Northwind", facts);
  assert.equal(outcome.kind, "partial");
  assert.equal(headlineFor(outcome, "Northwind"), "Northwind is connected, but some of it didn't come.");
  if (outcome.kind !== "partial") return;
  assert.equal(outcome.missing.length, 1);
  assert.equal(outcome.missing[0]?.label, "Returns");
  assert.ok(outcome.retry);
  const noRetry = firstSyncOutcome(status(), "Northwind", { ...facts, gaps: [{ kind: "skip_result", stream: "returns", reason: "not_available", recovery_hint: { retryable: false } }] });
  assert.equal(noRetry.kind === "partial" ? noRetry.retry : undefined, null);
});
test("reported busy, owner stop, and assistance timeout get their own truthful result", () => {
  for (const [reason, title] of [["owner_cancelled", "You stopped this."], ["owner_cancel_forced", "You stopped this."], ["assistance_timed_out", "The sign-in to Northwind wasn't finished."]] as const) {
    const outcome = firstSyncOutcome(status({ setup_state: "first_sync_failed" }), "Northwind", { ...withOrders, failureReason: reason });
    assert.equal(headlineFor(outcome, "Northwind"), title);
  }
  const busy = firstSyncOutcome(status({ setup_state: "first_sync_failed" }), "Northwind", { ...withOrders, runStatus: "deferred" });
  assert.equal(headlineFor(busy, "Northwind"), "DataConnect was busy with another sign-in.");
  // Arbitrary prose, connector cancellation, and scheduler timeout do not prove these causes.
  for (const reason of ["auth failed", "connector_reported_cancelled", "run_timed_out"]) {
    const outcome = firstSyncOutcome(status({ setup_state: "first_sync_failed" }), "Northwind", { ...withOrders, failureReason: reason });
    assert.equal(headlineFor(outcome, "Northwind"), "Northwind didn't connect.");
  }
});
test("needs-you goes to the code page or the same-copy details form, not back to Connect", () => {
  for (const [setup_state, suffix] of [["awaiting_browser_login", "/stream"], ["awaiting_credential", "?return_to=status#sign-in-details"]] as const) {
    const outcome = firstSyncOutcome(status({ setup_state }), "Northwind", withOrders);
    assert.equal(outcome.kind === "needs-you" ? outcome.next.href : null, `/syncs/run_1${suffix}`);
  }
});

test("copying stop asks before stopping and preserves copied data in its explanation", async () => {
  const { StopCopyingQuestion } = await import("./stop-copying.tsx");
  const html = renderToStaticMarkup(createElement(StopCopyingQuestion, { name: "Northwind", onKeepGoing() {}, onStop() {} }));
  assert.match(visibleText(html), /Stop copying Northwind\? What has been copied so far is kept\. You can start again any time\./);
  assert.match(html, /role="alertdialog"/);
  assert.match(visibleText(html), /Keep going/);
});

test("a first connection that failed before its sign-in page opened says what did not start", () => {
  const failed = status({ setup_state: "first_sync_failed", last_error: { reason: "The sign-in computer was unavailable.", remediation: "Try again." } });
  const facts: FirstSyncFacts = { kinds: null, schedule: undefined, signedIn: false, runStatus: "surface_failed" };
  const outcome = firstSyncOutcome(failed, "Northwind", facts);
  assert.equal(headlineFor(outcome, "Northwind"), "Northwind didn't connect.");
  assert.equal(outcome.kind, "failed");
  if (outcome.kind !== "failed") return;
  assert.equal(outcome.reason, "DataConnect could not open Northwind's sign-in page.");
  assert.equal(outcome.retry.label, "Try again");
  // A run id exists: the raw reason moves to its technical page.
  assert.equal(outcome.wentWrong, null);
  assert.equal(outcome.technical?.href, "/syncs/run_1/technical");
  const afterCopy = firstSyncOutcome(failed, "Northwind", { ...facts, kinds: [{ count: 1, kind: "messages" }] });
  assert.ok(afterCopy.kind === "failed" && afterCopy.reason === "Something went wrong while copying your data.");
});

// Phone walk, fault 1c: the page for a partly failed data source shows one plain sentence,
// never the connector's own text or codes.
const RAW_VENMO_GAP = "Venmo is showing a security check instead of the sign-in form (sign-in form did not render). Complete the check, then respond succe… venmo_session_failed: venmo_login_did_not_complete: no sign-in outcome within 30000ms after challenge replay Staged stream state was not committed";
test("partial: a gap's raw connector text is replaced by one plain sentence", async () => {
  const { FirstSyncBody } = await bodyModule;
  const facts = { ...withOrders, gaps: [{ kind: "skip_result", reason: "venmo_session_failed", message: RAW_VENMO_GAP, recovery_hint: { retryable: true } }] };
  const outcome = firstSyncOutcome(status(), "Venmo", facts);
  assert.equal(outcome.kind, "partial");
  const text = visibleText(renderToStaticMarkup(createElement(FirstSyncBody, { ...bodyProps(outcome), name: "Venmo" }))).replace(/\s+/g, " ");
  assert.doesNotMatch(text, /venmo_session_failed|Staged stream|succe…|30000ms|CAPTCHA/);
  assert.match(text, /Venmo asked for a new sign-in\./);
  // A sign-in cause needs the person: no promise of an automatic retry, a real action instead.
  assert.doesNotMatch(text, /It will try again/);
  assert.equal(outcome.kind === "partial" ? outcome.retry?.label : null, "Sign in again");
  assert.match(outcome.kind === "partial" ? outcome.retry?.href ?? "" : "", /^\/connect\/browser-session\/amazon\/launch/);
  assert.ok(/href="\/connect\/browser-session\/amazon\/launch[^"]*"[^>]*>(?:<!-- -->)?Sign in again/.test(renderToStaticMarkup(createElement(FirstSyncBody, { ...bodyProps(outcome), name: "Venmo" }))));
  assert.equal(outcome.kind === "partial" ? outcome.technical?.href : null, "/syncs/run_1/technical");
  assert.match(text, /Technical details/);
});
test("partial: a cause that retries by itself still says so, with Try again", async () => {
  const { FirstSyncBody } = await bodyModule;
  const facts = { ...withOrders, gaps: [{ kind: "skip_result", reason: "stream_collection_failed", message: "x", recovery_hint: { retryable: true } }] };
  const outcome = firstSyncOutcome(status(), "Amazon", facts);
  const text = visibleText(renderToStaticMarkup(createElement(FirstSyncBody, bodyProps(outcome)))).replace(/\s+/g, " ");
  assert.match(text, /It will try again the next time DataConnect checks Amazon\./);
  assert.equal(outcome.kind === "partial" ? outcome.retry?.label : null, "Try again");
});
test("failed: a known cause gets its plain sentence and action, the raw reason stays on the technical page", async () => {
  const { FirstSyncBody } = await bodyModule;
  const failed = status({ setup_state: "first_sync_failed", last_error: { reason: "venmo_session_failed: venmo_login_did_not_complete", remediation: "x" } });
  const outcome = firstSyncOutcome(failed, "Venmo", withOrders);
  assert.equal(outcome.kind, "failed");
  if (outcome.kind !== "failed") return;
  assert.equal(outcome.reason, "Venmo asked for a new sign-in.");
  assert.equal(outcome.retry.label, "Sign in again");
  assert.equal(outcome.wentWrong, null);
  assert.equal(outcome.technical?.href, "/syncs/run_1/technical");
  const text = visibleText(renderToStaticMarkup(createElement(FirstSyncBody, { ...bodyProps(outcome), name: "Venmo" })));
  assert.doesNotMatch(text, /venmo_session_failed|What went wrong/);
  assert.match(text, /Technical details/);
  const noRun = firstSyncOutcome(status({ ...failed, run: null }), "Venmo", withOrders);
  assert.ok(noRun.kind === "failed" && noRun.technical === null && noRun.wentWrong === failed.last_error?.reason);
});
test("partial: a gap with no known cause says DataConnect could not copy it", () => {
  const outcome = firstSyncOutcome(status(), "Northwind", { ...withOrders, gaps: [{ kind: "skip_result", stream: "returns", reason: "odd", message: "odd_code: raw detail" }] });
  assert.equal(outcome.kind === "partial" ? outcome.missing[0]?.message : null, "DataConnect could not copy this.");
});

// Phone walk, fault 1a: with no name at all the words stay grammatical.
test("a data source with no name never reads 'your this data source data'", async () => {
  const { FirstSyncBody } = await bodyModule;
  const name = "this data source";
  const outcome = firstSyncOutcome(status(), name, { ...withOrders, gaps: [{ kind: "skip_result", stream: "returns", reason: "x", recovery_hint: { retryable: true } }] });
  assert.equal(headlineFor(outcome, name), "This data source is connected, but some of it didn't come.");
  const text = visibleText(renderToStaticMarkup(createElement(FirstSyncBody, { ...bodyProps(outcome), name }))).replace(/\s+/g, " ");
  assert.doesNotMatch(text, /your this data source/i);
  assert.match(text, /See your data/);
});

// Phone walk, fault 1b: a source's own page does not end its trail with "Add a data source".
test("the trail on a source's own page ends with that source, not 'Add a data source'", async () => {
  const { FirstSyncBody } = await bodyModule;
  const html = renderToStaticMarkup(createElement(FirstSyncBody, { ...bodyProps(firstSyncOutcome(status(), "Amazon", withOrders)), name: "Amazon" }));
  const nav = html.match(/<nav[\s\S]*?<\/nav>/)?.[0] ?? "";
  assert.match(visibleText(nav), /Home\s*\/\s*Data sources\s*\/\s*Amazon/);
  assert.doesNotMatch(nav, /Add a data source/);
  assert.match(nav, /href="\/sources\/amazon\?connection_id=conn_1"/);
});

// Round 3, finding 1: the cause is one thing, the label is the kind of service's.
test("known recovery matches setup kind", () => {
  const keyGone = { ...withOrders, gaps: [{ kind: "skip_result", reason: "static_secret_credential_unavailable", message: "x" }] };
  const key = firstSyncOutcome(status({ setup_kind: "static_secret" }), "Linear", keyGone);
  assert.equal(key.kind === "partial" ? key.retry?.label : null, "Enter the key again");
  assert.match(key.kind === "partial" ? key.retry?.href ?? "" : "", /^\/connect\/static-secret\/amazon\?connection_id=conn_1/);
  const denied = { ...withOrders, gaps: [{ kind: "skip_result", reason: "access_denied", message: "x" }] };
  const file = firstSyncOutcome(status({ setup_kind: "manual_upload" }), "Takeout", denied);
  assert.equal(file.kind === "partial" ? file.retry?.label : null, "Choose another file");
  assert.match(file.kind === "partial" ? file.retry?.href ?? "" : "", /^\/connect\/manual-upload\//);
  assert.doesNotMatch(JSON.stringify(file), /[Ss]ign[- ]in/);
  const failedKey = firstSyncOutcome(status({ setup_kind: "static_secret", setup_state: "first_sync_failed", last_error: { reason: "static_secret_credential_unavailable", remediation: "x" } }), "Linear", withOrders);
  assert.equal(failedKey.kind === "failed" ? failedKey.retry.label : null, "Enter the key again");
  const failedFile = firstSyncOutcome(status({ setup_kind: "manual_upload", setup_state: "first_sync_failed", last_error: { reason: "access_denied", remediation: "x" } }), "Takeout", withOrders);
  assert.equal(failedFile.kind === "failed" ? failedFile.retry.label : null, "Choose another file");
  assert.doesNotMatch(JSON.stringify(failedFile), /[Ss]ign[- ]in/);
});

// Round 3, finding 2: promise a retry only when a schedule will make it and the cause does not need the person.
test("partial: no automatic-retry promise without an active schedule or when the person is needed", async () => {
  const { FirstSyncBody } = await bodyModule;
  const render = (facts: FirstSyncFacts, name = "Amazon") => visibleText(renderToStaticMarkup(createElement(FirstSyncBody, { ...bodyProps(firstSyncOutcome(status(), name, facts)), name }))).replace(/\s+/g, " ");
  const retryable = { kind: "skip_result", reason: "stream_collection_failed", message: "x", recovery_hint: { retryable: true } };
  const manual = render({ ...withOrders, schedule: null, gaps: [retryable] });
  assert.doesNotMatch(manual, /It will try again/);
  assert.match(manual, /Nothing is scheduled for Amazon, so it will not try again by itself\./);
  assert.match(manual, /Try again/);
  const timeout = render({ ...withOrders, gaps: [{ kind: "skip_result", reason: "assistance_timed_out", message: "x", recovery_hint: { retryable: true } }] });
  assert.doesNotMatch(timeout, /It will try again|Nothing is scheduled/);
  assert.match(timeout, /Try again/);
  assert.match(render({ ...withOrders, gaps: [retryable] }), /It will try again the next time DataConnect checks Amazon\./);
  assert.doesNotMatch(render({ ...withOrders, schedule: undefined, gaps: [retryable] }), /It will try again|Nothing is scheduled/);
});

// Round 3, finding 3: a present recovery link is the primary button whatever its label.
test("partial: Try again is the primary button and See your data the secondary", async () => {
  const { FirstSyncBody } = await bodyModule;
  const facts = { ...withOrders, gaps: [{ kind: "skip_result", reason: "stream_collection_failed", message: "x", recovery_hint: { retryable: true } }] };
  const html = renderToStaticMarkup(createElement(FirstSyncBody, bodyProps(firstSyncOutcome(status(), "Amazon", facts))));
  const cls = (label: string) => new RegExp(`<a[^>]*class="([^"]*)"[^>]*>(?:<!-- -->)?${label}`).exec(html)?.[1] ?? "";
  // The default variant has no modifier class; the secondary one is the ghost variant.
  assert.ok(cls("Try again").includes("pdpp-btn"));
  assert.doesNotMatch(cls("Try again"), /pdpp-btn--ghost/);
  assert.match(cls("See your Amazon data"), /pdpp-btn--ghost/);
});
