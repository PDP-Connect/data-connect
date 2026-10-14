// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * apple_contacts, spotify and github, built from data-connectors 97536ad49 in the developer-local
 * source layout, added and selected under their stored keys, and run through the real controller
 * against a legacy registration with no network. See helpers/legacy-profile-api.ts.
 */

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import test from "node:test";

import {
	API_PROFILES,
	type ApiProfileKey,
	runApiProfile,
} from "./helpers/legacy-profile-api.ts";
import { sqliteBackend } from "./helpers/legacy-upgrade.ts";

function record(key: string, run: unknown) {
	if (process.env.LEGACY_PROFILE_EVIDENCE_FILE) {
		writeFileSync(
			`${process.env.LEGACY_PROFILE_EVIDENCE_FILE}.${key}.json`,
			`${JSON.stringify(run, null, 2)}\n`,
		);
	}
}

const EXPECTED_STATE: Record<ApiProfileKey, Record<string, true>> = {
	apple_contacts: { address_books: true, contact_groups: true, contacts: true },
	github: {
		gists: true,
		issues: true,
		pull_requests: true,
		repositories: true,
		starred: true,
		user: true,
		user_stats: true,
	},
	spotify: { playlists: true, recently_played: true, saved_tracks: true },
};

// Records the run added per manifest stream. The first stream also holds the one legacy record seeded before the run.
const EXPECTED_NEW_RECORDS: Record<ApiProfileKey, Record<string, number>> = {
	apple_contacts: { address_books: 1, contact_groups: 1, contacts: 2 },
	github: {
		gists: 1,
		issues: 1,
		pull_requests: 1,
		repositories: 2,
		starred: 1,
		user: 1,
		user_stats: 1,
	},
	spotify: {
		playlists: 2,
		recently_played: 2,
		saved_tracks: 2,
		top_artists: 6,
	},
};

for (const key of Object.keys(API_PROFILES) as ApiProfileKey[]) {
	test(`${key}: the built local source loads under its stored key and runs offline against fixtures`, {
		timeout: 120_000,
	}, async () => {
		const run = await runApiProfile(sqliteBackend, key);
		record(key, run);
		assert.equal(
			run.facts.terminal_status,
			"completed",
			JSON.stringify(run.facts),
		);
		assert.deepEqual(run.facts.skipped, [], "no stream skipped");
		assert.deepEqual(
			run.manifestStreams,
			API_PROFILES[key].streams,
			"profile manifest streams",
		);
		const [seeded] = API_PROFILES[key].streams;
		const added = Object.fromEntries(
			Object.entries(run.byStream).map(([stream, count]) => [
				stream,
				count - (stream === seeded ? 1 : 0),
			]),
		);
		assert.deepEqual(
			added,
			EXPECTED_NEW_RECORDS[key],
			"records per manifest stream",
		);
		assert.deepEqual(
			Object.keys(run.state).sort(),
			Object.keys(EXPECTED_STATE[key]).sort(),
			"state written per stream",
		);
		assert.deepEqual(
			run.shimLog.filter((entry) => entry.blocked),
			[],
			"nothing outside the fixtures was attempted",
		);
		if (key === "apple_contacts") {
			assert.deepEqual(
				run.carddavRequests.map(
					(request) => `${String(request.method)} ${String(request.path)}`,
				),
				[
					"PROPFIND /.well-known/carddav",
					"PROPFIND /principals/u1/",
					"PROPFIND /carddav/u1/",
					"REPORT /carddav/u1/card/",
				],
				"RFC 6764 discovery, address-book listing and one sync-collection REPORT against the loopback server",
			);
		}
	});
}
