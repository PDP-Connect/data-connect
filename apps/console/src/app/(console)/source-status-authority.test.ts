// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const HOME = `${HERE}components/views/standing-overview.tsx`;
const HOME_MODEL = `${HERE}components/views/standing-view-model.ts`;
const SOURCES = `${HERE}sources/sources-view.tsx`;
const SOURCES_MODEL = `${HERE}sources/sources-view-model.ts`;
const SOURCE_DETAIL = `${HERE}sources/[connector]/source-page.tsx`;
const SOURCE_ROW_STATUS = `${HERE}sources/source-row-status.tsx`;
const SOURCE_SENTENCE = `${HERE}sources/[connector]/source-state-sentence.tsx`;

const LEGACY_STATUS_WORDERS = [
  "deriveConnectionStatusDisplay",
  "deriveConnectionNextStep",
  "formatLastDurableProgress",
  "summarizeOutboxForRow",
  "deriveRenderedSourceStatus",
  "deriveSourceVerdictStatus",
  "renderedSourceStatus",
] as const;

function importedNames(source: string, modulePath: string): string[] {
  const declaration = source.match(new RegExp(`import\\s+\\{([^}]+)\\}\\s+from\\s+["']${modulePath}["']`));
  const bindings = declaration?.[1];
  assert.ok(bindings, `expected a named import from ${modulePath}`);
  return bindings
    .split(",")
    .map((name) => name.trim().replace(/^type\s+/, ""))
    .filter(Boolean)
    .sort();
}

function allNamedImports(source: string): string[] {
  return [...source.matchAll(/import\s+\{([^}]+)\}\s+from\s+["'][^"']+["']/g)]
    .flatMap(([, bindings]) =>
      (bindings ?? "")
        .split(",")
        .map((name) => name.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0])
        .filter((name): name is string => Boolean(name))
    );
}

test("Home, data sources, and data source pages use the shared status wording", async () => {
  const [home, homeModel, sources, sourcesModel, detail, rowStatus, sentence] = await Promise.all([
    readFile(HOME, "utf8"),
    readFile(HOME_MODEL, "utf8"),
    readFile(SOURCES, "utf8"),
    readFile(SOURCES_MODEL, "utf8"),
    readFile(SOURCE_DETAIL, "utf8"),
    readFile(SOURCE_ROW_STATUS, "utf8"),
    readFile(SOURCE_SENTENCE, "utf8"),
  ]);

  assert.match(home, /import \{ SourceStatusText \} from "\.\.\/source-status-text\.tsx"/);
  assert.deepEqual(importedNames(homeModel, "\\.\\.\\/\\.\\.\\/lib\\/source-status-words\\.ts"), [
    "SourceStatusWords",
    "isUpToDateRow",
    "sourceStatusWords",
  ]);
  assert.match(homeModel, /status: sourceStatusWords\(source,/);
  assert.match(sources, /import \{ SourceRowStatus \} from "\.\/source-row-status\.tsx"/);
  assert.deepEqual(importedNames(sourcesModel, "\\.\\.\\/lib\\/source-status-words\\.ts"), [
    "ENTER_THE_CODE",
    "SourceStatusWords",
    "manifestCredentialKind",
    "sourceStatusWords",
  ]);
  assert.match(sourcesModel, /statusWordsNow = sourceStatusWords\(summary,/);
  assert.match(sourcesModel, /statusWords: statusWordsNow/);
  assert.deepEqual(importedNames(detail, "\\.\\.\\/\\.\\.\\/lib\\/source-status-words\\.ts"), [
    "SourceStatusAction",
    "manifestCredentialKind",
    "sourceNeverConnected",
    "sourceStateSentence",
    "sourceStatusWords",
  ]);
  assert.match(detail, /SourceStateSentenceText/);
  assert.match(rowStatus, /SourceStatusText/);
  assert.match(sentence, /SourceStatusText/);

  for (const [name, source] of [
    ["Home", home],
    ["Home model", homeModel],
    ["Data sources", sources],
    ["Data sources model", sourcesModel],
    ["Data source", detail],
  ] as const) {
    const competingImports = allNamedImports(source).filter((binding) => LEGACY_STATUS_WORDERS.includes(binding as (typeof LEGACY_STATUS_WORDERS)[number]));
    assert.deepEqual(competingImports, [], `${name} must not import a competing status worder`);
  }
});
