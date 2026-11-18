// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
// Display boundary for Remote access text. Library and server values (labels,
// reasons, disclosure keys, timestamps) reach the screen through `plain`, so an
// underscore-joined code, a dotted capability flag, an ISO timestamp or the old
// name "reachability" never shows outside Details → Diagnostics.

type TimeOptions = { locale?: string; timeZone?: string; now?: number };

const isoTimestamp = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g;
const underscoreCode = /\b[a-z0-9]+(?:_[a-z0-9]+)+\b/gi;
const dottedFlag = /\b(?:installer|runtime|privilege|secrets|host)\.[a-z]+(?:\.[a-z]+)*\b/gi;
const hyphenCode = /^[a-z0-9]+(?:-[a-z0-9]+)+$/;
const oldName = /reachability/gi;

// "1:00 PM" today; "Nov 19, 1:00 PM" on another day. Never ISO.
export function formatLocalTime(value: string | number | Date, options: TimeOptions = {}): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "an unknown time";
  }
  const zone = options.timeZone ? { timeZone: options.timeZone } : {};
  const time = date.toLocaleTimeString(options.locale, { hour: "numeric", minute: "2-digit", ...zone });
  const day = (d: Date) => d.toLocaleDateString(options.locale, { year: "numeric", month: "numeric", day: "numeric", ...zone });
  if (day(date) === day(new Date(options.now ?? Date.now()))) {
    return time;
  }
  return `${date.toLocaleDateString(options.locale, { month: "short", day: "numeric", ...zone })}, ${time}`;
}

export function plain(text: string, options: TimeOptions = {}): string {
  let out = text.replace(isoTimestamp, (match) => formatLocalTime(match, options));
  out = out.replace(dottedFlag, (match) => match.replaceAll(".", " "));
  out = out.replace(underscoreCode, (match) => match.replaceAll("_", " ").toLowerCase());
  if (hyphenCode.test(out)) {
    out = out.replaceAll("-", " ");
  }
  return out.replace(oldName, (match) => (match[0] === "R" ? "Remote access" : "remote access"));
}

// A disclosure key such as `metadataVisibleTo` or `tls_termination` as a label.
export function humanizeKey(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._-]+/g, " ")
    .trim()
    .toLowerCase();
  return plain(words.charAt(0).toUpperCase() + words.slice(1));
}
