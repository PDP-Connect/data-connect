// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the canonical connector-key helpers.
 *
 * These pin the registry-URL to key normalization and the rule that no
 * connector list decides a key: a connector this repository does not ship
 * resolves like one it does, and a retired underscore id is not rewritten.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readPolyfillManifests } from "@pdpp/polyfill-connectors/manifests";

import {
  canonicalConnectorKey,
  canonicalConnectorKeyFromManifest,
  connectorKeyFromRegistryUrl,
  firstPartyConnectorKeys,
  isConnectorKey,
  isInternalConnectorId,
  isRegistryUrlConnectorId,
} from "../server/connector-key.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_MANIFESTS_DIR = resolve(__dirname, "..", "fixtures", "seed-manifests");

const REGISTRY_PREFIX = "https://registry.pdpp.dev/connectors/";

interface ManifestFileEntry {
  name: string;
  manifest: Record<string, unknown>;
}

/** Every manifest under a real repo-relative directory (the reference-fixture
 * manifests root), read and parsed. Malformed entries are skipped. */
function readManifestsFromDir(dir: string): ManifestFileEntry[] {
  const out: ManifestFileEntry[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) {
      continue;
    }
    try {
      out.push({ manifest: JSON.parse(readFileSync(join(dir, name), "utf8")), name });
    } catch {
      // Skip: not this function's job to validate manifest well-formedness.
    }
  }
  return out;
}

/** Every manifest `@pdpp/polyfill-connectors` ships, in the same
 * `{ name, manifest }` shape `readManifestsFromDir` produces for the
 * reference-fixture root, so both sources compose identically below. */
function readShippedPolyfillManifestEntries(): ManifestFileEntry[] {
  return readPolyfillManifests().map((entry) => ({
    manifest: entry.manifest as Record<string, unknown>,
    name: entry.file,
  }));
}

test("connectorKeyFromRegistryUrl returns the canonical slug for every first-party URL", () => {
  for (const key of firstPartyConnectorKeys()) {
    assert.equal(connectorKeyFromRegistryUrl(`${REGISTRY_PREFIX}${key}`), key, `expected ${key} round-trip`);
  }
});

test("connectorKeyFromRegistryUrl returns the slug of a connector this repository does not ship", () => {
  assert.equal(connectorKeyFromRegistryUrl(`${REGISTRY_PREFIX}fictional`), "fictional");
});

test("connectorKeyFromRegistryUrl rejects malformed URLs", () => {
  // Wrong host or scheme.
  assert.equal(connectorKeyFromRegistryUrl("http://registry.pdpp.dev/connectors/gmail"), null);
  assert.equal(connectorKeyFromRegistryUrl("https://other.example/connectors/gmail"), null);
  // Extra path segments / query / fragment.
  assert.equal(connectorKeyFromRegistryUrl(`${REGISTRY_PREFIX}gmail/extra`), null);
  assert.equal(connectorKeyFromRegistryUrl(`${REGISTRY_PREFIX}gmail?x=1`), null);
  assert.equal(connectorKeyFromRegistryUrl(`${REGISTRY_PREFIX}gmail#frag`), null);
  // Empty / non-string.
  assert.equal(connectorKeyFromRegistryUrl(""), null);
  assert.equal(connectorKeyFromRegistryUrl("   "), null);
  assert.equal(connectorKeyFromRegistryUrl(null), null);
  assert.equal(connectorKeyFromRegistryUrl(undefined), null);
  assert.equal(connectorKeyFromRegistryUrl(42), null);
});

test("connectorKeyFromRegistryUrl tolerates one trailing slash", () => {
  assert.equal(connectorKeyFromRegistryUrl(`${REGISTRY_PREFIX}gmail/`), "gmail");
  // Two trailing slashes look like an extra empty segment — reject.
  assert.equal(connectorKeyFromRegistryUrl(`${REGISTRY_PREFIX}gmail//`), null);
});

