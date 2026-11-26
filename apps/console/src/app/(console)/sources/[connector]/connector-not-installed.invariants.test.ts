// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Source-text invariants for the source page's not-installed state.
 *
 * `page.tsx` is a server component with no render harness here (see
 * `sync-now-modality.test.ts`), so these pin the wiring: the page reads the
 * reference's `connector_implementation`, shows the install notice before any
 * run is attempted, feeds the same fact to the per-stream and diagnostics
 * dispositions, and tells the Sync button the notice is already on screen.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PAGE_FILE = `${HERE}source-page.tsx`;
const INSTALL_PROMPT_FILE = `${HERE}connector-install-prompt.tsx`;

const READS_SERVER_FACT = /const connectorNotInstalled = isConnectorNotInstalled\(summary\);/;
const STREAM_FACTS_GET_FACT = /formatStreamCollectionFacts\(entry, \{\s*connectorNotInstalled[,\s}]/;
const PROMPT_GATED = /const installPromptShown = connectorNotInstalled && !revoked && !setupFailed;/;
const INSTALL_ACTION_RENDERED = /if \(statusAction\?\.kind === "install"\)[\s\S]*<ConnectorInstallPrompt[\s\S]*variant="inline"/;
const INSTALL_STATE_COPY = /DataConnect needs to install/;
const DIAGNOSTICS_GET_FACT = /<ConnectionDiagnostics[\s\S]{0,300}connectorNotInstalled=\{connectorNotInstalled\}/;
const SYNC_BUTTONS = /<SyncNowButton\b[\s\S]*?\/>/g;

test("the source page puts install in the status action and keeps its prompt explanation", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  const prompt = await readFile(INSTALL_PROMPT_FILE, "utf8");
  assert.match(src, READS_SERVER_FACT);
  assert.match(src, STREAM_FACTS_GET_FACT);
  assert.match(src, PROMPT_GATED);
  // DIRECTION.md: the status table owns the one top action and the state copy follows its sentence.
  assert.match(src, INSTALL_ACTION_RENDERED);
  assert.match(prompt, INSTALL_STATE_COPY);
  assert.match(src, DIAGNOSTICS_GET_FACT);
});

test("every Sync button on the page knows whether the install notice is already shown", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  const buttons = src.match(SYNC_BUTTONS) ?? [];
  assert.ok(buttons.length > 0, "expected Sync buttons on the page");
  for (const element of buttons) {
    assert.match(element, /installPromptShown=\{installPromptShown\}/, element);
  }
});
