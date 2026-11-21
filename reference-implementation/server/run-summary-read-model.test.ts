// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import { canUseConnectorWideRunSummaryFallback } from "./run-summary-read-model.ts";

type Input = Parameters<typeof canUseConnectorWideRunSummaryFallback>[0];

test("singleton fallback preserves untagged legacy summaries", () => {
  const summary = { status: "failed" } as Input["summary"];
  const input = {
    activeVisibleConnectionCount: 1,
    browserSurfaceProfileKey: null,
    connectorInstanceId: "connection-fixture",
    summary,
  };
  assert.equal(canUseConnectorWideRunSummaryFallback(input), true);
  assert.equal(canUseConnectorWideRunSummaryFallback({
    ...input,
    activeVisibleConnectionCount: 2,
  }), false);
});

test("singleton fallback preserves a summary with the exact connection tag", () => {
  const connectorInstanceId = "connection-fixture";
  const summary = { status: "failed", connection_id: connectorInstanceId } as Input["summary"];
  assert.equal(canUseConnectorWideRunSummaryFallback({
    activeVisibleConnectionCount: 1,
    browserSurfaceProfileKey: null,
    connectorInstanceId,
    summary,
  }), true);
});
