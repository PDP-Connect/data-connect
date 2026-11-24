// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// The server advertises the product icon at the console's Next.js metadata
// routes (`/icon`, `/apple-icon`). Those routes exist only as long as the
// matching files under `apps/console/src/app/` do, and the advertised
// mimeType/size are only true while those files keep returning that type/size.
// A previous `/icon.svg` URL went stale silently (404) when the static file
// was replaced by `icon.tsx`; these tests fail on that kind of drift.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  PRODUCT_ICON_PNG,
  PRODUCT_ICON_SVG,
  productIconLinkHeader,
  productIconUrl,
  productServerIcons,
} from "../server/product-icons.ts";

const CONSOLE_APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "apps", "console", "src", "app");

function consoleMetadataSource(icon: { path: string }): { file: string; source: string } {
  const file = join(CONSOLE_APP_DIR, `${icon.path.slice(1)}.tsx`);
  assert.equal(
    existsSync(file),
    true,
    `${icon.path} is advertised but apps/console/src/app${icon.path}.tsx does not exist, so the route would 404`
  );
  return { file, source: readFileSync(file, "utf8") };
}

function exportedString(source: string, name: string): string | undefined {
  return new RegExp(`export const ${name} = "([^"]+)"`).exec(source)?.[1];
}

test("advertised icon URLs are the console metadata routes", () => {
  assert.equal(productIconUrl("https://pdpp.test", PRODUCT_ICON_SVG), "https://pdpp.test/icon");
  assert.equal(productIconUrl("https://pdpp.test", PRODUCT_ICON_PNG), "https://pdpp.test/apple-icon");
  assert.equal(productIconUrl("https://pdpp.test/some/base", PRODUCT_ICON_SVG), "https://pdpp.test/icon");
});

test("serverInfo.icons lists the SVG and the PNG with their true types and sizes", () => {
  assert.deepEqual(productServerIcons("https://pdpp.test"), [
    { mimeType: "image/svg+xml", sizes: ["any"], src: "https://pdpp.test/icon" },
    { mimeType: "image/png", sizes: ["180x180"], src: "https://pdpp.test/apple-icon" },
  ]);
});

test("Link header advertises the SVG icon route", () => {
  assert.equal(productIconLinkHeader("https://pdpp.test"), '<https://pdpp.test/icon>; rel="icon"; type="image/svg+xml"');
});

test("drift guard: /icon is served by icon.tsx as image/svg+xml", () => {
  const { source } = consoleMetadataSource(PRODUCT_ICON_SVG);
  assert.equal(exportedString(source, "contentType"), PRODUCT_ICON_SVG.mimeType);
});

test("drift guard: /apple-icon is served by apple-icon.tsx as a 180x180 image/png", () => {
  const { source } = consoleMetadataSource(PRODUCT_ICON_PNG);
  assert.equal(exportedString(source, "contentType"), PRODUCT_ICON_PNG.mimeType);
  assert.match(source, /export const size = \{ height: 180, width: 180 \}/);
  assert.deepEqual(PRODUCT_ICON_PNG.sizes, ["180x180"]);
});
