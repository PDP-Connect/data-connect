// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-stream scope narrowing for the hosted MCP picker: which fields, and
 * over what dates.
 *
 * The picker used to grant every field of every checked stream, with no date
 * bound, and told the owner so: "Everything in each data type you check, with
 * no date limit." That sentence described an unbuilt feature as though it
 * were a property of the protocol. It is not. `spec-core.md:761` makes
 * `fields` a protocol-enforced allowlist and `spec-core.md:758-759` makes
 * `time_range` a protocol-enforced window; the resource server already
 * enforces both. The controls were missing, not the mechanism.
 *
 * This module owns the middle of that path: what a stream is *capable* of
 * offering, and how a submitted narrowing is validated back into a selection
 * the existing resolver accepts. Rendering lives in the consent-UI helpers;
 * resolution into a grant stays in `core-source-authorization.ts`, which
 * already handles both fields and time ranges correctly.
 *
 * **Capability is declared, never assumed.** Two manifest signals decide what
 * the picker may offer for a stream:
 *
 *   - `selection.fields` — whether field narrowing is supported at all.
 *     `resolveFields` rejects a field list on a stream without it.
 *   - `consent_time_field` — the field a time window is evaluated against.
 *     `spec-core.md:547` makes its absence the normative signal that a stream
 *     does not support time filtering, and `resolveTimeConstraint` fails on a
 *     `time_range` for such a stream.
 *
 * Offering a control the declaration does not support would produce a 400 at
 * issuance, after the owner had already made a choice. So the capability
 * check happens before anything is rendered, and a stream that cannot be
 * narrowed simply shows no control — silence is the correct rendering of an
 * inapplicable option.
 *
 * **Schema-required fields are the consent floor.** `spec-core.md:764` states
 * that required fields are always included regardless of the requested list,
 * because a record missing them is not a valid record of that stream. The UI
 * therefore renders them checked and disabled rather than hiding them: the
 * owner should see what they cannot exclude, not be quietly overruled after
 * unchecking it.
 */

/** The manifest facts the picker needs to decide what it may offer. */
export interface StreamScopeSource {
  readonly consent_time_field?: string | null;
  readonly name: string;
  readonly schema?: {
    readonly properties?: Record<string, unknown> | null;
    readonly required?: readonly string[] | null;
  } | null;
  readonly selection?: { readonly fields?: boolean | null } | null;
}

/** What the picker may offer for one stream, resolved from its declaration. */
export interface StreamScopeCapability {
  /** Field names the owner may switch off. Empty when narrowing is unsupported. */
  readonly optionalFields: readonly string[];
  /** Field names always included; rendered checked and disabled. */
  readonly requiredFields: readonly string[];
  /** True when this stream declares `selection.fields`. */
  readonly supportsFieldNarrowing: boolean;
  /** The `consent_time_field`, or null when the stream has no temporal scope. */
  readonly timeField: string | null;
}

/** One stream's submitted narrowing, already validated against its capability. */
export interface StreamScopeSelection {
  /** Resolved allowlist, or null to request every field (the default). */
  readonly fields: readonly string[] | null;
  /** Resolved window, or null for no temporal bound (the default). */
  readonly timeRange: { since?: string; until?: string } | null;
}

