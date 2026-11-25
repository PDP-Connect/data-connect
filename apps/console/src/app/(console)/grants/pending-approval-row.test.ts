// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PendingApproval } from "../lib/ref-client.ts";
import { PendingApprovalRow } from "./pending-approval-row.tsx";

(globalThis as { React?: typeof React }).React = React;

const DENY_LABEL_RE = /Don(?:&#x27;|')t allow/;
const DENY_CONFIRM_RE = /name="deny_confirmation"[^>]*value="yes"/;
const NO_APPROVAL_RE = /Approve|issue grant/;
const REVIEW_LABEL_RE = />Review</;

function noAction(): void {
  // Rendering proof only.
}

test("pending approval queue renders Review and a confirmed Don't allow action, never approval", () => {
  const approval: PendingApproval = {
    approval_id: "apr_queue_only",
    batch: false,
    client_id: "concert_finder",
    created_at: "2026-08-11T12:00:00.000Z",
    grant_preview: { source: { id: "spotify", kind: "connector" }, streams: [{ name: "top_artists" }] },
    kind: "consent",
    object: "approval",
  };
  const html = renderToStaticMarkup(PendingApprovalRow({ approval, denyAction: noAction }));
  assert.match(html, REVIEW_LABEL_RE);
  assert.match(html, DENY_LABEL_RE);
  // DIRECTION.md §What must stay true: destructive actions need a confirmation step that names the effect.
  assert.match(html, DENY_CONFIRM_RE);
  assert.match(html, /The app will not get access to your data\./);
  assert.doesNotMatch(html, NO_APPROVAL_RE);
  const visible = html.replace(/<details\b[\s\S]*?<\/details>/g, "");
  assert.doesNotMatch(visible, /\b(grant|bearer|scope|manifest|stream|connector|OAuth|PKCE)\b/i);
});