test("a registry URL whose tail is not a connector key gives no key", () => {
  for (const tail of ["gmail\\extra", "..", ".", "bad key", "gmail%2Fextra", "Gmail", "-gmail"]) {
    assert.equal(connectorKeyFromRegistryUrl(`${REGISTRY_PREFIX}${tail}`), null, tail);
    assert.equal(canonicalConnectorKey(`${REGISTRY_PREFIX}${tail}`), null, tail);
    assert.equal(canonicalConnectorKeyFromManifest({ connector_id: `${REGISTRY_PREFIX}${tail}` }), null, tail);
  }
});

test("canonicalConnectorKey accepts a bare first-party slug", () => {
  for (const key of firstPartyConnectorKeys()) {
    assert.equal(canonicalConnectorKey(key), key);
  }
});

test("canonicalConnectorKey passes native bare slugs through", () => {
  // Native reference manifests carry their key in storage_binding.connector_id.
  const nativeKeys = readManifestsFromDir(REFERENCE_MANIFESTS_DIR).flatMap(({ manifest }) => {
    const binding = manifest.storage_binding as { connector_id?: unknown } | undefined;
    return typeof binding?.connector_id === "string" ? [binding.connector_id] : [];
  });
  assert.ok(nativeKeys.length > 0, "the reference fixtures must include a native-binding manifest");
  for (const key of nativeKeys) {
    assert.equal(canonicalConnectorKey(key), key);
  }
});

test("canonicalConnectorKey does not rewrite a retired underscore id to its current key", () => {
  // The four ids older collectors spelled with underscores are plain unknown
  // ids now: nothing at runtime maps one to the other, and a lookup under the
  // old id finds nothing (see retired-connector-id-lookup.test.ts).
  for (const retired of ["apple_photos", "claude_code", "google_messages", "google_takeout"]) {
    assert.equal(canonicalConnectorKey(retired), retired);
    assert.equal(isConnectorKey(retired), true, "still a well-formed key, just not a registered connector");
    assert.ok(!firstPartyConnectorKeys().includes(retired), `${retired} is not a vendored connector key`);
  }
  for (const current of ["apple-photos", "claude-code", "google-messages", "google-takeout"]) {
    assert.equal(canonicalConnectorKey(current), current);
    assert.ok(firstPartyConnectorKeys().includes(current), `${current} is a vendored connector key`);
  }
});

test("bundled local-collector connector ids all resolve to a canonical key the manifest catalog also resolves (alias/canonical equivalence)", async () => {
  // Discriminator for the enrollment-boundary identity bug this branch fixed:
  // every id LOCAL_COLLECTOR_DEFINITIONS bundles (what --connector actually
  // receives, and what the enrollment-codes route's raw connector_id param
  // carries) must canonicalize to the SAME key the connector's own manifest
  // declares as connector_key — proving the enrollment boundary and the
  // manifest catalog agree, not just that each individually parses. A
  // connector whose bundle id and manifest key differ without an alias here
  // reproduces the "no registered manifest declares a 'filesystem' or
  // 'browser' binding" 400 the google_takeout enroll smoke hit.
  const { LOCAL_COLLECTOR_DEFINITIONS } = await import("@pdpp/polyfill-connectors/collectors");
  for (const definition of LOCAL_COLLECTOR_DEFINITIONS) {
    const manifestEntry = readPolyfillManifests().find(
      (candidate) => candidate.file === `${definition.entry}.json`
    );
    if (!manifestEntry) {
      throw new Error(`no polyfill manifest found for ${definition.entry}.json`);
    }
    const manifest = manifestEntry.manifest as { connector_key?: string; connector_id?: string };
    const manifestCanonicalKey = manifest.connector_key ?? canonicalConnectorKey(manifest.connector_id);
    const bundleIdCanonicalKey = canonicalConnectorKey(definition.connector_id);
    assert.ok(
      manifestCanonicalKey,
      `${definition.connector_id}: manifest must declare a resolvable connector_key/connector_id`
    );
    assert.ok(
      bundleIdCanonicalKey,
      `${definition.connector_id}: bundle connector_id must canonicalize`
    );
    if (definition.connector_id.replaceAll("_", "-") === manifestCanonicalKey) {
      // The pinned @pdpp/polyfill-connectors tarball still bundles the four
      // underscore spellings. The server no longer rewrites them, so the only
      // acceptable gap is the underscore spelling of the manifest key; refresh
      // the pin and this branch goes dead.
      continue;
    }
    assert.equal(
      bundleIdCanonicalKey,
      manifestCanonicalKey,
      `${definition.connector_id}: bundled connector_id canonicalizes to '${bundleIdCanonicalKey}' but the manifest's own key is '${manifestCanonicalKey}' — the enrollment boundary and the manifest catalog would disagree`
    );
  }
});

