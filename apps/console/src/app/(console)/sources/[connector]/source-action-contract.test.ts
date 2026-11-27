// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import test from "node:test";
import ts from "typescript";
import baseline from "./source-action-contract.json" with { type: "json" };

const root = new URL("./", import.meta.url);
const compact = (text: string) => text.replace(/\s+/gu, "");
const uses = new Map<string, string[]>();
for (const file of readdirSync(root).filter((name) => name.endsWith(".tsx"))) {
  const source = ts.createSourceFile(file, readFileSync(new URL(file, root), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && /Action$/u.test(node.expression.getText(source))) {
      const action = node.expression.getText(source);
      uses.set(action, [...uses.get(action) ?? [], compact(node.getText(source))]);
    }
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(source) === "form") {
      const action = node.openingElement.attributes.properties.find((attr) => ts.isJsxAttribute(attr) && attr.name.getText(source) === "action");
      if (action && ts.isJsxAttribute(action) && action.initializer && ts.isJsxExpression(action.initializer)) {
        const name = action.initializer.expression?.getText(source) ?? "";
        const fields: string[] = [];
        function field(child: ts.Node) {
          if ((ts.isJsxSelfClosingElement(child) || ts.isJsxOpeningElement(child)) && child.tagName.getText(source) === "input") {
            const attrs = child.attributes.properties.filter((attr) => ts.isJsxAttribute(attr) && ["name", "value"].includes(attr.name.getText(source)));
            fields.push(attrs.map((attr) => compact(attr.getText(source))).sort().join(" "));
          }
          ts.forEachChild(child, field);
        }
        field(node);
        uses.set(name, [...uses.get(name) ?? [], fields.sort().join(";")]);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}

for (const [action, expected] of Object.entries(baseline.uses)) {
  test(`${action} keeps its call arguments or posted fields`, () => {
    const withoutTrailingCommas = (value: string) => value.replace(/,([)}\]])/gu, "$1");
    assert.deepEqual(uses.get(action)?.map(withoutTrailingCommas).sort(), expected.map(withoutTrailingCommas).sort());
  });
}
for (const [file, hash] of Object.entries(baseline.actions)) {
  test(`${file} keeps the same server requests and validation`, () => {
    assert.equal(createHash("sha256").update(readFileSync(new URL(file, root))).digest("hex"), hash);
  });
}

for (const action of ["confirmCoverageHorizonAction", "acknowledgeConnectionLossAction"]) {
  test(`${action} stays bound to the same connection on the technical page`, () => {
    const page = readFileSync(new URL("./source-page.tsx", import.meta.url), "utf8");
    const technical = page.slice(page.indexOf("export function SourceTechnicalDetails"));
    assert.ok(technical.includes(`${action}={${action}}`));
    assert.ok(technical.includes("connectionId={connectorInstanceId ?? connectionId}"));
    const forms = readFileSync(new URL("./connection-confirmation.tsx", import.meta.url), "utf8");
    assert.ok(forms.includes(`action={${action}}`));
  });
}
