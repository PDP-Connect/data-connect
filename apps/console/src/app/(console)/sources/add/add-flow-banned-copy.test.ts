// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test, { mock } from "node:test";
import * as navigation from "next/navigation";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { bannedCopyProblems, visibleText } from "./banned-copy.ts";
import { ALL_ENTRIES, installed, notInstalled } from "./add-flow-fixtures.ts";
import { buildAddSourceList } from "./add-source-list-model.ts";
import { connectorLookupKey } from "../../lib/connector-install-presentation.ts";

Object.assign(globalThis, { React });
mock.module("server-only", { namedExports: {} });
mock.module("next/navigation", {
  namedExports: { ...navigation, useRouter: () => ({ refresh() {}, replace() {}, push() {} }) },
});

const listModule = import("./add-source-list.tsx");

const lifecycles = {
  amazon: notInstalled("amazon"),
  "apple-health": installed("apple-health"),
  chase: notInstalled("chase"),
  "claude-code": notInstalled("claude-code"),
  whoop: notInstalled("whoop"),
  ynab: notInstalled("ynab"),
};

const model = buildAddSourceList({
  catalog: ALL_ENTRIES,
  catalogTransientlyUnavailable: false,
  existingConnectionIds: { amazon: ["cin_a"] },
  lifecycleFor: (entry) => lifecycles[connectorLookupKey(entry.connectorKey) as keyof typeof lifecycles] ?? { catalog: null, installed: null },
});

function assertClean(html: string, label: string) {
  assert.deepEqual(bannedCopyProblems(html), [], `banned copy on "${label}"`);
}

// Design "Banned on these pages": every state of /sources/add.
test("the list page, in every state, uses none of the banned words, badges or folds", async () => {
  const { AddSourceList, AddSourceListSkeleton, AddSourceLoadFailed } = await listModule;
  const states: Array<[string, string]> = [
    ["rows", renderToStaticMarkup(createElement(AddSourceList, { model, query: "" }))],
    ["search hit", renderToStaticMarkup(createElement(AddSourceList, { model, query: "ama" }))],
    ["service that cannot be added", renderToStaticMarkup(createElement(AddSourceList, { model, query: "whoop" }))],
    ["no match", renderToStaticMarkup(createElement(AddSourceList, { model, query: "zzz" }))],
    ["loading", renderToStaticMarkup(createElement(AddSourceListSkeleton))],
    ["load failed", renderToStaticMarkup(createElement(AddSourceLoadFailed))],
  ];
  for (const [label, html] of states) assertClean(html, label);
});

// Design "Page 1": each row is the logo and name; "Added" is the only extra.
test("a row shows the name once and Added only for a service that has an account", async () => {
  const { AddSourceList } = await listModule;
  const html = renderToStaticMarkup(createElement(AddSourceList, { model, query: "" }));
  assert.equal((html.match(/>Added</g) ?? []).length, 1);
  assert.equal((html.match(/>Amazon</g) ?? []).length, 1);
  assert.doesNotMatch(html, />WHOOP</);
  assert.doesNotMatch(html, /<button/);
});

// Design "Page 1": no match and can't-be-added are followed by one "Show all services".
test("the empty search answers each carry one Show all services action", async () => {
  const { AddSourceList } = await listModule;
  for (const query of ["zzz", "whoop"]) {
    const html = renderToStaticMarkup(createElement(AddSourceList, { model, query }));
    assert.equal((html.match(/Show all services/g) ?? []).length, 1, query);
    assertClean(html, `empty: ${query}`);
  }
});

test("the checker itself catches a fold, a badge and a banned word", () => {
  assert.ok(bannedCopyProblems("<details><summary>Details</summary>x</details>").length > 0);
  assert.ok(bannedCopyProblems("<span>Experimental</span>").length > 0);
  assert.ok(bannedCopyProblems("<p>Install package first</p>").length >= 2);
  assert.deepEqual(bannedCopyProblems("<details><summary>What went wrong</summary>x</details>"), []);
});

// ── Page 2: every kind, every state ────────────────────────────────────────

const bodiesModule = import("./connect-bodies.tsx");
const partsModule = import("./connect-parts.tsx");
const programModule = import("./program-connect.tsx");
const gettingReadyModule = import("./getting-ready.tsx");
const uploadFormModule = import("../../connect/manual-upload/[connectorId]/manual-upload-form.tsx");

