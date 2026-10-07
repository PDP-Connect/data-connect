// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The owner's collection window (`collection_scope.since`), stated in the type
 * of each stream's consent-time field.
 *
 * Collection Profile §5.1: a `time_range` bound has the type of the field's
 * declared format, a `full-date` for `format: "date"` and an RFC 3339
 * date-time with an offset for `format: "date-time"`. When the runtime chooses
 * a window itself, it states the window in each field's type. A connector that
 * gets a bound of the wrong type, or a bound on a field of any other type,
 * skips the stream with `scope_not_supported`. So one owner window cannot be
 * copied unchanged onto every stream.
 *
 * The owner states the window as an RFC 3339 date-time with an offset, for
 * example `2026-09-05T00:00:00-04:00` for "since 5 Sep" in UTC-4. The offset
 * comes from the owner, so the runtime never guesses a time zone. That value
 * gives both forms:
 *
 * - A `date-time` field gets the value unchanged.
 * - A `date` field gets its date part, the calendar day that contains the
 *   instant at the owner's offset. When the time is midnight, this is exact.
 *   Otherwise it is the whole day: a record dated that day can be at or after
 *   the instant, so a later day would drop records the owner asked for.
 *
 * A stored `full-date` (written before the route required an offset) goes to a
 * `date` field unchanged. A `date-time` field gets the first instant of that
 * day in any time zone (`T00:00:00+14:00`), because the runtime does not know
 * the owner's zone and must not drop records from that day.
 *
 * Both mappings follow one rule: when the owner's window cannot be stated
 * exactly in a field's type, send the narrowest bound of that type that holds
 * the whole window. Never send one that drops part of it.
 *
 * A field with no `date` or `date-time` format (an epoch integer, a string with
 * no format) cannot take a bound, so the stream gets no `time_range`, the same
 * as a stream with no `consent_time_field`.
 */

const FULL_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const OFFSET_DATE_TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|[+-](\d{2}):(\d{2}))$/;

/** The earliest offset in use (UTC+14:00), where each calendar day starts first. */
const EARLIEST_DAY_START = "T00:00:00+14:00";

export type OwnerWindowSince =
  | { readonly kind: "date"; readonly date: string }
  | { readonly kind: "instant"; readonly date: string; readonly instant: string };

export type ConsentTimeFormat = "date" | "date-time";

function isRealCalendarDay(year: string, month: string, day: string): boolean {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (m < 1 || m > 12 || d < 1) {
    return false;
  }
  // Day 0 of the next month is the last day of this month.
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/**
 * Parse an owner window bound. Returns null for anything that is not an RFC
 * 3339 `full-date` or an RFC 3339 date-time with an offset. A date-time with
 * no offset is not an instant (§5.1), so it is rejected.
 */
export function parseOwnerWindowSince(value: unknown): OwnerWindowSince | null {
  if (typeof value !== "string") {
    return null;
  }
  const date = FULL_DATE_PATTERN.exec(value);
  if (date) {
    const [, year = "", month = "", day = ""] = date;
    return isRealCalendarDay(year, month, day) ? { date: value, kind: "date" } : null;
  }
  const instant = OFFSET_DATE_TIME_PATTERN.exec(value);
  if (!instant) {
    return null;
  }
  const [, year = "", month = "", day = "", hour, minute, second, offsetHour, offsetMinute] = instant;
  if (
    !isRealCalendarDay(year, month, day) ||
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 59 ||
    (offsetHour !== undefined && Number(offsetHour) > 23) ||
    (offsetMinute !== undefined && Number(offsetMinute) > 59)
  ) {
    return null;
  }
  return { date: `${year}-${month}-${day}`, instant: value, kind: "instant" };
}

/**
 * The consent-time format a field schema declares, or null when the field
 * cannot take a `time_range` bound (§5.1).
 */
export function consentTimeFormat(fieldSchema: unknown): ConsentTimeFormat | null {
  if (typeof fieldSchema !== "object" || fieldSchema === null) {
    return null;
  }
  const { format, type } = fieldSchema as { format?: unknown; type?: unknown };
  const allowsString = type === "string" || (Array.isArray(type) && type.includes("string"));
  if (!allowsString) {
    return null;
  }
  return format === "date" || format === "date-time" ? format : null;
}

/** The owner window's `since`, stated in a field of the given format. */
export function ownerWindowBound(since: OwnerWindowSince, format: ConsentTimeFormat): string {
  if (format === "date") {
    return since.date;
  }
  return since.kind === "instant" ? since.instant : `${since.date}${EARLIEST_DAY_START}`;
}

/**
 * The default `time_range` for one manifest stream under the owner's window,
 * or null when the stream gets no bound: it has no `consent_time_field`, or
 * that field has no `date` or `date-time` format.
 */
export function ownerWindowTimeRange(
  stream: {
    readonly consent_time_field?: string | null;
    readonly schema?: { readonly [key: string]: unknown } | null;
  },
  since: OwnerWindowSince
): { since: string } | null {
  const field = stream.consent_time_field;
  if (!field) {
    return null;
  }
  const properties = stream.schema?.properties;
  const fieldSchema =
    typeof properties === "object" && properties !== null ? (properties as Record<string, unknown>)[field] : undefined;
  const format = consentTimeFormat(fieldSchema);
  return format ? { since: ownerWindowBound(since, format) } : null;
}

/**
 * What an owner may write as `collection_scope.since`. A new window must carry
 * the owner's offset, so a full-date is accepted only when it is already
 * stored.
 */
export const OWNER_WINDOW_SINCE_REQUIREMENT =
  "an RFC 3339 date-time with an offset, for example 2026-09-05T00:00:00-04:00 for the start of 5 Sep in UTC-4";

/** Whether an owner may declare `value` as a new `collection_scope.since`. */
export function isDeclarableOwnerWindowSince(value: string): boolean {
  return parseOwnerWindowSince(value)?.kind === "instant";
}
