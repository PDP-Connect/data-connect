// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { basename } from "node:path";
import { contentDigest } from "./test-accounting/inventory.ts";
import { structuredNodeSummary } from "./test-accounting/receipt.ts";

const GATE_CONCURRENCY_RECEIPT_SCHEMA = "pdpp.gate-concurrency-receipt/v1";

export interface GateConcurrencyReceipt {
	cap: number;
	counts: ReturnType<typeof structuredNodeSummary> & {
		completed_files: number;
		planned_files: number;
	};
	ended_at: string;
	exit_code: number;
	failure_identities: string[];
	git_head: string;
	node_version: string;
	profile: "memory-default";
	schema: typeof GATE_CONCURRENCY_RECEIPT_SCHEMA;
	selected_files: string[];
	selected_files_sha256: string;
	selection_manifest_sha256: string;
	source_tree_sha256: string;
	started_at: string;
	transcript: string;
	transcript_sha256: string;
}

interface TranscriptEvent {
	details?: { name?: string; skip?: boolean | string; type?: string };
	type: string;
}

function fail(message: string): never {
	throw new Error(`gate concurrency receipt: ${message}`);
}

function eventLines(output: string): TranscriptEvent[] {
	return output
		.split("\n")
		.filter((line) => line.startsWith("PDPP_TEST_ACCOUNTING_EVENT "))
		.map(
			(line) =>
				JSON.parse(
					line.slice("PDPP_TEST_ACCOUNTING_EVENT ".length),
				) as TranscriptEvent,
		);
}

export function failureIdentities(output: string): string[] {
	return eventLines(output)
		.filter(
			(event) =>
				event.type === "test:fail" &&
				event.details?.type === "test" &&
				!event.details.skip,
		)
		.map((event) => event.details?.name)
		.filter((name): name is string => typeof name === "string")
		.sort();
}

export function buildGateConcurrencyReceipt({
	cap,
	endedAt,
	exitCode,
	gitHeadSha,
	output,
	selectedFiles,
	sourceTreeSha256,
	startedAt,
	transcript,
}: {
	cap: number;
	endedAt: string;
	exitCode: number;
	gitHeadSha: string;
	output: string;
	selectedFiles: string[];
	sourceTreeSha256: string;
	startedAt: string;
	transcript: string;
}): GateConcurrencyReceipt {
	if (!Number.isInteger(cap) || cap <= 0) {
		fail("cap must be a positive integer");
	}
	const summary = structuredNodeSummary(output);
	const counts = {
		...summary,
		// Legacy field, derived from the exit code rather than from observed
		// per-file completion events. On a failed run it is 0 because the run
		// exited non-zero, NOT because no file finished. A real completion count
		// needs raw per-file outcome events, which this schema does not carry.
		completed_files: exitCode === 0 ? selectedFiles.length : 0,
		planned_files: selectedFiles.length,
	};
	if (counts.assertions !== counts.passed + counts.failed + counts.skipped) {
		fail("structured output has inconsistent assertion counts");
	}
	return {
		cap,
		counts,
		ended_at: endedAt,
		exit_code: exitCode,
		failure_identities: failureIdentities(output),
		git_head: gitHeadSha,
		node_version: process.version,
		profile: "memory-default",
		schema: GATE_CONCURRENCY_RECEIPT_SCHEMA,
		selected_files: selectedFiles,
		selected_files_sha256: contentDigest(JSON.stringify(selectedFiles)),
		selection_manifest_sha256: contentDigest(
			JSON.stringify({
				profile: "memory-default",
				selected_files: selectedFiles,
			}),
		),
		source_tree_sha256: sourceTreeSha256,
		started_at: startedAt,
		transcript: basename("gate-concurrency-memory.transcript"),
		transcript_sha256: contentDigest(transcript),
	};
}

/**
 * Extracts the captured runner output that the transcript binds.
 *
 * The transcript's middle `output` event carries the raw structured events the
 * receipt's counts and failure identities were derived from. Recovering it is
 * what lets the verifier re-derive those claims instead of trusting the
 * receipt's own summary of itself.
 */
export function transcriptOutput(transcript: string): string {
	const lines = transcript.split("\n").filter(Boolean);
	for (const line of lines) {
		const event = JSON.parse(line) as { event?: string; output?: string };
		if (event.event === "output") {
			if (typeof event.output !== "string") {
				fail("transcript output event does not carry captured output");
			}
			return event.output;
		}
	}
	return fail("transcript has no output event");
}

export function assertGateConcurrencyReceipt(
	receipt: GateConcurrencyReceipt,
	transcript: string,
): void {
	if (
		receipt.schema !== GATE_CONCURRENCY_RECEIPT_SCHEMA ||
		receipt.profile !== "memory-default"
	) {
		fail("receipt schema or profile is invalid");
	}
	if (receipt.transcript_sha256 !== contentDigest(transcript)) {
		fail("transcript digest does not match");
	}
	if (
		receipt.selected_files_sha256 !==
		contentDigest(JSON.stringify(receipt.selected_files))
	) {
		fail("selected-file digest does not match");
	}
	const lines = transcript.split("\n").filter(Boolean);
	if (
		receipt.selection_manifest_sha256 !==
		contentDigest(
			JSON.stringify({
				profile: receipt.profile,
				selected_files: receipt.selected_files,
			}),
		)
	) {
		fail("selection manifest digest does not match");
	}
	const start = JSON.parse(lines[0] ?? "{}") as {
		cap?: number;
		event?: string;
		git_head?: string;
		profile?: string;
	};
	const end = JSON.parse(lines.at(-1) ?? "{}") as {
		event?: string;
		exit_code?: number;
	};
	if (
		start.event !== "start" ||
		start.cap !== receipt.cap ||
		start.git_head !== receipt.git_head ||
		start.profile !== receipt.profile
	) {
		fail("transcript start does not bind receipt settings");
	}
	if (end.event !== "end" || end.exit_code !== receipt.exit_code) {
		fail("transcript end does not bind receipt exit code");
	}
	// Digests bind the bytes; they do not check that the receipt's summary of
	// those bytes is honest. Re-derive the counts and failure identities from the
	// captured output so a forged count or a renamed failure fails here even
	// when every digest still matches.
	const output = transcriptOutput(transcript);
	const rederived = structuredNodeSummary(output);
	for (const field of ["assertions", "passed", "failed", "skipped"] as const) {
		if (receipt.counts[field] !== rederived[field]) {
			fail(`receipt ${field} count does not match the transcript output`);
		}
	}
	const rederivedFailures = failureIdentities(output);
	if (receipt.failure_identities.length !== rederivedFailures.length) {
		fail("receipt failure identity count does not match the transcript output");
	}
	for (const [index, identity] of rederivedFailures.entries()) {
		if (receipt.failure_identities[index] !== identity) {
			fail("receipt failure identities do not match the transcript output");
		}
	}
	if (receipt.counts.failed !== rederivedFailures.length) {
		fail("receipt failed count does not match its own failure identities");
	}
	if (receipt.counts.planned_files !== receipt.selected_files.length) {
		fail("receipt planned file count does not match its selected files");
	}
}