const field = (name: string, label: string, secret = false) => ({
  autocomplete: null,
  label,
  name,
  placeholder: null,
  required: true,
  secret,
  type: secret ? ("password" as const) : ("text" as const),
});
const signInFields = [field("email", "Amazon email or phone"), field("password", "Amazon password", true)];
const noAccounts: never[] = [];
const workAccount = [{ connectionId: "cin_0123456789abcdef01234567", displayName: "Amazon" }];
const service = (overrides: Partial<{ accounts: typeof workAccount; tier: string | null }> = {}) => ({
  accounts: overrides.accounts ?? noAccounts,
  connectorKey: "amazon",
  icon: undefined,
  name: "Amazon",
  tier: overrides.tier ?? "supported",
});
const noop = () => {};

// Design "Banned on these pages": sign-in services, each state.
test("the sign-in page, in every state, uses none of the banned words, badges or folds", async () => {
  const { SignInConnectBody } = await bodiesModule;
  const required = { checkboxName: "remember_sign_in_details", fields: signInFields, required: true };
  const optional = { ...required, required: false };
  const cases: Array<[string, Parameters<typeof SignInConnectBody>[0]]> = [
    ["required details", { canConnect: true, capture: required, service: service() }],
    ["optional details", { canConnect: true, capture: optional, service: service() }],
    ["no details", { canConnect: true, capture: null, service: service() }],
    ["new service", { canConnect: true, capture: optional, service: service({ tier: "preview" }) }],
    ["existing account", { canConnect: true, capture: optional, service: service({ accounts: workAccount }) }],
    ["start failed", { canConnect: true, capture: optional, error: "browser pool unavailable (connector error)", service: service() }],
    ["reconnect", { canConnect: false, capture: optional, repairConnectionId: "cin_0123456789abcdef01234567", service: service() }],
    ["cannot be connected", { canConnect: false, capture: null, service: service() }],
  ];
  for (const [label, props] of cases) assertClean(renderToStaticMarkup(createElement(SignInConnectBody, props)), `sign-in: ${label}`);
});

test("the sign-in page shows each design sentence for its state, and the account name field only with an existing account", async () => {
  const { SignInConnectBody } = await bodiesModule;
  const render = (props: Parameters<typeof SignInConnectBody>[0]) => visibleText(renderToStaticMarkup(createElement(SignInConnectBody, props))).replace(/\s+/g, " ");
  const optional = { checkboxName: "remember_sign_in_details", fields: signInFields, required: false };
  const fresh = render({ canConnect: true, capture: optional, service: service({ tier: "development" }) });
  assert.match(fresh, /DataConnect signs in to Amazon for you, in a browser you can watch\. If Amazon asks for a code, you type it there\./);
  assert.match(fresh, /Amazon is new here\. It works in our tests, but it has not been tried with many accounts yet\./);
  assert.match(fresh, /Save my sign-in so DataConnect can sign in again without me/);
  assert.doesNotMatch(fresh, /Name for this account|Amazon password/);
  const second = render({ canConnect: true, capture: optional, service: service({ accounts: workAccount }) });
  assert.match(second, /You already have Amazon ?\. This adds another account\./);
  assert.match(second, /Name for this account/);
  const required = render({ canConnect: true, capture: { ...optional, required: true }, service: service() });
  assert.match(required, /Amazon email or phone/);
  assert.match(required, /Your password is stored encrypted on the computer that runs DataConnect\. It is sent only to Amazon\./);
  assert.doesNotMatch(required, /is new here/);
});

