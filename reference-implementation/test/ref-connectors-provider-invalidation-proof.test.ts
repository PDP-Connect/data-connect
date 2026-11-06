// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { recordSignInProofAfterRun } from "../runtime/browser-surface/sign-in-proof-recorder.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import {
	getConnectorSummaryForRoute,
	invalidateConnectorSummariesCache,
} from "../server/ref-control.ts";
import { createSqliteConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";
import { getDefaultProviderInvalidationProofStore } from "../server/stores/provider-invalidation-proof-store.ts";
import { createSqliteSchedulerStore } from "../server/stores/scheduler-store.ts";

const CONNECTOR_ID = "provider_invalidation_browser_connector";
const INSTANCE_ID = "cin_test_provider_invalidation";
const NOW = "2026-05-20T12:00:00.000Z";
const CDP_URL = "http://127.0.0.1:9222";
const SIGN_IN_PATTERN = "https://accounts.example.test/signin*";
const SIGN_IN_URL = "https://accounts.example.test/signin?continue=app";
const APP_URL = "https://app.example.test/home";

function withTmpDb(fn: () => Promise<void>): () => Promise<void> {
	return async () => {
		const dir = mkdtempSync(join(tmpdir(), "pdpp-provider-invalidation-"));
		initDb(join(dir, "pdpp.sqlite"));
		try {
			await fn();
		} finally {
			closeDb();
			rmSync(dir, { force: true, recursive: true });
		}
	};
}

function manifestWith(pattern: string | null) {
	return {
		capabilities: { public_listing: { tier: "supported" } },
		connector_id: CONNECTOR_ID,
		display_name: "Provider invalidation browser connector",
		protocol_version: "0.1.0",
		runtime_requirements: {
			bindings: {
				browser: {
					required: true,
					...(pattern ? { sign_in_url_pattern: pattern } : {}),
				},
				network: { required: true },
			},
		},
		streams: [{ name: "messages", primary_key: ["id"] }],
		version: "1.0.0",
	};
}

async function seedConnection(pattern: string | null): Promise<void> {
	getDb()
		.prepare(
			"INSERT INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)",
		)
		.run(CONNECTOR_ID, JSON.stringify(manifestWith(pattern)), NOW);
	await createSqliteConnectorInstanceStore().upsert({
		connectorId: CONNECTOR_ID,
		connectorInstanceId: INSTANCE_ID,
		createdAt: NOW,
		displayName: "Browser connection",
		ownerSubjectId: "owner_local",
		sourceBinding: { kind: "account" },
		sourceBindingKey: "account-browser",
		sourceKind: "account",
		status: "active",
		updatedAt: NOW,
	});
}

/** A run that kept going and reported per-item 401 detail gaps: the run reason is specific and non-credential, and the 401 is only connector message text. */
async function appendRun(
	status: "failed" | "succeeded",
	runId: string,
): Promise<void> {
	const scheduler = createSqliteSchedulerStore();
	await Promise.resolve(
		scheduler.appendRunHistory({
			attempt: 1,
			checkpointSummary: null,
			completedAt: NOW,
			connectorError: null,
			connectorId: CONNECTOR_ID,
			connectorInstanceId: INSTANCE_ID,
			failureReason: status === "failed" ? "collection_incomplete" : null,
			knownGaps:
				status === "succeeded"
					? []
					: [
							{
								kind: "detail_unavailable",
								message: "GET /item/1 returned 401",
								reason: "detail_fetch_failed",
								severity: "actionable",
								stream: "messages",
							},
						],
			recordsEmitted: 1,
			reportedRecordsEmitted: 1,
			runId,
			source: { id: CONNECTOR_ID, kind: "connector" },
			startedAt: NOW,
			status,
			terminalReason: null,
			traceId: `trc_${runId}`,
		}),
	);
	await Promise.resolve(
		createSqliteSchedulerStore().upsertLastRunTime(
			INSTANCE_ID,
			Date.parse(NOW),
			NOW,
			CONNECTOR_ID,
		),
	);
}

function fetchReturningPageUrl(url: string): typeof fetch {
	return (() =>
		Promise.resolve(
			new Response(JSON.stringify([{ type: "page", url }]), {
				headers: { "content-type": "application/json" },
			}),
		)) as typeof fetch;
}

function writer(
	url: string,
	pattern: string | null,
	status: "failed" | "succeeded",
	runId: string,
) {
	return recordSignInProofAfterRun(
		{
			fetchImpl: fetchReturningPageUrl(url),
			store: getDefaultProviderInvalidationProofStore(),
		},
		{
			cdpUrl: CDP_URL,
			connectionId: INSTANCE_ID,
			connectorId: CONNECTOR_ID,
			manifest: manifestWith(pattern),
			nowIso: NOW,
			runId,
			status,
		},
	);
}

async function reauthSurface(): Promise<string | undefined> {
	invalidateConnectorSummariesCache();
	const summary = await getConnectorSummaryForRoute(INSTANCE_ID);
	assert.ok(summary, "the browser-session connection projects a summary");
	return summary.rendered_verdict.required_actions.find(
		(action) => action.kind === "reauth",
	)?.surface?.kind;
}

test(
	"(a) a failed run whose last navigation matched the sign-in pattern prompts a browser_session reauth",
	withTmpDb(async () => {
		await seedConnection(SIGN_IN_PATTERN);
		await appendRun("failed", "run_a");
		assert.equal(
			await writer(SIGN_IN_URL, SIGN_IN_PATTERN, "failed", "run_a"),
			"recorded",
		);
		assert.equal(await reauthSurface(), "browser_session");
	}),
);

test(
	"(b) a failed run whose last navigation did not match the pattern gets no reauth",
	withTmpDb(async () => {
		await seedConnection(SIGN_IN_PATTERN);
		await appendRun("failed", "run_b");
		assert.equal(
			await writer(APP_URL, SIGN_IN_PATTERN, "failed", "run_b"),
			"none",
		);
		assert.equal(await reauthSurface(), undefined);
	}),
);

test(
	"(c) the sign-in page on a healthy run records no proof and prompts nothing",
	withTmpDb(async () => {
		await seedConnection(SIGN_IN_PATTERN);
		await appendRun("succeeded", "run_c");
		assert.equal(
			await writer(SIGN_IN_URL, SIGN_IN_PATTERN, "succeeded", "run_c"),
			"repaired",
		);
		assert.equal(
			(await getDefaultProviderInvalidationProofStore().load(INSTANCE_ID))
				.proof,
			null,
		);
		assert.equal(await reauthSurface(), undefined);
	}),
);

test(
	"(d) a proof already marked repaired is suppressed",
	withTmpDb(async () => {
		await seedConnection(SIGN_IN_PATTERN);
		await appendRun("failed", "run_d");
		await writer(SIGN_IN_URL, SIGN_IN_PATTERN, "failed", "run_d");
		assert.equal(await reauthSurface(), "browser_session");
		await getDefaultProviderInvalidationProofStore().markRepaired(
			INSTANCE_ID,
			NOW,
		);
		assert.equal(await reauthSurface(), undefined);
	}),
);

test(
	"(e) a connector that declares no pattern behaves as before",
	withTmpDb(async () => {
		await seedConnection(null);
		await appendRun("failed", "run_e");
		assert.equal(await writer(SIGN_IN_URL, null, "failed", "run_e"), "none");
		assert.equal(await reauthSurface(), undefined);
	}),
);
