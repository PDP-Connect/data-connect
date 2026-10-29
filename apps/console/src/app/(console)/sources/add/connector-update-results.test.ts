// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BatchResults } from "./connector-update-results.tsx";

const digest = `sha256:${"a".repeat(64)}`;

test("a partial batch reports progress and the old version after failure", () => {
  const markup = renderToStaticMarkup(
    React.createElement(BatchResults, {
      batch: {
        batch_id: "batch-1",
        items: [
          {
            connector_id: "github",
            installed: { digest, version: "1.0.0" },
            target: { digest, version: "1.1.0" },
            state: "succeeded",
          },
          {
            connector_id: "reddit",
            error: "Verification failed",
            installed: { digest, version: "2.0.0" },
            target: { digest, version: "2.1.0" },
            state: "failed",
          },
        ],
        state: "completed_with_issues",
      },
    })
  );
  assert.ok(markup.includes('role="progressbar"'));
  assert.ok(markup.includes('role="alert"'));
  assert.ok(markup.includes("Still using v2.0.0"));
  assert.ok(!markup.includes("All connector updates finished"));
});

test("successful eligible updates still show reviewed items as unfinished", () => {
  const markup = renderToStaticMarkup(
    React.createElement(BatchResults, {
      batch: {
        batch_id: "batch-2",
        items: [
          {
            connector_id: "github",
            installed: { digest, version: "1.2.0" },
            target: { digest, version: "1.3.0" },
            state: "succeeded",
          },
        ],
        state: "completed",
      },
      reviewItems: [
        {
          connector_id: "slack",
          installed: { digest, version: "1.2.0" },
          target: { digest, version: "2.0.0" },
          manual_eligible: false,
          review_required: true,
          reasons: ["major_version"],
        },
      ],
    })
  );
  assert.ok(markup.includes("Needs review · Still using v1.2.0"));
  assert.ok(!markup.includes("All connector updates finished"));
});
