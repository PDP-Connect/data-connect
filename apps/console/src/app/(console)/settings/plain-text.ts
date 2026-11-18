// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
// Display boundary for Remote access text. Library and server values (labels,
// reasons, disclosure keys, timestamps) reach the screen through `plain`, so an
// underscore-joined code, a dotted capability flag, an ISO timestamp or the old
// name "reachability" never shows outside Details → Diagnostics.

type TimeOptions = { locale?: string; timeZone?: string; now?: number };

const isoTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/;
const underscoreCode = /^[a-z0-9]+(?:_[a-z0-9]+)+$/i;
// The capability flags the host reports. A list, not a pattern: a pattern also
// matches host names such as `secrets.example.com`.
const dottedFlag = /^(?:installer\.execute|privilege\.elevate|runtime\.attached|runtime\.durable|secrets\.backend)$/;
const hyphenCode = /^[a-z0-9]+(?:-[a-z0-9]+)+$/;
const oldName = /^reachability$/i;
// A token with any of these is a URL, an address, a query or a path. It is
// somebody's value and passes through whole.
const opaque = /[/?=&#@\\]|:\/\//;

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

// A disclosure value is shown as written, except an ISO timestamp, which is a
// time and never appears as ISO on screen.
export function verbatimValue(value: string, options: TimeOptions = {}): string {
  return isoTimestamp.test(value) ? formatLocalTime(value, options) : value;
}

// For a code or label that a library or the host supplied: a status, a
// reason, a capability flag, a group or a label. Each whitespace-separated word
// is rewritten only if the whole word is a code, an ISO timestamp or the old
// product name, so a URL, host name, address, query string or command inside a
// longer text stays as it is. Never pass it a value, an address or text the
// owner has to copy or type (instructions, help, a setting's value).
export function plain(text: string, options: TimeOptions = {}): string {
  const whole = hyphenCode.test(text) ? text.replaceAll("-", " ") : text;
  return whole
    .split(/(\s+)/)
    .map((word) => (/^\s*$/.test(word) ? word : plainWord(word, options)))
    .join("");
}

function plainWord(word: string, options: TimeOptions): string {
  const match = /^([("'[]*)(.*?)([)"'\].,;:!]*)$/.exec(word);
  const [, lead = "", core = word, tail = ""] = match ?? [];
  if (!core || opaque.test(core)) return word;
  if (isoTimestamp.test(core)) return `${lead}${formatLocalTime(core, options)}${tail}`;
  // Unknown dotted tokens are opaque values, never guessed capability labels.
  if (/\w\.\w/.test(core) && !dottedFlag.test(core)) return word;
  if (dottedFlag.test(core)) return `${lead}${core.replaceAll(".", " ")}${tail}`;
  if (underscoreCode.test(core)) return `${lead}${core.replaceAll("_", " ").toLowerCase()}${tail}`;
  if (oldName.test(core)) return `${lead}${core[0] === "R" ? "Remote access" : "remote access"}${tail}`;
  return word;
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