test("canonicalConnectorKey accepts URL-shaped first-party ids", () => {
  for (const key of firstPartyConnectorKeys()) {
    assert.equal(canonicalConnectorKey(`${REGISTRY_PREFIX}${key}`), key);
  }
});

test("isConnectorKey accepts operational keys and rejects URLs", () => {
  assert.equal(isConnectorKey("gmail"), true);
  assert.equal(isConnectorKey("claude-code"), true);
  assert.equal(isConnectorKey("northstar_hr_native"), true);
  assert.equal(isConnectorKey(`${REGISTRY_PREFIX}gmail`), false);
  assert.equal(isConnectorKey(""), false);
  assert.equal(isConnectorKey("  "), false);
  assert.equal(isConnectorKey("bad/key"), false);
  assert.equal(isConnectorKey(null), false);
});

test("canonicalConnectorKey gives a connector this repository does not ship the same key it would get if it did", () => {
  // No list stands behind the answer: a connector installed from the catalog
  // after this server was built resolves exactly like a vendored one.
  assert.equal(canonicalConnectorKey(`${REGISTRY_PREFIX}unknown-thing`), "unknown-thing");
  assert.equal(canonicalConnectorKey(`${REGISTRY_PREFIX}unknown-thing/`), "unknown-thing");
  assert.equal(canonicalConnectorKey("unknown-thing"), "unknown-thing");
  assert.equal(canonicalConnectorKey("custom_provider"), "custom_provider");
});

test("canonicalConnectorKey rejects empty input and malformed registry URLs", () => {
  assert.equal(canonicalConnectorKey(`${REGISTRY_PREFIX}gmail/extra`), null);
  assert.equal(canonicalConnectorKey(`${REGISTRY_PREFIX}`), null);
  assert.equal(canonicalConnectorKey("   "), null);
  assert.equal(canonicalConnectorKey(""), null);
  assert.equal(canonicalConnectorKey(null), null);
  assert.equal(canonicalConnectorKey(undefined), null);
  assert.equal(canonicalConnectorKey({}), null);
});

test("canonicalConnectorKey leaves a URL on another host as it is", () => {
  assert.equal(canonicalConnectorKey("https://other.example/connectors/gmail"), "https://other.example/connectors/gmail");
});

test("canonicalConnectorKey trims surrounding whitespace before lookup", () => {
  assert.equal(canonicalConnectorKey("  gmail  "), "gmail");
  assert.equal(canonicalConnectorKey("\tclaude-code\n"), "claude-code");
  assert.equal(canonicalConnectorKey("\tclaude_code\n"), "claude_code", "trims, and does not rewrite a retired id");
});

test("isRegistryUrlConnectorId reports the URL shape for any slug", () => {
  assert.equal(isRegistryUrlConnectorId(`${REGISTRY_PREFIX}gmail`), true);
  assert.equal(isRegistryUrlConnectorId(`${REGISTRY_PREFIX}unknown`), true);
  assert.equal(isRegistryUrlConnectorId("gmail"), false);
  assert.equal(isRegistryUrlConnectorId("https://other.example/connectors/gmail"), false);
  assert.equal(isRegistryUrlConnectorId(null), false);
});

test("canonicalConnectorKeyFromManifest reads polyfill-style top-level connector_id", () => {
  const manifest = {
    connector_id: `${REGISTRY_PREFIX}gmail`,
    display_name: "Gmail",
    streams: [],
  };
  assert.equal(canonicalConnectorKeyFromManifest(manifest), "gmail");
});

