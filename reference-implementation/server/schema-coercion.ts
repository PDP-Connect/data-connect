// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { invalidQueryError, parseIntegerValue } from "./record-expand-helpers.ts";

export interface FieldSchema {
  format?: string | null;
  type?: string | string[] | null;
  [key: string]: unknown;
}

interface ManifestStreamSchema {
  properties?: Record<string, FieldSchema> | null;
  required?: string[] | null;
  [key: string]: unknown;
}

interface ManifestStream {
  consent_time_field?: string | null;
  cursor_field?: string | null;
  name?: string | null;
  primary_key?: string | string[] | null;
  query?: unknown | null;
  relationships?: unknown[];
  schema?: ManifestStreamSchema | null;
  [key: string]: unknown;
}

export function getFieldSchema(manifestStream: ManifestStream | null | undefined, field: string): FieldSchema | null {
  return manifestStream?.schema?.properties?.[field] ?? null;
}

/**
 * JSON Schema allows `type` to be either a string (`"string"`) or an array
 * (`["string", "null"]`). For cursor-field parity checks and filter
 * validation/coercion we care about the underlying non-null type(s).
 * Returns a Set of type names with `"null"` stripped out. An empty set means
 * "type not declared". A size-1 set represents a cleanly-typed scalar
 * (possibly nullable); callers that need a single type should bail otherwise.
 */
export function nonNullSchemaTypes(schema: FieldSchema | null | undefined): Set<string> {
  const raw = schema?.type;
  if (raw === null) {
    return new Set();
  }
  const list = Array.isArray(raw) ? raw : [raw];
  return new Set(list.filter((type): type is string => typeof type === "string" && type !== "null"));
}

function parseNumberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseDateValue(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// Match the wire syntax before parsing. Validate the local date separately so
// an offset or a permissive parser cannot normalize an impossible day.
const STRICT_DATE = /^\d{4}-\d{2}-\d{2}(?![\s\S])/;
const STRICT_DATE_TIME = /^\d{4}-\d{2}-\d{2}[Tt](?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:[Zz]|[+-](?:[01]\d|2[0-3]):[0-5]\d)(?![\s\S])/;

function parseStrictDateValue(value: unknown, format: string): number | null {
  if (typeof value !== "string" || !(format === "date" ? STRICT_DATE : STRICT_DATE_TIME).test(value)) {
    return null;
  }
  const day = value.slice(0, 10);
  const midnight = Date.parse(day + "T00:00:00Z");
  if (!Number.isFinite(midnight) || new Date(midnight).toISOString().slice(0, 10) !== day) {
    return null;
  }
  return parseDateValue(value);
}

export function coerceComparableValue(
  value: unknown,
  fieldSchema: FieldSchema | null | undefined,
  { strict = false } = {}
): string | number | null {
  if (value === null) {
    return null;
  }

  // Branch on the non-null component of the declared type so that nullable
  // scalar schemas (`["integer", "null"]` etc.) coerce the same way as their
  // bare counterparts. An ambiguous `type` (e.g. `["string","integer"]`)
  // falls through to string coercion — that matches pre-nullable behavior
  // for any schema we wouldn't have accepted as range-queryable anyway.
  const types = nonNullSchemaTypes(fieldSchema);
  const only = types.size === 1 ? [...types][0] : null;

  if (only === "integer") {
    const parsed = parseIntegerValue(value);
    if (parsed === null && strict) {
      throw invalidQueryError(`Invalid integer value for '${String(value)}'`);
    }
    return parsed;
  }

  if (only === "number") {
    const parsed = parseNumberValue(value);
    if (parsed === null && strict) {
      throw invalidQueryError(`Invalid number value for '${String(value)}'`);
    }
    return parsed;
  }

  if (
    only === "string" &&
    typeof fieldSchema?.format === "string" &&
    (["date", "date-time"] as string[]).includes(fieldSchema.format)
  ) {
    const parsed = strict ? parseStrictDateValue(value, fieldSchema.format) : parseDateValue(value);
    if (parsed === null && strict) {
      throw invalidQueryError(`Invalid date value for '${String(value)}'`);
    }
    return parsed;
  }

  return String(value);
}
