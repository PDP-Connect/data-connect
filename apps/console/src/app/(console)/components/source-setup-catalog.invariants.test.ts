// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SOURCE_SETUP_CATALOG_FILE = fileURLToPath(new URL("./source-setup-catalog.tsx", import.meta.url));

const EXTERNAL_DOCS = /externalDocs\.map/;
const OPENS_VIA_SYSTEM_BROWSER = /<OpenExternalLink/;
const NEW_TAB_TITLE = /title="Opens in a new tab"/;
const NEW_TAB_COPY = /\(opens in a new tab\)/;

test("source cards keep one flat surface with identity, package, and action columns", async () => {
  const src = await readFile(SOURCE_SETUP_CATALOG_FILE, "utf8");
  assert.match(src, /data-testid="source-setup-list"/);
  assert.match(src, /data-tier=\{entry\.publicTier\}/);
  assert.match(src, /data-install-state=\{installModel\?\.activationState \?\? "unknown"\}/);
  assert.match(src, /<ConnectorMark[\s\S]*icon=\{entry\.icon\}[\s\S]*name=\{entry\.displayName\}/);
  assert.doesNotMatch(src, /experimental-setup-summary|development-setup-summary|ExperimentalSetupSummary|DevelopmentSetupSummary/);
  assert.match(src, /Package status unavailable/);
  assert.doesNotMatch(src, /<span className="pdpp-eyebrow text-muted-foreground">Next step<\/span>\s*<Link/);
  // Developer mode (Settings) is the single control for development-tier
  // visibility. This surface must never grow its own second toggle for the
  // same concept -- it only reports the hidden count with a link back to
  // Settings.
  assert.doesNotMatch(src, /show-development-connectors-control|Show in-development connectors/);
  assert.match(src, /data-testid="development-hidden-notice"/, "hidden development connectors must stay discoverable");
  assert.match(src, /hidden by/i);
  assert.match(src, /href="\/settings"/);
});

test("source-setup-catalog renders external documentation links with new-tab forewarning", async () => {
  const src = await readFile(SOURCE_SETUP_CATALOG_FILE, "utf8");
  assert.match(src, EXTERNAL_DOCS, "must render externalDocs links");
  assert.match(
    src,
    OPENS_VIA_SYSTEM_BROWSER,
    "external documentation links must route through OpenExternalLink, not a bare <a>, so Tauri opens them in the system browser instead of the webview"
  );
  assert.match(src, NEW_TAB_COPY, "external documentation links must warn visibly before opening a new tab");
  assert.match(
    src,
    NEW_TAB_TITLE,
    'external documentation links must have title="Opens in a new tab" for accessibility/forewarning'
  );
});

test("unavailable rows never offer an install control and sort into a collapsed footer", async () => {
  const src = await readFile(SOURCE_SETUP_CATALOG_FILE, "utf8");
  assert.match(src, /sourceSetupRowIsUnavailable/, "must use the shared unavailable predicate, not a local reimplementation");
  // The Package column must render a disabled fact instead of ConnectorInstallRow
  // for an unavailable row -- an OCI package existing for a scaffold or
  // proof-gated connector must never surface an Install button.
  assert.match(src, /data-testid="connector-install-disabled"/);
  assert.match(src, /isUnavailable[\s\S]{0,80}\?[\s\S]{0,200}data-testid="connector-install-disabled"/);
  // The primary action column must also stay empty for an unavailable row.
  assert.match(src, /const action = packageNeedsInstall \|\| isUnavailable \? null : sourceSetupAction\(entry\);/);
  // Unavailable rows collapse into their own disclosure, separate from the
  // primary scannable list, so N dead rows never sit in the middle of it.
  assert.match(src, /data-testid="unavailable-connectors-disclosure"/);
  assert.match(src, /not available on this platform/);
});
