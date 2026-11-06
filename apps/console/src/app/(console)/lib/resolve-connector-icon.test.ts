// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { ConnectorMark } from "../components/connector-mark.tsx";
import corpus from "./connector-icons/sanitized-assets.json" with { type: "json" };
import { connectorIconIdentityKeys, resolveConnectorIcon, resolveSourceIcon } from "./resolve-connector-icon.ts";

// The repository test harness transpiles source JSX with the classic runtime.
Object.assign(globalThis, { React });

test("resolveConnectorIcon resolves every bundled mark by connector key and stable registry ID", () => {
  for (const entry of corpus.entries) {
    const byKey = resolveConnectorIcon(entry.connector_key);
    const byId = resolveConnectorIcon(entry.connector_id);
    assert.equal(byKey?.kind, "inline_svg", entry.connector_key);
    assert.equal(byId?.kind, "inline_svg", entry.connector_id);
    assert.equal(byKey?.svg, entry.svg, entry.connector_key);
    assert.equal(byId?.svg, entry.svg, entry.connector_id);
  }
});

test("known connector key aliases accept underscore and hyphen spellings", () => {
  const hyphen = resolveConnectorIcon("apple-contacts");
  assert.ok(hyphen);
  assert.equal(resolveConnectorIcon("apple_contacts")?.svg, hyphen.svg);
});

test("safe supplied icon wins and unsafe SVG falls back to the genuine bundled mark", () => {
  const custom = { kind: "inline_svg" as const, svg: '<svg viewBox="0 0 1 1"><path d="M0 0" /></svg>' };
  assert.equal(resolveConnectorIcon("amazon", custom)?.svg, custom.svg);
  const unsafe = { kind: "inline_svg" as const, svg: '<svg onload="alert(1)"><path d="M0 0" /></svg>' };
  assert.equal(resolveConnectorIcon("amazon", unsafe)?.svg, resolveConnectorIcon("amazon")?.svg);
});

test("unknown IDs and arbitrary registry origins do not borrow a mark by basename", () => {
  assert.equal(resolveConnectorIcon("not-a-known-connector"), null);
  assert.equal(resolveConnectorIcon("https://attacker.example/connectors/amazon"), null);
  assert.equal(resolveConnectorIcon(""), null);
});

test("ConnectorMark SSR uses stable connector identity when no optional icon was supplied", () => {
  const markup = renderToStaticMarkup(
    createElement(ConnectorMark, { connectorId: "amazon", name: "Custom account label" })
  );
  assert.ok(markup.includes("<svg"));
  assert.ok(markup.includes('viewBox="0 0 24 24"'));
  assert.equal(markup.includes("Custom account label"), false);
});

test("ConnectorMark keeps the genuine initials fallback for an unknown connector ID", () => {
  const markup = renderToStaticMarkup(
    createElement(ConnectorMark, { connectorId: "unknown-connector", name: "Example Source" })
  );
  assert.equal(markup.includes("<svg"), false);
  assert.ok(markup.includes('data-initials="ES"'));
});

test("preserves first-party registry aliases without borrowing brands from unrelated URLs", () => {
  assert.deepEqual(
    resolveConnectorIcon("https://registry.pdpp.dev/connectors/apple_contacts/"),
    resolveConnectorIcon("apple-contacts")
  );
  assert.equal(resolveConnectorIcon("https://unrelated.example/connectors/apple-contacts"), null);
});

test("Core source display uses declared provenance without conflating connector identity", () => {
  const sourceId = corpus.entries.find((entry) => entry.connector_key === "amazon")?.source_id;
  assert.ok(sourceId);
  const connector = resolveConnectorIcon("amazon");
  assert.deepEqual(resolveSourceIcon(sourceId), connector);
  assert.equal(resolveConnectorIcon(sourceId), null, "Core source identity is not an operational connector ID");
  assert.equal(resolveSourceIcon("https://unrelated.example/sources/amazon"), null);
  const markup = renderToStaticMarkup(createElement(ConnectorMark, { sourceId, name: "Personal source" }));
  assert.ok(markup.includes("<svg"));
});

test("non-hierarchical URI identities never acquire local-key aliases", () => {
  const underscored = "urn:vendor:foo_bar";
  const hyphenated = "urn:vendor:foo-bar";
  assert.equal(new URL(underscored).protocol, "urn:");
  assert.deepEqual(connectorIconIdentityKeys(underscored), [underscored]);
  assert.deepEqual(connectorIconIdentityKeys(hyphenated), [hyphenated]);
});

const SOURCE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/u;

// Geometry is a product-wide renderer decision. Parsing every caller catches
// future pages too; a snapshot of today's two reported rows would miss them.
test("product connector marks cannot bypass shared geometry through local rendering or CSS", () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const wrapper = path.join("app", "(console)", "components", "connector-mark.tsx");
  const violations: string[] = [];
  for (const relative of readdirSync(root, { recursive: true })) {
    if (typeof relative !== "string" || relative.includes(".test.")) {
      continue;
    }
    const filename = path.join(root, relative);
    if (relative.endsWith(".css")) {
      postcss.parse(readFileSync(filename, "utf8")).walkRules((rule) => {
        if (rule.selector.includes(".pdpp-connector-icon")) {
          violations.push(`${relative}: icon CSS belongs to the shared renderer`);
        }
      });
      continue;
    }
    if (!SOURCE_FILE.test(relative) || relative === wrapper) {
      continue;
    }
    const source = ts.createSourceFile(
      filename,
      readFileSync(filename, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    );
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement)) {
        continue;
      }
      const bindings = statement.importClause?.namedBindings;
      if (
        bindings &&
        ts.isNamedImports(bindings) &&
        bindings.elements.some((binding) => (binding.propertyName ?? binding.name).text === "ConnectorIcon")
      ) {
        violations.push(`${relative}: render ConnectorMark instead of importing ConnectorIcon`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test("product connector mark API reserves geometry and exposes only text spacing", () => {
  type Overrides = Extract<keyof Parameters<typeof ConnectorMark>[0], "className" | "style" | "size">;
  const acceptsNoGeometryOverrides: Overrides extends never ? true : false = true;
  assert.equal(acceptsNoGeometryOverrides, true);
  const markup = renderToStaticMarkup(
    createElement(ConnectorMark, { connectorId: "claude-code", name: "Account", spacing: "after" })
  );
  assert.ok(markup.includes('class="pdpp-connector-icon mr-2"'));
});
