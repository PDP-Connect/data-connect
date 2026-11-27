// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

(globalThis as typeof globalThis & { React: typeof React }).React = React;
mock.module("server-only", { namedExports: {} });
import * as navigation from "next/navigation";
mock.module("next/navigation", { namedExports: { ...navigation, useRouter: () => ({ refresh() {}, replace() {} }) } });

// Round 7 (F37): the run page said "Needs you to finish signing in." in red where the source page says
// "Venmo is waiting for a security code." in the attention tone, for one state.
test("a run that needs the person says what the source page says, in the same tone", async () => {
  const { OneSyncView } = await import("./one-sync-view.tsx");
  const { oneSyncPractice } = await import("./one-sync-model.ts");
  const base = oneSyncPractice("needs-you", Date.now())!;
  const model = {
    ...base,
    currentSource: { currentAnswer: { row: 8, tone: "attention", words: "Needs a code", action: null, needsYou: true, problem: true, sentence: { slot: null, text: "Venmo is waiting for a security code. Enter it to continue." } } },
  } as unknown as Parameters<typeof OneSyncView>[0]["model"];
  const html = renderToStaticMarkup(React.createElement(OneSyncView, { model, offset: 0, practice: true }));
  assert.match(html, /Venmo is waiting for a security code\./);
  assert.doesNotMatch(html, /Needs you to finish signing in/);
  assert.doesNotMatch(html, /text-destructive/);
  assert.match(html, /text-attention/);
});
