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
const WRAPS_RE = /whitespace-pre-wrap break-words/;
const COPY_COMMAND_RE = /Copy command/;
const NOW_ASK_IT_ANOTHER_APP_X27_RE = /Now ask it|Another app&#x27;s help/;
const ONE_OTHER_APP_ARE_CONNECTED_RE = /1 other app are connected/;
const NOW_ASK_IT_RE = /Now ask it/;
const SET_UP_REMOTE_ACCESS_RE = /Set up remote access/;

test("local setup explains remote access, wraps the address and supplies a copyable command", () => {
  const html = renderToStaticMarkup(React.createElement(ConnectView, { origin: "http://localhost:7663", apps: [] }));
  assert.match(html, REMOTE_ACCESS_GIVES_THIS_DATACONNECT_AN_RE);
  assert.match(html, PDPP_BTN_HREF_SETTINGS_REMOTE_ACCESS_RE);
  assert.match(html, WRAPS_RE);
  assert.doesNotMatch(html, /break-all|whitespace-nowrap|overflow-x-auto/);
  // Copy sits under the text on a phone, so the text has the whole width.
  assert.match(html, /flex min-w-0 flex-col gap-3 [^"]*sm:flex-row/);
  assert.match(html, COPY_COMMAND_RE);
  assert.doesNotMatch(html, NOW_ASK_IT_ANOTHER_APP_X27_RE);
  assert.equal(
    claudeCodeCommand("http://localhost:7663"),
    "claude mcp add --transport http dataconnect 'http://localhost:7663/mcp'"
  );
});
// Round 7 (F9): paste-this-address steps must not be offered to assistants that cannot reach the address.
test("while only this computer can reach DataConnect, ChatGPT and Claude show no paste steps, only the way to turn remote access on", () => {
  const html = renderToStaticMarkup(React.createElement(ConnectView, { origin: "http://127.0.0.1:18708", apps: [] }));
  assert.doesNotMatch(html, /Add custom MCP server/);
  assert.doesNotMatch(html, /Add custom connector/);
  assert.match(html, /Not available until remote access is on/);
  assert.match(html, /claude mcp add/);
  const remote = renderToStaticMarkup(React.createElement(ConnectView, { origin: "https://data.example", apps: [] }));
  assert.match(remote, /Add custom MCP server/);
  assert.match(remote, /Add custom connector/);
  assert.doesNotMatch(remote, /Not available until remote access is on/);
});
test("a malformed address renders as unavailable without copy or cloud steps", () => {
  const html = renderToStaticMarkup(React.createElement(ConnectView, { origin: "not-an-address", apps: [] }));
  assert.match(html, /DataConnect does not have a usable address yet/);
  assert.doesNotMatch(html, /Add custom MCP server|Add custom connector|Copy command|Copy your address|not-an-address/);
});

test("two connected apps use the singular and offer a first question", () => {
  const html = renderToStaticMarkup(
    React.createElement(ConnectView, { origin: "https://data.example", apps: buildAppPractice("several").apps })
  );
  assert.match(html, ONE_OTHER_APP_ARE_CONNECTED_RE);
  assert.match(html, NOW_ASK_IT_RE);
  assert.doesNotMatch(html, SET_UP_REMOTE_ACCESS_RE);
});

// A command that scrolls sideways must not widen the page: every grid cell can shrink below its content.
test("each assistant's cell can shrink, so a long command scrolls inside its box instead of widening the page", () => {
  const html = renderToStaticMarkup(React.createElement(ConnectView, { origin: "http://127.0.0.1:18708", apps: [] }));
  assert.match(html, /<section class="min-w-0">/);
});

test("a loopback address says it only works on this computer; a private one says your own network", () => {
  const loopback = renderToStaticMarkup(React.createElement(ConnectView, { origin: "http://127.0.0.1:18708", apps: [] }));
  assert.match(loopback, /address only works on this computer\./);
  const lan = renderToStaticMarkup(React.createElement(ConnectView, { origin: "http://192.168.1.10:3000", apps: [] }));
  assert.match(lan, /address only works on your own network\./);
});

// Round 9 (F30): Connect an app sits under Apps.
test("Connect an app has the trail Apps / Connect an app", () => {
  const html = renderToStaticMarkup(React.createElement(ConnectView, { origin: "https://data.example", apps: [] }));
  assert.match(html, /aria-label="Breadcrumb"[\s\S]*href="\/grants"[^>]*>Apps<[\s\S]*Connect an app/);
});
