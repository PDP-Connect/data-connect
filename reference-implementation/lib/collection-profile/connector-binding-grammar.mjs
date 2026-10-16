// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Typed parsers and canonicalizers for the binding constraint grammars
 * defined in docs/spec/collection-profile.md Section 3.3. JSON Schema can
 * check shape (strings, required members, enums) but cannot perform IDNA
 * canonicalization, IPv6 normalization, or "is this string already in its
 * one canonical form" equivalence checks. This module does that work, and
 * schemas/connector-manifest.schema.json's string patterns are deliberately
 * written to accept only the output these functions already produce.
 *
 * Node's `url.domainToASCII` was evaluated for the IDNA/UTS46 step. This
 * module uses the WHATWG `URL` constructor instead, because the same
 * host-parsing algorithm that backs `domainToASCII` also normalizes IPv4
 * and IPv6 literals and drops a scheme's default port, so one call covers
 * every canonicalization rule in the web-origin grammar instead of hand
 * -rolling IPv6 compression or IPv4 interpretation separately. Both paths
 * share the same underlying WHATWG URL Standard host parser, so the result
 * is the one `domainToASCII` would give for the host component alone.
 *
 * Grammar (docs/spec/collection-profile.md Section 3.3.2):
 * `[scheme://]host[:port]`, exact or one leading `*.` wildcard label, no
 * path, query, or fragment. Section 3.3.3 (browser) and 3.3.4 (network) layer
 * their own scheme sets and endpoint rules on top of this shared grammar.
 */

import { URL } from "node:url";
import net from "node:net";

export class GrammarError extends Error {
  constructor(message) {
    super(message);
    this.name = "GrammarError";
  }
}

// Schemes `browser.navigate` accepts: a navigation always loads a document.
const NAVIGATE_SCHEMES = new Set(["http", "https"]);

// Schemes `browser.connect` accepts: a page can open a WebSocket from a
// document loaded over http(s), so `connect` is scheme-aware in a way
// `navigate` is not (Section 3.3.3, live capture evidence from chatgpt:
// wss://ws.chatgpt.com, wss://codex-cloud-backend.chatgpt.com).
const CONNECT_SCHEMES = new Set(["http", "https", "ws", "wss"]);

// network.hosts without an explicit scheme, and any bare http(s) entry,
// reuses the same grammar as `navigate` (Section 3.3.4).
const WEB_SCHEMES = NAVIGATE_SCHEMES;

// Well-known default ports, used to drop a redundant explicit port from the
// canonical form. Only schemes with one conventional default port are
// listed; an endpoint whose scheme is not here must always state its port
// (Section 3.3.4). ws/wss share http/https's ports because a WebSocket
// upgrade begins as an http(s) request.
// Object.create(null) has no prototype chain, so a scheme named
// "constructor", "__proto__", "toString", or "hasOwnProperty" cannot read an
// inherited value through `DEFAULT_PORTS[scheme]` and be mistaken for a
// scheme with a real default port. A plain object literal is vulnerable to
// exactly this (schemas/connector-binding-grammar.test.mjs tests it).
const DEFAULT_PORTS = Object.assign(Object.create(null), {
  http: 80,
  https: 443,
  ws: 80,
  wss: 443,
  imap: 143,
  imaps: 993,
  pop3: 110,
  pop3s: 995,
  smtp: 25,
  smtps: 465,
  submission: 587,
  ldap: 389,
  ldaps: 636,
  ftp: 21,
  ftps: 990,
});

function assertNoWhitespaceOrControl(raw) {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new GrammarError("must be a non-empty string");
  }
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) {
      throw new GrammarError("must not contain whitespace or control characters");
    }
  }
}

