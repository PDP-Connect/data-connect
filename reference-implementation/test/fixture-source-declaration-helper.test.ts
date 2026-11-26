// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { fixtureSlugOf, withFixtureSourceDeclaration } from "./helpers/fixture-source-declaration.ts";

const STREAM = {
  name: "items",
  primary_key: ["id"],
  semantics: "mutable_state",
  selection: { fields: true, resources: true },
  schema: { type: "object", properties: { id: { type: "string" } } },
};

const PROTOCOL = "0.1.0";

const KEYS = [
  "foo-bar",
  "foo/bar",
  "foo bar",
  "Foo-Bar",
  "foo_bar",
  "foo~2f~bar",
  "https://registry.pdpp.test/connectors/foo-bar",
  "http://registry.pdpp.test/connectors/foo-bar",
  ".",
  "..",
  ".hidden",
  "é",
];

interface DeclaredFixture {
  source_declaration: { declaration_version: string; source: { id: string } };
}

function declarationOf(manifest: object): DeclaredFixture["source_declaration"] {
  return (manifest as DeclaredFixture).source_declaration;
}

test("fixtureSlugOf gives distinct keys distinct slugs", () => {
  const slugs = KEYS.map((key) => fixtureSlugOf({ connector_key: key }));
  assert.equal(new Set(slugs).size, KEYS.length, slugs.join("\n"));
});

test("fixtureSlugOf keeps a clean key unchanged and never emits a dot-only segment", () => {
  assert.equal(fixtureSlugOf({ connector_key: "foo-bar" }), "foo-bar");
  assert.equal(fixtureSlugOf({ connector_id: "plain.id_1" }), "plain.id_1");
  for (const key of [".", ".."]) {
    assert.doesNotMatch(fixtureSlugOf({ connector_key: key }), /^\.+$/);
  }
});

test("distinct keys get distinct source identities", () => {
  const sourceIds = KEYS.map((key) => {
    const declared = withFixtureSourceDeclaration({ connector_key: key, connector_id: "x", version: "1.0.0", protocol_version: PROTOCOL, display_name: "Fixture", streams: [STREAM] });
    return declarationOf(declared).source.id;
  });
  assert.equal(new Set(sourceIds).size, KEYS.length);
});

test("a manifest derived by spreading another fixture gets a declaration for its own content", () => {
  const base = withFixtureSourceDeclaration({ connector_id: "spread", version: "1.0.0", protocol_version: PROTOCOL, display_name: "Fixture", streams: [STREAM] });
  const derived = withFixtureSourceDeclaration({ ...base, version: "2.0.0" });
  assert.notEqual(declarationOf(derived).declaration_version, declarationOf(base).declaration_version);
  const rewrapped = withFixtureSourceDeclaration({ ...base });
  assert.equal(declarationOf(rewrapped).declaration_version, declarationOf(base).declaration_version);
});
