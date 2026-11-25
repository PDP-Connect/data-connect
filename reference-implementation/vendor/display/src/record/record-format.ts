// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Declared-type-aware value formatting for record fields — a framework-agnostic,
 * dependency-free leaf module.
 *
 * A connector manifest may declare a field's presentation type via the
 * `x_pdpp_type` JSON-Schema extension, surfaced read-only on the read contract
 * as `field_capabilities[field].type`. This module turns that declared type into
 * a display string for a single field value — most importantly, rendering a
 * monetary minor-units field (chase `amount`, documented "signed amount in
 * cents") as `$30.00` rather than the raw integer `3000`.
 *
 * It is presentation metadata only: never written back, never sent to the
 * resource server, never treated as a manifest field. A field with no declared
 * type (or an unrecognized one) is left to the caller's plain stringification —
 * this module deliberately does NOT apply a magnitude heuristic, so a bare
 * undeclared integer is never silently reinterpreted as cents.
 *
 * This lives in the framework-free `@pdpp/display` package so all consumers
 * share one source of truth without depending on a UI framework.
 */

/**
 * Maps a field's wire key → its declared presentation type (from
 * `field_capabilities[field].type`). Presentation-only and read-only; only field
 * names that carry a declared type appear here. Inlined here (rather than pulling
 * in operator-ui's `record-kind.ts`) to keep this module a self-contained leaf.
 */
import type { DeclaredFieldTypes } from "./declared-field-types.ts";

export type { DeclaredFieldTypes } from "./declared-field-types.ts";

// Declared presentation types denoting a monetary value carried in MINOR units
// (integer cents). `currency` is the vocabulary the pilot manifests use (e.g.
// chase `amount`); the explicit aliases future-proof the same intent. A field
// with one of these declared types is divided by 100, independent of magnitude.
const MINOR_UNITS_TYPE_RE = /^(currency|currency_minor_units|minor_units|cents)$/;
// Declared types denoting MILLI units (thousandths), e.g. YNAB-style amounts.
const MILLI_UNITS_TYPE_RE = /^(currency_milliunits|milliunits|milli_units)$/;

export interface FormattedAmount {
  positive: boolean;
  text: string;
}

export type FormattedRecordFieldValue =
  | { kind: "amount"; positive: boolean; text: string }
  | { kind: "plain"; text: string };

function normalizeType(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

function formatDollars(n: number): FormattedAmount {
  const positive = n >= 0;
  const sign = positive ? "" : "-";
  return { text: `${sign}$${Math.abs(n).toFixed(2)}`, positive };
}

/**
 * Format a numeric value as a monetary amount IFF the declared type names a
 * monetary unit (minor units → ÷100, milli units → ÷1000). Returns null when
 * the value is not a finite number or the declared type is not monetary — in
 * which case the caller keeps its plain rendering. No magnitude heuristic: an
 * undeclared field is never guessed at here.
 */
export function formatDeclaredAmount(value: unknown, declaredType: unknown): FormattedAmount | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  const declared = normalizeType(declaredType);
  if (!declared) {
    return null;
  }
  if (MINOR_UNITS_TYPE_RE.test(declared)) {
    return formatDollars(value / 100);
  }
  if (MILLI_UNITS_TYPE_RE.test(declared)) {
    return formatDollars(value / 1000);
  }
  return null;
}

const GROUPED_NUMBER_TYPES = new Set(["number", "integer"]);
// Numbers a person reads as a label, a date or a time, never as a quantity: ids, years, codes,
// phone and postal numbers, and epoch times. Grouping them ("2,024", "1,700,000,000") misleads.
const UNGROUPED_FIELD_NAME_RE =
  /(?:^id$|_id$|Id$|ID$|year$|Year$|^zip|zip$|Zip$|postal|Postal|code$|Code$|phone|Phone|_at$|_ts$|timestamp|Timestamp|epoch|Epoch)/;
const WHOLE_NUMBER_FORMAT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

function isIdentifierLikeField(name: string): boolean {
  return UNGROUPED_FIELD_NAME_RE.test(name);
}

/**
 * The JSON-Schema `type` of a field as one lower-case word: a plain string type, or the
 * single non-null member of a type list (`["integer", "null"]` → `integer`). Null otherwise.
 */
export function fieldSchemaType(schema: unknown): string | null {
  if (!schema || typeof schema !== "object") {
    return null;
  }
  const type = (schema as { type?: unknown }).type;
  if (Array.isArray(type)) {
    const nonNull = type.filter((item) => item !== "null");
    return nonNull.length === 1 ? normalizeType(nonNull[0]) : null;
  }
  return normalizeType(type);
}

/** Map each field to its JSON-Schema `type` from a stream's `field_capabilities[field].schema`. */
export function deriveFieldSchemaTypes(
  metadata: { field_capabilities?: Record<string, { schema?: unknown } | null | undefined> | null } | null | undefined
): Readonly<Record<string, string>> {
  const raw = metadata?.field_capabilities;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const entries: Array<readonly [string, string]> = [];
  for (const [name, cap] of Object.entries(raw)) {
    const type = fieldSchemaType(cap?.schema);
    if (type) {
      entries.push([name, type]);
    }
  }
  return Object.fromEntries(entries);
}

/**
 * Format a field only when its value and types make the display safe: a declared monetary
 * amount; a list of plain strings joined with ", "; or a whole number of 10,000 or more with
 * grouping separators, only when the field's JSON-Schema type is number/integer and its name
 * is not id-, year-, code-, phone-, postal- or time-like. Returns null to keep the caller's
 * plain rendering.
 */
export function formatRecordFieldValue(
  value: unknown,
  fieldName: string,
  declaredType: unknown,
  schemaType?: unknown
): FormattedRecordFieldValue | null {
  const amount = formatDeclaredAmount(value, declaredType);
  if (amount) {
    return { kind: "amount", positive: amount.positive, text: amount.text };
  }
  if (Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string")) {
    return { kind: "plain", text: value.join(", ") };
  }
  const normalizedSchemaType = normalizeType(schemaType);
  if (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    Math.abs(value) >= 10_000 &&
    normalizedSchemaType !== null &&
    GROUPED_NUMBER_TYPES.has(normalizedSchemaType) &&
    !isIdentifierLikeField(fieldName)
  ) {
    return { kind: "plain", text: WHOLE_NUMBER_FORMAT.format(value) };
  }
  return null;
}

/** True when the declared type names a monetary unit this module formats. */
export function isMonetaryDeclaredType(declaredType: unknown): boolean {
  const declared = normalizeType(declaredType);
  return declared !== null && (MINOR_UNITS_TYPE_RE.test(declared) || MILLI_UNITS_TYPE_RE.test(declared));
}

interface StreamMetadataLike {
  field_capabilities?: Record<string, { type?: unknown } | null | undefined> | null;
}

/**
 * Build the declared field-type map from a stream's `field_capabilities`,
 * keeping only entries that carry a non-empty string `type`. Mirrors the
 * Explorer feed's derivation so every surface reads the same declared types.
 * Returns an empty object when no field declares a type.
 */
export function deriveDeclaredFieldTypes(metadata: StreamMetadataLike | null | undefined): DeclaredFieldTypes {
  const raw = metadata?.field_capabilities;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const entries: Array<readonly [string, string]> = [];
  for (const [name, cap] of Object.entries(raw)) {
    const type = normalizeType(cap?.type);
    if (type) {
      entries.push([name, type]);
    }
  }
  return Object.fromEntries(entries);
}
