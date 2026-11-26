// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

Object.assign(globalThis, { React });

import { buildAppPractice } from "../grants/app-practice.ts";
import { claudeCodeCommand } from "./assistant-instructions.ts";
import { ConnectView } from "./connect-page.tsx";

const REMOTE_ACCESS_GIVES_THIS_DATACONNECT_AN_RE = /Remote access gives this DataConnect an address on the internet/;
const PDPP_BTN_HREF_SETTINGS_REMOTE_ACCESS_RE = /pdpp-btn[^>]*href="\/settings\/remote-access"/;
const WHITESPACE_PRE_WRAP_BREAK_ALL_RE = /whitespace-pre-wrap break-all/;
const COPY_COMMAND_RE = /Copy command/;
const NOW_ASK_IT_ANOTHER_APP_X27_RE = /Now ask it|Another app&#x27;s help/;
const ONE_OTHER_APP_ARE_CONNECTED_RE = /1 other app are connected/;
const NOW_ASK_IT_RE = /Now ask it/;
const SET_UP_REMOTE_ACCESS_RE = /Set up remote access/;

test("local setup explains remote access, wraps the address and supplies a copyable command", () => {
  const html = renderToStaticMarkup(React.createElement(ConnectView, { origin: "http://localhost:7663", apps: [] }));
  assert.match(html, REMOTE_ACCESS_GIVES_THIS_DATACONNECT_AN_RE);
  assert.match(html, PDPP_BTN_HREF_SETTINGS_REMOTE_ACCESS_RE);
  assert.match(html, WHITESPACE_PRE_WRAP_BREAK_ALL_RE);
  assert.match(html, COPY_COMMAND_RE);
  assert.doesNotMatch(html, NOW_ASK_IT_ANOTHER_APP_X27_RE);
  assert.equal(
    claudeCodeCommand("http://localhost:7663"),
    "claude mcp add --transport http dataconnect 'http://localhost:7663/mcp'"
  );
});
test("two connected apps use the singular and offer a first question", () => {
  const html = renderToStaticMarkup(
    React.createElement(ConnectView, { origin: "https://data.example", apps: buildAppPractice("several").apps })
  );
  assert.match(html, ONE_OTHER_APP_ARE_CONNECTED_RE);
  assert.match(html, NOW_ASK_IT_RE);
  assert.doesNotMatch(html, SET_UP_REMOTE_ACCESS_RE);
});
