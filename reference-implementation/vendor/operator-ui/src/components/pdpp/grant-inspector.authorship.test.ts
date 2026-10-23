// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Authorship guard for the grant inspector. Like the consent-card guard, this
 * pins the wiring at the source (the component imports client-only deps that
 * do not resolve under the bare node test runner): enforced terms, declared
 * policy and client claims are three separate groups, and retention, purpose
 * and the self-described app name never sit in the enforced group.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const src = await readFile(`${fileURLToPath(new URL(".", import.meta.url))}grant-inspector.tsx`, "utf8");

const GROUP_RE = /<GrantGroup authorship="(protocol|declared|client)">([\s\S]*?)<\/GrantGroup>/g;

function groups(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of src.matchAll(GROUP_RE)) {
    out[match[1] ?? ""] = match[2] ?? "";
  }
  return out;
}

test("grant inspector renders three separate authorship groups", () => {
  assert.deepEqual(Object.keys(groups()).sort(), ["client", "declared", "protocol"]);
});

test("enforced group holds only server-held terms", () => {
  const enforced = groups().protocol ?? "";
  for (const term of ["Issued", "Expires", "Access"]) {
    assert.ok(enforced.includes(`label="${term}"`), `${term} is enforced`);
  }
  for (const leaked of ["retention", "purposeCode", "purposeDescription", "client.name"]) {
    assert.equal(enforced.includes(leaked), false, `${leaked} must not be in the enforced group`);
  }
});

test("declared group holds purpose code, purpose description and retention", () => {
  const declared = groups().declared ?? "";
  for (const needle of ["purposeCode", "purposeDescription", "retention.duration"]) {
    assert.ok(declared.includes(needle), `${needle} is declared`);
  }
  assert.equal(declared.includes("client.name"), false);
});

test("the self-described app name is a client claim", () => {
  const claims = groups().client ?? "";
  assert.ok(claims.includes("{client.name}"));
  assert.equal(/\{client\.name\}/.test(groups().protocol ?? ""), false);
});

test("each group carries a distinct eyebrow, and retention is never called enforced", () => {
  assert.match(src, /protocol: "Your server enforces"/);
  assert.match(src, /declared: "The app declared this — your server does not enforce it"/);
  assert.match(src, /client: "They claim — not verified by your server"/);
});

test("access copy does not promise access until revocation regardless of expiry", () => {
  assert.equal(src.includes('"Continuous access until revoked"'), false);
});
