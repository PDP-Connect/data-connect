// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import { equalJsonValues } from "./experimental-record-updates.ts";
import { currentStorageGeneration } from "./storage-generation.ts";

// Prototype only: retain serialized authorized snapshots, independent of history
// pruning. Sessions do not survive a process restart or a storage lifecycle change.
export const BOOTSTRAP_MAX_RECORDS = 10_000;
const MAX_SESSIONS = 32;
const MAX_BYTES = 32 * 1024 * 1024;
const SESSION_TTL_MS = 5 * 60 * 1000;
interface Session {
	bytes: number;
	changesCursor: string;
	context: string;
	expiresAt: number;
	generation: number;
	records: string[];
	baseline: Map<string, string>;
}
export interface BootstrapSnapshot<T extends { id: string }> {
	record: T;
	eligibility: unknown;
}
interface BootstrapPage<T> extends Record<string, unknown> {
	object: "list";
	data: T[];
	has_more: boolean;
	next_cursor?: string;
	next_changes_since?: string;
}
interface BootstrapCursor {
	kind?: unknown;
	session?: unknown;
	bootstrap_session?: unknown;
	bootstrap_offset?: unknown;
}
const sessions = new Map<string, Session>();

function bootstrapError(
	code: string,
	message: string,
): Error & { code: string } {
	return Object.assign(new Error(message), { code });
}

function pruneSessions(): void {
	for (const [id, session] of sessions) {
		if (
			session.expiresAt <= Date.now() ||
			session.generation !== currentStorageGeneration()
		) {
			sessions.delete(id);
		}
	}
}

function page<T>(
	id: string,
	session: Session,
	offset: number,
	limit: number,
): BootstrapPage<T> {
	const end = Math.min(offset + limit, session.records.length);
	const hasMore = end < session.records.length;
	return {
		object: "list",
		data: session.records
			.slice(offset, end)
			.map((record) => JSON.parse(record) as T),
		has_more: hasMore,
		...(hasMore
			? {
					next_cursor: Buffer.from(
						JSON.stringify({
							kind: "page",
							session: "changes",
							bootstrap_session: id,
							bootstrap_offset: end,
						}),
					).toString("base64url"),
				}
			: { next_changes_since: session.changesCursor }),
	};
}

function retainedSession(cursor: string, context: string): Session {
	pruneSessions();
	let decoded: Record<string, unknown>;
	try {
		decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
	} catch {
		throw bootstrapError(
			"invalid_cursor",
			"Malformed retained bootstrap token",
		);
	}
	const session =
		typeof decoded.bootstrap_baseline === "string"
			? sessions.get(decoded.bootstrap_baseline)
			: null;
	if (!session)
		throw bootstrapError(
			"cursor_expired",
			"Experimental sync baseline expired; restart from beginning",
		);
	if (session.context !== context || session.changesCursor !== cursor) {
		throw bootstrapError(
			"invalid_cursor",
			"Experimental sync token does not match this query context",
		);
	}
	return session;
}

export function retainedBootstrapRecordIds(
	cursor: string,
	context: string,
): string[] {
	return [...retainedSession(cursor, context).baseline.keys()];
}

export function startBootstrapPage<T extends { id: string }>({
	context,
	records,
	changesCursor,
	limit,
	sinceCursor,
	removedRecords = [],
	order = "ASC",
}: {
	context: string;
	records: Iterable<BootstrapSnapshot<T>>;
	changesCursor: string;
	limit: number;
	sinceCursor?: string;
	removedRecords?: Iterable<T>;
	order?: "ASC" | "DESC";
}): BootstrapPage<T> {
	pruneSessions();
	const previous = sinceCursor ? retainedSession(sinceCursor, context) : null;
	const baseline = new Map<string, string>();
	const serialized: string[] = [];
	let bytes = 0;
	for (const snapshot of records) {
		const value = JSON.stringify(snapshot);
		baseline.set(snapshot.record.id, value);
		bytes += Buffer.byteLength(value);
		if (baseline.size > BOOTSTRAP_MAX_RECORDS || bytes > MAX_BYTES) {
			throw bootstrapError(
				"bootstrap_capacity_exceeded",
				"Experimental bootstrap snapshot exceeds its record or byte limit",
			);
		}
		const prior = previous?.baseline.get(snapshot.record.id);
		if (
			!prior ||
			!equalJsonValues(JSON.parse(prior).eligibility, snapshot.eligibility)
		) {
			serialized.push(JSON.stringify(snapshot.record));
		}
	}
	if (previous) {
		const removed = new Map(
			[...removedRecords].map((record) => [record.id, record]),
		);
		for (const id of previous.baseline.keys()) {
			if (baseline.has(id)) continue;
			const record = removed.get(id);
			if (!record)
				throw bootstrapError(
					"cursor_expired",
					"Experimental sync deletion baseline cannot be resolved",
				);
			serialized.push(JSON.stringify(record));
		}
	}
	bytes += serialized.reduce(
		(total, value) => total + Buffer.byteLength(value),
		0,
	);
	const orderedRecords = serialized.map((record) => ({
		id: (JSON.parse(record) as T).id,
		record,
	}));
	orderedRecords.sort((left, right) => {
		const comparison = left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
		return order === "DESC" ? -comparison : comparison;
	});
	const id = randomUUID();
	const token = JSON.parse(
		Buffer.from(changesCursor, "base64url").toString("utf8"),
	);
	const session: Session = {
		bytes,
		context,
		changesCursor: Buffer.from(
			JSON.stringify({ ...token, bootstrap_baseline: id }),
		).toString("base64url"),
		records: orderedRecords.map((entry) => entry.record),
		baseline,
		expiresAt: Date.now() + SESSION_TTL_MS,
		generation: currentStorageGeneration(),
	};
	const retainedBytes = [...sessions.values()].reduce(
		(total, existing) => total + existing.bytes,
		0,
	);
	if (sessions.size >= MAX_SESSIONS || retainedBytes + bytes > MAX_BYTES) {
		throw bootstrapError(
			"bootstrap_capacity_exceeded",
			"Experimental bootstrap session capacity is exhausted",
		);
	}
	sessions.set(id, session);
	return page<T>(id, session, 0, limit);
}

export function continueBootstrapPage<T>(
	cursor: BootstrapCursor,
	context: string,
	limit: number,
): BootstrapPage<T> {
	pruneSessions();
	const id = cursor.bootstrap_session;
	const offset = cursor.bootstrap_offset;
	if (
		cursor.kind !== "page" ||
		cursor.session !== "changes" ||
		typeof id !== "string" ||
		typeof offset !== "number" ||
		!Number.isInteger(offset) ||
		offset < 0
	) {
		throw bootstrapError(
			"invalid_cursor",
			"Malformed experimental bootstrap cursor",
		);
	}
	const session = sessions.get(id);
	if (!session) {
		throw bootstrapError(
			"cursor_expired",
			"Experimental bootstrap session expired; restart from beginning",
		);
	}
	if (session.context !== context || offset > session.records.length) {
		throw bootstrapError(
			"invalid_cursor",
			"Experimental bootstrap cursor does not match this query context",
		);
	}
	return page<T>(id, session, offset, limit);
}
