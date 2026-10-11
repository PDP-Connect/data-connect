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

/** Sparse responses retain required fields without widening a frozen grant. */
export function resolveResponseProjectionFields(
  value: unknown,
  requiredFields: readonly string[],
  authorizedFields: readonly string[] | null = null
): string[] | null {
  const requestedFields = normalizeProjectionFields(value);
  let fields = authorizedFields === null ? requestedFields : [...authorizedFields];
  if (requestedFields && authorizedFields !== null) {
    fields = requestedFields.filter((field) => authorizedFields.includes(field));
  }
  if (fields === null) {
    return null;
  }
  const required = requiredFields.filter((field) => authorizedFields === null || authorizedFields.includes(field));
  return [...new Set([...required, ...fields])];
}

export function projectRecordEnvelope<T extends Record<string, unknown>>(
  record: T,
  fields: readonly string[] | null | undefined
): T {
  if (!fields || fields.length === 0) {
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

function projectObject(source: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    if (Object.hasOwn(source, field)) {
      out[field] = source[field];
    }
  }
  return out;
}
