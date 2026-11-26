// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";
import { BASELINE_SHA } from "../reference-implementation/vendor/mcp-server/scripts/artifact-receipt.ts";

// mcp-server's `verify` builds an artifact receipt whose base is
// `git merge-base HEAD BASELINE_SHA`. On a shallow checkout that commit is
// absent and git exits 128, so every job that runs the mcp-server verify
// must check out full history. The pull-request job had it; the release
// job did not, so the first release after the packages moved here failed
// in `quality` while every PR check was green.

interface WorkflowStep {
	name?: string;
	uses?: string;
	run?: string;
	with?: Record<string, unknown>;
}

interface WorkflowDocument {
	jobs: Record<string, { steps: WorkflowStep[] }>;
}

function job(workflowFile: string, jobId: string): WorkflowStep[] {
	const workflow = load(
		readFileSync(
			resolve(process.cwd(), ".github/workflows", workflowFile),
			"utf8",
		),
	) as WorkflowDocument;
	const steps = workflow.jobs[jobId]?.steps;
	if (!steps) throw new Error(`Missing job '${jobId}' in ${workflowFile}`);
	return steps;
}

function checkout(steps: WorkflowStep[]): WorkflowStep {
	const step = steps.find((s) => s.uses?.startsWith("actions/checkout@"));
	if (!step) throw new Error("Job has no actions/checkout step");
	return step;
}

describe("jobs that verify mcp-server check out full history", () => {
	it("mcp-server still pins a fixed baseline commit for its receipt", () => {
		expect(BASELINE_SHA).toMatch(/^[0-9a-f]{40}$/);
	});

	it("npm-release quality runs the mcp-server verify on a full clone", () => {
		const steps = job("npm-release.yml", "quality");
		expect(steps.some((s) => s.run?.includes("vendor/mcp-server verify"))).toBe(
			true,
		);
		expect(checkout(steps).with?.["fetch-depth"]).toBe(0);
	});

	it("package-verify verify runs on a full clone", () => {
		expect(
			checkout(job("package-verify.yml", "verify")).with?.["fetch-depth"],
		).toBe(0);
	});
});
