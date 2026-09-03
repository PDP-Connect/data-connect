// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import {
  assertGateConcurrencyReceipt,
  buildGateConcurrencyReceipt,
  failureIdentities,
} from "./gate-concurrency-receipt.ts";

const SELECTED_FILE_DIGEST_PATTERN = /selected-file digest/;
const TRANSCRIPT_DIGEST_PATTERN = /transcript digest/;
const output = [
  'PDPP_TEST_ACCOUNTING_EVENT {"type":"test:pass","details":{"type":"test","name":"passes"}}',
  'PDPP_TEST_ACCOUNTING_EVENT {"type":"test:fail","details":{"type":"test","name":"fails"}}',
  'PDPP_TEST_ACCOUNTING_EVENT {"type":"test:pass","details":{"type":"test","name":"skips","skip":"no database"}}',
].join("\n");
const transcript = [
  JSON.stringify({ cap: 8, event: "start", git_head: "head", profile: "memory-default" }),
  JSON.stringify({ event: "output", output }),
  JSON.stringify({ event: "end", exit_code: 1 }),
].join("\n");

test("receipt binds cap, selected files, structured counts, failure identity, and transcript", () => {
  const receipt = buildGateConcurrencyReceipt({
    cap: 8,
    endedAt: "2026-09-03T16:00:01.000Z",
    exitCode: 1,
    gitHeadSha: "head",
    output,
    selectedFiles: ["reference-implementation/test/example.test.ts"],
    sourceTreeSha256: "source",
    startedAt: "2026-09-03T16:00:00.000Z",
    transcript,
  });

  assert.deepEqual(receipt.counts, {
    assertions: 3,
    completed_files: 0,
    consumed_mapping_identities: [],
    failed: 1,
    passed: 1,
    planned_files: 1,
    skip_reasons: { "no database": 1 },
    skipped: 1,
  });
  assert.deepEqual(receipt.failure_identities, ["fails"]);
  assert.doesNotThrow(() => assertGateConcurrencyReceipt(receipt, transcript));
});

test("receipt verification rejects a modified transcript or selected file list", () => {
  const receipt = buildGateConcurrencyReceipt({
    cap: 8,
    endedAt: "2026-09-03T16:00:01.000Z",
    exitCode: 1,
    gitHeadSha: "head",
    output,
    selectedFiles: ["reference-implementation/test/example.test.ts"],
    sourceTreeSha256: "source",
    startedAt: "2026-09-03T16:00:00.000Z",
    transcript,
  });

  assert.throws(() => assertGateConcurrencyReceipt(receipt, `${transcript}\nchanged`), TRANSCRIPT_DIGEST_PATTERN);
  receipt.selected_files.push("reference-implementation/test/other.test.ts");
  assert.throws(() => assertGateConcurrencyReceipt(receipt, transcript), SELECTED_FILE_DIGEST_PATTERN);
});

test("failure identities exclude skipped failures", () => {
  assert.deepEqual(failureIdentities(output), ["fails"]);
});

test("the selection manifest is stable across concurrency measurements", () => {
  const common = {
    endedAt: "2026-09-03T16:00:01.000Z",
    exitCode: 1,
    gitHeadSha: "head",
    output,
    selectedFiles: ["reference-implementation/test/example.test.ts"],
    sourceTreeSha256: "source",
    startedAt: "2026-09-03T16:00:00.000Z",
    transcript,
  };
  const capTwo = buildGateConcurrencyReceipt({ ...common, cap: 2 });
  const capEight = buildGateConcurrencyReceipt({ ...common, cap: 8 });

  assert.equal(capTwo.selection_manifest_sha256, capEight.selection_manifest_sha256);
});
