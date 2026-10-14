// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Executes the COMPILED Slack connector profiles through the real runtime as a
 * developer-local source keyed `slack`, against a legacy-upgraded registration,
 * with no network.
 *
 * What is real: the connector bundles (esbuild of data-connectors sources, see
 * fixtures/legacy-profiles/build-local-source.mjs), the local-source add/select
 * routes, the controller run path and child process, the connector protocol,
 * ingest, state, owner reads, and PAR/consent-issued client grants.
 *
 * What is replaced, and why:
 * - slackdump: `slackdump-stub.mjs`, which replays a CONSTRUCTED archive (there is no
 *   recorded real slackdump archive in data-connectors).
 * - slack.com Web API: the connector hard-codes `https://slack.com/api/`, so the base
 *   URL cannot be redirected to a local mock. `child-net-shim.mjs` (NODE_OPTIONS preload
 *   in the connector child only) answers those four methods with constructed fixtures
 *   and refuses every other non-loopback connection.
 * - Credentials: syntactically valid fakes, supplied through the connection-scoped run
 *   env resolver.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	copyFileSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

import { resolveActiveInstallFirstConnectorPath } from "../../runtime/controller.ts";
import {
	createConnectorInstallService,
	createFileConnectorInstallStore,
} from "../../server/connector-install/index.ts";
import { createFileLocalConnectorSourceStore } from "../../server/connector-install/local-source.ts";
import { TEST_PRE_REGISTERED_PUBLIC_CLIENTS } from "../fixtures/demo-clients.ts";
import {
	fetchJson,
	type LegacyBackend,
	type LegacyUrls,
	type Row,
} from "./legacy-upgrade.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
export const SLACK_PROFILE_FIXTURES = join(
	HERE,
	"..",
	"fixtures",
	"legacy-profiles",
	"slack",
);
const UPGRADE_FIXTURES = join(HERE, "..", "fixtures", "legacy-upgrade");

/** Pinned compiled bundles: sha256 of the decompressed `dist/collection-profile.mjs`. */
export const SLACK_BUNDLES = {
	legacy: {
		// data-connectors 97536ad49: its slack manifest is byte-identical to fixtures/legacy-upgrade/slack.json
		// (0.6.0), so this is the emitter that matches the legacy registration.
		file: "slack-0.6.0-97536ad49.collection-profile.mjs.gz",
		manifest: "slack.json",
		sha256: "75022d8fd3b0ace2ef4bb7a4698bfbc876d17b5328ed713916f64ed5cabe34c2",
	},
	v071: {
		// data-connectors 861be44d48 (origin/main at build time, descends from 2afb7109), manifest 0.7.1.
		file: "slack-0.7.1-861be44d48.collection-profile.mjs.gz",
		manifest: "slack-0.7.1.json",
		sha256: "d1be528ba5a175e1a0cfb9b4d9afe9b89e18fa891364536ef5e1698edc86a968",
	},
} as const;

export const SLACK_INSTANCE = "cin_slack_legacy";
export const FAKE_CREDENTIALS = {
	SLACK_COOKIE: "xoxd-0000000000000000000000000000fake",
	SLACK_TOKEN: "xoxc-0000000000-0000000000-0000000000-0000000000000000fake",
	SLACK_WORKSPACE: "acme",
} as const;

export type SourceKind = keyof typeof SLACK_BUNDLES;

/**
 * Lays out `<parent>/slack/{profile,dist}` and `<parent>/config/slackdump-api-config.toml`.
 * The bundle resolves `new URL("../../config/slackdump-api-config.toml", import.meta.url)` to
 * the latter, i.e. a `config` directory beside the source root.
 */
export function materializeSlackSource(
	parent: string,
	kind: SourceKind,
): string {
	const bundle = SLACK_BUNDLES[kind];
	const code = gunzipSync(
		readFileSync(join(SLACK_PROFILE_FIXTURES, bundle.file)),
	);
	assert.equal(
		createHash("sha256").update(code).digest("hex"),
		bundle.sha256,
		`${bundle.file} matches its pinned hash`,
	);
	const root = join(parent, "slack");
	mkdirSync(join(root, "profile"), { recursive: true });
	mkdirSync(join(root, "dist"), { recursive: true });
	mkdirSync(join(parent, "config"), { recursive: true });
	copyFileSync(
		join(UPGRADE_FIXTURES, bundle.manifest),
		join(root, "profile", "collection-profile.json"),
	);
	writeFileSync(join(root, "dist", "collection-profile.mjs"), code);
	copyFileSync(
		join(SLACK_PROFILE_FIXTURES, "slackdump-api-config.toml"),
		join(parent, "config", "slackdump-api-config.toml"),
	);
	return root;
}

