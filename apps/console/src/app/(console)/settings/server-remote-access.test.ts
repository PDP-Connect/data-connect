// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ServerRemoteAccess } from "./server-remote-access.tsx";
Object.assign(globalThis, { React });
for (const address of [null, "https://maple.example.test"]) test(`server remote access has truthful configured-address state: ${!!address}`, () => {
  const html = renderToStaticMarkup(createElement(ServerRemoteAccess, { address }));
  assert.match(html, address ? /DataConnect is reached at/ : /Remote access is set up where/);
  assert.doesNotMatch(html, /Quit and reopen|host_runtime|<details|Code:/);
});
