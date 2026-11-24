// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import {
  CONNECTOR_NOT_INSTALLED_DISPOSITION,
  connectorInstallActionLabel,
  connectorInstallFailureCopy,
  connectorInstallKey,
  connectorNotInstalledCopy,
  dispositionForInstallState,
  isConnectorNotInstalled,
  parseRunNowRejection,
  runNowRejectionFromError,
} from "./connector-implementation.ts";
import { formatForwardDisposition } from "./connection-evidence.ts";

test("only an explicit not_installed state reads as not installed", () => {
  assert.equal(isConnectorNotInstalled({ connector_implementation: { connector_id: "chase", state: "not_installed" } }), true);
  for (const state of ["built_in", "installed", "local_source", "unknown"] as const) {
    assert.equal(isConnectorNotInstalled({ connector_implementation: { connector_id: "chase", state } }), false, state);
  }
  assert.equal(isConnectorNotInstalled({ connector_implementation: null }), false);
  assert.equal(isConnectorNotInstalled({}), false);
  assert.equal(isConnectorNotInstalled(null), false);
});

test("the install key prefers the key the reference named", () => {
  assert.equal(
    connectorInstallKey({ connector_id: "chase", connector_implementation: { connector_id: "chase-bank", state: "not_installed" } }),
    "chase-bank"
  );
  assert.equal(connectorInstallKey({ connector_id: "chase" }), "chase");
});

test("owner copy is plain and names the connector", () => {
  assert.equal(connectorNotInstalledCopy("Chase"), "Chase isn't installed on this server yet, so it can't sync.");
  assert.equal(connectorInstallActionLabel("Chase"), "Install Chase");
  assert.equal(
    connectorInstallFailureCopy("Chase", "Requested connector digest is not a verified catalog target."),
    "Couldn't install Chase: Requested connector digest is not a verified catalog target."
  );
  assert.equal(
    connectorInstallFailureCopy("Chase", "  "),
    "Couldn't install Chase. Try again, or check the server logs."
  );
});

test("the install blocker replaces any disposition only while the connector is not installed", () => {
  const refreshDue = formatForwardDisposition("owner_refresh_due");
  assert.equal(dispositionForInstallState(refreshDue, true), CONNECTOR_NOT_INSTALLED_DISPOSITION);
  assert.equal(dispositionForInstallState(refreshDue, false), refreshDue);
  assert.equal(dispositionForInstallState(null, true), CONNECTOR_NOT_INSTALLED_DISPOSITION);
  assert.equal(dispositionForInstallState(null, false), null);
});

test("parseRunNowRejection reads code and connector_id from the reference error envelope", () => {
  assert.deepEqual(
    parseRunNowRejection({
      error: {
        code: "connector_not_installed",
        connector_id: "chase",
        message: "No runnable connector implementation is available for chase",
        type: "api_error",
      },
    }),
    { code: "connector_not_installed", connectorId: "chase" }
  );
  assert.deepEqual(parseRunNowRejection({ error: { code: "run_already_active" } }), {
    code: "run_already_active",
    connectorId: null,
  });
  for (const body of [null, "plain text", [], { error: "invalid_request" }, { error: { code: 4 } }]) {
    assert.deepEqual(parseRunNowRejection(body), { code: null, connectorId: null });
  }
});

test("runNowRejectionFromError reads the same fields off a thrown client error", () => {
  const err = Object.assign(new Error("No runnable connector"), { code: "connector_not_installed", connectorId: "chase" });
  assert.deepEqual(runNowRejectionFromError(err), { code: "connector_not_installed", connectorId: "chase" });
  assert.deepEqual(runNowRejectionFromError(new Error("plain")), { code: null, connectorId: null });
  assert.deepEqual(runNowRejectionFromError("boom"), { code: null, connectorId: null });
});
