// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Historical evidence replay for the archived memory-default concurrency pair.
//
// This file is not part of the ordinary backend test plan: it is a separately
// owned conditional evidence suite, run when the archive, its summary, the
// receipt verifier/builder, their parser dependencies
// (test-accounting/receipt.ts, test-accounting/inventory.ts) or this replay
// change. Run it directly with:
//
//   node --test --experimental-strip-types scripts/evidence/gate-concurrency-receipts.test.ts
//
// It lives under scripts/evidence/ so the runner's non-recursive scripts/
// discovery does not pull it into every gate run.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	assertGateConcurrencyReceipt,
	buildGateConcurrencyReceipt,
	failureIdentities,
	type GateConcurrencyReceipt,
	transcriptOutput,
} from "../gate-concurrency-receipt.ts";

const ARCHIVE = fileURLToPath(
	new URL(
		"../../docs/receipts/gate-concurrency-20260903.tar.gz",
		import.meta.url,
	),
);
const SUMMARY = fileURLToPath(
	new URL(
		"../../docs/receipts/gate-concurrency-20260903.summary.json",
		import.meta.url,
	),
);

interface EvidenceSummary {
	archive: { member_names: string[]; name: string; sha256: string };
	pair_comparison: {
		both_exit_code: number;
		same_assertion_counts: boolean;
		same_failure_identities: boolean;
		same_selected_files: boolean;
	};
	recorded_provenance: {
		git_head: string;
		node_version: string;
		profile: string;
		source_tree_sha256: string;
	};
	runs: Record<
		string,
		{
			cap: number;
			counts: {
				assertions: number;
				failed: number;
				passed: number;
				planned_files: number;
				skipped: number;
			};
			elapsed_seconds: number;
			exit_code: number;
			failure_identity_count: number;
			members: {
				receipt: { name: string; sha256: string };
				transcript: { name: string; sha256: string };
			};
			selected_file_count: number;
		}
	>;
	selection_identity: {
		selected_files_sha256: string;
		selection_manifest_sha256: string;
	};
}

/** Reads one archive member without unpacking the archive to disk. */
function readMember(name: string): string {
	return execFileSync("tar", ["-xzOf", ARCHIVE, name], {
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	});
}

function readArchivedPair(cap: 2 | 8): {
	receipt: GateConcurrencyReceipt;
	transcript: string;
} {
	const prefix = `gate-concurrency-memory-cap-${cap}`;
	return {
		receipt: JSON.parse(
			readMember(`${prefix}.receipt.json`),
		) as GateConcurrencyReceipt,
		transcript: readMember(`${prefix}.transcript`),
	};
}

function readSummary(): EvidenceSummary {
	return JSON.parse(readFileSync(SUMMARY, "utf8")) as EvidenceSummary;
}

function comparableCounts(receipt: GateConcurrencyReceipt) {
	const {
		assertions,
		completed_files,
		failed,
		passed,
		planned_files,
		skip_reasons,
		skipped,
	} = receipt.counts;
	return {
		assertions,
		completed_files,
		failed,
		passed,
		planned_files,
		skip_reasons,
		skipped,
	};
}

test("archived cap-2 and cap-8 receipts retain an equivalent memory-default result", () => {
	const capTwo = readArchivedPair(2);
	const capEight = readArchivedPair(8);

	assertGateConcurrencyReceipt(capTwo.receipt, capTwo.transcript);
	assertGateConcurrencyReceipt(capEight.receipt, capEight.transcript);
	assert.equal(capTwo.receipt.cap, 2);
	assert.equal(capEight.receipt.cap, 8);
	assert.deepEqual(
		comparableCounts(capTwo.receipt),
		comparableCounts(capEight.receipt),
	);
	assert.deepEqual(
		capTwo.receipt.failure_identities,
		capEight.receipt.failure_identities,
	);
	assert.deepEqual(
		capTwo.receipt.selected_files,
		capEight.receipt.selected_files,
	);
	assert.equal(capTwo.receipt.git_head, capEight.receipt.git_head);
	assert.equal(capTwo.receipt.node_version, capEight.receipt.node_version);
	assert.equal(
		capTwo.receipt.selection_manifest_sha256,
		capEight.receipt.selection_manifest_sha256,
	);
	assert.equal(
		capTwo.receipt.source_tree_sha256,
		capEight.receipt.source_tree_sha256,
	);
	assert.equal(capTwo.receipt.exit_code, 1);
	assert.equal(capEight.receipt.exit_code, 1);
	assert.ok(
		Date.parse(capTwo.receipt.ended_at) > Date.parse(capTwo.receipt.started_at),
	);
	assert.ok(
		Date.parse(capEight.receipt.ended_at) >
			Date.parse(capEight.receipt.started_at),
	);
});