/** A rejected narrowing. The picker re-renders rather than minting a grant. */
export interface StreamScopeError {
  readonly message: string;
  readonly streamName: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Resolve what a stream's declaration permits the picker to offer.
 *
 * Required fields are reported even when narrowing is unsupported, so the
 * caller can always describe the resolved scope honestly; `optionalFields` is
 * what gates whether a control appears at all.
 */
export function resolveStreamScopeCapability(stream: StreamScopeSource): StreamScopeCapability {
  const properties = stream.schema?.properties;
  const allFields = properties && typeof properties === "object" ? Object.keys(properties).sort() : [];
  const declaredRequired = Array.isArray(stream.schema?.required) ? stream.schema.required : [];
  const required = allFields.filter((field) => declaredRequired.includes(field));
  const supportsFieldNarrowing = stream.selection?.fields === true && allFields.length > 0;
  return Object.freeze({
    optionalFields: Object.freeze(supportsFieldNarrowing ? allFields.filter((f) => !required.includes(f)) : []),
    requiredFields: Object.freeze(required),
    supportsFieldNarrowing,
    timeField: isNonEmptyString(stream.consent_time_field) ? stream.consent_time_field.trim() : null,
  });
}

/**
 * Normalize a submitted date bound into the ISO-8601 instant the grant
 * carries.
 *
 * The form offers a date; the protocol stores an instant. `since` is
 * inclusive and `until` is exclusive (`spec-core.md:758-759`), so a `since`
 * of 2026-03-01 becomes that day's first moment, and an `until` of the same
 * day becomes the *following* day's first moment — otherwise picking a single
 * day as both bounds would authorize an empty window, which is never what
 * someone choosing a date range means.
 *
 * Returns null for a blank value and undefined for an unparseable one, so the
 * caller can tell "not set" from "wrong".
 */
export function normalizeScopeBound(value: unknown, bound: "since" | "until"): string | null | undefined {
  if (!isNonEmptyString(value)) {
    return null;
  }
  const trimmed = value.trim();
  if (!ISO_DATE.test(trimmed)) {
    return undefined;
  }
  const parsed = Date.parse(`${trimmed}T00:00:00.000Z`);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  const instant = bound === "until" ? parsed + 24 * 60 * 60 * 1000 : parsed;
  return new Date(instant).toISOString();
}

/**
 * Validate one stream's submitted narrowing against what its declaration
 * permits.
 *
 * Every branch here fails closed. The submitted values arrive from a form the
 * owner's browser rendered, so they are as client-controlled as anything else
 * on the request: a field name absent from the schema, or a date window on a
 * stream with no `consent_time_field`, is rejected rather than passed down to
 * be caught later. Catching it later would still be safe — the resolver
 * validates too — but it would surface as an opaque 400 after the owner
 * pressed Allow, instead of as a correction on the page they are looking at.
 *
 * An empty field selection is an error rather than an implicit "everything":
 * the owner unchecking every optional field on a stream they left checked is
 * a contradiction the page should resolve with them, not silently reinterpret.
 */
export function resolveStreamScopeSelection(
  stream: StreamScopeSource,
  submitted: { fields?: readonly string[] | null; since?: unknown; until?: unknown }
): { error: StreamScopeError } | { selection: StreamScopeSelection } {
  const capability = resolveStreamScopeCapability(stream);
  const streamName = stream.name;

  let fields: readonly string[] | null = null;
  const submittedFields = submitted.fields;
  if (Array.isArray(submittedFields)) {
    if (!capability.supportsFieldNarrowing) {
      return { error: { message: `${streamName} does not support choosing fields.`, streamName } };
    }
    const permitted = new Set([...capability.requiredFields, ...capability.optionalFields]);
    const chosen = submittedFields.filter(isNonEmptyString).map((field) => field.trim());
    const unknown = chosen.filter((field) => !permitted.has(field));
    if (unknown.length > 0) {
      return { error: { message: `${streamName} has no field named ${unknown[0]}.`, streamName } };
    }
    // The consent floor: required fields are always included, so a submission
    // that omits them is completed rather than rejected (spec-core.md:764).
    const resolved = [...new Set([...chosen, ...capability.requiredFields])].sort();
    if (resolved.length === 0) {
      return { error: { message: `Choose at least one field in ${streamName}, or uncheck it.`, streamName } };
    }
    // Asking for everything is the same as asking for nothing in particular;
    // omitting `fields` keeps the grant's provenance honest about that.
    const isEverything = resolved.length === permitted.size;
    fields = isEverything ? null : resolved;
  }

  const since = normalizeScopeBound(submitted.since, "since");
  const until = normalizeScopeBound(submitted.until, "until");
  if (since === undefined || until === undefined) {
    return { error: { message: `Enter dates for ${streamName} as YYYY-MM-DD.`, streamName } };
  }
  if ((since || until) && !capability.timeField) {
    return { error: { message: `${streamName} cannot be limited by date.`, streamName } };
  }
  if (since && until && Date.parse(since) > Date.parse(until)) {
    return { error: { message: `The start date for ${streamName} must come before the end date.`, streamName } };
  }

  return {
    selection: Object.freeze({
      fields,
      timeRange:
        since || until
          ? Object.freeze({ ...(since ? { since } : {}), ...(until ? { until } : {}) })
          : null,
    }),
  };
}

/**
 * Describe a resolved scope in the owner's terms.
 *
 * `spec-core.md:545` requires the temporal bound to be rendered in
 * human-readable form — "playlists created on or after January 1, 2026", not
 * "playlists in time_range". The time field is humanized the same way stream
 * names are, so `create_time` reads as "created".
 */
export function describeStreamScope(
  capability: StreamScopeCapability,
  selection: StreamScopeSelection,
  formatDate: (iso: string) => string
): string {
  const totalFields = capability.requiredFields.length + capability.optionalFields.length;
  const fieldPart = selection.fields ? `${selection.fields.length} of ${totalFields} fields` : "All fields";
  const range = selection.timeRange;
  if (!range) {
    return `${fieldPart} · all dates`;
  }
  const verb = describeTimeField(capability.timeField);
  if (range.since && range.until) {
    // `until` is exclusive; the owner picked the last day they wanted, so
    // report that day rather than the boundary instant stored in the grant.
    return `${fieldPart} · ${verb} ${formatDate(range.since)} to ${formatDate(exclusiveEndToLastDay(range.until))}`;
  }
  if (range.since) {
    return `${fieldPart} · ${verb} on or after ${formatDate(range.since)}`;
  }
  return `${fieldPart} · ${verb} before ${formatDate(range.until as string)}`;
}

/** Roll an exclusive end instant back to the last day it includes. */
export function exclusiveEndToLastDay(untilIso: string): string {
  const parsed = Date.parse(untilIso);
  if (!Number.isFinite(parsed)) {
    return untilIso;
  }
  return new Date(parsed - 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Turn a `consent_time_field` into the verb an owner reads: `create_time` and
 * `created_at` both become "created". Falls back to a neutral phrase rather
 * than printing a raw field name at someone.
 */
export function describeTimeField(field: string | null): string {
  if (!field) {
    return "dated";
  }
  const normalized = field.toLowerCase().replace(/[_\s]*(at|time|date|ts)$/g, "");
  switch (normalized) {
    case "create":
    case "created":
      return "created";
    case "update":
    case "updated":
    case "modified":
      return "updated";
    case "send":
    case "sent":
      return "sent";
    case "start":
    case "started":
      return "started";
    case "play":
    case "played":
      return "played";
    case "occur":
    case "occurred":
    case "event":
      return "from";
    default:
      return "dated";
  }
}
