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
  assert.match(
    src,
    /const action = packageNeedsInstall \|\| packageAvailabilityUnknown \|\| isUnavailable \? null : sourceSetupAction\(entry\);/
  );
  // Unavailable rows collapse into their own disclosure, separate from the
  // primary scannable list, so N dead rows never sit in the middle of it.
  assert.match(src, /data-testid="unavailable-connectors-disclosure"/);
  assert.match(src, /not available on this platform/);
});

test("transient install catalog failures disable unknown package actions without hiding installed rows", async () => {
  const src = await readFile(SOURCE_SETUP_CATALOG_FILE, "utf8");
  assert.match(src, /installCatalogTransientlyUnavailable = false/);
  assert.match(src, /const packageAvailabilityUnknown = installCatalogTransientlyUnavailable && !installLifecycle\?\.installed;/);
  assert.match(src, /packageNeedsInstall \|\| packageAvailabilityUnknown \|\| isUnavailable \? null : sourceSetupAction\(entry\)/);
  assert.match(src, /data-testid="connector-install-catalog-transient"/);
  assert.match(src, /Package availability is unknown while the catalog is busy; this page will retry once shortly\./);
  assert.match(src, /Package availability is unknown while the catalog is busy; use Retry to check again\./);
  assert.match(src, /Checking package availability now\./);
  assert.match(src, /This page will check the package catalog for updates shortly\./);
  assert.match(src, /The package catalog is still busy; use Retry to check for updates\./);
  assert.match(src, /Checking the package catalog for updates now\./);
});

test("transient install catalog notice retries once and keeps a manual retry action", async () => {
  const src = await readFile(SOURCE_SETUP_CATALOG_FILE, "utf8");
  assert.match(src, /const TRANSIENT_CATALOG_RETRY_DELAY_MS = 5000;/);
  assert.match(src, /let transientCatalogRetryAttempted = false;/);
  assert.match(src, /let transientCatalogRefreshInFlight = false;/);
  assert.match(src, /let transientCatalogPendingSnapshotId: string \| null = null;/);
  assert.match(src, /type ConnectorCatalogRecoveryState = "exhausted" \| "refreshing" \| "scheduled";/);
  assert.match(src, /function resetTransientCatalogRetry\(\): void \{/);
  assert.doesNotMatch(src, /function scheduleTransientCatalogRetryReset/);
  assert.match(src, /function useConnectorCatalogRecovery\(enabled: boolean, busySnapshotId: string \| null\)/);
  assert.match(src, /const \[recoveryState, setRecoveryState\] = useState<ConnectorCatalogRecoveryState>\("exhausted"\);/);
  assert.match(src, /const retryTimerRef = useRef<ReturnType<typeof window\.setTimeout> \| null>\(null\);/);
  assert.match(src, /if \(transientCatalogRefreshInFlight \|\| !busySnapshotId\) \{\s*return;\s*\}/);
  assert.match(src, /transientCatalogRefreshInFlight = true;/);
  assert.match(src, /transientCatalogPendingSnapshotId = busySnapshotId;/);
  assert.match(src, /setRecoveryState\("refreshing"\);/);
  assert.match(src, /resetTransientCatalogRetry\(\);/);
  assert.match(
    src,
    /if \(transientCatalogRefreshInFlight && transientCatalogPendingSnapshotId !== busySnapshotId\) \{[\s\S]{0,160}setRecoveryState\("exhausted"\);/
  );
  assert.match(src, /if \(transientCatalogRefreshInFlight\) \{\s*setRecoveryState\("refreshing"\);/);
  assert.match(src, /if \(transientCatalogRetryAttempted\) \{\s*setRecoveryState\("exhausted"\);/);
  assert.match(src, /retryTimerRef\.current = window\.setTimeout\(\(\) => \{/);
  assert.match(src, /transientCatalogRetryAttempted = true;[\s\S]{0,120}refreshCatalog\(\);/);
  assert.match(src, /const refreshCatalog = useCallback\(\(\) => \{[\s\S]{0,300}router\.refresh\(\);/);
  assert.match(src, /const refreshManually = useCallback\(\(\) => \{/);
  assert.match(src, /transientCatalogRetryAttempted = true;[\s\S]{0,80}clearRetryTimer\(\);[\s\S]{0,80}refreshCatalog\(\);/);
  assert.match(src, /TRANSIENT_CATALOG_RETRY_DELAY_MS/);
  assert.match(src, /return clearRetryTimer;/);
  assert.doesNotMatch(src, /window\.setInterval/);
  assert.doesNotMatch(src, /sessionStorage/);
  assert.doesNotMatch(src, /setTimeout\(\(\) => \{\s*resetTransientCatalogRetry/);
  assert.match(src, /data-testid="connector-install-catalog-recovery"/);
  assert.match(src, /This page will retry once in a few seconds/);
  assert.match(src, /Checking the package catalog now\. Retry will be available again if the catalog is still busy\./);
  assert.match(src, /The package catalog is still busy\. Use Retry to check again for package actions\./);
  assert.match(
    src,
    /<IcButton[\s\S]{0,120}disabled=\{recoveryState === "refreshing"\}[\s\S]{0,120}onClick=\{refreshManually\}[\s\S]{0,120}variant="ghost"/
  );
  assert.match(src, />\s*Retry\s*<\/IcButton>/);
});
