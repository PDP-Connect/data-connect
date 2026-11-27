// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildDuplicateNotice } from "./sources-view.tsx";

Object.assign(globalThis, { React });

test("the same-name banner is two short sentences and one action", () => {
  const html = renderToStaticMarkup(buildDuplicateNotice([{ connectorId: "steam", firstUnnamedHref: "/sources/x", kind: "Steam", total: 2, unnamed: 2 }]));
  const text = html.replace(/<[^>]+>/g, "|").split("|").map((part) => part.trim()).filter(Boolean);
  assert.deepEqual(text, ["You have two Steam accounts.", "Name them so you can tell them apart.", "Name them →"]);
  assert.equal(html.match(/<a /g)?.length, 1);
});
