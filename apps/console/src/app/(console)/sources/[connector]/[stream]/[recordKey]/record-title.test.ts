// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { rowPrimary } from "@pdpp/display";
import { recordCrumbLabel, recordTitlePreview } from "./record-title.ts";

// data-pages.md, decision 3: the record title follows Explore's rule and never shows "field: value".

test("a declared title is the record title and the last breadcrumb", () => {
  const preview = recordTitlePreview({ kind: "generic", title: "Blue Monday" }, "generic", "top_tracks");
  assert.equal(rowPrimary(preview), "Blue Monday");
  assert.equal(recordCrumbLabel(preview, "top_tracks"), "Blue Monday");
});

test("a record with a body but no title keeps the body, as an Explore row does", () => {
  const preview = recordTitlePreview({ body: "See you at six", kind: "message" }, "message", "messages");
  assert.equal(rowPrimary(preview), "See you at six");
  assert.equal(recordCrumbLabel(preview, "messages"), "See you at six");
});

test("a record with only generic fields falls back to the kind name, not a field line", () => {
  const preview = recordTitlePreview(
    { fields: [{ label: "Play count", value: "12" }], kind: "generic" } as never,
    "generic",
    "top_artists"
  );
  assert.equal(rowPrimary(preview), "Top artists");
  // The kind crumb already says "Top artists"; no repeated leaf.
  assert.equal(recordCrumbLabel(preview, "top_artists"), null);
});

test("a record with no preview or a blank title falls back to the kind name", () => {
  assert.equal(rowPrimary(recordTitlePreview(null, "generic", "saved_posts")), "Saved posts");
  assert.equal(rowPrimary(recordTitlePreview({ kind: "generic", title: "  " }, "generic", "saved_posts")), "Saved posts");
});
