// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import {
	assertGateConcurrencyReceipt,
	buildGateConcurrencyReceipt,
	failureIdentities,
	type GateConcurrencyReceipt,
} from "./gate-concurrency-receipt.ts";

const SELECTED_FILE_DIGEST_PATTERN = /selected-file digest/;
const TRANSCRIPT_DIGEST_PATTERN = /transcript digest/;
const FAILED_COUNT_PATTERN =
	/failed count does not match the transcript output/;
const FORGED_COUNT_PATTERN =
	/(assertions|passed) count does not match the transcript output/;
const FAILURE_IDENTITY_PATTERN =
	/failure identities do not match the transcript output/;
const FAILURE_IDENTITY_COUNT_PATTERN =
	/failure identity count does not match the transcript output/;
const output = [
	'PDPP_TEST_ACCOUNTING_EVENT {"type":"test:pass","details":{"type":"test","name":"passes"}}',
	'PDPP_TEST_ACCOUNTING_EVENT {"type":"test:fail","details":{"type":"test","name":"fails"}}',
	'PDPP_TEST_ACCOUNTING_EVENT {"type":"test:pass","details":{"type":"test","name":"skips","skip":"no database"}}',
	// A skipped case reported as test:fail. It is a skip, not a failure, so it
	// must stay out of the failure identities.
	'PDPP_TEST_ACCOUNTING_EVENT {"type":"test:fail","details":{"type":"test","name":"skipped failure","skip":"no database"}}',
].join("\n");

function transcriptFor(
	capturedOutput: string,
	{ cap = 8, exitCode = 1 } = {},
): string {
	return [
		JSON.stringify({
			cap,
			event: "start",
			git_head: "head",
			profile: "memory-default",
		}),
		JSON.stringify({ event: "output", output: capturedOutput }),
		JSON.stringify({ event: "end", exit_code: exitCode }),
	].join("\n");
}

const transcript = transcriptFor(output);

function receiptFor(
	overrides: { cap?: number; output?: string; transcript?: string } = {},
): GateConcurrencyReceipt {
	const capturedOutput = overrides.output ?? output;
	return buildGateConcurrencyReceipt({
		cap: overrides.cap ?? 8,
		endedAt: "2026-09-03T16:00:01.000Z",
		exitCode: 1,
		gitHeadSha: "head",
		output: capturedOutput,
		selectedFiles: ["reference-implementation/test/example.test.ts"],
		sourceTreeSha256: "source",
		startedAt: "2026-09-03T16:00:00.000Z",
		transcript:
			overrides.transcript ??
			transcriptFor(capturedOutput, { cap: overrides.cap ?? 8 }),
	});
}

test("receipt binds cap, selected files, structured counts, failure identity, and transcript", () => {
	const receipt = receiptFor();

	assert.deepEqual(receipt.counts, {
		assertions: 4,
		completed_files: 0,
		consumed_mapping_identities: [],
		failed: 1,
		passed: 1,
		planned_files: 1,
		skip_reasons: { "no database": 2 },
		skipped: 2,
	});
	assert.deepEqual(receipt.failure_identities, ["fails"]);
	assert.doesNotThrow(() => assertGateConcurrencyReceipt(receipt, transcript));
});

test("receipt verification rejects a modified transcript or selected file list", () => {
	const receipt = receiptFor();

	assert.throws(
		() => assertGateConcurrencyReceipt(receipt, `${transcript}\nchanged`),
		TRANSCRIPT_DIGEST_PATTERN,
	);
	receipt.selected_files.push("reference-implementation/test/other.test.ts");
	assert.throws(
		() => assertGateConcurrencyReceipt(receipt, transcript),
		SELECTED_FILE_DIGEST_PATTERN,
	);
});

test("failure identities exclude skipped failures", () => {
	assert.deepEqual(failureIdentities(output), ["fails"]);
});

test("the selection manifest is stable across concurrency measurements", () => {
	const capTwo = receiptFor({ cap: 2 });
	const capEight = receiptFor({ cap: 8 });

	assert.equal(
		capTwo.selection_manifest_sha256,
		capEight.selection_manifest_sha256,
	);
});

test("receipt verification rejects a forged assertion count", () => {
	const receipt = receiptFor();
	receipt.counts.failed = 2;

	assert.throws(
		() => assertGateConcurrencyReceipt(receipt, transcript),
		FAILED_COUNT_PATTERN,
	);
});

test("receipt verification rejects a renamed failure identity", () => {
	const receipt = receiptFor();
	receipt.failure_identities = ["a different name"];

	assert.throws(
		() => assertGateConcurrencyReceipt(receipt, transcript),
		FAILURE_IDENTITY_PATTERN,
	);
});

test("receipt verification rejects a dropped failure identity", () => {
	const receipt = receiptFor();
	receipt.failure_identities = [];

	assert.throws(
		() => assertGateConcurrencyReceipt(receipt, transcript),
		FAILURE_IDENTITY_COUNT_PATTERN,
	);
});

// A corruption that is applied identically to both receipts still has to fail.
// Comparing the pair against each other cannot catch it; only re-deriving each
// receipt's claims from its own captured output can.
test("identically forged counts in both arms of a pair still fail verification", () => {
	const capTwo = receiptFor({ cap: 2 });
	const capEight = receiptFor({ cap: 8 });
	for (const receipt of [capTwo, capEight]) {
		receipt.counts.passed = 99;
		receipt.counts.assertions = 102;
	}

	assert.deepEqual(capTwo.counts, capEight.counts);
	assert.throws(
		() =>
			assertGateConcurrencyReceipt(capTwo, transcriptFor(output, { cap: 2 })),
		FORGED_COUNT_PATTERN,
	);
	assert.throws(
		() => assertGateConcurrencyReceipt(capEight, transcript),
		FORGED_COUNT_PATTERN,
	);
});

test("identically renamed failures in both arms of a pair still fail verification", () => {
	const capTwo = receiptFor({ cap: 2 });
	const capEight = receiptFor({ cap: 8 });
	for (const receipt of [capTwo, capEight]) {
		receipt.failure_identities = ["an agreed-upon lie"];
	}

	assert.deepEqual(capTwo.failure_identities, capEight.failure_identities);
	assert.throws(
		() =>
			assertGateConcurrencyReceipt(capTwo, transcriptFor(output, { cap: 2 })),
		FAILURE_IDENTITY_PATTERN,
	);
	assert.throws(
		() => assertGateConcurrencyReceipt(capEight, transcript),
		FAILURE_IDENTITY_PATTERN,
	);
});

test("receipt verification rejects corrupted captured output", () => {
	const receipt = receiptFor();
	const corruptedOutput = output.replace(
		'"name":"fails"',
		'"name":"renamed in the raw bytes"',
	);
	const corruptedTranscript = transcriptFor(corruptedOutput);

	// The digest catches the edit first, which is the point: raw-byte corruption
	// does not reach the count comparison at all.
	assert.throws(
		() => assertGateConcurrencyReceipt(receipt, corruptedTranscript),
		TRANSCRIPT_DIGEST_PATTERN,
	);
});
