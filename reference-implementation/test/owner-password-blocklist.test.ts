// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { isBlockedOwnerPassword } from "../server/owner-password-blocklist.ts";
import { OWNER_PASSWORD_MIN_LENGTH } from "../server/owner-password-verifier.ts";

test("blocklist: a common password is blocked as listed, repeated, or with a digit tail", () => {
  assert.equal(isBlockedOwnerPassword("password"), true);
  assert.equal(isBlockedOwnerPassword("PASSWORD"), true);
  assert.equal(isBlockedOwnerPassword("passwordpassword"), true);
  assert.equal(isBlockedOwnerPassword("password1234567890"), true);
  assert.equal(isBlockedOwnerPassword("qwertyqwertyqwerty"), true);
});

test("blocklist: a long passphrase that is not on the list is accepted", () => {
  assert.equal(isBlockedOwnerPassword("maple orbit canyon velvet"), false);
  assert.equal(isBlockedOwnerPassword("a".repeat(64) + "x7Qz"), false);
  assert.equal(isBlockedOwnerPassword("x".repeat(80)), false);
});

test("blocklist: there are no composition rules, so any unlisted 15+ character value passes", () => {
  for (const value of ["abcdefghijklmnopqrstuvwxyz", "zzzzzzzzzzzzzzzzzzzzzzzq", "ALLUPPERCASELETTERSNOW", "12345678 90 !!?? ##"]) {
    assert.ok(value.length >= OWNER_PASSWORD_MIN_LENGTH);
    assert.equal(isBlockedOwnerPassword(value), false, value);
  }
});

test("blocklist: whitespace padding does not make a listed password acceptable", () => {
  assert.equal(isBlockedOwnerPassword("password123456 "), true);
  assert.equal(isBlockedOwnerPassword(" password123456"), true);
  assert.equal(isBlockedOwnerPassword("\tpassword\n"), true);
});
