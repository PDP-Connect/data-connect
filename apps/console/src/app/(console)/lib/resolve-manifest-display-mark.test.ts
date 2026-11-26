// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveManifestDisplayMark } from "./resolve-manifest-display-mark.ts";

const WHITE_GLYPH = '<svg viewBox="0 0 24 24" fill="#FFFFFF"><path d="M1 2h20v20z"/></svg>';
const INLINE_GLYPH = '<svg viewBox="0 0 24 24"><path d="M3 3h18v18z"/></svg>';

async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "display-mark-"));
  try {
    await mkdir(join(dir, "icons"));
    await writeFile(join(dir, "icons", "white.svg"), WHITE_GLYPH);
    await run(dir);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
}

test("a path-resolved glyph takes the declared brand backdrop", async () => {
  await withDir(async (dir) => {
    const mark = await resolveManifestDisplayMark(
      { brand: { background_color: "#FF9900", icon: "icons/white.svg" }, connector_id: "zz-new", connector_key: "zz-new" },
      dir
    );
    assert.deepEqual(mark, {
      icon: { backgroundColor: "#FF9900", kind: "inline_svg", svg: WHITE_GLYPH },
      source: "manifest",
    });
  });
});

test("an inline mark wins over brand.icon, and its own backdrop wins over the declared one", async () => {
  await withDir(async (dir) => {
    const mark = await resolveManifestDisplayMark(
      {
        brand: { background_color: "#FF9900", icon: "icons/white.svg" },
        connector_id: "zz-new",
        icon: { backgroundColor: "#112233", kind: "inline_svg", svg: INLINE_GLYPH },
      },
      dir
    );
    assert.deepEqual(mark.icon, { backgroundColor: "#112233", kind: "inline_svg", svg: INLINE_GLYPH });
    const declaredOnly = await resolveManifestDisplayMark(
      { brand: { background_color: "#FF9900" }, connector_id: "zz-new", icon: { kind: "inline_svg", svg: INLINE_GLYPH } },
      dir
    );
    assert.equal(declaredOnly.icon?.backgroundColor, "#FF9900");
  });
});

test("a declared backdrop that is not a six-digit hex colour is dropped", async () => {
  await withDir(async (dir) => {
    const mark = await resolveManifestDisplayMark(
      { brand: { background_color: "url(javascript:0)", icon: "icons/white.svg" }, connector_id: "zz-new" },
      dir
    );
    assert.equal(mark.icon?.backgroundColor, undefined);
    assert.equal(mark.icon?.svg, WHITE_GLYPH);
  });
});

test("without an own mark, the bundled mark for the identity is used with its own backdrop", async () => {
  await withDir(async (dir) => {
    const mark = await resolveManifestDisplayMark(
      { brand: { background_color: "#000001" }, connector_id: "https://registry.pdpp.dev/connectors/amazon", connector_key: "amazon" },
      dir
    );
    assert.equal(mark.source, "bundled");
    assert.equal(mark.icon?.backgroundColor, "#FF9900");
  });
});

test("a bundled mark outranks the generic simple-icons mark for the same key", async () => {
  await withDir(async (dir) => {
    const mark = await resolveManifestDisplayMark({ connector_id: "github", connector_key: "github" }, dir);
    assert.equal(mark.source, "bundled");
  });
});

test("simple-icons is used only when nothing else matches, and nothing leaves the monogram", async () => {
  await withDir(async (dir) => {
    const generic = await resolveManifestDisplayMark({ connector_id: "figma", connector_key: "figma" }, dir);
    assert.equal(generic.source, "simple-icons");
    assert.ok(generic.icon?.svg);
    assert.deepEqual(await resolveManifestDisplayMark({ connector_id: "zz-unknown" }, dir), {
      icon: null,
      source: undefined,
    });
  });
});

test("an unreadable brand.icon falls through to the bundled mark", async () => {
  await withDir(async (dir) => {
    const mark = await resolveManifestDisplayMark(
      { brand: { icon: "icons/missing.svg" }, connector_id: "amazon", connector_key: "amazon" },
      dir
    );
    assert.equal(mark.source, "bundled");
  });
});
