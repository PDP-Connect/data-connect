// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Canonical connector-key helpers.
 *
 * The reference implementation addresses a connector by a short, path-safe
 * key (`gmail`, `claude-code`, ...). A connector manifest can also spell its
 * identity as a registry URL (`https://registry.pdpp.dev/connectors/<slug>`).
 * This module turns either spelling into the key.
 *
 * The functions carry no connector list. Any connector, including one
 * installed from the signed catalog after this server was built, gets the
 * same key it would get if it shipped in the repository. They do not decide
 * whether a connector is allowed; install, setup, scheduling and consent
 * decide that from the manifest.
 *
 * `FIRST_PARTY_CONNECTOR_KEYS` stays for two uses that do not gate behavior:
 * the test that every vendored manifest is registered, and the rule that a
 * connector's own tuning-environment namespace must not shadow a vendored
 * connector's.
 *
 * Keep this module pure (no DB, no fs, no network) so it stays cheap to
 * unit-test and safe to import from any layer.
 */

import { FIRST_PARTY_CONNECTOR_KEYS } from "./generated/connector-registry.generated.ts";

const FIRST_PARTY_REGISTRY_PREFIX = "https://registry.pdpp.dev/connectors/";

// FIRST_PARTY_CONNECTOR_KEYS is generated from the shipped connector manifests;
// see connector-registry.generated.ts and scripts/generate-connector-registry.ts.

const CONNECTOR_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

function trimOrNull(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Return the connector key for a registry URL
 * (`https://registry.pdpp.dev/connectors/<slug>`), or `null` if `value` is
 * not one.
 *
 * Trailing slashes are tolerated to match common copy/paste behavior, but
 * any additional path segments, query string, or fragment cause `null`.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
export function connectorKeyFromRegistryUrl(value: unknown): string | null {
  const trimmed = trimOrNull(value);
  if (!trimmed) {
    return null;
  }
  if (!trimmed.startsWith(FIRST_PARTY_REGISTRY_PREFIX)) {
    return null;
  }
  let tail = trimmed.slice(FIRST_PARTY_REGISTRY_PREFIX.length);
  // Tolerate one trailing slash, but reject anything past it.
  if (tail.endsWith("/")) {
    tail = tail.slice(0, -1);
  }
  if (!tail || tail.includes("/") || tail.includes("?") || tail.includes("#")) {
    return null;
  }
  // A slug is a connector key. Reject what isConnectorKey rejects (whitespace,
  // backslashes, dot segments, percent escapes) so a malformed URL tail never
  // becomes a stored or routed id.
  if (!CONNECTOR_KEY_PATTERN.test(tail)) {
    return null;
  }
  return tail;
}

/**
 * Return the connector key for an operational `connector_id` value, or
 * `null` for empty or non-string input and for a malformed registry URL.
 *
 *   - registry URL: its slug (`https://registry.pdpp.dev/connectors/gmail`
 *     becomes `gmail`), whether or not the slug ships in this repository
 *   - anything else: the trimmed value
 *
 * Pure function: no DB, no I/O, no caching.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
export function canonicalConnectorKey(value: unknown): string | null {
  const trimmed = trimOrNull(value);
  if (!trimmed) {
    return null;
  }
  if (trimmed.startsWith(FIRST_PARTY_REGISTRY_PREFIX)) {
    return connectorKeyFromRegistryUrl(trimmed);
  }
  return trimmed;
}

/**
 * True iff `value` is a syntactically valid operational connector key. Keys
 * must stay short and path-safe and must not be registry/document URLs.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isConnectorKey(value: unknown): boolean {
  const trimmed = trimOrNull(value);
  if (!trimmed) {
    return false;
  }
  return CONNECTOR_KEY_PATTERN.test(trimmed) && !isRegistryUrlConnectorId(trimmed);
}

/**
 * Derive the canonical connector key from a parsed connector manifest
 * object. Reads explicit top-level `connector_key` first, then falls back
 * to top-level `connector_id` (legacy polyfill-style manifest), then
 * `storage_binding.connector_id` (native-style reference manifest). Returns
 * `null` if no accepted identity field yields a key.
 *
 * A registry-URL `connector_id` yields its slug, so a manifest that declares
 * only the URL still gets a key.
 *
 * @param {unknown} manifest
 * @returns {string | null}
 */
export function canonicalConnectorKeyFromManifest(manifest: unknown): string | null {
  if (!manifest || typeof manifest !== "object") {
    return null;
  }
  const record = manifest as Record<string, unknown>;
  if (isConnectorKey(record.connector_key)) {
    // isConnectorKey already proved record.connector_key is a non-empty
    // string via trimOrNull; re-deriving through the same helper avoids an
    // `as string` assertion on the narrowed-but-not-narrowed-by-TS value.
    const trimmed = trimOrNull(record.connector_key);
    if (trimmed) {
      return trimmed;
    }
  }
  const topLevel = canonicalConnectorKey(record.connector_id);
  if (topLevel) {
    return topLevel;
  }
  const storageBinding = record.storage_binding;
  if (storageBinding && typeof storageBinding === "object") {
    return canonicalConnectorKey((storageBinding as Record<string, unknown>).connector_id);
  }
  return null;
}

/**
 * True iff `value` is a registry-URL connector id. Used by call sites that
 * want to detect "this looks like a registry URL — refuse it on an active
 * surface".
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isRegistryUrlConnectorId(value: unknown): boolean {
  const trimmed = trimOrNull(value);
  if (!trimmed) {
    return false;
  }
  return trimmed.startsWith(FIRST_PARTY_REGISTRY_PREFIX);
}

// Connector id substrings that identify test/stub/internal connectors that
// should not appear in owner-facing pickers or public surfaces. Matches the
// same set filtered by `isPublicReferenceConnector` in ref-control.ts for
// catalog visibility; kept here so pure connector-key helpers can apply the
// same guard without importing TypeScript modules.
const INTERNAL_CONNECTOR_ID_PARTS = Object.freeze([
  "manual_action_stub",
  "manual-action-stub",
  "stream-test-stub",
  "pg_runtime_",
  "pg_canonical_",
  "pg_expand_",
  "pg_lexical_backfill_",
]);

/**
 * True iff `value` contains a marker substring that identifies a test,
 * stub, or internal connector that must not appear in owner-facing consent
 * pickers or user-visible surfaces. Returns false for null/non-string inputs
 * (fail open — unknown ids are not silently excluded).
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isInternalConnectorId(value: unknown): boolean {
  const trimmed = trimOrNull(value);
  if (!trimmed) {
    return false;
  }
  return INTERNAL_CONNECTOR_ID_PARTS.some((part) => trimmed.includes(part));
}

/**
 * Read-only getters. Returned arrays/objects are frozen so callers cannot
 * accidentally mutate the shared tables.
 */
export function firstPartyConnectorKeys() {
  return FIRST_PARTY_CONNECTOR_KEYS;
}
