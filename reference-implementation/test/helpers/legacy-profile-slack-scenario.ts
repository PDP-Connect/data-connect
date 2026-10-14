// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Scenarios for the compiled Slack profiles (see legacy-profile-slack.ts for what is real and
 * what is replaced). Each asserts on what the run actually did, not on a hoped-for outcome;
 * where the observed behavior is a contract change for owners, the assertion pins it and says so.
 */

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { registerConnector } from "../../server/auth.ts";
import {
	addAndSelectSlackSource,
	createSlackRunHarness,
	materializeSlackSource,
	mintClientGrant,
	ownerHeaders,
	readState,
	readStream,
	runSlackSync,
	SLACK_INSTANCE,
	SLACK_PROFILE_FIXTURES,
	SLACK_STREAMS,
	scratchDir,
	seedLegacySlackRegistration,
} from "./legacy-profile-slack.ts";
import {
	fetchJson,
	type LegacyBackend,
	type LegacyUrls,
	legacyStoredManifest,
	type Row,
	withLegacyServer,
} from "./legacy-upgrade.ts";

type StoredRecord = { data: Row; deleted: boolean; version: number };

/** Every slack record as stored, keyed `stream/record_key`. */
async function storedRecords(
	backend: LegacyBackend,
): Promise<Map<string, StoredRecord>> {
	const rows = await backend.query(
		"SELECT stream, record_key, record_json, version, deleted FROM records WHERE connector_id = 'slack' ORDER BY stream, record_key",
	);
	return new Map(
		rows.map((row) => {
			const data = (
				typeof row.record_json === "string"
					? JSON.parse(row.record_json)
					: row.record_json
			) as Row;
			// The stored envelope may wrap the record in `data`; the owner read exposes the same object.
			return [
				`${String(row.stream)}/${String(row.record_key)}`,
				{
					data: (data.data ?? data) as Row,
					deleted: Boolean(row.deleted) && row.deleted !== "0",
					version: Number(row.version),
				},
			] as const;
		}),
	);
}

const hasFetchedAt = (record: StoredRecord) =>
	Object.hasOwn(record.data, "fetched_at");
const streamOf = (key: string) => key.slice(0, key.indexOf("/"));

function perStream(records: Map<string, StoredRecord>) {
	const out: Record<string, { fetched_at: number; records: number }> = {};
	for (const stream of SLACK_STREAMS) {
		out[stream] = { fetched_at: 0, records: 0 };
	}
	for (const [key, record] of records) {
		const entry = out[streamOf(key)];
		assert.ok(entry, `unexpected stream in ${key}`);
		entry.records += 1;
		entry.fetched_at += hasFetchedAt(record) ? 1 : 0;
	}
	return out;
}

function runFacts(timeline: Row) {
	const events = timeline.data as Row[];
	const terminal = events.at(-1) as Row;
	const data = terminal.data as Row;
	return {
		checkpoint_commit_status: data.checkpoint_commit_status,
		failure_message: data.failure_message,
		records_accepted: data.records_accepted,
		skipped: events
			.filter((event) => event.event_type === "run.stream_skipped")
			.map((event) => ({
				event_type: event.event_type,
				stream: event.stream_id,
			})),
		state_streams_committed: data.state_streams_committed,
		terminal_status: timeline.terminal_status,
	};
}

const GRANT_QUERIES = [
	["no fields param", ""],
	["fields=<granted non-fetched_at>", "&fields=id"],
	["fields=id,fetched_at", "&fields=id,fetched_at"],
] as const;

interface GrantSpec {
	readonly fields: readonly string[];
	readonly label: string;
	readonly stream: string;
}

const GRANT_SPECS: readonly GrantSpec[] = [
	{
		fields: ["id", "channel_id", "user_id", "fetched_at"],
		label: "channel_memberships grant WITH fetched_at",
		stream: "channel_memberships",
	},
	{
		fields: ["id", "channel_id", "user_id"],
		label: "channel_memberships grant WITHOUT fetched_at",
		stream: "channel_memberships",
	},
	{
		fields: ["id", "name", "fetched_at"],
		label: "workspace grant WITH fetched_at",
		stream: "workspace",
	},
	{
		fields: ["id", "name"],
		label: "workspace grant WITHOUT fetched_at",
		stream: "workspace",
	},
];

type GrantRead = { body: unknown; query: string; status: number };

