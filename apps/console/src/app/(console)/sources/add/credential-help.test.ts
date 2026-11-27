// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CredentialFields } from "./credential-fields.tsx";
import { splitHelpText } from "./credential-help.ts";

Object.assign(globalThis, { React });

const LONG = "Enter your 17-digit SteamID64, or the custom profile name from your Steam profile URL. Use https://steamcommunity.com/my/profile while logged in: copy the number after '/profiles/', or the name after '/id/'. Do not enter your Steam login username or display name.";

test("long help text is one short line with the how-to behind a disclosure", () => {
  const { more, short } = splitHelpText(LONG);
  assert.equal(short, "Enter your 17-digit SteamID64, or the custom profile name from your Steam profile URL.");
  assert.match(more ?? "", /^Use https:\/\/steamcommunity\.com/);
  assert.equal(splitHelpText("One short line.").more, null);
});

test("the field draws the short line, and the rest only inside a details element", () => {
  const html = renderToStaticMarkup(
    React.createElement(CredentialFields, { fields: [{ autocomplete: null, helpText: LONG, label: "Steam identity", name: "steamid", placeholder: null, required: true, secret: false, type: "text" }], idPrefix: "key", required: true }),
  );
  const outside = html.replace(/<details[\s\S]*<\/details>/, "");
  assert.match(outside, /Enter your 17-digit SteamID64/);
  assert.doesNotMatch(outside, /steamcommunity\.com/);
  assert.match(html, /<details[\s\S]*steamcommunity\.com[\s\S]*<\/details>/);
});
