// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RecordBody } from "@pdpp/brand-react";
import { browseKindLinkText, manifestFieldLabels } from "./record-field-words.ts";

Object.assign(globalThis, { React });

test("a manifest property title becomes the field label", () => {
  const labels = manifestFieldLabels({ schema: { properties: { appid: { title: "Steam app number", type: "integer" }, name: { type: "string" } } } });
  assert.deepEqual(labels, { appid: "Steam app number" });
});

test("the link names the kind", () => {
  assert.equal(browseKindLinkText("Your owned games"), "Browse all owned games →");
  assert.equal(browseKindLinkText("Playtime"), "Browse all playtime →");
});

test("a field without a manifest label reads as words, not run-together ids", () => {
  const html = renderToStaticMarkup(createElement(RecordBody, { data: { appid: 401, steamid: "7656" }, stream: "owned_games" }));
  assert.match(html, />App id</);
  assert.match(html, />Steam id</);
});

test("fieldLabels from the manifest win over the fallback", () => {
  const html = renderToStaticMarkup(createElement(RecordBody, { data: { appid: 401 }, fieldLabels: { appid: "Game number" }, stream: "owned_games" }));
  assert.match(html, />Game number</);
});
