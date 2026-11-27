// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RemoveAccessConfirmation, RemoveThisAccess } from "./remove-access-confirmation.tsx";

// The vendored button compiles with the classic JSX runtime under tests.
(globalThis as { React?: typeof React }).React = React;

function noAction(): void {
  // Rendering proof only.
}

const BANNED = /\b(grant|bearer|scope|manifest|stream|connector|OAuth|PKCE)\b/i;
const FORM_RE = /<form[^>]*>([\s\S]*?)<\/form>/;
const CANCEL_RE = /<button[^>]*type="button"[^>]*>[\s\S]*?Cancel[\s\S]*?<\/button>/;

test("the confirmation posts the named ids with the confirmation field, and Cancel sits outside the form", () => {
  const html = renderToStaticMarkup(
    React.createElement(RemoveAccessConfirmation, {
      action: noAction,
      fields: [
        ["grant_id", "access-1"],
        ["return_to", "/grants/access-1"],
      ],
      id: "remove-1",
      onCancel: noAction,
      sentence: "Chat helper will no longer read Gmail. It keeps what it already read.",
      submitLabel: "Remove this access",
    })
  );
  // RAISE-RULES 5: the step names what will happen in one sentence.
  assert.match(html, /role="alertdialog"/);
  assert.match(html, /Chat helper will no longer read Gmail\. It keeps what it already read\./);
  const form = FORM_RE.exec(html)?.[1] ?? "";
  assert.ok(form, html);
  assert.match(form, /name="grant_id"[^>]*value="access-1"/);
  assert.match(form, /name="confirm_revoke"[^>]*value="yes"/);
  assert.match(form, /type="submit"[\s\S]*?Remove this access/);
  // Cancel is a plain button and is not inside the form, so it cannot post anything.
  assert.doesNotMatch(form, /Cancel/);
  assert.match(html.slice(html.indexOf("</form>")), CANCEL_RE);
  assert.doesNotMatch(html.replace(/name="grant_id"/g, ""), BANNED);
});

test("Cancel closes the confirmation without calling the removal action", () => {
  let actionCalls = 0;
  let cancelCalls = 0;
  const confirmation = RemoveAccessConfirmation({
    action: () => { actionCalls += 1; },
    fields: [["package_id", "package-1"]],
    id: "remove-package",
    onCancel: () => { cancelCalls += 1; },
    sentence: "Chat helper will no longer read your data. It keeps what it already read.",
    submitLabel: "Remove access",
  });
  const [, controls] = confirmation.props.children as [unknown, { props: { children: [unknown, { props: { onClick: () => void } }] } }];
  controls.props.children[1].props.onClick();
  assert.equal(cancelCalls, 1);
  assert.equal(actionCalls, 0);
});

test("Remove this access starts closed: a plain button, no form", () => {
  const html = renderToStaticMarkup(
    React.createElement(RemoveThisAccess, {
      action: noAction,
      grantId: "access-1",
      returnTo: "/grants/access-1",
      sentence: "Chat helper will no longer read Gmail. It keeps what it already read.",
    })
  );
  assert.match(html, /<button[^>]*type="button"[^>]*>[\s\S]*?Remove this access[\s\S]*?<\/button>/);
  assert.doesNotMatch(html, /<form/);
});
