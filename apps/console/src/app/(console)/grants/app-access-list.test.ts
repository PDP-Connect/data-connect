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
    grantIds: ["access-1"],
    hrefId: "access-1",
    lastRead: "2026-11-25T12:00:00.000Z",
    name: "ChatGPT",
    sources: ["Gmail", "Spotify"],
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

test("app removal names what happens and requires opening a confirmation step", async () => {
  const src = await readFile(`${HERE}app-access-list.tsx`, "utf8");
  // RAISE-RULES 5: destructive actions name the effect and wait for confirmation.
  assert.match(src, /setConfirming\(true\)/);
  assert.match(src, /will no longer read your data\. It keeps what it already read\./);
  assert.match(src, /name="confirm_revoke" type="hidden" value="yes"/);
  assert.match(src, /Cancel/);
});
