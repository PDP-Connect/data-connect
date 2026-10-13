// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Parsers for the grant lifecycle operation's request values (Core: Grant
 * lifecycle operation). Strict on purpose: a value that is not in a defined
 * form is `invalid_request`, never a guess.
 *
 * PROTOTYPE: experimental held-data lifecycle work, off by default.
 */
import type { RetainedUntil } from "../../lib/held-data/authority.ts";

const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

/** RFC 3339 date-time to epoch milliseconds, or null. A date alone is not a date-time. */
export function parseRfc3339(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const m = RFC3339.exec(value);
  if (!m) return null;
  const [, y, mo, d, h, mi, sec, , zone] = m as unknown as string[];
  const month = Number(mo);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || Number(h) > 23 || Number(mi) > 59 || Number(sec) > 60) return null;
  if (day > new Date(Date.UTC(Number(y), month, 0)).getUTCDate()) return null;
  if (zone !== "Z" && zone !== "z") {
    const [zh, zm] = (zone as string).slice(1).split(":").map(Number) as [number, number];
    if (zh > 23 || zm > 59) return null;
  }
  // A leap second is valid in RFC 3339; JavaScript has none, so it counts as the next second.
  const ms = Date.parse(value.replace(/[tz]/g, (c) => c.toUpperCase()).replace(/:60(?=[.\dZ+-])/, ":59"));
  if (!Number.isFinite(ms)) return null;
  return Number(sec) === 60 ? ms + 1000 : ms;
}

/**
 * `retained_until`: an RFC 3339 date-time; `event:` followed by non-empty
 * text; or `unknown`. Anything else is null.
 */
export function parseRetainedUntil(value: unknown): RetainedUntil | null {
  if (typeof value !== "string") return null;
  if (value === "unknown") return { form: "unknown" };
  if (value.startsWith("event:")) {
    const text = value.slice("event:".length);
    return text.trim().length > 0 ? { form: "event", text } : null;
  }
  const t = parseRfc3339(value);
  return t === null ? null : { form: "date-time", at: t };
}

/** Mapped to RFC 9396 `invalid_authorization_details` by the PAR and authorize adapters. */
export class RetentionDurationError extends Error {
  readonly code = "source.authorization_details_invalid";
}

/**
 * Core (Retention): `max_duration` MUST have the form `PnD`, n a positive
 * whole number of days. Months, years, weeks, and time components are
 * rejected, as is anything else.
 */
export function requireDayDuration(retention: unknown): void {
  if (typeof retention !== "object" || retention === null) return;
  const value = (retention as { max_duration?: unknown }).max_duration;
  if (typeof value !== "string" || !/^P(\d+)D$/.test(value) || Number(value.slice(1, -1)) < 1) {
    throw new RetentionDurationError("retention.max_duration must have the form PnD, n a positive whole number of days");
  }
}