function splitScheme(raw) {
  const match = raw.match(/^([A-Za-z][A-Za-z0-9+.-]*):\/\//);
  if (!match) return { scheme: null, rest: raw };
  return { scheme: match[1].toLowerCase(), rest: raw.slice(match[0].length) };
}

function splitWildcard(rest) {
  if (rest.startsWith("*.")) {
    const apex = rest.slice(2);
    if (apex.includes("*")) {
      throw new GrammarError("a wildcard must be exactly one leading '*.' label");
    }
    return { wildcard: true, rest: apex };
  }
  if (rest.includes("*")) {
    throw new GrammarError("a wildcard must be exactly one leading '*.' label");
  }
  return { wildcard: false, rest };
}

function rejectPathQueryFragment(rest) {
  if (/[/?#]/.test(rest)) {
    throw new GrammarError("must not contain a path, query, or fragment");
  }
}

function rejectUserinfo(rest) {
  if (rest.includes("@")) {
    throw new GrammarError("must not contain userinfo; this grammar has no '@' component");
  }
}

/**
 * Splits `rest` (no scheme, no wildcard, no path) into a host token and an
 * optional port token, respecting bracketed IPv6 literals.
 */
function splitHostPort(rest) {
  if (rest.startsWith("[")) {
    const end = rest.indexOf("]");
    if (end === -1) throw new GrammarError("unterminated IPv6 literal");
    const host = rest.slice(0, end + 1);
    const tail = rest.slice(end + 1);
    if (tail.length === 0) return { host, port: null, isIPv6Literal: true };
    if (!tail.startsWith(":")) throw new GrammarError("unexpected characters after an IPv6 literal");
    return { host, port: tail.slice(1), isIPv6Literal: true };
  }
  const colonIdx = rest.lastIndexOf(":");
  if (colonIdx === -1) return { host: rest, port: null, isIPv6Literal: false };
  return { host: rest.slice(0, colonIdx), port: rest.slice(colonIdx + 1), isIPv6Literal: false };
}

function validatePort(port) {
  if (!/^[0-9]+$/.test(port)) throw new GrammarError("port must be digits only");
  const value = Number(port);
  if (!Number.isInteger(value) || value < 1 || value > 65535 || String(value) !== port) {
    throw new GrammarError("port must be a canonical integer from 1 to 65535");
  }
  return value;
}

function stripTrailingDot(host) {
  if (host.startsWith("[") || !host.endsWith(".")) return host;
  const stripped = host.slice(0, -1);
  if (stripped.length === 0 || stripped.endsWith(".")) {
    throw new GrammarError("host has more than one trailing dot, or is empty after stripping it");
  }
  return stripped;
}

/**
 * Validates DNS label syntax (LDH rule) for a non-IP hostname. The WHATWG
 * URL host parser accepts some strings this grammar must reject, such as an
 * empty label from a doubled dot (`a..b.example`).
 */
function assertValidDnsLabels(host) {
  if (host.length > 253) throw new GrammarError("host exceeds 253 characters");
  for (const label of host.split(".")) {
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label)) {
      throw new GrammarError(`invalid host label '${label}'`);
    }
    if (label.length > 63) throw new GrammarError(`host label '${label}' exceeds 63 octets`);
  }
}

/**
 * Canonicalizes the host[:port] portion shared by the web and endpoint
 * grammars. `scheme` is the already-lowercased scheme, or null when the web
 * grammar's scheme is omitted. Returns `{ host, isIP, port }`, where `port`
 * is the canonical port string or `""` when the port is implied.
 */
function canonicalizeHostAndPort(rest, { scheme, allowWildcard }) {
  const { wildcard, rest: afterWildcard } = allowWildcard
    ? splitWildcard(rest)
    : { wildcard: false, rest: (() => { if (rest.includes("*")) throw new GrammarError("a wildcard is not allowed here"); return rest; })() };
  rejectPathQueryFragment(afterWildcard);
  rejectUserinfo(afterWildcard);
  const { host: hostToken, port: portToken, isIPv6Literal } = splitHostPort(afterWildcard);
  if (hostToken.length === 0) throw new GrammarError("host must not be empty");
  if (wildcard && isIPv6Literal) throw new GrammarError("a wildcard cannot apply to an IP literal");

  const portValue = portToken === null ? null : validatePort(portToken);
  const hostForUrl = stripTrailingDot(hostToken);

  // Always probe through a "special" WHATWG scheme (any of http, https, ws,
  // wss, ftp, file) so the URL constructor runs its full host algorithm
  // (IDNA, IPv4, IPv6). For a non-special scheme such as "imaps", the same
  // constructor treats the host as opaque and skips all of that -- compared
  // in schemas/connector-binding-grammar.test.mjs. The real scheme is used
  // below only to decide default-port dropping, never for this probe.
  let probe;
  try {
    probe = new URL(`https://${hostForUrl}/`);
  } catch {
    throw new GrammarError(`invalid host '${hostToken}'`);
  }
  const canonicalHost = probe.hostname;
  const isIP = net.isIP(canonicalHost.replace(/^\[|\]$/g, "")) !== 0;

  if (!isIPv6Literal) {
    const bareInput = hostForUrl.toLowerCase();
    if (net.isIPv4(canonicalHost) && bareInput !== canonicalHost) {
      throw new GrammarError(`'${hostToken}' is an IPv4-looking label; use the exact dotted-quad address`);
    }
  }
  if (!isIP) {
    assertValidDnsLabels(canonicalHost);
  }
  if (wildcard) {
    if (isIP) throw new GrammarError("a wildcard cannot apply to an IP literal");
    if (canonicalHost.split(".").length < 2) {
      throw new GrammarError("a wildcard apex must have at least one more label");
    }
  }

  let canonicalPort = "";
  if (scheme !== null) {
    const schemeDefault = DEFAULT_PORTS[scheme];
    if (portValue !== null && portValue !== schemeDefault) canonicalPort = String(portValue);
  } else if (portValue !== null) {
    canonicalPort = String(portValue);
  }

  return { host: canonicalHost, isIP, wildcard, port: canonicalPort };
}

