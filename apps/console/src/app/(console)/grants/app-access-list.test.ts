// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fileURLToPath } from "node:url";
import { AppAccessList } from "./app-access-list.tsx";
import type { AppAccess } from "./app-access.ts";

function noAction(): void {
  // Rendering proof only.
}

function render(apps: readonly AppAccess[]): string {
  return renderToStaticMarkup(React.createElement(AppAccessList, { apps, canRemove: true, removeAction: noAction, returnTo: "/grants" }));
}

const HERE = fileURLToPath(new URL(".", import.meta.url));

test("app rows name the data they can read and offer a separate actions menu", () => {
  const html = render([{
    clientIds: [], place: "chatgpt.com", verified: false, sourceAccess: [], since: null, expiresAt: null, stoppedReason: "removed", state: "reading",
    grantIds: ["access-1"],
    hrefId: "access-1",
    lastRead: "2026-11-25T12:00:00.000Z",
    name: "ChatGPT",
    packageIds: [],
    sources: ["Gmail", "Spotify"],
    stoppedAt: null,
    status: null,
  }]);
  assert.match(html, /ChatGPT/);
  assert.match(html, /Can read Gmail, Spotify/);
  assert.match(html, /Last read/);
  assert.match(html, /aria-label="More actions for ChatGPT"/);
  assert.doesNotMatch(html, /\b(grant|bearer|scope|manifest|stream|connector|OAuth|PKCE)\b/i);
});

test("empty app list uses one plain sentence", () => {
  const html = render([]);
  assert.match(html, /No app can read your data yet\./);
  assert.doesNotMatch(html, /\b(grant|bearer|scope|manifest|stream|connector|OAuth|PKCE)\b/i);
});

test("removed app rows do not say the app can still read data", () => {
  const html = render([{
    clientIds: [], place: "chatgpt.com", verified: false, sourceAccess: [], since: null, expiresAt: null, stoppedReason: "removed", state: "reading",
    grantIds: [],
    hrefId: "access-removed",
    lastRead: null,
    name: "ChatGPT",
    packageIds: [],
    sources: [],
    stoppedAt: "2026-11-25T12:00:00.000Z",
    status: "Removed",
  }]);
  // apps-repair.md P2: only live accesses belong in the app's readable-data line.
  assert.match(html, /Removed/);
  assert.doesNotMatch(html, /Can read data from this server/);
  // round5 item 2: history says when access stopped, not when the app last read.
  assert.match(html, /Access stopped/);
  assert.doesNotMatch(html, /Last read/);
});

test("app removal names what happens and requires opening a confirmation step", async () => {
  const src = await readFile(`${HERE}app-access-list.tsx`, "utf8");
  // RAISE-RULES 5: destructive actions name the effect and wait for confirmation.
  assert.match(src, /setConfirming\(true\)/);
  assert.match(src, /will no longer read your data\. It keeps what it already read\./);
  // The confirmation step, its confirm_revoke field and its Cancel are proven in remove-access-confirmation.test.ts.
  assert.match(src, /<RemoveAccessConfirmation/);
  // A whole app is removed through the package revoke for its packages (RAISE-RULES 1: same server action as today).
  assert.match(src, /\["package_id", packageId\]/);
});
