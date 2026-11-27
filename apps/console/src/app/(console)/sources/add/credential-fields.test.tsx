// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CredentialFields } from "./credential-fields.tsx";

Object.assign(globalThis, { React });

test("a field with help text from the manifest shows it under its label and links it to the input", () => {
  const html = renderToStaticMarkup(
    React.createElement(CredentialFields, {
      fields: [{ autocomplete: null, helpText: "Enter your 17-digit SteamID64, or the custom profile name from your Steam profile URL.", label: "Steam identity", name: "steamid", placeholder: null, required: true, secret: false, type: "text" }],
      idPrefix: "key",
      required: true,
    })
  );
  assert.match(html, /Steam identity/);
  assert.match(html, /Enter your 17-digit SteamID64/);
  assert.match(html, /aria-describedby="key-steamid-help"/);
  assert.match(html, /id="key-steamid-help"/);
});

test("a field with no help text draws no help line", () => {
  const html = renderToStaticMarkup(
    React.createElement(CredentialFields, { fields: [{ autocomplete: null, label: "Key", name: "k", placeholder: null, required: true, secret: true, type: "password" }], idPrefix: "key", required: true })
  );
  assert.doesNotMatch(html, /aria-describedby/);
});