test("the key page, in every state, uses none of the banned words, badges or folds", async () => {
  const { KeyConnectBody } = await bodiesModule;
  const keyField = field("api_key", "YNAB personal access token", true);
  const base = {
    action: noop,
    blockers: [{ key: "PDPP_CREDENTIAL_ENCRYPTION_KEY" }],
    fields: [keyField],
    helpUrl: "https://app.ynab.com/settings/developer",
    keyIsOptional: false,
    mode: "new" as const,
    service: { ...service(), connectorKey: "ynab", name: "YNAB" },
    storageReady: true,
  };
  const cases: Array<[string, Parameters<typeof KeyConnectBody>[0]]> = [
    ["new", base],
    ["new service", { ...base, service: { ...base.service, tier: "development" } }],
    ["existing account", { ...base, service: { ...base.service, accounts: workAccount } }],
    ["reconnect", { ...base, connectionId: "cin_0123456789abcdef01234567", mode: "replace" }],
    ["retry after a failed check", { ...base, connectionId: "cin_0123456789abcdef01234567", displayNameParam: "YNAB, work", mode: "draft-retry" }],
    ["save failed", { ...base, error: "token rejected by the connector" }],
    ["storage not ready", { ...base, storageReady: false }],
  ];
  for (const [label, props] of cases) {
    const html = renderToStaticMarkup(createElement(KeyConnectBody, props));
    // Repair brief 2 permits "install guide" only in the blocked storage guidance.
    assert.deepEqual(bannedCopyProblems(html, { allowWords: props.storageReady ? [] : ["install"] }), [], `key: ${label}`);
  }
  const notReadyHtml = renderToStaticMarkup(createElement(KeyConnectBody, { ...base, storageReady: false }));
  const notReady = visibleText(notReadyHtml).replace(/\s+/g, " ");
  // Repair brief 2: explain the block and link to the instructions that resolve it.
  assert.match(notReady, /This server can't store keys yet, so YNAB can't be connected\./);
  assert.match(notReady, /Whoever set up this server needs to turn on key storage\. The install guide shows how\./);
  assert.match(notReadyHtml, /href="https:\/\/github.com\/PDP-Connect\/data-connect\/blob\/main\/deploy\/docker\/README.md"[^>]*>install guide<\/a>/);
  assert.match(notReady, /The settings are/);
  assert.doesNotMatch(notReady, /YNAB personal access token/);
  // Design "Key services": storage not ready shows the heading and the blocked text, no lead or help link.
  assert.doesNotMatch(notReady, /gives you a key|Where to find it/);
  assert.match(notReady, /Connect YNAB/);
  const ready = visibleText(renderToStaticMarkup(createElement(KeyConnectBody, base))).replace(/\s+/g, " ");
  assert.match(ready, /YNAB gives you a key that lets DataConnect read your data\./);
  assert.match(ready, /Where to find it/);
  assert.match(ready, /Connect YNAB/);
});

test("the file page, in every state, uses none of the banned words, badges or folds", async () => {
  const { FileConnectBody } = await bodiesModule;
  const { NewServiceNote } = await partsModule;
  const { ManualUploadForm } = await uploadFormModule;
  const setup = {
    accepted_file_extensions: [".zip", ".xml"],
    accepted_file_names: [],
    connector_id: "apple-health",
    display_name: "Apple Health",
    max_file_bytes: 8 * 1024 ** 3,
    validation_expectations: ["export.xml"],
  };
  const instructions = {
    links: [{ href: "https://support.apple.com/health-export", label: "Apple's own guide" }],
    steps: ["Open the Health app. Tap your picture. Scroll down and tap Export All Health Data.", "Wait for the file to be made."],
  };
  const health = { ...service(), connectorKey: "apple-health", name: "Apple Health" };
  const cases: Array<[string, boolean, typeof health, typeof setup]> = [
    ["no account yet", false, health, setup],
    ["new service", false, { ...health, tier: "development" }, setup],
    ["existing account", true, { ...health, accounts: [{ connectionId: "cin_0123456789abcdef01234567", displayName: "Apple Health" }] }, setup],
    ["no check offered", false, health, { ...setup, validation_expectations: [] }],
  ];
  for (const [label, hasExisting, svc, setupFacts] of cases) {
    const form = createElement(ManualUploadForm, {
      existingSources: hasExisting ? [{ connection_id: "cin_0123456789abcdef01234567", detail: "", display_name: "Apple Health" }] : [],
      name: "Apple Health",
      note: createElement(NewServiceNote, { name: "Apple Health", tier: svc.tier }),
      setup: setupFacts,
    });
    const html = renderToStaticMarkup(createElement(FileConnectBody, { form, instructions, service: svc }));
    assertClean(html, `file: ${label}`);
    const text = visibleText(html).replace(/\s+/g, " ");
    assert.match(text, /Apple Health has no sign-in\. You export a file from it and give the file to DataConnect\./);
    assert.match(text, /1\. Export your data/);
    assert.match(text, /2\. Choose the file/);
    assert.match(text, /Accepted: \.zip, \.xml, up to 8 GB each\./);
    assert.match(text, /Import/);
    // Design "File services": one sentence per line; the "new here" sentence sits just above the buttons.
    const lines = [...html.matchAll(/<li>([^<]*)<\/li>/g)].map((m) => m[1]);
    assert.deepEqual(lines.slice(0, 4), ["Open the Health app.", "Tap your picture.", "Scroll down and tap Export All Health Data.", "Wait for the file to be made."], label);
    const newHere = text.indexOf("is new here");
    assert.equal(newHere >= 0, svc.tier === "development", label);
    if (newHere >= 0) {
      assert.ok(newHere > text.indexOf("Accepted:"), "after the file control");
      assert.ok(newHere < text.lastIndexOf("Import"), "before the buttons");
    }
    assert.equal(/Check the file first/.test(text), setupFacts.validation_expectations.length > 0, label);
    assert.equal(/Add to Apple Health/.test(text) && /Keep as a separate data source/.test(text), hasExisting, label);
    assert.equal(/Name for this account/.test(text), hasExisting, label);
  }
});

