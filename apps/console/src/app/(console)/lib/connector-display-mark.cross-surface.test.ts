// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * One connector, every surface. The real Amazon manifest names a white glyph
 * file (`brand.icon`) and an orange `brand.background_color`. A white glyph
 * with no backdrop is invisible on a light surface, so the setup pages, the
 * summary pages and a console with no manifests on disk must paint the same
 * backdrop.
 */

import assert from "node:assert/strict";
import { mock, test } from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// The vendored renderer relies on the classic JSX runtime.
(globalThis as { React?: typeof React }).React = React;

// rs-client reaches `server-only`, which throws outside a server component.
mock.module("server-only", { namedExports: {} });

const AMAZON = "https://registry.pdpp.dev/connectors/amazon";
const imports = Promise.all([
  import("../components/connector-mark.tsx"),
  import("../sources/lib/relationships.ts"),
  import("./connector-icon-map.ts"),
  import("./rs-client.ts"),
]);

function mark(
  ConnectorMark: (typeof import("../components/connector-mark.tsx"))["ConnectorMark"],
  icon: Parameters<typeof ConnectorMark>[0]["icon"]
): string {
  return renderToStaticMarkup(createElement(ConnectorMark, { connectorId: AMAZON, icon, name: "Amazon" }));
}

test("setup, summary and manifest-less surfaces paint the same backdrop behind a white glyph", async () => {
  const [{ ConnectorMark }, { findManifestForConnectorId }, { buildConnectorIconMap }, { listConnectorManifests }] =
    await imports;
  const manifests = await listConnectorManifests();
  const manifest = findManifestForConnectorId(manifests, AMAZON);
  assert.ok(manifest, "the installed connector package ships the Amazon manifest");
  assert.equal(manifest.brand?.background_color, "#FF9900");
  assert.equal(manifest.resolvedIconSource, "manifest", "the glyph came from brand.icon, not the bundled asset");

  // Setup pages pass the manifest icon; summary pages read the icon map; a
  // console with no manifests on disk passes nothing and uses the bundled mark.
  const setup = mark(ConnectorMark, manifest.icon);
  const summary = mark(ConnectorMark, (await buildConnectorIconMap(manifests, []))[AMAZON]);
  const withoutManifests = mark(ConnectorMark, undefined);

  assert.match(setup, /background-color:#FF9900/i);
  assert.match(setup, /fill="#FFFFFF"/i, "the white glyph is kept, not forced to currentColor");
  assert.equal(setup, summary);
  assert.equal(setup, withoutManifests);
});

test("for every installed manifest the summary map and the setup mark are the same mark", async () => {
  const [, , { buildConnectorIconMap }, { listConnectorManifests }] = await imports;
  const manifests = await listConnectorManifests();
  assert.ok(manifests.length > 0);
  const icons = await buildConnectorIconMap(manifests, []);
  for (const manifest of manifests) {
    assert.deepEqual(icons[manifest.connector_id], manifest.icon ?? undefined, manifest.connector_id);
  }
});
