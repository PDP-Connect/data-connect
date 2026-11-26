// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The source detail page must follow the data-source layout in DIRECTION.md.
 *
 * Owner, 2026-08-07: "There is no information architecture. Diagnostics is open
 * by default and is the first thing you see. […] Streams and Runs/Syncs are the
 * main things a user expects to see."
 *
 * Main content comes before source controls; then Settings and folded Details.
 * This pins the requested information order without encoding visual styling.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const DIAGNOSTICS_CLOSED_BY_DEFAULT_RE = /open=\{hasDeviceLocalRemediation \|\| undefined\}/;
const PAGE_FILE = `${HERE}source-page.tsx`;

interface SectionOffsets {
  collected: number;
  configuration: number;
  dangerZone: number;
  details: number;
  diagnostics: number;
  runs: number;
  whatIsHere: number;
}

async function renderOrder(): Promise<SectionOffsets> {
  const src = await readFile(PAGE_FILE, "utf8");
  return {
    collected: src.indexOf("<AcquisitionCoverageSection"),
    configuration: src.indexOf("<ConnectionConfiguration"),
    dangerZone: src.indexOf("<ConnectionDangerZone"),
    details: src.indexOf('>Technical details</Link>'),
    diagnostics: src.indexOf("<ConnectionDiagnostics"),
    runs: src.indexOf("<RecentRunsSection"),
    whatIsHere: src.indexOf('title="What is here"'),
  };
}

test("What is here and Latest syncs lead; collected evidence stays inside folded Details", async () => {
  const at = await renderOrder();
  for (const [name, index] of Object.entries(at)) {
    assert.notEqual(index, -1, `${name} must render on this page`);
  }
  // Brief decisions 6–7: the two plain-language sections lead; evidence moves into Details.
  assert.ok(at.whatIsHere < at.runs, "What is here precedes Latest syncs");
  assert.ok(at.runs < at.details, "Latest syncs precedes folded Details");
  assert.ok(at.details < at.collected, "technical evidence is rendered by the separate technical view");
});

test("the header shows the account line and a 48px source mark", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  // DIRECTION.md §One data source: the logo, title, and account line lead the page.
  assert.match(src, /description=\{accountLine === displayName \? undefined : accountLine\}/);
  // DIRECTION.md §What must stay true: raw IDs stay inside folded Details.
  assert.match(src, /const accountLabel = source\.display_name \?\? source\.local_binding_name/);
  assert.doesNotMatch(src, /const accountLabel = source\.display_name \?\? source\.local_binding_name \?\? source\.device_id/);
  // DIRECTION.md §One data source: the source logo is 48px.
  assert.match(src, /\[&_\.pdpp-connector-icon\]:size-12/);
});

test("a disconnected source has one set-up link", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  // DIRECTION.md §One data source: the two disconnected-source links share one setup destination.
  assert.equal((src.match(/>Set up again<\/Link>/g) ?? []).length, 1);
  // DIRECTION.md §One data source: keep one “Set up again” action, not the duplicate reconnect label.
  assert.doesNotMatch(src, />Reconnect source</);
});

test("device collector trouble is shown under the state sentence when local recovery is needed", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  const sentence = src.indexOf("<SourceStateSentenceText");
  const trouble = src.indexOf('data-testid="device-collector-trouble"');
  const details = src.indexOf('>Technical details</Link>');
  const recovery = src.indexOf("<ConnectionRecoverySummary");
  // DIRECTION.md §One data source: device collector trouble sits directly under the state sentence.
  assert.ok(sentence < trouble, "state sentence precedes the device recovery note");
  // Brief decision 5: recovery information is folded under Details.
  assert.ok(trouble < details && details < recovery, "device note stays visible while recovery details are folded");
  // DIRECTION.md §One status, from one place: use the existing structured local-device condition.
  assert.match(src, /hasPrimaryOwnerLocalDeviceRemediation\(connectionRenderedVerdict\)/);
  // Brief decision 5: technical diagnostics remain inside folded Details.
  assert.match(src, /showRecoverySummary=\{false\}/);
});

test("source controls precede Settings and folded Details", async () => {
  const at = await renderOrder();
  // DIRECTION.md §One data source: controls come before Settings and Details.
  assert.ok(at.dangerZone < at.configuration, "source controls precede Settings");
  assert.ok(at.configuration < at.details, "Settings precede folded Details");
  assert.ok(at.details < at.diagnostics, "Diagnostics stays inside folded Details");
});

/**
 * Configuration is owner-decision content, not operator-debug detail. It
 * Settings follows the source controls and precedes Details.
 */
test("Settings follows source controls and precedes Diagnostics in Details", async () => {
  const at = await renderOrder();
  assert.notEqual(at.configuration, -1, "configuration must render on this page");
  // DIRECTION.md §One data source: Settings is followed by folded Details.
  assert.ok(at.dangerZone < at.configuration, "source controls precede Settings");
  assert.ok(at.configuration < at.diagnostics, "Settings precedes diagnostics");
});

test("diagnostics stays collapsed unless it has something actionable", async () => {
  // An <details> that is open by default reintroduces the original complaint
  // even if the section is ordered correctly. The one sanctioned exception is a
  // device-local remediation the owner must actually run.
  const src = await readFile(`${HERE}connection-diagnostics.tsx`, "utf8");
  assert.match(src, DIAGNOSTICS_CLOSED_BY_DEFAULT_RE);
});
