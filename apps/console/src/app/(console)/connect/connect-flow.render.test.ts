// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test, { mock } from "node:test";
import * as React from "react";
import * as navigation from "next/navigation";
import { renderToStaticMarkup } from "react-dom/server";
import { flowPreview, previewStates } from "./flow-preview.ts";
import { bannedCopyProblems, visibleText } from "../sources/add/banned-copy.ts";
Object.assign(globalThis, { React });
mock.module("server-only", { namedExports: {} });
mock.module("next/navigation", { namedExports: { ...navigation, useRouter: () => ({ refresh() {}, replace() {} }) } });
const launchModule = import("./browser-session/[connectorId]/launch/launch-panel.tsx");
const providerModule = import("./provider-auth/[connectorId]/provider-auth-body.tsx");
test("opening and provider states use the shared heading, one logo, and plain copy", async () => {
  const { LaunchPresentation } = await launchModule;
  const { ProviderAuthBody } = await providerModule;
  for (const state of previewStates.launch) {
    const html = renderToStaticMarkup(React.createElement(LaunchPresentation, { connectorId: flowPreview.connector.connectorId, displayName: flowPreview.connector.displayName, onRetry() {}, state: { starting: state === "opening", networkLost: state === "lost-contact", error: state === "opening" ? null : state === "busy" ? flowPreview.busyError : flowPreview.startError } }));
    assert.deepEqual(bannedCopyProblems(html), [], state);
    const text = visibleText(html);
    assert.doesNotMatch(text, /sync history|secure browser|PDPP|browser session/i);
    if (state === "busy") assert.match(text, /another service/);
    if (state === "lost-contact") assert.match(text, /Check again/);
  }
  for (const state of previewStates.provider) {
    const html = renderToStaticMarkup(React.createElement(ProviderAuthBody, { connectorId: flowPreview.connector.connectorId, displayName: flowPreview.connector.displayName, accounts: state === "already-have-one" ? [{ connectionId: flowPreview.connectionId, displayName: "Northwind, home" }] : [], error: state === "could-not-start" ? flowPreview.startError : undefined }));
    assert.deepEqual(bannedCopyProblems(html), [], state);
    assert.match(visibleText(html), /DataConnect never sees your Northwind password/);
    assert.doesNotMatch(visibleText(html), /Back to Data sources/);
  }
});
