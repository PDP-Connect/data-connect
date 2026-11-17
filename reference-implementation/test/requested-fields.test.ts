// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { resolveRequestedFields, UNGRANTED_FIELD_POLICY } from "../server/requested-fields.ts";

const granted = ["id", "amount"];

test("a request inside the grant passes through under every policy", () => {
  for (const policy of ["drop", "forbid_named", "forbid_uniform"] as const) {
    assert.deepEqual(resolveRequestedFields(["amount"], granted, policy), ["amount"]);
  }
});

test("a grant without a field list allows every requested field", () => {
  assert.deepEqual(resolveRequestedFields(["secret"], null), ["secret"]);
  assert.deepEqual(resolveRequestedFields(["secret"], undefined), ["secret"]);
});

test("drop leaves ungranted fields out and does not fail", () => {
  assert.deepEqual(resolveRequestedFields(["id", "secret"], granted, "drop"), ["id"]);
  assert.deepEqual(resolveRequestedFields(["secret"], granted, "drop"), []);
});

test("forbid_named refuses with 403 field_not_granted and names the fields", () => {
  assert.throws(
    () => resolveRequestedFields(["id", "secret", "other"], granted, "forbid_named"),
    (error: Error & { code?: string }) =>
      error.code === "field_not_granted" && error.message === "Fields not in grant: secret, other"
  );
});

test("forbid_uniform refuses with one message whichever field is asked for", () => {
  const messages = ["secret", "no_such_field"].map((field) => {
    try {
      resolveRequestedFields([field], granted, "forbid_uniform");
    } catch (error) {
      assert.equal((error as { code?: string }).code, "field_not_granted");
      return (error as Error).message;
    }
    return assert.fail("expected a refusal");
  });
  assert.equal(messages[0], messages[1]);
  assert.doesNotMatch(messages[0] ?? "", /secret|no_such_field/);
});

test("the default policy is today's behavior until Core decides", () => {
  assert.equal(UNGRANTED_FIELD_POLICY, "forbid_named");
  assert.throws(() => resolveRequestedFields(["secret"], granted), /Fields not in grant: secret/);
});