/**
 * Canonicalizes a web-origin or web-host constraint: `browser.navigate`, an
 * HTTP(S) entry in `network`'s `hosts` list (Section 3.3.4), or (with
 * `schemes: CONNECT_SCHEMES`) `browser.connect` (Section 3.3.3), which also
 * accepts `ws`/`wss` because a page can open a WebSocket from a document
 * loaded over http(s).
 *
 * Matching semantics (stated here because the grammar alone does not fix
 * them): an omitted scheme matches every scheme `schemes` allows. An omitted
 * port matches the matching scheme's own default port (80 for http/ws, 443
 * for https/wss) -- it does NOT mean "any port", unlike a CSP host-source.
 * An explicit port matches exactly that port for the matching scheme(s).
 *
 * @param {string} raw
 * @param {{ schemes?: Set<string> }} [options] `schemes` defaults to `{http, https}`.
 * @returns {string} the canonical form
 * @throws {GrammarError}
 */
export function canonicalizeWebHost(raw, { schemes = NAVIGATE_SCHEMES } = {}) {
  assertNoWhitespaceOrControl(raw);
  const { scheme, rest } = splitScheme(raw);
  if (scheme !== null && !schemes.has(scheme)) {
    const allowed = [...schemes].join("', '");
    throw new GrammarError(`scheme '${scheme}' is not one of '${allowed}'; use canonicalizeEndpoint for a non-HTTP, non-WebSocket scheme`);
  }
  const { host, wildcard, port } = canonicalizeHostAndPort(rest, { scheme, allowWildcard: true });
  const prefix = scheme === null ? "" : `${scheme}://`;
  const wildcardPrefix = wildcard ? "*." : "";
  const portSuffix = port === "" ? "" : `:${port}`;
  return `${prefix}${wildcardPrefix}${host}${portSuffix}`;
}

/**
 * Returns whether `raw` is already in `canonicalizeWebHost`'s canonical
 * form (idempotent fixed point), without throwing on invalid input.
 */
export function isCanonicalWebHost(raw, options) {
  try {
    return canonicalizeWebHost(raw, options) === raw;
  } catch {
    return false;
  }
}

/**
 * Whether `candidateHost` (already canonical: lowercase, IDNA ASCII, no
 * trailing dot) is matched by the wildcard apex `apex` (the canonical host
 * text after a leading `*.`, for example `"chase.com"` from
 * `"*.chase.com"`). Section 3.3.2's rule follows the CSP host-source
 * convention: a wildcard matches one or more leftmost labels prepended to
 * the apex, at any depth, and never the bare apex itself, which an author
 * lists as its own separate entry when it also needs to be reachable. A
 * single leading `*.` label is this grammar's SYNTAX (Section 3.3.2); it
 * does not bound the MATCHING depth, which real captures need: the reddit
 * capture loaded `b.thumbs.redditmedia.com`, two labels under
 * `redditmedia.com`, which `*.redditmedia.com` must cover.
 *
 * Examples for apex `"chase.com"`: matches `"secure.chase.com"` and
 * `"a.b.chase.com"`; does not match `"chase.com"` itself; does not match
 * `"evilchase.com"` (a label boundary is required, not just a string
 * suffix).
 *
 * @param {string} apex
 * @param {string} candidateHost
 * @returns {boolean}
 */