// The builder's live consumer. Rebuilding each receipt from its own archived
// raw output is what makes the archived counts, failure names and selection
// digests re-derived claims instead of self-reported ones.
test("rebuilding each archived receipt from its raw output reproduces the recorded claims", () => {
	for (const cap of [2, 8] as const) {
		const { receipt, transcript } = readArchivedPair(cap);
		const output = transcriptOutput(transcript);
		const rebuilt = buildGateConcurrencyReceipt({
			cap: receipt.cap,
			endedAt: receipt.ended_at,
			exitCode: receipt.exit_code,
			gitHeadSha: receipt.git_head,
			output,
			selectedFiles: receipt.selected_files,
			sourceTreeSha256: receipt.source_tree_sha256,
			startedAt: receipt.started_at,
			transcript,
		});

		// Compare the rederived fields only. node_version and transcript come from
		// this replay process, not from the original measurement, so the whole
		// rebuilt receipt is deliberately not compared.
		for (const field of [
			"assertions",
			"passed",
			"failed",
			"skipped",
			"planned_files",
		] as const) {
			assert.equal(
				rebuilt.counts[field],
				receipt.counts[field],
				`cap ${cap} ${field}`,
			);
		}
		assert.deepEqual(
			rebuilt.counts.skip_reasons,
			receipt.counts.skip_reasons,
			`cap ${cap} skip reasons`,
		);
		assert.deepEqual(
			rebuilt.failure_identities,
			receipt.failure_identities,
			`cap ${cap} failure identities`,
		);
		assert.equal(
			rebuilt.selected_files_sha256,
			receipt.selected_files_sha256,
			`cap ${cap} selected files digest`,
		);
		assert.equal(
			rebuilt.selection_manifest_sha256,
			receipt.selection_manifest_sha256,
			`cap ${cap} selection manifest digest`,
		);
		assert.equal(
			rebuilt.transcript_sha256,
			receipt.transcript_sha256,
			`cap ${cap} transcript digest`,
		);
		assert.equal(rebuilt.exit_code, receipt.exit_code, `cap ${cap} exit code`);
		assert.deepEqual(
			failureIdentities(output),
			receipt.failure_identities,
			`cap ${cap} raw failure identities`,
		);
	}
});

test("forged counts and failure names in an archived receipt are rejected", () => {
	const { receipt, transcript } = readArchivedPair(8);

	const forgedCounts = {
		...receipt,
		counts: { ...receipt.counts, failed: receipt.counts.failed - 1 },
	};
	assert.throws(
		() => assertGateConcurrencyReceipt(forgedCounts, transcript),
		/count does not match/,
	);

	const renamed = [...receipt.failure_identities];
	renamed[0] = "a failure that was never recorded";
	const forgedNames = { ...receipt, failure_identities: renamed };
	assert.throws(
		() => assertGateConcurrencyReceipt(forgedNames, transcript),
		/failure identities do not match the transcript output/,
	);

	const dropped = {
		...receipt,
		failure_identities: receipt.failure_identities.slice(1),
	};
	assert.throws(
		() => assertGateConcurrencyReceipt(dropped, transcript),
		/failure identity count does not match the transcript output/,
	);
});

test("corrupting the archived raw bytes is rejected", () => {
	const { receipt, transcript } = readArchivedPair(2);
	const [firstFailure] = receipt.failure_identities;
	assert.ok(
		firstFailure,
		"the archived pair records at least one failure identity",
	);

	const corrupted = transcript.replace(
		firstFailure,
		"a name that is not in the receipt",
	);
	assert.notEqual(
		corrupted,
		transcript,
		"the corruption changed the raw bytes",
	);
	assert.throws(
		() => assertGateConcurrencyReceipt(receipt, corrupted),
		/transcript digest does not match/,
	);
});

test("the readable summary agrees with the archived raw bytes", () => {
	const summary = readSummary();
	const capTwo = readArchivedPair(2);
	const capEight = readArchivedPair(8);

	assert.equal(summary.archive.name, "gate-concurrency-20260903.tar.gz");
	assert.deepEqual(summary.archive.member_names.toSorted(), [
		"gate-concurrency-memory-cap-2.receipt.json",
		"gate-concurrency-memory-cap-2.transcript",
		"gate-concurrency-memory-cap-8.receipt.json",
		"gate-concurrency-memory-cap-8.transcript",
	]);
	assert.equal(summary.recorded_provenance.git_head, capTwo.receipt.git_head);
	assert.equal(
		summary.recorded_provenance.node_version,
		capTwo.receipt.node_version,
	);
	assert.equal(summary.recorded_provenance.profile, capTwo.receipt.profile);
	assert.equal(
		summary.recorded_provenance.source_tree_sha256,
		capTwo.receipt.source_tree_sha256,
	);
	assert.equal(
		summary.selection_identity.selection_manifest_sha256,
		capTwo.receipt.selection_manifest_sha256,
	);
	assert.equal(
		summary.selection_identity.selected_files_sha256,
		capTwo.receipt.selected_files_sha256,
	);
	assert.equal(summary.pair_comparison.both_exit_code, 1);

	for (const [cap, pair] of [
		[2, capTwo],
		[8, capEight],
	] as const) {
		const run = summary.runs[String(cap)];
		assert.ok(run, `summary records cap ${cap}`);
		assert.equal(run.cap, pair.receipt.cap);
		assert.equal(run.exit_code, pair.receipt.exit_code);
		assert.equal(run.selected_file_count, pair.receipt.selected_files.length);
		assert.equal(
			run.failure_identity_count,
			pair.receipt.failure_identities.length,
		);
		for (const field of [
			"assertions",
			"passed",
			"failed",
			"skipped",
			"planned_files",
		] as const) {
			assert.equal(
				run.counts[field],
				pair.receipt.counts[field],
				`summary cap ${cap} ${field}`,
			);
		}
		const elapsed =
			(Date.parse(pair.receipt.ended_at) -
				Date.parse(pair.receipt.started_at)) /
			1000;
		assert.equal(
			run.elapsed_seconds,
			elapsed,
			`summary cap ${cap} elapsed seconds`,
		);
	}

	// The summary points at the archive; it must not become a second copy of the
	// full selected-file or failure-name lists.
	const summaryText = readFileSync(SUMMARY, "utf8");
	for (const identity of capEight.receipt.failure_identities.slice(0, 5)) {
		assert.ok(
			!summaryText.includes(identity),
			"the summary does not duplicate failure names",
		);
	}
});
