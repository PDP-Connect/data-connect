// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Wire shape of a record by token kind (Core "Response records" and Section 4).
 *
 * A non-owner response (`client`, or the grant-bound `mcp_package`) MUST NOT
 * include `emitted_at`. A non-owner tombstone keeps only the Core members
 * `{object, id, instance_id, stream, deleted}`; `instance_id` is kept only
 * when the stored record has one. Owner responses are returned unchanged.
 * The stored RECORD envelope keeps `emitted_at`.
 */

export interface WireShapeToken {
  readonly pdpp_token_kind?: string | null | undefined;
}

const CLIENT_TOMBSTONE_MEMBERS = new Set(["object", "id", "instance_id", "stream", "deleted"]);

function shapeRecord(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  if (record.object !== "record") {
    return value;
  }
  if (record.deleted === true) {
    return Object.fromEntries(Object.entries(record).filter(([key]) => CLIENT_TOMBSTONE_MEMBERS.has(key)));
  }
  return Object.fromEntries(Object.entries(record).filter(([key]) => key !== "emitted_at"));
}

export function withTokenKindRecordShape(body: unknown, token: WireShapeToken): unknown {
  if (token.pdpp_token_kind === "owner" || !body || typeof body !== "object" || Array.isArray(body)) {
    return body;
  }
  const payload = body as Record<string, unknown>;
  if (payload.object === "record") {
    return shapeRecord(payload);
  }
  if (Array.isArray(payload.data)) {
    return { ...payload, data: payload.data.map(shapeRecord) };
  }
  return payload;
}
