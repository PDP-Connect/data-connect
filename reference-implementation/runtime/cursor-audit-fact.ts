// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Compact, bounded audit fact for a connector cursor.
 *
 * `run.state_staged`, `run.state_advanced` and `run.state_commit_failed` spine
 * events used to embed the full connector cursor (`data.cursor`). Cursors can reach
 * megabytes, so the append-only spine grew without bound (issue #76). The
 * spine is an audit record, not the state store: the authoritative cursor is
 * persisted through `PUT /v1/state/<connector>` and read back from there, never
 * from spine events. These events therefore record only a digest and a size,
 * which still lets an auditor tell "same cursor" from "different cursor" and
 * see its magnitude.
 *
 * An absent cursor and a `null` cursor produce the same fact; the event does
 * not distinguish them. Input is parsed JSON, so boxed primitives and other
 * non-JSON values are not expected.
 *
 * Old events (full `cursor`) remain in storage. Readers must tolerate both
 * shapes: `cursor` present (legacy) or `cursor_sha256` + `cursor_bytes`.
 */
import { createHash } from "node:crypto";

export interface CursorAuditFact {
  /** UTF-8 byte length of the canonical JSON serialization of the cursor. */
  readonly cursor_bytes: number;
  /** Lowercase hex SHA-256 of the canonical JSON serialization of the cursor. */
  readonly cursor_sha256: string;
}

/**
 * `JSON.stringify` semantics with object keys sorted at every depth. Built by
 * serializing sorted entries directly rather than copying into a new object:
 * assigning `sorted["__proto__"] = ...` on a plain object calls the prototype
 * setter and silently drops that own key, which would make two distinct
 * cursors hash alike. Returns `undefined` for values JSON omits.
 */
function stringifySorted(input: unknown): string | undefined {
  const value =
    input !== null && typeof input === "object" && typeof (input as { toJSON?: unknown }).toJSON === "function"
      ? (input as { toJSON: () => unknown }).toJSON()
      : input;
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((element) => stringifySorted(element) ?? "null").join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const members: string[] = [];
  for (const key of Object.keys(record).sort()) {
    const member = stringifySorted(record[key]);
    if (member !== undefined) {
      members.push(`${JSON.stringify(key)}:${member}`);
    }
  }
  return `{${members.join(",")}}`;
}

/**
 * Stable JSON: object keys sorted at every depth, every own key preserved
 * (including `__proto__`), otherwise `JSON.stringify` semantics. A value JSON
 * cannot represent (`undefined`, function) serializes as `null` so the digest
 * is always defined.
 */
export function canonicalCursorJson(cursor: unknown): string {
  return stringifySorted(cursor) ?? "null";
}

export function cursorAuditFact(cursor: unknown): CursorAuditFact {
  const serialized = canonicalCursorJson(cursor);
  return {
    cursor_bytes: Buffer.byteLength(serialized, "utf8"),
    cursor_sha256: createHash("sha256").update(serialized, "utf8").digest("hex"),
  };
}
