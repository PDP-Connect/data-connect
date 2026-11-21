// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { assertConnectorInstanceWritableStatus } from "./connector-instance-admission.ts";

test("only the known write-admitted lifecycle statuses pass", () => {
  const instance = "synthetic-connector";
  for (const status of ["active", "draft"]) {
    assert.doesNotThrow(() => assertConnectorInstanceWritableStatus(status, instance));
  }
  for (const status of [null, "revoked", "deleted", "suspended", "paused", "", undefined]) {
    assert.throws(() => assertConnectorInstanceWritableStatus(status, instance), {
      code: "connector_instance_not_writable",
      connectorInstanceId: instance,
    });
  }
});