test("canonicalConnectorKeyFromManifest prefers explicit connector_key", () => {
  const manifest = {
    connector_id: `${REGISTRY_PREFIX}gmail`,
    connector_key: "custom-source",
    display_name: "Custom Source",
    manifest_uri: "https://example.test/manifests/custom-source",
    streams: [],
  };
  assert.equal(canonicalConnectorKeyFromManifest(manifest), "custom-source");
});

test("canonicalConnectorKeyFromManifest rejects invalid explicit connector_key", () => {
  assert.equal(
    canonicalConnectorKeyFromManifest({
      connector_key: `${REGISTRY_PREFIX}gmail`,
      manifest_uri: `${REGISTRY_PREFIX}gmail`,
      streams: [],
    }),
    null
  );
});

test("canonicalConnectorKeyFromManifest falls back to storage_binding.connector_id", () => {
  // Native reference manifest shape (`reference-implementation/fixtures/
  // seed-manifests/northstar-hr.json`).
  const manifest = {
    provider_id: "northstar_hr",
    storage_binding: { connector_id: "northstar_hr_native" },
    streams: [],
  };
  assert.equal(canonicalConnectorKeyFromManifest(manifest), "northstar_hr_native");
});

test("canonicalConnectorKeyFromManifest returns null when a manifest names no connector", () => {
  assert.equal(canonicalConnectorKeyFromManifest(null), null);
  assert.equal(canonicalConnectorKeyFromManifest({}), null);
  assert.equal(canonicalConnectorKeyFromManifest({ streams: [] }), null);
});

test("canonicalConnectorKeyFromManifest gives a manifest that declares only a registry URL its slug", () => {
  assert.equal(canonicalConnectorKeyFromManifest({ connector_id: `${REGISTRY_PREFIX}whatsapp-web` }), "whatsapp-web");
  assert.equal(canonicalConnectorKeyFromManifest({ storage_binding: { connector_id: "custom_thing" } }), "custom_thing");
});

// -------- First-party key list parity with shipped manifests --------
//
// The first-party key list gates nothing; it feeds the tuning-namespace
// collision rule. These tests guard against drift between it and the shipped
// JSON manifests: if a new polyfill manifest is added without regenerating
// the list, the test fails loudly.

function shippedConnectorKeysFromEntries(entries: ManifestFileEntry[]): Set<string> {
  const keys = new Set<string>();
  for (const { manifest } of entries) {
    const explicitKey = typeof manifest.connector_key === "string" ? manifest.connector_key.trim() : "";
    if (explicitKey) {
      keys.add(explicitKey);
      continue;
    }
    const topLevel = typeof manifest.connector_id === "string" ? manifest.connector_id.trim() : "";
    if (topLevel.startsWith(REGISTRY_PREFIX)) {
      let tail = topLevel.slice(REGISTRY_PREFIX.length);
      if (tail.endsWith("/")) {
        tail = tail.slice(0, -1);
      }
      if (tail && !tail.includes("/")) {
        keys.add(tail);
        continue;
      }
    }
    const storageBinding = manifest.storage_binding as Record<string, unknown> | undefined;
    const nativeBinding = storageBinding?.connector_id;
    if (typeof nativeBinding === "string" && nativeBinding.trim()) {
      keys.add(nativeBinding.trim());
    }
  }
  return keys;
}

function registryBackedManifestsFromEntries(entries: ManifestFileEntry[]) {
  const manifests: { name: string; manifest: Record<string, unknown>; connectorId: string }[] = [];
  for (const { name, manifest } of entries) {
    const connectorId = typeof manifest.connector_id === "string" ? manifest.connector_id.trim() : "";
    if (!connectorId.startsWith(REGISTRY_PREFIX)) {
      continue;
    }
    manifests.push({ connectorId, manifest, name });
  }
  return manifests;
}

