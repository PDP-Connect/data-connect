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
    client_id: "https://music.example/client",
    created_at: "2026-08-11T12:00:00.000Z",
    grant_preview: { source: { id: "github", kind: "connector" }, streams: [{ name: "saved_tracks" }] },
    kind: "consent",
    object: "approval",
  };
  const html = renderToStaticMarkup(PendingApprovalRow({ appName: "Concert finder", approval, denyAction: noAction }));
  // apps-repair.md P2: the waiting row title uses the app name supplied from request details.
  assert.match(html, /Concert finder/);
  assert.match(html, REVIEW_LABEL_RE);
  assert.match(html, DENY_LABEL_RE);
  // DIRECTION.md, PAGE-RULES 6: connector names use the shared display helper.
  assert.match(html, /Can read GitHub/);
  // DIRECTION.md, PAGE-RULES 6: record kind names use the shared kind display helper.
  assert.match(html, /Saved tracks/);
  // DIRECTION.md, PAGE-RULES 6: raw connector and kind names do not appear in row copy.
  assert.doesNotMatch(html, /saved_tracks|Can read Github/);
  // Round 6 item 6: Details remains available after name formatting.
  assert.match(html, /<summary[^>]*>Details<\/summary>[\s\S]*apr_queue_only/);
  // DIRECTION.md §What must stay true: destructive actions need a confirmation step that names the effect.
  assert.match(html, DENY_CONFIRM_RE);
  assert.match(html, /The app will not get access to your data\./);
  assert.doesNotMatch(html, NO_APPROVAL_RE);
  const visible = html.replace(/<details\b[\s\S]*?<\/details>/g, "");
  assert.doesNotMatch(visible, /\b(grant|bearer|scope|manifest|stream|connector|OAuth|PKCE)\b/i);
});
