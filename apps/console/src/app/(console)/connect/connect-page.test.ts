// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import {renderToStaticMarkup} from "react-dom/server";
Object.assign(globalThis, {React});
import {ConnectView} from "./connect-page.tsx";
import {claudeCodeCommand} from "./assistant-instructions.ts";
import {buildAppPractice} from "../grants/app-practice.ts";
test("local setup explains remote access, wraps the address and supplies a copyable command",()=>{
 const html=renderToStaticMarkup(React.createElement(ConnectView,{origin:"http://localhost:7663",apps:[]}));
 assert.match(html,/Remote access gives this DataConnect an address on the internet/);assert.match(html,/pdpp-btn[^>]*href="\/settings#remote-access"/);
 assert.match(html,/whitespace-pre-wrap break-all/);assert.match(html,/Copy command/);assert.doesNotMatch(html,/Now ask it|Another app&#x27;s help/);
 assert.equal(claudeCodeCommand("http://localhost:7663"),"claude mcp add --transport http pdpp 'http://localhost:7663/mcp'");
});
test("two connected apps use the singular and offer a first question",()=>{
 const html=renderToStaticMarkup(React.createElement(ConnectView,{origin:"https://data.example",apps:buildAppPractice("several").apps}));
 assert.match(html,/1 other app are connected/);assert.match(html,/Now ask it/);assert.doesNotMatch(html,/Set up remote access/);
});
