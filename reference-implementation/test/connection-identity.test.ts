// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import { projectPinnedConnectionDisplayName } from "../server/connection-identity.ts";

test("a matching connector's own display name is preserved", () => {
  const instance = { connectorId: "example", displayName: "Example workspace" };
  assert.equal(projectPinnedConnectionDisplayName(instance, "example-connection", "example"), "Example workspace");
  assert.equal(projectPinnedConnectionDisplayName(instance, "example-connection", null), "Example workspace");
});

test("a display name is not projected for a different pinned connector", () => {
  const instance = { connectorId: "example", displayName: "Example workspace" };
  assert.equal(projectPinnedConnectionDisplayName(instance, "example-connection", "other"), null);
});
