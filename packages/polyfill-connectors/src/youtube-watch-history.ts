// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared parser for the Google Takeout "YouTube and YouTube Music" watch
 * history export (watch-history.json). Two connectors read the exact same
 * file format for the exact same reason to change: `google_takeout`, which
 * reads it as one stream among several inside a general Takeout archive,
 * and `youtube`, which reads it as its own dedicated manual import (D9 in
 * docs/migration/connector-cutover/CONTRACTS.md). A change to Google's
 * export shape is one edit here, not two connectors drifting independently.
 *
 * Moved out of connectors/google_takeout/parsers.ts (see git history for
 * the pre-extraction version) with behavior preserved exactly: same hash
 * derivation, same field mapping, same null-on-missing-timestamp rule.
 */

import { createHash } from "node:crypto";

// Length of sha256-derived record IDs — 24 hex chars = 96 bits of entropy.
const RECORD_ID_HASH_LENGTH = 24;

export interface WatchHistoryEntry {
	subtitles?: Array<{ name?: string; url?: string }>;
	time?: string;
	title?: string;
	titleUrl?: string;
}

export interface WatchHistoryRecord {
	channel_name: string | null;
	channel_url: string | null;
	id: string;
	video_title: string | null;
	video_url: string | null;
	watched_at: string;
}

export function hashWatchHistoryId(s: string): string {
	return createHash("sha256")
		.update(s)
		.digest("hex")
		.slice(0, RECORD_ID_HASH_LENGTH);
}

/**
 * Build a youtube_watch_history record from a raw WatchHistoryEntry. Returns
 * null if the entry is missing a timestamp — Takeout entries for removed
 * videos sometimes carry only a title, and a record with no `watched_at`
 * has nothing to cursor on.
 */
export function buildWatchHistoryRecord(
	e: WatchHistoryEntry,
): WatchHistoryRecord | null {
	const ts = e.time || null;
	if (!ts) {
		return null;
	}
	const videoUrl = e.titleUrl || null;
	const channelUrl = e.subtitles?.[0]?.url || null;
	return {
		id: hashWatchHistoryId(`yt|${ts}|${videoUrl || e.title}`),
		watched_at: ts,
		video_url: videoUrl,
		video_title: e.title || null,
		channel_name: e.subtitles?.[0]?.name || null,
		channel_url: channelUrl,
	};
}
