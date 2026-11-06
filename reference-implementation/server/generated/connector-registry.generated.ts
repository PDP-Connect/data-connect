// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// GENERATED FILE — do not hand-edit. Produced by
// reference-implementation/scripts/generate-connector-registry.ts from the
// shipped connector manifests (packages/polyfill-connectors/manifests/,
// reference-implementation/fixtures/seed-manifests/) and
// @pdpp/polyfill-connectors's LOCAL_COLLECTOR_DEFINITIONS. Regenerate with
// `pnpm --filter pdpp-reference-implementation run generate:connector-registry`.
// scripts/check-generated-artifacts.ts fails CI if this file drifts from
// what the generator would produce for the manifests currently on disk —
// this is how the RI's setup/proof-gate classification stays manifest-derived
// instead of a hand-maintained connector-id allowlist. See
// docs/inbox/findings-deployment-env-vars.md (Cluster B).

/** Every first-party manifest's canonical connector_key. */
export const FIRST_PARTY_CONNECTOR_KEYS: readonly string[] = Object.freeze(["amazon", "anthropic", "apple-contacts", "apple-health", "apple-photos", "chase", "chatgpt", "claude-code", "codex", "doordash", "github", "gmail", "google-calendar", "google-contacts", "google-maps", "google-maps-data-portability", "google-messages", "google-takeout", "groupme", "heb", "ical", "imessage", "jellyfin", "linkedin", "loom", "meta", "netflix-export", "notion", "oura", "pocket", "reddit", "shopify", "signal", "slack", "spotify", "steam", "strava", "twitter-archive", "uber", "usaa", "venmo", "whatsapp", "wholefoods", "whoop", "ynab"]);

/** Known unconditional collect stubs from the pinned conformance roster. */
export const KNOWN_SCAFFOLD_KEYS: readonly string[] = Object.freeze(["anthropic", "doordash", "linkedin", "loom", "meta", "shopify", "uber", "wholefoods"]);

/** Native (storage_binding.connector_id) reference-fixture connector keys. */
export const NATIVE_CONNECTOR_KEYS: readonly string[] = Object.freeze(["northstar_hr_native"]);

/**
 * Legacy snake_case local-collector bundle id -> canonical manifest
 * connector_key, wherever the two differ. Derived by cross-referencing
 * LOCAL_COLLECTOR_DEFINITIONS (the bundle's own directory-name ids) against
 * each connector's manifest-declared connector_key.
 */
export const LEGACY_LOCAL_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  "apple_photos": "apple-photos",
  "claude_code": "claude-code",
  "codex": "codex",
  "google_messages": "google-messages",
  "google_takeout": "google-takeout",
  "imessage": "imessage",
});

/** Manifests declaring capabilities.proven.local_collector === true. */
export const LOCAL_COLLECTOR_PROVEN_KEYS: readonly string[] = Object.freeze(["claude-code", "codex", "google-takeout", "imessage", "apple-photos", "google-messages"]);

/** Manifests declaring a runtime_requirements.bindings.browser binding. */
export const BROWSER_BOUND_KEYS: readonly string[] = Object.freeze(["amazon", "anthropic", "chase", "chatgpt", "doordash", "heb", "linkedin", "loom", "meta", "reddit", "shopify", "uber", "usaa", "venmo", "wholefoods", "whoop"]);

/** Manifests declaring capabilities.proven.provider_auth_lifecycle === true. */
export const PROVIDER_AUTH_LIFECYCLE_PROVEN_KEYS: readonly string[] = Object.freeze(["google-calendar", "google-contacts", "google-maps-data-portability"]);

/** Manifests declaring capabilities.proven.static_secret_live.proven === true. */
export const STATIC_SECRET_LIVE_PROVEN_KEYS: readonly string[] = Object.freeze(["github", "gmail", "slack", "ynab"]);

/** Reviewed historical source bindings derived from the pinned connector package. */
export const LEGACY_FIRST_PARTY_SOURCE_ENTRIES: readonly (readonly [string, string])[] = Object.freeze(([["amazon", "https://registry.pdpp.dev/connectors/amazon"], ["anthropic", "https://registry.pdpp.dev/connectors/anthropic"], ["apple-contacts", "https://registry.pdpp.dev/connectors/apple-contacts"], ["apple-health", "https://registry.pdpp.dev/connectors/apple-health"], ["apple-photos", "https://registry.pdpp.dev/connectors/apple-photos"], ["chase", "https://registry.pdpp.dev/connectors/chase"], ["chatgpt", "https://registry.pdpp.dev/connectors/chatgpt"], ["claude-code", "https://registry.pdpp.dev/connectors/claude-code"], ["codex", "https://registry.pdpp.dev/connectors/codex"], ["doordash", "https://registry.pdpp.dev/connectors/doordash"], ["github", "https://registry.pdpp.dev/connectors/github"], ["gmail", "https://registry.pdpp.dev/connectors/gmail"], ["google-calendar", "https://registry.pdpp.dev/connectors/google-calendar"], ["google-contacts", "https://registry.pdpp.dev/connectors/google-contacts"], ["google-maps", "https://registry.pdpp.dev/connectors/google-maps"], ["google-maps-data-portability", "https://registry.pdpp.dev/connectors/google-maps-data-portability"], ["google-messages", "https://registry.pdpp.dev/connectors/google-messages"], ["google-takeout", "https://registry.pdpp.dev/connectors/google-takeout"], ["groupme", "https://registry.pdpp.dev/connectors/groupme"], ["heb", "https://registry.pdpp.dev/connectors/heb"], ["ical", "https://registry.pdpp.dev/connectors/ical"], ["imessage", "https://registry.pdpp.dev/connectors/imessage"], ["jellyfin", "https://registry.pdpp.dev/connectors/jellyfin"], ["linkedin", "https://registry.pdpp.dev/connectors/linkedin"], ["loom", "https://registry.pdpp.dev/connectors/loom"], ["meta", "https://registry.pdpp.dev/connectors/meta"], ["netflix-export", "https://registry.pdpp.dev/connectors/netflix-export"], ["notion", "https://registry.pdpp.dev/connectors/notion"], ["oura", "https://registry.pdpp.dev/connectors/oura"], ["pocket", "https://registry.pdpp.dev/connectors/pocket"], ["reddit", "https://registry.pdpp.dev/connectors/reddit"], ["shopify", "https://registry.pdpp.dev/connectors/shopify"], ["signal", "https://registry.pdpp.dev/connectors/signal"], ["slack", "https://registry.pdpp.dev/connectors/slack"], ["spotify", "https://registry.pdpp.dev/connectors/spotify"], ["steam", "https://registry.pdpp.dev/connectors/steam"], ["strava", "https://registry.pdpp.dev/connectors/strava"], ["twitter-archive", "https://registry.pdpp.dev/connectors/twitter-archive"], ["uber", "https://registry.pdpp.dev/connectors/uber"], ["usaa", "https://registry.pdpp.dev/connectors/usaa"], ["venmo", "https://registry.pdpp.dev/connectors/venmo"], ["whatsapp", "https://registry.pdpp.dev/connectors/whatsapp"], ["wholefoods", "https://registry.pdpp.dev/connectors/wholefoods"], ["whoop", "https://registry.pdpp.dev/connectors/whoop"], ["ynab", "https://registry.pdpp.dev/connectors/ynab"]] as [string, string][]).map(([key, sourceId]) => Object.freeze([key, sourceId] as const)));
