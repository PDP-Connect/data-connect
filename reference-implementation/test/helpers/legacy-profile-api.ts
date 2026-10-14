// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Runnable-layout evidence for the O-era API connectors apple_contacts, spotify and github, built from
 * data-connectors 97536ad49 (their manifests there are byte-identical to the legacy registrations, spotify
 * excepted: it has no c82718d4 copy, so the 97536ad49 manifest is used). Each is added and selected as the
 * developer-local source under its stored key, then run through the real controller against a legacy
 * registration with no network:
 *
 * - apple_contacts reads its CardDAV origin from APPLE_CARDDAV_ORIGIN, so it talks to a real loopback
 *   HTTP server (fixtures/legacy-profiles/apple_contacts/carddav-mock.mjs).
 * - spotify and github hard-code their API origins, so a preload shim in the child answers constructed
 *   responses and refuses everything else (fixtures/legacy-profiles/http-fixture-shim.mjs).
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { resolveActiveInstallFirstConnectorPath } from "../../runtime/controller.ts";
import { registerConnector } from "../../server/auth.ts";
import {
	createConnectorInstallService,
	createFileConnectorInstallStore,
} from "../../server/connector-install/index.ts";
import { createFileLocalConnectorSourceStore } from "../../server/connector-install/local-source.ts";
import { TEST_PRE_REGISTERED_PUBLIC_CLIENTS } from "../fixtures/demo-clients.ts";
import { startCardDavMock } from "../fixtures/legacy-profiles/apple_contacts/carddav-mock.mjs";
import { SLACK_PROFILE_FIXTURES, scratchDir } from "./legacy-profile-slack.ts";
import {
	fetchJson,
	type LegacyBackend,
	legacyManifest,
	type Row,
	seedLegacyRegistration,
	withLegacyServer,
} from "./legacy-upgrade.ts";

const PROFILES = join(SLACK_PROFILE_FIXTURES, "..");

export const API_PROFILES = {
	apple_contacts: {
		bundle: "apple_contacts/apple_contacts-97536ad49.collection-profile.mjs.gz",
		sha256: "11777c08835a12e0ad04f62645c7315aae6918399964421a2072b8358ad009f7",
		streams: ["address_books", "contacts", "contact_groups"],
	},
	github: {
		bundle: "github/github-97536ad49.collection-profile.mjs.gz",
		handler: "github/github-http.mjs",
		sha256: "b33a2dcaecfe91e4b23f051800fe4814fed96f5b308e430bafec205e2139d9c7",
		streams: [
			"user",
			"user_stats",
			"repositories",
			"starred",
			"issues",
			"pull_requests",
			"gists",
		],
	},
	spotify: {
		bundle: "spotify/spotify-97536ad49.collection-profile.mjs.gz",
		handler: "spotify/spotify-http.mjs",
		sha256: "7df5838bda8dcd69ddb48a90177c814dd538b29c0b73f95aef80ba42952e7ef1",
		streams: ["playlists", "saved_tracks", "top_artists", "recently_played"],
	},
} as const;

export type ApiProfileKey = keyof typeof API_PROFILES;

const INSTANCE = (key: string) => `cin_${key}_legacy`;

export interface ApiProfileRun {
	readonly byStream: Record<string, number>;
	readonly carddavRequests: Row[];
	readonly events: Row[];
	readonly facts: Row;
	readonly manifestStreams: string[];
	readonly shimLog: Row[];
	readonly state: Row;
}

function jsonl(path: string): Row[] {
	try {
		return readFileSync(path, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as Row);
	} catch {
		return [];
	}
}

