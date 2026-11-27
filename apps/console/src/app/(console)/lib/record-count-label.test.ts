import assert from "node:assert/strict";
import test from "node:test";
import { recordCountLabel } from "./record-count-label.ts";

test("one count format for record kinds", () => {
  assert.equal(recordCountLabel(1), "1 record");
  assert.equal(recordCountLabel(2), "2 records");
  assert.equal(recordCountLabel(0), "0 records");
});
