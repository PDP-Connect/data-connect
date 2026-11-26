// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { flowPreviewState, previewStates } from "./flow-preview.ts";

test("production refuses every named preview, development requires the gate and a valid state", () => {
  const env: Record<string, string | undefined> = process.env;
  const before = env.NODE_ENV;
  try {
    for (const [page, states] of Object.entries(previewStates)) {
      for (const state of states) {
        env.NODE_ENV = "production";
        assert.equal(flowPreviewState(page as keyof typeof previewStates, { _preview: "1", _state: state }), null);
        env.NODE_ENV = "development";
        assert.equal(flowPreviewState(page as keyof typeof previewStates, { _preview: "1", _state: state }), state);
        assert.equal(flowPreviewState(page as keyof typeof previewStates, { _state: state }), null);
      }
      assert.equal(flowPreviewState(page as keyof typeof previewStates, { _preview: "1", _state: "unknown" }), null);
    }
  } finally { if (before === undefined) delete env.NODE_ENV; else env.NODE_ENV = before; }
});
