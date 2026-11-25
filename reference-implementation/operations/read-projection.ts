// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

export function normalizeProjectionFields(value: unknown): string[] | null {
  // biome-ignore lint/style/noNestedTernary: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const fields = raw
    .flatMap((entry) => String(entry).split(","))
    .map((entry) => entry.trim())
    .filter(Boolean);
  return fields.length > 0 ? [...new Set(fields)] : null;
}

/**
 * spec-core §8 `fields`: "Schema-required fields are always included." An
 * owner read consults current serving metadata, so the current schema's
 * required list joins any sparse projection. A client grant froze its field
 * set at issuance (spec-core §7) and does not record which of those fields
 * were required then, so a client projection never gains fields from the
 * current schema. A null projection (full read) stays null.
 */
export function withOwnerRequiredFields(
  fields: string[] | null,
  actorKind: "owner" | "client",
  schemaRequired: unknown
): string[] | null {
  if (fields === null || actorKind !== "owner" || !Array.isArray(schemaRequired)) {
    return fields;
  }
  const required = schemaRequired.filter((field): field is string => typeof field === "string");
  return [...new Set([...fields, ...required])];
}

export function projectRecordEnvelope<T extends Record<string, unknown>>(
  record: T,
  fields: readonly string[] | null | undefined
): T {
  if (!fields || fields.length === 0) {
    return record;
  }
  // spec-core §4 "Tombstones": a tombstone is the record envelope with
  // `deleted: true` and no `data`. Sparse fields select data fields, so a
  // tombstone has nothing to project and its envelope must stay whole.
  if (isTombstone(record)) {
    return record;
  }
  if (record.data && typeof record.data === "object" && !Array.isArray(record.data)) {
    return {
      ...record,
      data: projectObject(record.data as Record<string, unknown>, fields),
    };
  }
  return projectObject(record, fields) as T;
}

// Blob-ref decoration can leave an own `data: undefined` key on a tombstone,
// which JSON serialization drops; test the value, not key presence.
function isTombstone(record: Record<string, unknown>): boolean {
  return record.object === "record" && record.deleted === true && record.data === undefined;
}

function projectObject(source: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    if (Object.hasOwn(source, field)) {
      out[field] = source[field];
    }
  }
  return out;
}
