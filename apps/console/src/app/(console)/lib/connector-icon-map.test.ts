// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { buildConnectorIconMap, catalogEntryIcon } from "./connector-icon-map.ts";
import { resolveManifestDisplayMark } from "./resolve-manifest-display-mark.ts";
import iconCorpus from "./connector-icons/sanitized-assets.json" with { type: "json" };

const UNSAFE_ONLOAD = /onload/iu;
const GITHUB_SVG = iconCorpus.entries.find((entry) => entry.connector_key === "github")?.svg;
assert.ok(GITHUB_SVG);

const INLINE_MANIFEST_MARK = {
  color: "#123456",
  kind: "inline_svg",
  svg: GITHUB_SVG,
} as const;
const INLINE_TEMPLATE_MARK = {
  color: "#654321",
  kind: "inline_svg",
  svg: GITHUB_SVG,
} as const;

test("projects pinned upstream marks by exact connector key and canonical ID", async () => {
  const icons = await buildConnectorIconMap(
    [],
    [{ connector_id: "https://registry.pdpp.dev/connectors/github", connector_key: "github" }]
  );

  assert.ok(icons.github?.svg?.startsWith("<svg"));
  assert.equal(icons["https://registry.pdpp.dev/connectors/github"], icons.github);
});

test("maps the existing underscore spelling to its hyphenated connector identity", async () => {
  const icons = await buildConnectorIconMap([], []);
  assert.deepEqual(icons.apple_photos, icons["apple-photos"]);
});

test("preserves the valid inline owner-template mark over the pinned asset", async () => {
  const icons = await buildConnectorIconMap([], [{ connector_id: "github", connector_key: "github", icon: INLINE_TEMPLATE_MARK }]);

  assert.deepEqual(icons.github, INLINE_TEMPLATE_MARK);
});

test("a template mark beats a manifest's fallback mark but not the manifest's own", async () => {
  const bundled = await resolveManifestDisplayMark({ connector_id: "github", connector_key: "github" }, "/nonexistent");
  assert.equal(bundled.source, "bundled");
  const withFallback = await buildConnectorIconMap(
    [{ connector_id: "github", connector_key: "github", icon: bundled.icon, resolvedIconSource: bundled.source }],
    [{ connector_id: "github", connector_key: "github", icon: INLINE_TEMPLATE_MARK }]
  );
  assert.deepEqual(withFallback.github, INLINE_TEMPLATE_MARK);

  const own = await buildConnectorIconMap(
    [{ connector_id: "github", connector_key: "github", icon: INLINE_MANIFEST_MARK, resolvedIconSource: "manifest" }],
    [{ connector_id: "github", connector_key: "github", icon: INLINE_TEMPLATE_MARK }]
  );
  assert.deepEqual(own.github, INLINE_MANIFEST_MARK);
});

test("a manifest and a template that disagree yield the same mark on every surface", async () => {
  const manifest = { connector_id: "github", connector_key: "github", icon: INLINE_MANIFEST_MARK } as const;
  // Setup pages render the resolved manifest mark; summary and add pages read the map.
  const setup = (await resolveManifestDisplayMark(manifest, "/nonexistent")).icon;
  const withTemplate = await buildConnectorIconMap([manifest], [
    { connector_id: "github", connector_key: "github", icon: INLINE_TEMPLATE_MARK },
  ]);
  const withoutTemplate = await buildConnectorIconMap([manifest], []);

  assert.deepEqual(setup, withTemplate.github);
  assert.deepEqual(setup, withoutTemplate.github);
  assert.equal(withTemplate.github?.color, INLINE_MANIFEST_MARK.color);
});

test("preserves an explicitly supplied safe inline manifest mark over the pinned asset", async () => {
  const icons = await buildConnectorIconMap(
    [{ connector_id: "github", connector_key: "github", icon: INLINE_MANIFEST_MARK }],
    []
  );

  assert.deepEqual(icons.github, INLINE_MANIFEST_MARK);
});

test("rejects unsafe inline SVG and keeps the pinned safe asset", async () => {
  const icons = await buildConnectorIconMap(
    [
      {
        connector_id: "github",
        connector_key: "github",
        icon: { kind: "inline_svg", svg: '<svg onload="alert(1)"><path d="M1 2" /></svg>' },
      },
    ],
    []
  );

  assert.ok(icons.github?.svg?.startsWith("<svg"));
  assert.doesNotMatch(icons.github?.svg ?? "", UNSAFE_ONLOAD);
});

test("keeps every pinned connector glyph and its declared background without optional manifests", async () => {
  const icons = await buildConnectorIconMap([], []);
  for (const entry of iconCorpus.entries) {
    const icon = icons[entry.connector_key];
    assert.equal(icon?.svg, entry.svg, entry.connector_key);
    assert.equal(icon?.backgroundColor, entry.background_color, entry.connector_key);
    assert.equal(icons[entry.connector_id], icon, entry.connector_key);
  }
});

test("an iconless owner template preserves a custom manifest mark", async () => {
  const icons = await buildConnectorIconMap(
    [{ connector_id: "github", connector_key: "github", icon: INLINE_MANIFEST_MARK }],
    [{ connector_id: "github", connector_key: "github" }]
  );
  assert.deepEqual(icons.github, INLINE_MANIFEST_MARK);
});

test("a catalog entry keeps its own mark when the map does not index its key", async () => {
  const icons = await buildConnectorIconMap([], []);
  assert.deepEqual(catalogEntryIcon({ connectorKey: "not-in-the-map", icon: INLINE_TEMPLATE_MARK }, icons), INLINE_TEMPLATE_MARK);
  assert.equal(catalogEntryIcon({ connectorKey: "not-in-the-map" }, icons), null);
  assert.deepEqual(catalogEntryIcon({ connectorKey: "github", icon: INLINE_TEMPLATE_MARK }, icons), icons.github);
});