test("a program you run yourself, in every state, uses none of the banned words, badges or folds", async () => {
  const { ProgramConnectBody } = await programModule;
  const views = [
    { kind: "preparing" as const },
    { command: "npx -y @pdpp/local-collector setup --code abc", issuedAt: "2026-11-25T00:00:00.000Z", kind: "waiting" as const },
    { command: "npx -y @pdpp/local-collector setup --code abc", kind: "checked-in" as const },
    { kind: "failed" as const, message: "no enrollment key (connector missing)" },
  ];
  for (const view of views) {
    const html = renderToStaticMarkup(createElement(ProgramConnectBody, { name: "Claude Code", onRetry: noop, view }));
    assert.deepEqual(bannedCopyProblems(html, { allowWords: ["setup"] }), [], view.kind);
    assert.match(visibleText(html), /This one runs on the computer that has the data\./);
    // Design "Programs you run yourself": terminal sentence, and Node.js only for an npx command.
    if (view.kind === "waiting" || view.kind === "checked-in") {
      assert.match(visibleText(html), /Open a terminal on that computer, paste this command and press Enter\. It needs Node\.js\./);
    } else {
      assert.doesNotMatch(visibleText(html), /Open a terminal/);
    }
    if (view.kind === "waiting") assert.match(visibleText(html), /Waiting for it to check in…/);
    if (view.kind === "checked-in") assert.match(visibleText(html), /Claude Code checked in\./);
  }
});

test("a program whose command does not start with npx does not mention Node.js", async () => {
  const { ProgramConnectBody } = await programModule;
  const html = renderToStaticMarkup(createElement(ProgramConnectBody, { name: "Codex", onRetry: noop, view: { command: "pdpp-collector setup --code abc", issuedAt: "2026-11-25T00:00:00.000Z", kind: "waiting" } }));
  assert.match(visibleText(html), /paste this command and press Enter\./);
  assert.doesNotMatch(visibleText(html), /Node\.js/);
});

test("a service that cannot be connected shows its sentence, an acted-on reason, and one way back", async () => {
  const { CannotBeAddedHere } = await partsModule;
  const plain = renderToStaticMarkup(createElement(CannotBeAddedHere, { name: "WHOOP" }));
  assertClean(plain, "cannot be added here");
  const text = visibleText(plain).replace(/\s+/g, " ");
  assert.match(text, /WHOOP can't be added here yet\./);
  assert.match(plain, /href="\/sources\/add"[^>]*>Back to all services</);
  const withReason = renderToStaticMarkup(createElement(CannotBeAddedHere, { name: "WHOOP", reason: "This server is not set up to run it yet." }));
  assertClean(withReason, "cannot be added here with reason");
});

test("the getting-ready states use none of the banned words", async () => {
  const { GettingReadyBody } = await gettingReadyModule;
  for (const view of [{ kind: "waiting" as const }, { detail: "install timed out after 300000 ms", kind: "failed" as const }]) {
    assertClean(renderToStaticMarkup(createElement(GettingReadyBody, { name: "Amazon", onRetry: noop, view })), `getting ready: ${view.kind}`);
  }
});

// The second half uses the same check for every named development state.
test("signing in and sign-in details use none of the banned words in every sample state", async () => {
  const { flowPreview, previewStates } = await import("../../connect/flow-preview.ts");
  const { SignInPreview } = await import("../../syncs/[runId]/stream/sign-in-preview.tsx");
  const { RunInteractionForm } = await import("../../syncs/[runId]/interaction-form.tsx");
  for (const state of previewStates.browser) {
    const html = renderToStaticMarkup(createElement(SignInPreview, { state }));
    assertClean(html, `sign-in: ${state}`);
    assert.doesNotMatch(visibleText(html), /\b(?:run|sync details|data source status|approval waiting|browser deferred|browser session|secure browser|PDPP|interaction|assistance|surface|stream|close this tab)\b/i, state);
  }
  for (const state of previewStates.details) {
    const html = renderToStaticMarkup(createElement(RunInteractionForm, { fields: flowPreview.fields, interactionId: "sample-step", kind: "credentials", message: flowPreview.message, preview: true, previewError: state === "rejected" ? flowPreview.startError : undefined, runId: flowPreview.runId, serviceName: flowPreview.connector.displayName }));
    assertClean(html, `sign-in details: ${state}`);
    assert.doesNotMatch(visibleText(html), /\b(?:run|credential|interaction|assistance|surface|stream)\b/i, state);
  }
});
