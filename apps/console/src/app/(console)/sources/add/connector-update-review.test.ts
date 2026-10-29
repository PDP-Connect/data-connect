// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BatchResults } from "./connector-update-results.tsx";
import { ReviewPanel } from "./connector-update-review.tsx";

// The vendored brand-react button relies on a global React under the test loader.
(globalThis as { React?: typeof React }).React = React;

const oldDigest = `sha256:${"a".repeat(64)}`;
const newDigest = `sha256:${"b".repeat(64)}`;

const item = {
  connector_id: "slack",
  display_name: "Slack",
  installed: { digest: oldDigest, version: "1.2.0" },
  manifest_diff: {
    added_fields: ["streams[messages]"],
    changed_fields: ["streams"],
    compatibility: "unknown",
    removed_fields: ["streams[legacy]"],
  },
  manual_eligible: false,
  reasons: ["major_version", "compatibility_not_declared"],
  review_required: true,
  target: { digest: newDigest, version: "2.0.0" },
};

test("review view shows exact old and new version and digest, reasons and server manifest diff", () => {
  const markup = renderToStaticMarkup(React.createElement(ReviewPanel, { items: [item], onConfirm: () => undefined }));
  assert.ok(markup.includes("Slack"));
  assert.ok(markup.includes("v1.2.0"));
  assert.ok(markup.includes(oldDigest));
  assert.ok(markup.includes("v2.0.0"));
  assert.ok(markup.includes(newDigest));
  assert.ok(markup.includes("Major version change"));
  assert.ok(markup.includes("Compatibility is unknown"));
  assert.ok(markup.includes("streams[messages]"));
  assert.ok(markup.includes("streams[legacy]"));
  assert.ok(markup.includes("Confirm update to v2.0.0"));
});

test("each review reason has plain wording", () => {
  const reasons = ["downgrade", "same_version_republish", "prerelease_version", "incomparable_version"];
  const markup = renderToStaticMarkup(
    React.createElement(ReviewPanel, { items: [{ ...item, reasons }] })
  );
  assert.ok(markup.includes("Downgrade"));
  assert.ok(markup.includes("Republished"));
  assert.ok(markup.includes("Prerelease"));
  assert.ok(markup.includes("Version order cannot be determined"));
  assert.ok(!markup.includes("Confirm update"), "no confirmation without a handler");
});

test("a target that failed verification cannot be confirmed", () => {
  const markup = renderToStaticMarkup(
    React.createElement(ReviewPanel, {
      items: [{ ...item, reasons: ["verification_failed"] }],
      onConfirm: () => undefined,
    })
  );
  assert.ok(markup.includes("Verification failed"));
  assert.ok(!markup.includes("Confirm update"));
});

test("results use the display name and fall back to the connector id", () => {
  const markup = renderToStaticMarkup(
    React.createElement(BatchResults, {
      batch: {
        batch_id: "b1",
        items: [
          { connector_id: "slack", display_name: "Slack", installed: item.installed, state: "succeeded", target: item.target },
          { connector_id: "reddit", installed: item.installed, state: "succeeded", target: item.target },
        ],
        state: "completed",
      },
    })
  );
  assert.ok(markup.includes(">Slack<"));
  assert.ok(markup.includes(">reddit<"));
});
