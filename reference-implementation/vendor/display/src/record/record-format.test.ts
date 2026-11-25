// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  deriveDeclaredFieldTypes,
  deriveFieldSchemaTypes,
  fieldSchemaType,
  formatDeclaredAmount,
  formatRecordFieldValue,
  isMonetaryDeclaredType,
} from "./record-format.ts";

test("formats a declared `currency` integer as cents (the live chase bug)", () => {
  assert.deepEqual(formatDeclaredAmount(3000, "currency"), { positive: true, text: "$30.00" });
});

test("formats a negative declared currency amount with a leading minus", () => {
  assert.deepEqual(formatDeclaredAmount(-1245, "currency"), { positive: false, text: "-$12.45" });
});

test("a declared currency amount formats as cents regardless of magnitude", () => {
  assert.deepEqual(formatDeclaredAmount(438_120, "currency"), { positive: true, text: "$4381.20" });
});

test("a declared milliunits type divides by 1000", () => {
  assert.deepEqual(formatDeclaredAmount(-12_450, "currency_milliunits"), { positive: false, text: "-$12.45" });
});

test("accepts the minor-units aliases case-insensitively", () => {
  assert.equal(formatDeclaredAmount(3000, "Currency")?.text, "$30.00");
  assert.equal(formatDeclaredAmount(3000, "minor_units")?.text, "$30.00");
  assert.equal(formatDeclaredAmount(3000, "cents")?.text, "$30.00");
});

test("returns null when no monetary unit is declared — no magnitude guess", () => {
  assert.equal(formatDeclaredAmount(3000, undefined), null);
  assert.equal(formatDeclaredAmount(3000, "text"), null);
  assert.equal(formatDeclaredAmount(3000, "integer"), null);
});

test("returns null for non-finite or non-numeric values", () => {
  assert.equal(formatDeclaredAmount("3000", "currency"), null);
  assert.equal(formatDeclaredAmount(null, "currency"), null);
  assert.equal(formatDeclaredAmount(Number.NaN, "currency"), null);
});

test("formats plain string lists and large whole numbers whose schema type is a number", () => {
  assert.deepEqual(formatRecordFieldValue(["pop", "country pop"], "genres", undefined, "array"), {
    kind: "plain",
    text: "pop, country pop",
  });
  // Spotify `followers`: schema `type: integer`, no declared presentation type.
  assert.deepEqual(formatRecordFieldValue(98_000_000, "followers", undefined, "integer"), {
    kind: "plain",
    text: "98,000,000",
  });
  assert.deepEqual(formatRecordFieldValue(10_000, "total", undefined, "number"), {
    kind: "plain",
    text: "10,000",
  });
  assert.equal(formatRecordFieldValue(9999, "total", undefined, "integer"), null);
});

test("formats declared currency and never groups ids, years, codes, phones or times", () => {
  assert.deepEqual(formatRecordFieldValue(3000, "amount", "currency", "integer"), {
    kind: "amount",
    positive: true,
    text: "$30.00",
  });
  for (const fieldName of [
    "year",
    "release_year",
    "birthYear",
    "id",
    "record_id",
    "ownerId",
    "userID",
    "zip",
    "zip_code",
    "zipcode",
    "postal_code",
    "code",
    "area_code",
    "countryCode",
    "phone",
    "phone_number",
    "mobilePhone",
    "created_at",
    "timestamp",
    "epoch_ms",
  ]) {
    assert.equal(formatRecordFieldValue(98_000_000, fieldName, undefined, "integer"), null, fieldName);
  }
  assert.equal(formatRecordFieldValue(2024, "year", undefined, "integer"), null);
});

test("leaves numbers without a numeric schema type, fractions and mixed lists unchanged", () => {
  // The declared presentation type is not the schema type: it never turns on grouping.
  assert.equal(formatRecordFieldValue(98_000_000, "followers", "integer", undefined), null);
  assert.equal(formatRecordFieldValue(98_000_000, "followers", undefined, undefined), null);
  assert.equal(formatRecordFieldValue(98_000_000, "followers", undefined, "string"), null);
  assert.equal(formatRecordFieldValue(10_000.5, "followers", undefined, "number"), null);
  assert.equal(formatRecordFieldValue(["a", 2], "values", undefined, "array"), null);
});

test("reads the schema type from field capabilities, including nullable type lists", () => {
  assert.equal(fieldSchemaType({ type: "integer" }), "integer");
  assert.equal(fieldSchemaType({ type: ["integer", "null"] }), "integer");
  assert.equal(fieldSchemaType({ type: ["integer", "string"] }), null);
  assert.equal(fieldSchemaType(null), null);
  assert.deepEqual(
    deriveFieldSchemaTypes({
      field_capabilities: {
        followers: { schema: { type: "integer" } },
        genres: { schema: { type: "array" } },
        name: null,
      },
    }),
    { followers: "integer", genres: "array" }
  );
});

test("isMonetaryDeclaredType recognizes only monetary units", () => {
  assert.equal(isMonetaryDeclaredType("currency"), true);
  assert.equal(isMonetaryDeclaredType("currency_milliunits"), true);
  assert.equal(isMonetaryDeclaredType("timestamp"), false);
  assert.equal(isMonetaryDeclaredType(undefined), false);
});

test("deriveDeclaredFieldTypes keeps only fields with a non-empty string type", () => {
  const types = deriveDeclaredFieldTypes({
    field_capabilities: {
      account_id: { type: "" },
      amount: { type: "currency" },
      date: { type: "timestamp" },
      memo: {},
      missing: null,
    },
  });
  assert.deepEqual(types, { amount: "currency", date: "timestamp" });
});

test("deriveDeclaredFieldTypes returns an empty object when metadata is absent or malformed", () => {
  assert.deepEqual(deriveDeclaredFieldTypes(null), {});
  assert.deepEqual(deriveDeclaredFieldTypes(undefined), {});
  assert.deepEqual(deriveDeclaredFieldTypes({ field_capabilities: null }), {});
});
