// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const source = readFileSync(fileURLToPath(new URL("./technical-page.tsx", import.meta.url)), "utf8");

test("the sync page puts its source title and relative start time above the request", () => {
  assert.match(source, /<span>Technical details for this sync<\/span>/);
  assert.match(source, /formatRelative\(new Date\(startedAt\), Date\.now\(\)\)/);
  assert.ok(source.indexOf("<PageHeader") < source.indexOf("<CurrentAssistanceSection"));
  const header = source.slice(source.indexOf("<PageHeader"), source.indexOf("<CurrentAssistanceSection"));
  assert.ok(header.indexOf("{stateSentence}") < header.indexOf("Started {startedAt"));
  // DIRECTION.md, “What must stay true” #3: the title must not expose a raw ID or date.
  assert.doesNotMatch(source, /title=\{<code[^>]*>\{runId\}/);
});

test("the technical request and timeline remain unfolded and facts identify page-only counts", () => {
  assert.match(source, /<CurrentAssistanceSection/);
  assert.equal((source.match(/<summary[^>]*>Details<\/summary>/g) ?? []).length, 0);
  assert.match(source, /Checkpoints in this page/);
  assert.match(source, /Progress in this page/);
  assert.match(source, /Interactions in this page/);
  assert.match(source, /title="Failure"/);
  // Brief item 1: event and statistics counts describe the loaded timeline page.
  assert.match(source, /events in this page[\s\S]{0,120}\{events\.length\}/);
  // DIRECTION.md, “What must stay true” #4: every existing control stays on this page or its linked destination.
  assert.match(source, /<TimelineView/);
  assert.match(source, /exploreHrefFromEnvelope/);
  assert.match(source, /Open the browser/);
});

test("the sync page omits the internal server address and keeps one source breadcrumb", () => {
  assert.doesNotMatch(source, /getAsInternalUrl|raw: \$\{/);
  assert.match(source, /\{ href: sourceHref, label: connectorName \}/);
  assert.doesNotMatch(source, /connectorLabel|font-mono text-foreground underline/);
  // DIRECTION.md, “What must stay true” #4: both source navigation and the timeline controls remain reachable.
  assert.match(source, /dashboardRoutes\.section\.runs/);
});

test("collection facts show cancelled and failed partial counts, while zero kinds stay out", () => {
  // Brief item 3: cancelled and failed syncs label partial counts as collected before stopping.
  assert.match(readFileSync(new URL("./collected-kinds.ts",import.meta.url),"utf8"), /event\.event_type === "run\.cancelled"/);
  assert.match(source, /Collected before it stopped/);
  // Brief item 3: zero-count kinds are omitted, and an all-zero result says nothing was collected.
  assert.match(source, /collectedKinds\.filter\(\(\{ count \}\) => count > 0\)/);
  assert.match(source, /Nothing was collected\./);
});