async function readGrants(
	urls: LegacyUrls,
	grants: { spec: GrantSpec; token: string }[],
) {
	const out: Record<string, Record<string, GrantRead>> = {};
	for (const { spec, token } of grants) {
		const cases: Record<string, GrantRead> = {};
		for (const [name, query] of GRANT_QUERIES) {
			const read = await readStream(urls, spec.stream, token, query);
			const body =
				read.status === 200
					? (read.body.data as Row[]).map((row) => row.data ?? row)
					: {
							code: read.body?.error?.code,
							message: read.body?.error?.message,
						};
			cases[name] = { body, query, status: read.status };
		}
		out[spec.label] = cases;
	}
	return out;
}

function writeEvidence(report: Record<string, unknown>) {
	const file = process.env.LEGACY_PROFILE_EVIDENCE_FILE;
	if (file) {
		writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
	}
}

/** The base-archive resume fact the run committed; the connector writes it just after the run is terminal. */
async function waitForResumeFact(
	urls: LegacyUrls,
): Promise<{ archive: string; at: string }> {
	for (let attempt = 0; attempt < 50; attempt += 1) {
		const messages = ((await readState(urls)).state as Record<string, Row>)
			.messages as Row;
		const [entry] = Object.entries(
			(messages.base_archive_resumed_at as Row | undefined) ?? {},
		);
		if (entry) {
			return { archive: entry[0], at: String(entry[1]) };
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error("no base_archive_resumed_at fact appeared after the run");
}

/** State as an instance last synced 8 days ago would have it: slackdump is due again. */
async function ageLastResume(urls: LegacyUrls): Promise<void> {
	const messages = ((await readState(urls)).state as Record<string, Row>)
		.messages as Row;
	const archiveDir = messages.archive_dir as string;
	assert.ok(archiveDir, "state names the archive");
	const old = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
	const put = await fetchJson(
		`${urls.rsUrl}/v1/state/slack?connector_instance_id=${SLACK_INSTANCE}`,
		{
			body: JSON.stringify({
				state: {
					messages: {
						...messages,
						base_archive_resumed_at: { [archiveDir]: old },
					},
				},
			}),
			headers: { ...ownerHeaders(urls), "Content-Type": "application/json" },
			method: "PUT",
		},
	);
	assert.equal(put.status, 200, JSON.stringify(put.body));
}

/** A stream's state without its run clock, so values from different runs compare. */
const withoutClock = (state: Row | undefined) => {
	const { synced_at: _syncedAt, ...rest } = state ?? {};
	return rest;
};

const sorted = (values: Iterable<string>) => [...values].sort();

/**
 * 0.6.0 registration + 0.6.0 emitter -> register 0.7.1 + 0.7.1 emitter, both compiled, both run
 * through the controller as the developer-local source `slack`.
 */
export async function assertCompiledSlackUpgrade(
	backend: LegacyBackend,
	databaseUrl?: string,
): Promise<void> {
	const dir = scratchDir();
	mkdirSync(dir, { recursive: true });
	const harness = createSlackRunHarness(dir, registerConnector as never);
	const report: Record<string, unknown> = {};
	try {
		await withLegacyServer(
			{
				backend,
				databaseUrl,
				serverOptions: harness.serverOptions,
				service: harness.service,
			},
			async (urls) => {
				// ---- legacy registration, instance and grants issued BEFORE 0.7.1 ----
				await seedLegacySlackRegistration(
					backend,
					JSON.stringify(legacyStoredManifest("slack")),
				);
				const grants: { spec: GrantSpec; token: string }[] = [];
				for (const spec of GRANT_SPECS) {
					const minted = await mintClientGrant(urls, spec.stream, spec.fields);
					assert.deepEqual(
						(minted.grant.streams as Row[])[0]?.fields,
						spec.fields,
						`${spec.label}: granted fields`,
					);
					grants.push({ spec, token: minted.token });
				}

				// ---- legacy phase: the 0.6.0 emitter (data-connectors 97536ad49) ----
				await addAndSelectSlackSource(
					urls,
					materializeSlackSource(join(dir, "legacy-src"), "legacy"),
				);
				const legacyRun = await runSlackSync(urls);
				assert.equal(
					legacyRun.timeline.terminal_status,
					"completed",
					JSON.stringify(runFacts(legacyRun.timeline)),
				);
				const before = await storedRecords(backend);
				const beforeByStream = perStream(before);
				for (const stream of SLACK_STREAMS) {
					assert.ok(
						(beforeByStream[stream]?.records ?? 0) > 0,
						`legacy run produced ${stream}`,
					);
				}
				assert.deepEqual(
					SLACK_STREAMS.filter(
						(stream) => (beforeByStream[stream]?.fetched_at ?? 0) > 0,
					),
					["workspace", "channel_memberships", "dm_read_states"],
					"the 0.6.0 emitter stamps data.fetched_at in exactly the three streams that declare it",
				);
				const stateBefore = (await readState(urls)).state as Record<
					string,
					Row
				>;
				assert.deepEqual(
					sorted(Object.keys(stateBefore)),
					sorted(
						SLACK_STREAMS.filter(
							(stream) =>
								stream !== "message_attachments" && stream !== "reactions",
						),
					),
					"the legacy run wrote state for 12 streams (not message_attachments or reactions)",
				);
				const grantsBefore = await readGrants(urls, grants);
				const registeredBefore = await backend.query(
					"SELECT CAST(manifest_generation AS TEXT) AS generation FROM connector_instances WHERE connector_instance_id = ?",
					[SLACK_INSTANCE],
				);

				// ---- step 1: register the 0.7.1 manifest. No 0.7.1 code has run yet. ----
				const registered = await fetchJson(`${urls.asUrl}/connectors`, {
					body: readFileSync(
						join(
							SLACK_PROFILE_FIXTURES,
							"..",
							"..",
							"legacy-upgrade",
							"slack-0.7.1.json",
						),
						"utf8",
					),
					headers: { "Content-Type": "application/json" },
					method: "POST",
				});
				assert.equal(registered.status, 201, JSON.stringify(registered.body));
				const generations = await backend.query(
					"SELECT CAST(manifest_generation AS TEXT) AS generation FROM connector_instances WHERE connector_instance_id = ?",
					[SLACK_INSTANCE],
				);
				assert.equal(
					Number(generations[0]?.generation),
					Number(registeredBefore[0]?.generation) + 1,
					"registration bumps manifest_generation once",
				);
				const grantsRegistered = await readGrants(urls, grants);

				// ---- step 2: first run with the compiled 0.7.1 emitter. State proves a completed run (archive_dir,
				// last_ts) but holds no base_archive_resumed_at fact, so the connector's migration shim
				// (deriveMigratedBaseArchiveResumedAt, which the 0.6.0 bundle contains too) seeds the resume throttle from
				// this run and slackdump is not called. A throttle hit on an existing fact would leave the state
				// precondition false and the fact older than this run, so both are pinned. ----
				const messagesBefore = stateBefore.messages as Row;
				assert.ok(
					messagesBefore.archive_dir && messagesBefore.last_ts,
					"state proves a completed prior run",
				);
				assert.deepEqual(
					Object.keys(
						(messagesBefore.base_archive_resumed_at as Row | undefined) ?? {},
					),
					[],
					"the 0.6.0 run left no base_archive_resumed_at fact",
				);
				await addAndSelectSlackSource(
					urls,
					materializeSlackSource(join(dir, "v071-src"), "v071"),
				);
				const stubMark1 = harness.stubLog().length;
				const run1Started = Date.now();
				const run1 = await runSlackSync(urls);
				assert.equal(
					run1.timeline.terminal_status,
					"completed",
					JSON.stringify(runFacts(run1.timeline)),
				);
				assert.deepEqual(
					harness.stubLog().slice(stubMark1),
					[],
					"first post-upgrade run: slackdump not called",
				);
				assert.ok(
					(run1.timeline.data as Row[]).some(
						(event) =>
							event.event_type === "run.progress_reported" &&
							(event.data as Row).message ===
								"Using the saved copy; Slack was checked recently",
					),
					"the run reports the throttle decision",
				);
				const seeded = await waitForResumeFact(urls);
				assert.equal(seeded.archive, messagesBefore.archive_dir);
				assert.ok(
					Date.parse(seeded.at) >= run1Started - 1000,
					`the resume fact was seeded by this run, not carried over: ${seeded.at}`,
				);
				const afterRun1 = await storedRecords(backend);
				const written1 = [...afterRun1].filter(
					([key, record]) => record.version !== before.get(key)?.version,
				);
				// Unchanged content is re-emitted but stored as the same version; dm_read_states differs only by losing fetched_at.
				assert.deepEqual(
					written1.map(([key]) => key),
					["dm_read_states/D0DIRECT01"],
				);
				for (const [key, record] of written1) {
					assert.equal(
						hasFetchedAt(record),
						false,
						`${key} written by 0.7.1 has no fetched_at`,
					);
				}
				// CONTRACT CHANGE: rows the emitter did not rewrite keep their legacy data.fetched_at. The reason is the
				// connector's in-code FINGERPRINT_EXCLUDE (connectors/slack/index.ts at 861be44d48: workspace and
				// channel_memberships exclude "fetched_at"), not the manifest's compaction_fingerprint.exclude_keys: an
				// unchanged row's fingerprint still matches the stored one, so the connector suppresses it and the stored
				// version is never replaced. dm_read_states is rewritten because it is not in FINGERPRINTED_STREAMS, so
				// it is emitted on every run.
				assert.deepEqual(
					sorted(
						[...afterRun1]
							.filter(([, record]) => hasFetchedAt(record))
							.map(([key]) => key),
					),
					sorted([
						"workspace/T0ACME001",
						...[...before.keys()].filter((key) =>
							key.startsWith("channel_memberships/"),
						),
					]),
				);
				for (const key of before.keys()) {
					assert.ok(afterRun1.has(key), `retained ${key}`);
				}
				const stateRun1 = (await readState(urls)).state as Record<string, Row>;
				assert.deepEqual(
					sorted(Object.keys(stateRun1)),
					sorted(Object.keys(stateBefore)),
					"same state streams: none orphaned, none added",
				);
				for (const stream of ["message_attachments", "reactions"]) {
					assert.equal(
						stream in stateRun1,
						false,
						`${stream} has no state entry of its own, before or after`,
					);
				}
				for (const stream of Object.keys(stateBefore)) {
					if (stream !== "messages") {
						assert.deepEqual(
							withoutClock(stateRun1[stream]),
							withoutClock(stateBefore[stream]),
							`${stream}: state values unchanged by the first 0.7.1 run`,
						);
					}
				}
				assert.deepEqual(
					(stateRun1.messages as Row).channel_last_ts,
					(stateBefore.messages as Row).channel_last_ts,
					"message cursors honored, not reset",
				);
				assert.equal(
					(stateRun1.messages as Row).archive_dir,
					(stateBefore.messages as Row).archive_dir,
				);
				const grantsRun1 = await readGrants(urls, grants);

				// ---- step 3: slackdump is due again (last resume 8 days ago): resume sees new traffic ----
				await ageLastResume(urls);
				const stubMark2 = harness.stubLog().length;
				const run2 = await runSlackSync(urls);
				assert.equal(
					run2.timeline.terminal_status,
					"completed",
					JSON.stringify(runFacts(run2.timeline)),
				);
				const stubCalls = harness.stubLog().slice(stubMark2);
				const resume = stubCalls.find(
					(call) => (call.args as string[])[0] === "resume",
				);
				assert.ok(resume, `resume was called: ${JSON.stringify(stubCalls)}`);
				assert.equal(
					(resume.args as string[]).at(-1),
					(stateBefore.messages as Row).archive_dir,
					"resume target is the archive named by existing state",
				);
				assert.ok(
					!stubCalls.some((call) => (call.args as string[])[0] === "archive"),
					"existing state honored: no fresh archive",
				);
				const afterRun2 = await storedRecords(backend);
				const afterRun2ByStream = perStream(afterRun2);
				for (const stream of SLACK_STREAMS) {
					assert.ok(
						(afterRun2ByStream[stream]?.records ?? 0) >=
							(beforeByStream[stream]?.records ?? 0),
						`${stream}: no record lost`,
					);
				}
				for (const [key, record] of afterRun2) {
					if (record.version !== afterRun1.get(key)?.version) {
						assert.equal(
							hasFetchedAt(record),
							false,
							`${key} written by the resume run has no fetched_at`,
						);
					}
					assert.equal(record.deleted, false, `${key} not tombstoned`);
				}
				assert.equal(
					afterRun2.get("workspace/T0ACME001")?.data.name,
					"Acme Inc",
				);
				assert.equal(
					hasFetchedAt(afterRun2.get("workspace/T0ACME001") as StoredRecord),
					false,
					"workspace was changed, so it is rewritten without fetched_at",
				);
				assert.ok(afterRun2.has("channel_memberships/C0PRIVATE1:U0ALICE01"));
				assert.equal(
					afterRun2ByStream.messages?.records,
					(beforeByStream.messages?.records ?? 0) + 1,
					"the new message arrived through resume",
				);
				assert.equal(
					afterRun2ByStream.channel_memberships?.fetched_at,
					5,
					"unchanged memberships keep legacy fetched_at",
				);
				assert.equal(afterRun2ByStream.workspace?.fetched_at, 0);
				assert.equal(afterRun2ByStream.dm_read_states?.fetched_at, 0);
				assert.equal(
					afterRun2ByStream.message_attachments?.records,
					beforeByStream.message_attachments?.records,
				);
				assert.equal(
					afterRun2ByStream.reactions?.records,
					beforeByStream.reactions?.records,
				);
				const stateRun2 = (await readState(urls)).state as Record<string, Row>;
				assert.deepEqual(
					sorted(Object.keys(stateRun2)),
					sorted(Object.keys(stateBefore)),
				);
				for (const stream of Object.keys(stateBefore)) {
					// workspace, channel_memberships and messages legitimately change in the resume run.
					if (
						!["workspace", "channel_memberships", "messages"].includes(stream)
					) {
						assert.deepEqual(
							withoutClock(stateRun2[stream]),
							withoutClock(stateBefore[stream]),
							`${stream}: state values carried through the resume run`,
						);
					}
				}
				const messagesAfter = stateRun2.messages as Row;
				assert.ok(
					Number(messagesAfter.last_ts) > Number(messagesBefore.last_ts),
					"messages.last_ts advanced",
				);
				assert.ok(
					Number((messagesAfter.channel_last_ts as Row).C0GENERAL1) >
						Number((messagesBefore.channel_last_ts as Row).C0GENERAL1),
					"per-channel cursor advanced",
				);
				assert.deepEqual(
					messagesAfter.observed_channel_ids,
					messagesBefore.observed_channel_ids,
				);
				assert.deepEqual(
					sorted(
						Object.keys(
							(stateRun2.channel_memberships as Row).fingerprints as Row,
						),
					),
					sorted([
						...Object.keys(
							(stateBefore.channel_memberships as Row).fingerprints as Row,
						),
						"C0PRIVATE1:U0ALICE01",
					]),
					"membership fingerprints carried forward and extended",
				);
				const grantsRun2 = await readGrants(urls, grants);

				// ---- authenticated grant reads, grants issued before the 0.7.1 registration ----
				const m = "channel_memberships grant WITH fetched_at";
				const mw = "channel_memberships grant WITHOUT fetched_at";
				const w = "workspace grant WITH fetched_at";
				const ww = "workspace grant WITHOUT fetched_at";
				const NO = "no fields param";
				const EXPLICIT = "fields=id,fetched_at";
				const rowsOf = (read: GrantRead | undefined) =>
					(read?.body ?? []) as Row[];
				const withFetchedAt = (read: GrantRead | undefined) =>
					rowsOf(read).filter((row) => "fetched_at" in row).length;
				const stages = [
					// name, reads, registered 0.7.1?, expected [membership rows, with fetched_at, workspace rows with fetched_at]
					["before registration", grantsBefore, false, [5, 5, 1]],
					["registered, no 0.7.1 code run", grantsRegistered, true, [5, 5, 1]],
					["after first 0.7.1 run", grantsRun1, true, [5, 5, 1]],
					["after resume run", grantsRun2, true, [6, 5, 0]],
				] as const;
				for (const [
					stage,
					reads,
					isRegistered,
					[membershipRows, membershipWith, workspaceWith],
				] of stages) {
					assert.equal(reads[m]?.[NO]?.status, 200, stage);
					assert.equal(
						rowsOf(reads[m]?.[NO]).length,
						membershipRows,
						`${stage}: membership rows`,
					);
					assert.equal(
						withFetchedAt(reads[m]?.[NO]),
						membershipWith,
						`${stage}: WITH grant returns retained fetched_at by default`,
					);
					assert.equal(
						withFetchedAt(reads[w]?.[NO]),
						workspaceWith,
						`${stage}: workspace WITH grant`,
					);
					assert.equal(
						withFetchedAt(reads[mw]?.[NO]) + withFetchedAt(reads[ww]?.[NO]),
						0,
						`${stage}: WITHOUT grants never see fetched_at`,
					);
					for (const label of [m, mw, w, ww]) {
						assert.equal(
							reads[label]?.["fields=<granted non-fetched_at>"]?.status,
							200,
							`${stage} ${label}`,
						);
					}
					for (const label of [m, w]) {
						if (isRegistered) {
							assert.equal(
								reads[label]?.[EXPLICIT]?.status,
								400,
								`${stage} ${label}: explicit fetched_at`,
							);
							assert.deepEqual(reads[label]?.[EXPLICIT]?.body, {
								code: "unknown_field",
								message: "Unknown field: fetched_at",
							});
						} else {
							assert.equal(
								reads[label]?.[EXPLICIT]?.status,
								200,
								`${stage} ${label}: explicit fetched_at`,
							);
						}
					}
					for (const label of [mw, ww]) {
						assert.equal(
							reads[label]?.[EXPLICIT]?.status,
							isRegistered ? 400 : 403,
							`${stage} ${label}: explicit fetched_at`,
						);
						assert.equal(
							(reads[label]?.[EXPLICIT]?.body as Row | undefined)?.code,
							isRegistered ? "unknown_field" : "field_not_granted",
						);
					}
				}

				report.stages = Object.fromEntries(
					stages.map(([stage, reads]) => [stage, reads]),
				);
				report.per_stream_after_legacy = beforeByStream;
				report.per_stream_after_first_071_run = perStream(afterRun1);
				report.per_stream_after_resume_run = afterRun2ByStream;
				report.state_streams = sorted(Object.keys(stateRun2));
				report.runs = {
					legacy: runFacts(legacyRun.timeline),
					first_071: runFacts(run1.timeline),
					resume_071: runFacts(run2.timeline),
				};
				report.written_by_first_071_run = written1.map(([key]) => key);
				report.state_before = stateBefore;
				report.state_after = stateRun2;
				report.stub_calls = harness
					.stubLog()
					.map((call) => (call.args as string[]).slice(0, 2));
				report.shim_calls = harness.shimLog();
				assert.deepEqual(
					harness.shimLog().filter((entry) => entry.blocked),
					[],
					"nothing outside the four mocked Slack Web API methods was attempted",
				);
			},
		);
	} finally {
		harness.restore();
		writeEvidence(report);
		rmSync(dir, { force: true, recursive: true });
	}
}

/**
 * The 0.7.1 emitter while the registration is still 0.6.0, with every network path closed: the runtime
 * accepts the run (it checks the profile's own manifest), and the four Web API streams are skipped, not fatal.
 */
export async function assertCompiledSlackOffline(
	backend: LegacyBackend,
	databaseUrl?: string,
): Promise<void> {
	const dir = scratchDir();
	mkdirSync(dir, { recursive: true });
	const harness = createSlackRunHarness(dir, registerConnector as never);
	harness.setNetMode("deny");
	const report: Record<string, unknown> = {};
	try {
		await withLegacyServer(
			{
				backend,
				databaseUrl,
				serverOptions: harness.serverOptions,
				service: harness.service,
			},
			async (urls) => {
				await seedLegacySlackRegistration(
					backend,
					JSON.stringify(legacyStoredManifest("slack")),
				);
				await addAndSelectSlackSource(
					urls,
					materializeSlackSource(join(dir, "v071-src"), "v071"),
				);
				const run = await runSlackSync(urls);
				const facts = runFacts(run.timeline);
				const byStream = perStream(await storedRecords(backend));
				report.deny = { facts, byStream, shim: harness.shimLog() };
				assert.equal(
					run.timeline.terminal_status,
					"completed",
					JSON.stringify(facts),
				);
				const api = ["stars", "user_groups", "reminders", "dm_read_states"];
				assert.deepEqual(
					sorted(facts.skipped.map((skip) => String(skip.stream))),
					sorted(api),
					"the run reports exactly the four Web API streams as skipped",
				);
				for (const stream of SLACK_STREAMS) {
					assert.equal(
						(byStream[stream]?.records ?? 0) > 0,
						!api.includes(stream),
						`${stream}: ${api.includes(stream) ? "needs the live Web API and is skipped offline" : "comes from the slackdump archive"}`,
					);
					assert.equal(
						byStream[stream]?.fetched_at,
						0,
						`${stream}: no fetched_at`,
					);
				}
				assert.ok(
					harness.shimLog().length >= 4 &&
						harness.shimLog().every((entry) => entry.blocked === "deny-mode"),
				);
				const registered = await backend.query(
					"SELECT manifest FROM connectors WHERE connector_id = 'slack'",
				);
				const manifest = (
					typeof registered[0]?.manifest === "string"
						? JSON.parse(registered[0].manifest)
						: registered[0]?.manifest
				) as Row;
				assert.equal(
					manifest.version,
					"0.6.0",
					"the registration was never updated in this scenario",
				);
			},
		);
	} finally {
		harness.restore();
		writeEvidence(report);
		rmSync(dir, { force: true, recursive: true });
	}
}
