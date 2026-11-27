// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StartFailed } from "./connect-parts.tsx";

Object.assign(globalThis, { React });

test("the alert carries the authored reason itself and an id the fields can point at", () => {
  const html = renderToStaticMarkup(React.createElement(StartFailed, { message: "Invalid key sk-live-abc123", sentence: "The key could not be saved. Try again." }));
  assert.match(html, /role="alert"/);
  assert.match(html, /id="connect-error"/);
  assert.doesNotMatch(html, /sk-live-abc123/);
  assert.match(html, /<p[^>]*>[^<]*(did not accept|Something went wrong)/);
});

test("both connect forms submit through the one button that shows it is busy", () => {
  const bodies = readFileSync(new URL("./connect-bodies.tsx", import.meta.url), "utf8");
  assert.match(bodies, /SubmitButton/);
  assert.doesNotMatch(bodies, /type="submit"/);
});
