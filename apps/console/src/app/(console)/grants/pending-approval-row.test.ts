// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PendingApproval } from "../lib/ref-client.ts";
import { PendingApprovalRow } from "./pending-approval-row.tsx";

(globalThis as { React?: typeof React }).React = React;

const DENY_LABEL_RE = /Don(?:&#x27;|')t allow/;
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
  const html = renderToStaticMarkup(React.createElement(PendingApprovalRow, { appName: "Concert finder", approval, denyAction: noAction }));
  // apps-repair.md P2: the waiting row title uses the app name supplied from request details.
  assert.match(html, /Concert finder/);
  assert.match(html, REVIEW_LABEL_RE);
  assert.match(html, DENY_LABEL_RE);
  assert.match(html, /Wants to read GitHub/);
  assert.doesNotMatch(html, /<details|Saved tracks/);
  const source = readFileSync(new URL("./pending-approval-row.tsx", import.meta.url), "utf8");
  for (const field of ['name="kind" type="hidden" value={approval.kind}', 'name="approval_id" type="hidden" value={approval.approval_id}', 'name="deny_confirmation" type="hidden" value="yes"']) assert.ok(source.includes(field));
  assert.match(source, /Don't allow \{appName\}\? It will not get access to your data/);
  assert.match(source, /onClick=\{\(\) => setConfirming\(false\)\}/);
  assert.doesNotMatch(html, NO_APPROVAL_RE);
  const visible = html.replace(/<details\b[\s\S]*?<\/details>/g, "");
  assert.doesNotMatch(visible, /\b(grant|bearer|scope|manifest|stream|connector|OAuth|PKCE)\b/i);
});
