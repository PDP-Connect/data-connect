// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import GrantsError from "./error.tsx";

(globalThis as { React?: typeof React }).React = React;

test("failed Apps read gives one sentence and a Try again button", () => {
  const html = renderToStaticMarkup(React.createElement(GrantsError, { error: new Error("private server text"), reset() {} }));
  assert.match(html, /Apps could not be loaded\./);
  assert.match(html, />Try again<\/button>/);
  assert.doesNotMatch(html, /private server text|setTimeout|grants-read-recovering/);
});