export function hostMatchesWildcardApex(apex, candidateHost) {
  const suffix = `.${apex}`;
  if (!candidateHost.endsWith(suffix)) return false;
  const prefix = candidateHost.slice(0, candidateHost.length - suffix.length);
  return prefix.length > 0;
}

/**
 * Canonicalizes one entry of `browser.connect` (Section 3.3.3): the same
 * grammar as `canonicalizeWebHost`, with `ws` and `wss` also accepted.
 *
 * @param {string} raw
 * @returns {string}
 * @throws {GrammarError}
 */
export function canonicalizeConnectHost(raw) {
  return canonicalizeWebHost(raw, { schemes: CONNECT_SCHEMES });
}

export function isCanonicalConnectHost(raw) {
  return isCanonicalWebHost(raw, { schemes: CONNECT_SCHEMES });
}

/**
 * Canonicalizes a scheme-aware non-HTTP network endpoint (Section 3.3.4),
 * for example an IMAP mailbox host. Unlike the web grammar: the scheme is
 * REQUIRED (there is no implied protocol to fall back to), no wildcard is
 * allowed (an endpoint names one account's exact host), and an omitted port
 * is accepted only when the scheme has a listed default port.
 *
 * @param {string} raw
 * @returns {string} the canonical form
 * @throws {GrammarError}
 */
export function canonicalizeEndpoint(raw) {
  assertNoWhitespaceOrControl(raw);
  const { scheme, rest } = splitScheme(raw);
  if (scheme === null) {
    throw new GrammarError("a non-HTTP endpoint must state its scheme explicitly");
  }
  if (CONNECT_SCHEMES.has(scheme)) {
    throw new GrammarError(`scheme '${scheme}' is an HTTP or WebSocket scheme; use canonicalizeWebHost or canonicalizeConnectHost`);
  }
  const { host, port } = canonicalizeHostAndPort(rest, { scheme, allowWildcard: false });
  if (port === "" && DEFAULT_PORTS[scheme] === undefined) {
    throw new GrammarError(`scheme '${scheme}' has no known default port; state the port explicitly`);
  }
  const portSuffix = port === "" ? "" : `:${port}`;
  return `${scheme}://${host}${portSuffix}`;
}

export function isCanonicalEndpoint(raw) {
  try {
    return canonicalizeEndpoint(raw) === raw;
  } catch {
    return false;
  }
}

/**
 * Canonicalizes one entry of a `network` binding's `hosts` list (Section
 * 3.3.4), dispatching to the web or endpoint grammar by scheme. A bare host
 * with no scheme, or an `http`/`https` scheme, uses the web grammar
 * (wildcard allowed). Any other explicit scheme uses the endpoint grammar.
 *
 * @param {string} raw
 * @returns {string}
 * @throws {GrammarError}
 */
export function canonicalizeNetworkHost(raw) {
  assertNoWhitespaceOrControl(raw);
  const { scheme } = splitScheme(raw);
  if (scheme === null || WEB_SCHEMES.has(scheme)) return canonicalizeWebHost(raw);
  return canonicalizeEndpoint(raw);
}

export function isCanonicalNetworkHost(raw) {
  try {
    return canonicalizeNetworkHost(raw) === raw;
  } catch {
    return false;
  }
}

/**
 * Resolves the `filesystem.inputs` alias (Section 3.3.5): a filesystem-kind
 * binding instance can declare its inputs at the legacy top-level `inputs`
 * member, at `constraints.inputs`, at both, or at neither. When both are
 * present they MUST describe the same inputs; this normalizes them to one
 * array (order-independent, keyed by `env_var`) and throws when they
 * disagree. JSON Schema cannot express this cross-field equality, so it is
 * checked here instead.
 *
 * @param {{ inputs?: unknown[], constraints?: { inputs?: unknown[] } }} instance
 * @returns {unknown[] | undefined} the normalized inputs, or undefined when neither form is present
 * @throws {GrammarError} when both forms are present and disagree
 */
