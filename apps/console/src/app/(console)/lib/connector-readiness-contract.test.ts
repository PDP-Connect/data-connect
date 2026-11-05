// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { browserConnectSupportFromReadiness } from "./browser-connect-readiness.ts";
import { readinessBlockNote } from "./connector-readiness-copy.ts";
import {
  type ConnectorReadiness,
  parseConnectorReadiness,
  parseConnectorReadinessResponse,
  READINESS_ACTIONS,
  READINESS_REASONS,
} from "./connector-readiness-contract.ts";

const wire = (overrides: Record<string, unknown> = {}) => ({
  action: "connect",
  artifact: { digest: null, source: null, state: "verified", version: "1.0.0" },
  browser_bound: true,
  catalog: "not_consulted",
  connector_key: "linkedin",
  detail: null,
  host: "ready",
  reason: "runnable",
  ...overrides,
});

const readiness = (action: ConnectorReadiness["action"], reason: ConnectorReadiness["reason"], detail: string | null = null) =>
  ({ action, browserBound: true, connectorKey: "linkedin", detail, reason }) satisfies ConnectorReadiness;

test("a well-formed verdict parses; extra server fields are ignored", () => {
  assert.deepEqual(parseConnectorReadiness(wire()), readiness("connect", "runnable"));
});

test("every server action and reason the contract names parses", () => {
  for (const action of READINESS_ACTIONS) {
    assert.equal(parseConnectorReadiness(wire({ action }))?.action, action);
  }
  for (const reason of READINESS_REASONS) {
    assert.equal(parseConnectorReadiness(wire({ reason }))?.reason, reason);
  }
});

test("a malformed verdict reads as no verdict", () => {
  for (const bad of [
    null,
    "connect",
    [],
    wire({ action: "launch" }),
    wire({ reason: "because" }),
    wire({ browser_bound: "yes" }),
    wire({ connector_key: "" }),
    wire({ connector_key: undefined }),
  ]) {
    assert.equal(parseConnectorReadiness(bad), null, JSON.stringify(bad));
  }
});

test("detail is trimmed and blank detail becomes null", () => {
  assert.equal(parseConnectorReadiness(wire({ detail: "  no display  " }))?.detail, "no display");
  assert.equal(parseConnectorReadiness(wire({ detail: "   " }))?.detail, null);
  assert.equal(parseConnectorReadiness(wire({ detail: 5 }))?.detail, null);
});

test("the response parser keeps well-formed records and drops others", () => {
  const parsed = parseConnectorReadinessResponse({
    data: [wire(), { action: "nope" }, wire({ connector_key: "goodreads", action: "install", reason: "not_installed" })],
    object: "connector_browser_enrollment_readiness",
  });
  assert.deepEqual(
    parsed.map((item) => item.connectorKey),
    ["linkedin", "goodreads"]
  );
  assert.deepEqual(parseConnectorReadinessResponse({ data: [wire()], object: "something_else" }), []);
  assert.deepEqual(parseConnectorReadinessResponse(null), []);
});

test("only a connect verdict lets the browser-session routes add an account", () => {
  for (const action of READINESS_ACTIONS) {
    const support = browserConnectSupportFromReadiness("linkedin", { ...readiness(action, "runnable") });
    assert.equal(support.canAddAccount, action === "connect", action);
  }
  assert.equal(browserConnectSupportFromReadiness("linkedin", null).canAddAccount, false, "no verdict fails closed");
});

test("a server that predates the readiness endpoint is deferred to; any other missing verdict is not", () => {
  assert.equal(browserConnectSupportFromReadiness("linkedin", null, true).canAddAccount, true);
  assert.equal(browserConnectSupportFromReadiness("linkedin", null, false).canAddAccount, false);
  assert.equal(
    browserConnectSupportFromReadiness("linkedin", readiness("configure", "host_requirement_unmet"), true).canAddAccount,
    false,
    "a verdict always wins over the legacy deferral"
  );
});

test("the routes stay reachable for a browser-bound connector so an existing connection can be repaired", () => {
  assert.equal(browserConnectSupportFromReadiness("some-new-connector", readiness("repair", "artifact_invalid")).browserBound, true);
  assert.equal(
    browserConnectSupportFromReadiness("some-new-connector", { ...readiness("unavailable", "not_browser_bound"), browserBound: false })
      .browserBound,
    false
  );
});

test("blocking reasons have owner copy that carries the server's detail; others have none", () => {
  assert.match(readinessBlockNote(readiness("configure", "host_requirement_unmet", "No display."))!, /not set up to run this connector yet\. No display\./);
  assert.match(readinessBlockNote(readiness("repair", "artifact_invalid"))!, /failed verification/);
  assert.match(readinessBlockNote(readiness("retry", "inspection_unavailable"))!, /Retry/);
  assert.match(readinessBlockNote(readiness("retry", "catalog_unavailable"))!, /catalog could not be reached/);
  assert.match(readinessBlockNote(readiness("unavailable", "not_published"))!, /not published/);
  for (const quiet of [
    readiness("connect", "runnable"),
    readiness("install", "not_installed"),
    readiness("unavailable", "not_browser_bound"),
  ]) {
    assert.equal(readinessBlockNote(quiet), null, quiet.reason);
  }
  assert.equal(readinessBlockNote(null), null);
});
