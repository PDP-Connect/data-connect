// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CredentialFields, OptionalSignIn } from "./credential-fields.tsx";

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

test("an empty or raw field label falls back to a readable name", () => {
  const html = renderToStaticMarkup(
    React.createElement(CredentialFields, {
      fields: [
        { autocomplete: null, label: "", name: "api_key", placeholder: null, required: true, secret: true, type: "password" },
        { autocomplete: null, label: "steamId", name: "steamId", placeholder: null, required: true, secret: false, type: "text" },
      ],
      idPrefix: "key",
      required: true,
    })
  );
  assert.match(html, />Api key</);
  assert.match(html, />Steam id</);
  assert.doesNotMatch(html, />api_key</);
  assert.doesNotMatch(html, />steamId</);
});

test("when the form was rejected, each field is marked invalid and points at the reason", () => {
  const html = renderToStaticMarkup(
    React.createElement(CredentialFields, {
      errorId: "connect-error",
      fields: [{ autocomplete: null, helpText: "Short help.", label: "Key", name: "k", placeholder: null, required: true, secret: true, type: "password" }],
      idPrefix: "key",
      required: true,
    })
  );
  assert.match(html, /aria-invalid="true"/);
  assert.match(html, /aria-describedby="key-k-help connect-error"/);
});

// Round 7 review B4: the optional saved sign-in fields point at the rejection alert too.
test("the optional saved sign-in fields are marked invalid and linked to the alert after a rejection", () => {
  const html = renderToStaticMarkup(
    React.createElement(OptionalSignIn, {
      checkboxName: "save",
      errorId: "connect-error",
      fields: [{ autocomplete: null, label: "Password", name: "pw", placeholder: null, required: false, secret: true, type: "password" }],
      initiallySaving: true,
      name: "Venmo",
    })
  );
  assert.match(html, /aria-invalid="true"/);
  assert.match(html, /aria-describedby="connect-error"/);
});
test("the sign-in body hands the alert id to the optional fields", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("./connect-bodies.tsx", import.meta.url), "utf8");
  assert.match(src, /<OptionalSignIn checkboxName=\{capture\.checkboxName\} errorId=\{error \? CONNECT_ERROR_ID : undefined\}/);
});
