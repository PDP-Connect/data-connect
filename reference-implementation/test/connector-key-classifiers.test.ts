// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit coverage for the UNTESTED connector-key normalization + catalog
 * classification helpers in `server/connection-setup-plan.ts`. These shape how
 * the reference resolves a connector's canonical key from a manifest/registry
 * id and gate proven-lifecycle / supported-collector / browser-bound behavior.
 * None were covered by name (only `canonicalConnectorKey` was used incidentally
 * by other tests, never asserted directly).
 *
 * Contracts pinned:
 *   - canonicalConnectorKey: trims, and strips the
 *     `https://registry.pdpp.dev/connectors/<key>/` first-party registry prefix
 *     (and a trailing slash) down to the bare key.
 *   - connectorKeyFromManifest: connector_key → connector_id → explicit fallback
 *     → null; canonicalized; blanks skipped.
 *   - enrollmentKeyForCanonicalKey: identity except `claude-code` → `claude_code`.
 *   - displayNameForConnector: manifest.display_name → manifest.name → the key.
 *   - isProviderAuthLifecycleProven / isStaticSecretLiveProven: the claim in
 *     the connector's own manifest (`capabilities.proven`), never a key list.
 *   - isLocalCollectorProven: the manifest's `capabilities.proven.local_collector`.
 *   - classifyConnectorIntentModality: browser-bound from the manifest's bindings.
 *
 * Pure classification over shipped connector capability data — no DB, no
 * server, no fixtures.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalConnectorKey,
  classifyConnectorIntentModality,
  connectorKeyFromManifest,
  displayNameForConnector,
  enrollmentKeyForCanonicalKey,
  isLocalCollectorProven,
  isProviderAuthLifecycleProven,
  isStaticSecretLiveProven,
} from "../server/connection-setup-plan.ts";

// --- canonicalConnectorKey --------------------------------------------------

test("canonicalConnectorKey: trims and strips the first-party registry prefix + trailing slash", () => {
  assert.equal(canonicalConnectorKey("gmail"), "gmail", "bare key unchanged");
  assert.equal(canonicalConnectorKey("  gmail  "), "gmail", "trims surrounding whitespace");
  assert.equal(canonicalConnectorKey("https://registry.pdpp.dev/connectors/gmail"), "gmail", "strips registry prefix");
  assert.equal(
    canonicalConnectorKey("  https://registry.pdpp.dev/connectors/github/  "),
    "github",
    "strips prefix + trailing slash after trimming"
  );
  assert.equal(
    canonicalConnectorKey("https://example.com/other/thing"),
    "https://example.com/other/thing",
    "non-first-party url is left intact"
  );
});

// --- connectorKeyFromManifest -----------------------------------------------

test("connectorKeyFromManifest: prefers connector_key, canonicalized", () => {
  assert.equal(connectorKeyFromManifest({ connector_id: "other", connector_key: "  gmail  " }), "gmail");
  assert.equal(
    connectorKeyFromManifest({ connector_id: "https://registry.pdpp.dev/connectors/slack" }),
    "slack",
    "a registry-URL connector_id yields its slug"
  );
});

test("connectorKeyFromManifest: falls back connector_id -> explicit fallback -> null", () => {
  assert.equal(connectorKeyFromManifest({ connector_id: "github" }), "github", "uses connector_id");
  assert.equal(connectorKeyFromManifest({ connector_key: "   " }, "slack"), "slack", "blank key => fallback arg");
  assert.equal(connectorKeyFromManifest({}), null, "nothing => null");
  assert.equal(connectorKeyFromManifest({}, null), null, "null fallback => null");
});

// --- enrollmentKeyForCanonicalKey -------------------------------------------

test("enrollmentKeyForCanonicalKey: maps claude-code to claude_code, else identity", () => {
  assert.equal(enrollmentKeyForCanonicalKey("claude-code"), "claude_code", "the one special case");
  assert.equal(
    enrollmentKeyForCanonicalKey("https://registry.pdpp.dev/connectors/claude-code"),
    "claude_code",
    "canonicalizes first, then maps"
  );
  assert.equal(enrollmentKeyForCanonicalKey("codex"), "codex", "other keys unchanged");
  assert.equal(enrollmentKeyForCanonicalKey("gmail"), "gmail");
});

// --- displayNameForConnector ------------------------------------------------

test("displayNameForConnector: display_name -> name -> the key", () => {
  assert.equal(displayNameForConnector("gmail", { display_name: "Gmail Mail", name: "GM" }), "Gmail Mail");
  assert.equal(displayNameForConnector("gmail", { name: "GM" }), "GM", "falls back to name");
  assert.equal(displayNameForConnector("gmail", { display_name: "   " }), "gmail", "blank display_name => key");
  assert.equal(displayNameForConnector("gmail", null), "gmail", "no manifest => key");
});

// --- isProviderAuthLifecycleProven ------------------------------------------

test("isProviderAuthLifecycleProven: reads the manifest's own claim, strictly true", () => {
  assert.equal(isProviderAuthLifecycleProven({ capabilities: { proven: { provider_auth_lifecycle: true } } }), true);
  assert.equal(isProviderAuthLifecycleProven({ capabilities: { proven: { provider_auth_lifecycle: false } } }), false);
  assert.equal(isProviderAuthLifecycleProven({ capabilities: { proven: { provider_auth_lifecycle: "true" } } }), false);
  assert.equal(isProviderAuthLifecycleProven({ capabilities: {} }), false, "no proven block");
  assert.equal(isProviderAuthLifecycleProven(null), false, "no manifest");
});

// --- isStaticSecretLiveProven -----------------------------------------------

test("isStaticSecretLiveProven: reads capabilities.proven.static_secret_live.proven, strictly true", () => {
  assert.equal(isStaticSecretLiveProven({ capabilities: { proven: { static_secret_live: { proven: true } } } }), true);
  assert.equal(isStaticSecretLiveProven({ capabilities: { proven: { static_secret_live: { proven: false } } } }), false);
  assert.equal(isStaticSecretLiveProven({ capabilities: { proven: { static_secret_live: {} } } }), false);
  assert.equal(isStaticSecretLiveProven(undefined), false, "no manifest");
});

// --- isLocalCollectorProven -------------------------------------------------

test("isLocalCollectorProven: reads capabilities.proven.local_collector, strictly true", () => {
  assert.equal(isLocalCollectorProven({ capabilities: { proven: { local_collector: true } } }), true);
  assert.equal(isLocalCollectorProven({ capabilities: { proven: { local_collector: false } } }), false);
  assert.equal(isLocalCollectorProven({ capabilities: { proven: { local_collector: 1 } } }), false);
  assert.equal(isLocalCollectorProven(null), false, "no manifest");
});

// --- classifyConnectorIntentModality ----------------------------------------

test("classifyConnectorIntentModality: browser-bound comes from the manifest's own bindings", () => {
  const browserManifest = { runtime_requirements: { bindings: { browser: { required: true } } } };
  assert.equal(classifyConnectorIntentModality(browserManifest), "browser_bound");
  assert.notEqual(
    classifyConnectorIntentModality({ runtime_requirements: { bindings: { network: {} } } }),
    "browser_bound",
    "a manifest that declares no browser binding is not browser-bound"
  );
  assert.equal(classifyConnectorIntentModality(null), "unknown", "no manifest");
});