export interface SlackRunHarness {
	readonly dir: string;
	readonly localStore: ReturnType<typeof createFileLocalConnectorSourceStore>;
	readonly serverOptions: Record<string, unknown>;
	readonly service: ReturnType<typeof createConnectorInstallService>;
	restore(): void;
	setNetMode(mode: "deny" | "fixture"): void;
	stubLog(): Row[];
	shimLog(): Row[];
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

/** Process-env and server options that route a run through the stub and the shim. */
export function createSlackRunHarness(
	dir: string,
	registerManifest: (manifest: Row) => Promise<unknown>,
): SlackRunHarness {
	const dataDir = join(dir, "data");
	const artifactRoot = join(dir, "artifacts");
	mkdirSync(artifactRoot, { recursive: true });
	const saved = new Map<string, string | undefined>();
	const setEnv = (key: string, value: string) => {
		if (!saved.has(key)) {
			saved.set(key, process.env[key]);
		}
		process.env[key] = value;
	};
	setEnv("PDPP_DATA_DIR", dataDir);
	setEnv("PDPP_CONNECTOR_ARTIFACT_ROOT", artifactRoot);
	setEnv("SLACKDUMP_BIN", join(SLACK_PROFILE_FIXTURES, "slackdump-stub.mjs"));
	setEnv("TMPDIR", dir);
	rmSync(join(dir, "slackdump-stub.jsonl"), { force: true });
	rmSync(join(dir, "slack-net-shim.jsonl"), { force: true });
	let netMode: "deny" | "fixture" = "fixture";
	const localStore = createFileLocalConnectorSourceStore(dataDir);
	const installStore = createFileConnectorInstallStore(dataDir);
	const service = createConnectorInstallService({
		catalogLoader: async () => [],
		dataDir,
		localSourceStore: localStore,
		registerManifest: registerManifest as never,
		store: installStore,
	});
	const serverOptions = {
		connectionScopedRunEnvResolver: () => ({
			...FAKE_CREDENTIALS,
			NET_SHIM_MODE: netMode,
			NODE_OPTIONS: `--import=${pathToFileURL(join(SLACK_PROFILE_FIXTURES, "child-net-shim.mjs")).href}`,
		}),
		connectorPathResolver: (
			connectorId: string,
			manifest?: Record<string, unknown>,
		) =>
			resolveActiveInstallFirstConnectorPath(
				connectorId,
				manifest as never,
				undefined,
				localStore,
				installStore,
			),
		preRegisteredPublicClients: TEST_PRE_REGISTERED_PUBLIC_CLIENTS,
		startClientEventDeliveryWorker: false,
	};
	return {
		dir,
		localStore,
		restore() {
			for (const [key, value] of saved) {
				if (value === undefined) {
					delete process.env[key];
				} else {
					process.env[key] = value;
				}
			}
		},
		serverOptions,
		service,
		setNetMode(mode) {
			netMode = mode;
		},
		shimLog: () => jsonl(join(dir, "slack-net-shim.jsonl")),
		stubLog: () => jsonl(join(dir, "slackdump-stub.jsonl")),
	};
}

export function ownerHeaders(urls: LegacyUrls): Record<string, string> {
	return { Authorization: `Bearer ${urls.ownerToken}` };
}

/** add + select a developer-local source under the stored key `slack`. */
export async function addAndSelectSlackSource(
	urls: LegacyUrls,
	sourceRoot: string,
): Promise<Row> {
	const owner = { ...ownerHeaders(urls), "Content-Type": "application/json" };
	const added = await fetchJson(
		`${urls.rsUrl}/v1/owner/connector-install/local-sources/add`,
		{
			body: JSON.stringify({ source_path: sourceRoot }),
			headers: owner,
			method: "POST",
		},
	);
	assert.equal(added.status, 201, JSON.stringify(added.body));
	assert.equal(added.body.data.connector_key, "slack");
	const selected = await fetchJson(
		`${urls.rsUrl}/v1/owner/connector-install/local-sources/select`,
		{
			body: JSON.stringify({
				connector_key: "slack",
				source_id: added.body.data.source_id,
			}),
			headers: owner,
			method: "POST",
		},
	);
	assert.equal(selected.status, 200, JSON.stringify(selected.body));
	return added.body.data as Row;
}

export interface RunOutcome {
	readonly runId: string;
	readonly timeline: Row;
}

export async function runSlackSync(urls: LegacyUrls): Promise<RunOutcome> {
	const started = await fetchJson(
		`${urls.asUrl}/_ref/connections/${SLACK_INSTANCE}/run`,
		{ method: "POST" },
	);
	assert.equal(started.status, 202, JSON.stringify(started.body));
	const runId = started.body.run_id as string;
	const deadline = Date.now() + 90_000;
	while (Date.now() < deadline) {
		const timeline = await fetchJson(
			`${urls.asUrl}/_ref/runs/${encodeURIComponent(runId)}/timeline`,
		);
		if (timeline.body?.terminal_status) {
			return { runId, timeline: timeline.body as Row };
		}
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	throw new Error(`Timed out waiting for run ${runId}`);
}

export async function readStream(
	urls: LegacyUrls,
	stream: string,
	token: string = urls.ownerToken,
	query = "",
): Promise<{
	body: { data?: Row[]; error?: { code?: string; message?: string } };
	status: number;
}> {
	return fetchJson(
		`${urls.rsUrl}/v1/streams/${stream}/records?connector_id=slack&connector_instance_id=${SLACK_INSTANCE}&limit=200${query}`,
		{ headers: { Authorization: `Bearer ${token}` } },
	);
}

export async function readState(urls: LegacyUrls): Promise<Row> {
	const state = await fetchJson(
		`${urls.rsUrl}/v1/state/slack?connector_instance_id=${SLACK_INSTANCE}`,
		{
			headers: ownerHeaders(urls),
		},
	);
	assert.equal(state.status, 200, JSON.stringify(state.body));
	return state.body as Row;
}

export async function seedLegacySlackRegistration(
	backend: LegacyBackend,
	legacyManifestJson: string,
): Promise<void> {
	await backend.insertConnector("slack", legacyManifestJson);
	await backend.instanceStore().upsert({
		connectorId: "slack",
		connectorInstanceId: SLACK_INSTANCE,
		createdAt: "2026-05-18T12:00:00.000Z",
		displayName: "Legacy Slack",
		ownerSubjectId: "owner_local",
		sourceBinding: { account_hint: "legacy" },
		sourceBindingKey: "legacy",
		sourceKind: "account",
		updatedAt: "2026-05-18T12:00:00.000Z",
	});
}

/** PAR -> consent review -> approve: the path the client-grant tests use. Returns the issued token. */
export async function mintClientGrant(
	urls: LegacyUrls,
	stream: string,
	fields: readonly string[],
): Promise<{ grant: Row; token: string }> {
	const clientId = "concert_recommendation_app";
	const initiated = await fetchJson(`${urls.asUrl}/oauth/par`, {
		body: JSON.stringify({
			authorization_details: [
				{
					access_mode: "continuous",
					purpose_code: "https://pdpp.dev/purpose/legacy-profile-test",
					source: {
						id: "https://registry.pdpp.dev/connectors/slack",
						kind: "connector",
					},
					streams: [{ fields, name: stream }],
					type: "https://pdpp.dev/data-access",
				},
			],
			client_id: clientId,
		}),
		headers: { "Content-Type": "application/json" },
		method: "POST",
	});
	assert.equal(initiated.status, 201, JSON.stringify(initiated.body));
	const review = await fetchJson(`${urls.asUrl}/consent/review`, {
		body: JSON.stringify({
			request_uri: initiated.body.request_uri,
			subject_id: "owner_local",
		}),
		headers: { Accept: "application/json", "Content-Type": "application/json" },
		method: "POST",
	});
	assert.equal(review.status, 200, JSON.stringify(review.body));
	const approved = await fetchJson(`${urls.asUrl}/consent/approve`, {
		body: JSON.stringify({
			approval_review_revision: review.body.approval_review_revision,
			request_uri: initiated.body.request_uri,
		}),
		headers: { Accept: "application/json", "Content-Type": "application/json" },
		method: "POST",
	});
	assert.equal(approved.status, 200, JSON.stringify(approved.body));
	assert.ok(approved.body.token, "approval issues a client token");
	return {
		grant: approved.body.grant as Row,
		token: approved.body.token as string,
	};
}

export const SLACK_STREAMS = [
	"workspace",
	"channels",
	"channel_stats",
	"channel_memberships",
	"users",
	"messages",
	"message_attachments",
	"reactions",
	"files",
	"canvases",
	"stars",
	"user_groups",
	"reminders",
	"dm_read_states",
] as const;

export function scratchDir(): string {
	return join(
		tmpdir(),
		`pdpp-legacy-profile-slack-${process.pid}-${Date.now()}`,
	);
}
