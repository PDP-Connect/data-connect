// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { assertIconCorpusConsistent } from "./connector-icon-corpus-checks.ts";
import iconCorpus from "./connector-icons/sanitized-assets.json" with { type: "json" };

const SVG = '<svg viewBox="0 0 24 24"><path d="M0 0z"/></svg>';
const FOO_BAR_COLLISION = /foo[-_]bar/u;
const FOO = /foo/u;
const BACKGROUND = /background/u;
const SOURCE = /source/u;
const OTHER_SVG = '<svg viewBox="0 0 24 24"><path d="M1 1z"/></svg>';

function entry(key: string, overrides: Record<string, unknown> = {}) {
  return {
    background_color: "#112233",
    connector_id: `https://registry.pdpp.dev/connectors/${key}`,
    connector_key: key,
    source_id: null as string | null,
    svg: SVG,
    ...overrides,
  };
}

test("the checked-in corpus is consistent", () => {
  assert.doesNotThrow(() => assertIconCorpusConsistent(iconCorpus.entries));
});

test("two entries whose identities differ only by _/- spelling are rejected", () => {
  assert.throws(() => assertIconCorpusConsistent([entry("foo-bar"), entry("foo_bar")]), FOO_BAR_COLLISION);
});

test("a registry-prefixed id that spells another entry's key is rejected", () => {
  const first = entry("foo");
  const second = entry("other", { connector_id: "https://registry.pdpp.dev/connectors/foo" });
  assert.throws(() => assertIconCorpusConsistent([first, second]), FOO);
});

test("an exact duplicate key is still rejected", () => {
  assert.throws(() => assertIconCorpusConsistent([entry("foo"), entry("foo")]), FOO);
});

test("a background that is not a hex color is rejected", () => {
  for (const bad of ["transparent", "red", "#12", "#fff;x:y"]) {
    assert.throws(() => assertIconCorpusConsistent([entry("foo", { background_color: bad })]), BACKGROUND, bad);
  }
  assert.doesNotThrow(() => assertIconCorpusConsistent([entry("foo", { background_color: undefined })]));
  assert.doesNotThrow(() => assertIconCorpusConsistent([entry("foo", { background_color: "#fff" })]));
});

test("a source id shared by entries with different marks is rejected", () => {
  const source = "https://registry.pdpp.dev/sources/foo";
  assert.throws(
    () =>
      assertIconCorpusConsistent([
        entry("foo", { source_id: source }),
        entry("foo-live", { source_id: source, svg: OTHER_SVG }),
      ]),
    SOURCE
  );
  assert.throws(
    () =>
      assertIconCorpusConsistent([
        entry("foo", { source_id: source }),
        entry("foo-live", { background_color: "#445566", source_id: source }),
      ]),
    SOURCE
  );
});

test("a source id shared by entries with the same mark is accepted", () => {
  const source = "https://registry.pdpp.dev/sources/foo";
  assert.doesNotThrow(() =>
    assertIconCorpusConsistent([entry("foo", { source_id: source }), entry("foo-live", { source_id: source })])
  );
});