export async function runApiProfile(
	backend: LegacyBackend,
	key: ApiProfileKey,
	databaseUrl?: string,
): Promise<ApiProfileRun> {
	const profile = API_PROFILES[key];
	const dir = scratchDir();
	mkdirSync(dir, { recursive: true });
	const manifest = legacyManifest(key) as { streams: { name: string }[] };

	// The local-source layout: <root>/profile/collection-profile.json + <root>/dist/collection-profile.mjs.
	const code = gunzipSync(readFileSync(join(PROFILES, profile.bundle)));
	assert.equal(
		createHash("sha256").update(code).digest("hex"),
		profile.sha256,
		`${profile.bundle} matches its pinned hash`,
	);
	const root = join(dir, "source");
	mkdirSync(join(root, "profile"), { recursive: true });
	mkdirSync(join(root, "dist"), { recursive: true });
	writeFileSync(
		join(root, "profile", "collection-profile.json"),
		JSON.stringify(manifest),
	);
	writeFileSync(join(root, "dist", "collection-profile.mjs"), code);

	const saved = new Map<string, string | undefined>();
	const setEnv = (name: string, value: string) => {
		if (!saved.has(name)) {
			saved.set(name, process.env[name]);
		}
		process.env[name] = value;
	};
	const dataDir = join(dir, "data");
	setEnv("PDPP_DATA_DIR", dataDir);
	setEnv("PDPP_CONNECTOR_ARTIFACT_ROOT", join(dir, "artifacts"));
	setEnv("TMPDIR", dir);
	const mock = key === "apple_contacts" ? await startCardDavMock() : null;
	const credentials: Record<string, string> = {
		apple_contacts: {
			APPLE_ID: "tester@example.test",
			APPLE_APP_SPECIFIC_PASSWORD: "abcd-efgh-ijkl-mnop",
			APPLE_CARDDAV_ORIGIN: mock?.origin ?? "",
		},
		github: {
			GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_fixture0000000000000000000000000000",
		},
		spotify: { SPOTIFY_ACCESS_TOKEN: "fixture-spotify-token" },
	}[key] as Record<string, string>;
	const handler =
		"handler" in profile
			? pathToFileURL(join(PROFILES, profile.handler)).href
			: "";
	const localStore = createFileLocalConnectorSourceStore(dataDir);
	const installStore = createFileConnectorInstallStore(dataDir);
	const service = createConnectorInstallService({
		catalogLoader: async () => [],
		dataDir,
		localSourceStore: localStore,
		registerManifest: registerConnector as never,
		store: installStore,
	});
	try {
		let run!: ApiProfileRun;
		await withLegacyServer(
			{
				backend,
				databaseUrl,
				serverOptions: {
					connectionScopedRunEnvResolver: () => ({
						...credentials,
						NODE_OPTIONS: `--import=${pathToFileURL(join(PROFILES, "http-fixture-shim.mjs")).href}`,
						...(handler ? { NET_SHIM_HANDLER: handler } : {}),
					}),
					connectorPathResolver: (
						connectorId: string,
						resolvedManifest?: Record<string, unknown>,
					) =>
						resolveActiveInstallFirstConnectorPath(
							connectorId,
							resolvedManifest as never,
							undefined,
							localStore,
							installStore,
						),
					preRegisteredPublicClients: TEST_PRE_REGISTERED_PUBLIC_CLIENTS,
					startClientEventDeliveryWorker: false,
				},
				service,
			},
			async (urls) => {
				const owner = {
					Authorization: `Bearer ${urls.ownerToken}`,
					"Content-Type": "application/json",
				};
				await seedLegacyRegistration(
					backend,
					urls,
					key,
					[{ id: INSTANCE(key), status: "active" }],
					profile.streams[0],
				);
				const added = await fetchJson(
					`${urls.rsUrl}/v1/owner/connector-install/local-sources/add`,
					{
						body: JSON.stringify({ source_path: root }),
						headers: owner,
						method: "POST",
					},
				);
				assert.equal(added.status, 201, JSON.stringify(added.body));
				assert.equal(
					added.body.data.connector_key,
					key,
					"the source is keyed by the stored id",
				);
				const selected = await fetchJson(
					`${urls.rsUrl}/v1/owner/connector-install/local-sources/select`,
					{
						body: JSON.stringify({
							connector_key: key,
							source_id: added.body.data.source_id,
						}),
						headers: owner,
						method: "POST",
					},
				);
				assert.equal(selected.status, 200, JSON.stringify(selected.body));

				const started = await fetchJson(
					`${urls.asUrl}/_ref/connections/${INSTANCE(key)}/run`,
					{ method: "POST" },
				);
				assert.equal(started.status, 202, JSON.stringify(started.body));
				const runId = started.body.run_id as string;
				let timeline: Row = {};
				const deadline = Date.now() + 90_000;
				while (Date.now() < deadline) {
					timeline = (
						await fetchJson(
							`${urls.asUrl}/_ref/runs/${encodeURIComponent(runId)}/timeline`,
						)
					).body as Row;
					if (timeline.terminal_status) {
						break;
					}
					await new Promise((resolve) => setTimeout(resolve, 200));
				}
				const events = (timeline.data ?? []) as Row[];
				const terminal = (events.at(-1)?.data ?? {}) as Row;
				const rows = await backend.query(
					"SELECT stream, COUNT(*) AS n FROM records WHERE connector_id = ? AND connector_instance_id = ? GROUP BY stream ORDER BY stream",
					[key, INSTANCE(key)],
				);
				const state = await fetchJson(
					`${urls.rsUrl}/v1/state/${key}?connector_instance_id=${INSTANCE(key)}`,
					{ headers: owner },
				);
				run = {
					byStream: Object.fromEntries(
						rows.map((row) => [String(row.stream), Number(row.n)]),
					),
					carddavRequests: mock?.requests ?? [],
					events: events
						.filter(
							(event) =>
								event.event_type !== "run.progress_reported" ||
								process.env.LEGACY_PROFILE_VERBOSE,
						)
						.map((event) => ({
							data: {
								message: (event.data as Row).message,
								reason: (event.data as Row).reason,
								failure_message: (event.data as Row).failure_message,
								diagnostics: (event.data as Row).diagnostics,
							},
							stream: event.stream_id,
							type: event.event_type,
						})),
					facts: {
						failure_message: terminal.failure_message,
						reason: terminal.reason,
						records_accepted: terminal.records_accepted,
						skipped: events
							.filter((event) => String(event.event_type).includes("skip"))
							.map((event) => event.stream_id),
						terminal_status: timeline.terminal_status,
					},
					manifestStreams: manifest.streams.map((stream) => stream.name),
					shimLog: jsonl(join(dir, "net-shim.jsonl")),
					state: state.body.state as Row,
				};
			},
		);
		return run;
	} finally {
		await mock?.close();
		for (const [name, value] of saved) {
			if (value === undefined) {
				delete process.env[name];
			} else {
				process.env[name] = value;
			}
		}
		rmSync(dir, { force: true, recursive: true });
	}
}
