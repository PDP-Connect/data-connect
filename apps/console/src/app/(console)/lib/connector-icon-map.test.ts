// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { buildConnectorIconMap } from "./connector-icon-map.ts";
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
  const icons = await buildConnectorIconMap(
    [{ connector_id: "github", connector_key: "github", icon: INLINE_MANIFEST_MARK }],
    [{ connector_id: "github", connector_key: "github", icon: INLINE_TEMPLATE_MARK }]
  );

  assert.deepEqual(icons.github, INLINE_TEMPLATE_MARK);
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