test("shipped registry manifests use the canonical .dev origin", () => {
  for (const entries of [readShippedPolyfillManifestEntries(), readManifestsFromDir(REFERENCE_MANIFESTS_DIR)]) {
    for (const { name, manifest } of entries) {
      const connectorId = typeof manifest.connector_id === "string" ? manifest.connector_id.trim() : "";
      if (connectorId.startsWith("https://registry.pdpp.")) {
        assert.ok(connectorId.startsWith(REGISTRY_PREFIX), `${name} must use ${REGISTRY_PREFIX}`);
      }
    }
  }
});

test("registry-backed first-party manifests declare connector_key and manifest_uri", () => {
  for (const entries of [readShippedPolyfillManifestEntries(), readManifestsFromDir(REFERENCE_MANIFESTS_DIR)]) {
    for (const { name, manifest, connectorId } of registryBackedManifestsFromEntries(entries)) {
      const key = connectorKeyFromRegistryUrl(connectorId);
      assert.ok(key, `${name} must use a known first-party registry URI`);
      assert.equal(manifest.connector_key, key, `${name} must declare canonical connector_key`);
      assert.equal(manifest.manifest_uri, connectorId, `${name} must preserve registry URI as manifest_uri`);
    }
  }
});

test("the first-party key list covers every shipped polyfill-connectors manifest", () => {
  const shipped = shippedConnectorKeysFromEntries(readShippedPolyfillManifestEntries());
  const known = new Set(firstPartyConnectorKeys());
  // biome-ignore lint/suspicious/useArraySortCompare: the test relies on the platform default lexical sort behavior.
  const missing = [...shipped].filter((key) => !known.has(key)).sort();
  assert.deepEqual(missing, [], `polyfill manifests reference unknown canonical keys: ${missing.join(", ")}`);
});

test("canonicalConnectorKey passes every shipped reference-implementation manifest key through", () => {
  const shipped = shippedConnectorKeysFromEntries(readManifestsFromDir(REFERENCE_MANIFESTS_DIR));
  for (const key of shipped) {
    assert.equal(canonicalConnectorKey(key), key);
  }
});

test("isInternalConnectorId identifies test/stub/internal connector ids", () => {
  // All known internal marker substrings must match.
  assert.equal(isInternalConnectorId("manual_action_stub"), true);
  assert.equal(isInternalConnectorId("manual-action-stub"), true);
  assert.equal(isInternalConnectorId("stream-test-stub"), true);
  assert.equal(isInternalConnectorId("stream-test-stub-picker-regression"), true);
  assert.equal(isInternalConnectorId("pg_runtime_gmail"), true);
  assert.equal(isInternalConnectorId("pg_canonical_test"), true);
  assert.equal(isInternalConnectorId("pg_expand_records"), true);
  assert.equal(isInternalConnectorId("pg_lexical_backfill_1780426329141_34951"), true);
  // First-party and native canonical keys must NOT match.
  assert.equal(isInternalConnectorId("gmail"), false);
  assert.equal(isInternalConnectorId("spotify"), false);
  assert.equal(isInternalConnectorId("claude-code"), false);
  assert.equal(isInternalConnectorId("northstar_hr_native"), false);
  // Empty/non-string inputs must fail open (return false, not throw).
  assert.equal(isInternalConnectorId(null), false);
  assert.equal(isInternalConnectorId(undefined), false);
  assert.equal(isInternalConnectorId(""), false);
  assert.equal(isInternalConnectorId(42), false);
});

test("a non-registry URL connector_id keeps its spelling as the key", () => {
  const url = "https://test.pdpp.dev/connectors/acme";
  assert.equal(canonicalConnectorKeyFromManifest({ connector_id: url }), url);
  assert.equal(canonicalConnectorKeyFromManifest({ storage_binding: { connector_id: url } }), url);
});

test("manifest key derivation rejects malformed id-only identities", () => {
  for (const value of ["bad key", `${REGISTRY_PREFIX}gmail/extra`]) {
    assert.equal(canonicalConnectorKeyFromManifest({ connector_id: value }), null, value);
    assert.equal(canonicalConnectorKeyFromManifest({ storage_binding: { connector_id: value } }), null, value);
  }
});
