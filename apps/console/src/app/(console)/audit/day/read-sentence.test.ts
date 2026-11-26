// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { readPractice } from "../../history/practice.ts";
import { readSentence,refusalReason } from "./read-sentence.ts";
test("all nine observed query shapes have a sentence and unknown facts are omitted", () => {
  const page = readPractice("kinds"); if (page.mode !== "reads") throw Error("wrong mode");
  assert.equal(new Set(page.data.map(row=>row.shape)).size,9);
  for (const row of page.data) {
    const sentence = readSentence(row,row.source_id ? "Gmail" : null);
    assert.ok(sentence.length > 10); assert.ok(!sentence.includes("null")); assert.ok(!sentence.includes("undefined"));
  }
  const row = page.data[0]!;
  assert.equal(readSentence({...row,records:null},"Gmail"),"Listed messages from Gmail");
  assert.equal(readSentence({...row,shape:"schema"},"Gmail"),"Asked what it may read");
  assert.equal(refusalReason("grant_revoked"),"Its permission has ended or is no longer valid.");
  assert.equal(refusalReason("unknown_code"),null);
});
