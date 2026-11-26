// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { getCurrentBrowserSurfaceAssistance } from "../../../lib/run-assistance.ts";
import { resolveNoAssistanceEndedTerminalStatus, selectNoAssistanceStreamState } from "./stream-state.ts";

const pageSource = readFileSync(fileURLToPath(new URL("./page.tsx", import.meta.url)), "utf8") + readFileSync(fileURLToPath(new URL("./sign-in-parts.tsx", import.meta.url)), "utf8");
const streamViewerSource = readFileSync(fileURLToPath(new URL("./stream-viewer.tsx", import.meta.url)), "utf8");
// Brief item 4 and DIRECTION.md, “What must stay true” #3: keep the visible state in plain words.
const POLLER_TIMELINE_PROBE_RE = /fetch\(`\/_ref\/runs\/\$\{encodeURIComponent\(runId\)\}\/timeline`/;
const POLLER_STREAM_READY_RE = /getCurrentBrowserSurfaceAssistance\(timelineEventsFrom\(body\)\) !== null/;
const POLLER_HARD_RELOAD_RE = /window\.location\.reload\(\)/;
const RUN_STATUS_INSTANCE_CONTEXT_RE =
  /const connectorInstanceId =\s*runStatus\?\.connector_instance_id \?\? getConnectorInstanceIdFromTimeline\(envelope\.events\);/;
// The client no longer filters an unbounded fetch in the browser — it scopes
// the reference read itself, via resolveConnectorSummaryRouteId (instance id
// when known, else the bare connector id — the reference resolves exact
// identity first and only falls back to an unambiguous connector-id match,
// same precedence the old client-side filter enforced).
const INSTANCE_SCOPED_SUMMARY_MATCH_RE =
  /listConnectorSummaries\(\{\s*connectionRouteId:\s*resolveConnectorSummaryRouteId\(connectorId,\s*connectorInstanceId\)/;
const BROWSER_ASSISTANCE_STREAM_KIND_RE =
  /interactionKind=\{streamableAssistance\.kind === "otp" \? "otp" : "manual_action"\}[\s\S]{0,220}interactionMessage=\{normalizeInteractionPrompt\([\s\S]{0,80}streamableAssistance\.message/;
const BROWSER_ASSISTANCE_RESPONSE_CONTRACT_RE =
  /interactionRequiresResponse=\{streamableAssistance\.responseContract === "response_required"\}/;
// Brief item 4 and DIRECTION.md, “What must stay true” #3: keep system terms out of visible state copy.
const WINDOW_CLOSE_RE = /window\.close\(\)/;
const NO_CLIENT_SIDE_FIRST_MATCH_RE = /summaries\.data\.find\(\(c\) => c\.connector_id === connectorId\)/;
const BUILDS_CONTEXT_FROM_MATCH_RE = /return buildConnectorContext\(connectorId, match\);/;
const BUILDS_CONTEXT_FROM_UNDEFINED_RE = /return buildConnectorContext\(connectorId, undefined\);/;

test("no-assistance stream state distinguishes success, terminal failure, and active runs", () => {
  assert.equal(selectNoAssistanceStreamState({ terminalStatus: "completed" }), "resolved");
  assert.equal(selectNoAssistanceStreamState({ terminalStatus: "failed" }), "ended");
  assert.equal(selectNoAssistanceStreamState({ terminalStatus: "cancelled" }), "ended");
  assert.equal(selectNoAssistanceStreamState({ terminalStatus: "abandoned" }), "ended");
  assert.equal(selectNoAssistanceStreamState({ terminalStatus: null }), "running");
  assert.equal(selectNoAssistanceStreamState({ terminalStatus: undefined }), "running");
  assert.equal(selectNoAssistanceStreamState({ runHandleStatus: "failed", terminalStatus: null }), "ended");
  assert.equal(selectNoAssistanceStreamState({ runHandleStatus: "deferred", terminalStatus: null }), "ended");
  assert.equal(selectNoAssistanceStreamState({ runHandleStatus: "surface_failed", terminalStatus: null }), "ended");
  assert.equal(selectNoAssistanceStreamState({ runHandleStatus: "active", terminalStatus: null }), "running");
});

test("ended fallback status preserves specific terminal labels when timeline status is absent", () => {
  assert.equal(
    resolveNoAssistanceEndedTerminalStatus({ runHandleStatus: "cancelled", terminalStatus: null }),
    "cancelled"
  );
  assert.equal(
    resolveNoAssistanceEndedTerminalStatus({ runHandleStatus: "abandoned", terminalStatus: null }),
    "abandoned"
  );
  assert.equal(
    resolveNoAssistanceEndedTerminalStatus({ runHandleStatus: "surface_failed", terminalStatus: null }),
    "failed"
  );
  assert.equal(
    resolveNoAssistanceEndedTerminalStatus({ runHandleStatus: "deferred", terminalStatus: null }),
    "deferred"
  );
});

test("active runs without assistance go to status; only reported completion shows signed-in", () => {
  assert.match(pageSource, /signInDestination\(state, statusHref\)/);
  assert.match(pageSource, /state === "resolved" \|\| hasResolvedBrowserSurfaceAssistance/);
  assert.match(pageSource, /if \(state === "ended"\) redirect\(statusHref\)/);
});
test("completed browser assistance uses the signed-in surface and same-copy destination", () => {
  assert.match(pageSource, /hasResolvedBrowserSurfaceAssistance\(envelope.events\)/);
  assert.match(pageSource, /statusHref=\{statusHref\}/);
  assert.match(streamViewerSource, /You're signed in to/);
  assert.match(streamViewerSource, /scheduleSignInContinuation/);
});
test("automatic browser waits have no history detour", () => {
  assert.doesNotMatch(pageSource, /Sync details|Data source status/);
  assert.match(pageSource, /sign-in page will appear here/);
});
test("browser assistance keeps the server's OTP kind through to the live code field", () => {
  const otpEvent = {
    actor_id: "runtime",
    actor_type: "runtime",
    client_id: null,
    data: {
      assistance_request_id: "assist_otp",
      attachments: [{ kind: "browser_surface", ref: "surface_1" }],
      kind: "otp",
      message: "Enter the code in the browser.",
      owner_action: "operate_attachment",
      progress_posture: "blocked",
      response_contract: "response_required",
    },
    event_id: "evt_assist_otp",
    event_type: "run.assistance_requested",
    grant_id: null,
    interaction_id: null,
    object_id: null,
    object_type: null,
    occurred_at: "2026-11-25T12:00:00.000Z",
    recorded_at: "2026-11-25T12:00:00.000Z",
    request_id: null,
    run_id: "run_1",
    scenario_id: null,
    status: null,
    stream_id: null,
    subject_id: null,
    subject_type: null,
    token_id: null,
    trace_id: "trace_1",
    version: "1",
  };
  const assistance = getCurrentBrowserSurfaceAssistance([otpEvent]);

  assert.equal(assistance?.kind, "otp");
  // A structured browser step carries no kind on the timeline, so it parses as
  // "assistance". It must still reach the dock as a manual step (Done button),
  // never as a kind the dock refuses to render.
  const structured = getCurrentBrowserSurfaceAssistance([
    {
      ...otpEvent,
      data: { ...otpEvent.data, assistance_request_id: "assist_structured", kind: undefined },
      event_id: "evt_assist_structured",
    },
  ]);
  assert.equal(structured?.kind, "assistance");
  assert.match(pageSource, BROWSER_ASSISTANCE_STREAM_KIND_RE);
  assert.match(streamViewerSource, /interactionKind === "otp" \? \(\s*<label[\s\S]{0,150}<IcInput/);
  // DIRECTION.md, “What must stay true” #4: keep the one-time code control reachable.
});

test("external provider approval does not render as a browser-session repair", () => {
  const externalApprovalGate = pageSource.indexOf(
    'currentAssistance?.ownerAction === "act_elsewhere" && currentAssistance.responseContract === "none"'
  );
  const browserPrepGate = pageSource.indexOf("hasActiveBrowserSurface(envelope.events)");

  assert.notEqual(externalApprovalGate, -1);
  assert.notEqual(browserPrepGate, -1);
  assert.ok(
    externalApprovalGate < browserPrepGate,
    "external app approval must be handled before the generic active-browser fallback"
  );
  const externalApprovalStart = pageSource.indexOf("function ExternalApprovalSurface(");
  const externalApprovalEnd = pageSource.length;
  assert.notEqual(externalApprovalStart, -1);
  assert.ok(externalApprovalEnd > externalApprovalStart, "approval surface must have a stable source boundary");
  const externalApprovalSource = pageSource.slice(externalApprovalStart, externalApprovalEnd);
  assert.match(externalApprovalSource, /Approve the sign-in to/);
  assert.match(externalApprovalSource, /There is nothing to do on this page/);
});

test("stream page labels multi-account runs by connection instance before connector type", () => {
  assert.match(pageSource, RUN_STATUS_INSTANCE_CONTEXT_RE);
  assert.match(pageSource, INSTANCE_SCOPED_SUMMARY_MATCH_RE);
});

// Intentional migration behavior change (gate finding #6, 2026-07-29):
//
// BEFORE: when the run timeline carried no connector_instance_id, the page
// fetched the WHOLE fleet and did
//   `instanceMatch ?? summaries.data.find((c) => c.connector_id === connectorId)`
// — an ambiguous connector_id (multiple connections of the same connector
// type) silently resolved to the FIRST configured connection, attaching
// that connection's display_name to a run that might belong to a sibling
// connection. This was a real, if narrow, mislabeling bug.
//
// AFTER: the page scopes the reference read itself, via
// `resolveConnectorSummaryRouteId` (instance id when known, else the bare
// connector id), which server-side resolves exact instance identity first,
// then a connector_id fallback ONLY when exactly one configured connection
// has that connector type (`resolveUnambiguousConnectionForConnectorId`,
// `connection-route.ts`'s established precedent for the SAME tradeoff on
// the records subpage). An ambiguous connector_id now resolves to NO
// match — `buildConnectorContext` (connector-context-resolution.ts,
// executable-tested there) degrades to the generic connector-type label
// (e.g. "Strava") instead of a specific but possibly-wrong connection's
// display_name (e.g. "Strava (work account)"). This is strictly safer
// (never attributes to the wrong sibling connection) but is a real,
// observable UX change for the rare multi-instance-same-connector-type
// case with no instance id on the timeline, so it is pinned here as an
// intentional scenario rather than left as an unexamined side effect.
test("multi-instance fallback: the resolver delegates to the exact-identity-first, no-silent-first-match helpers", () => {
  const resolverBody = pageSource.slice(
    pageSource.indexOf("async function resolveConnectorContext"),
    pageSource.indexOf("function renderNoAssistanceSurface")
  );
  // The scoped call resolves its route id via resolveConnectorSummaryRouteId
  // (instance id when known, else connector id) — there is no client-side
  // "first match" fallback left in this function.
  assert.match(resolverBody, INSTANCE_SCOPED_SUMMARY_MATCH_RE);
  assert.doesNotMatch(
    resolverBody,
    NO_CLIENT_SIDE_FIRST_MATCH_RE,
    "no residual client-side first-match-by-connector_id fallback may remain"
  );
  // Both the resolved-match and error paths build the context through the
  // shared, directly-unit-tested buildConnectorContext helper — never an
  // inline fallback that could silently diverge from the tested behavior.
  assert.match(resolverBody, BUILDS_CONTEXT_FROM_MATCH_RE);
  assert.match(resolverBody, BUILDS_CONTEXT_FROM_UNDEFINED_RE);
});

test("stream page opens browser-surface assistance without assuming a response is required", () => {
  assert.match(pageSource, BROWSER_ASSISTANCE_STREAM_KIND_RE);
  assert.match(pageSource, BROWSER_ASSISTANCE_RESPONSE_CONTRACT_RE);
});

test("ended browser work goes to status to explain the outcome", () => {
  assert.match(pageSource, /if \(state === "ended"\) redirect\(statusHref\)/);
});
test("no-assistance poller explicitly transitions into current browser assistance", () => {
  const pollerSource = readFileSync(fileURLToPath(new URL("./no-assistance-run-poller.tsx", import.meta.url)), "utf8");

  assert.match(pollerSource, POLLER_TIMELINE_PROBE_RE);
  assert.match(pollerSource, POLLER_STREAM_READY_RE);
  assert.match(pollerSource, POLLER_HARD_RELOAD_RE);
  assert.match(pageSource, /function PreparingBrowserSurface[\s\S]{0,520}<NoAssistanceRunPoller/);
});

test("resolved browser work offers Continue and never asks for tab close", () => {
  assert.match(streamViewerSource, /onClick=\{\(\) => router\.replace\(statusHref\)\}[^>]*>Continue/);
  assert.doesNotMatch(streamViewerSource, /close this tab/i);
  assert.doesNotMatch(streamViewerSource, WINDOW_CLOSE_RE);
});