/**
 * Structural equality for plain JSON values (objects, arrays, strings,
 * numbers, booleans, null). Unlike `JSON.stringify(a) === JSON.stringify(b)`,
 * this does not depend on an object's member order -- two filesystem input
 * entries with the same fields written in a different key order compare
 * equal. Array element order still matters (an array is an ordered list,
 * e.g. `accepted_extensions`, and reordering it is a real difference).
 */
export function deepEqualJson(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    return a.length === b.length && a.every((value, i) => deepEqualJson(value, b[i]));
  }
  if (typeof a === "object") {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    return keysA.length === keysB.length && keysA.every((key) => Object.hasOwn(b, key) && deepEqualJson(a[key], b[key]));
  }
  return false;
}

export function normalizeFilesystemInputs(instance) {
  const topLevel = instance?.inputs;
  const nested = instance?.constraints?.inputs;
  if (topLevel === undefined) return nested;
  if (nested === undefined) return topLevel;

  const byEnvVar = (list) => {
    const map = new Map();
    for (const entry of list) map.set(entry?.env_var, entry);
    return map;
  };
  const a = byEnvVar(topLevel);
  const b = byEnvVar(nested);
  const sameKeys = a.size === b.size && [...a.keys()].every((key) => b.has(key));
  const sameEntries = sameKeys && [...a.entries()].every(([key, value]) => deepEqualJson(value, b.get(key)));
  if (!sameEntries) {
    throw new GrammarError("filesystem.inputs and constraints.inputs disagree; declare one, or make both equal");
  }
  return topLevel;
}

/**
 * Finds duplicate JSON object keys in raw manifest text. `JSON.parse`
 * silently keeps the last value for a repeated key, which hides an author
 * or generator mistake and is a real interop hazard: two readers could
 * reasonably disagree about which value won. This performs its own
 * lightweight tokenization so the check runs on the text as written, not on
 * the already-collapsed object.
 *
 * @param {string} jsonText
 * @returns {Array<{ path: string, key: string }>} every duplicate found
 */
export function findDuplicateJsonKeys(jsonText) {
  const duplicates = [];
  const stack = []; // { kind: "object"|"array", keys?: Set<string>, path: string, index?: number }
  let i = 0;
  const n = jsonText.length;

  function skipWhitespace() {
    while (i < n && /\s/.test(jsonText[i])) i += 1;
  }

  function readString() {
    // Assumes jsonText[i] === '"'.
    const start = i;
    i += 1;
    while (i < n) {
      const c = jsonText[i];
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === '"') {
        i += 1;
        return JSON.parse(jsonText.slice(start, i));
      }
      i += 1;
    }
    throw new GrammarError("unterminated string in JSON text");
  }

  // The path a newly opened `{` or `[` should take: the path of the key (in
  // an object) or index (in an array) whose value it is. `null` at the
  // document root.
  let pendingPath = "$";

  function childPath(parentTop, segment) {
    if (!parentTop) return "$";
    return parentTop.path === "$" ? String(segment) : `${parentTop.path}.${segment}`;
  }

  skipWhitespace();
  while (i < n) {
    const c = jsonText[i];
    const top = stack[stack.length - 1];
    if (c === "{") {
      stack.push({ kind: "object", keys: new Set(), path: pendingPath });
      i += 1;
    } else if (c === "[") {
      // Array element paths are not tracked per-index: a duplicate *key*
      // can occur only inside an object, so the generic "[]" segment below
      // is precise enough for this check's error messages.
      stack.push({ kind: "array", path: pendingPath });
      pendingPath = childPath({ path: pendingPath }, "[]");
      i += 1;
    } else if (c === "}" || c === "]") {
      stack.pop();
      i += 1;
    } else if (c === '"') {
      const str = readString();
      if (top?.kind === "object") {
        skipWhitespace();
        if (jsonText[i] === ":") {
          // This string is a key, not a value.
          if (top.keys.has(str)) {
            duplicates.push({ path: childPath(top, str), key: str });
          } else {
            top.keys.add(str);
          }
          pendingPath = childPath(top, str);
        }
      }
    } else if (c === ":" || c === ",") {
      i += 1;
    } else {
      // number, true, false, null -- skip to the next structural character.
      i += 1;
    }
    skipWhitespace();
  }

  return duplicates;
}
