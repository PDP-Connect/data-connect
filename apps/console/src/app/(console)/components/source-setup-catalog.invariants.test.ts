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
  // Add-page repair decision 2: unknown package status is omitted from the source row.
  assert.doesNotMatch(src, /Package status unavailable/);
  assert.doesNotMatch(src, /<span className="pdpp-eyebrow text-muted-foreground">Next step<\/span>\s*<Link/);
  // The maturity filter reveals development rows; Developer mode still gates local-source controls.
  assert.doesNotMatch(src, /show-development-connectors-control|Show in-development connectors/);
  // Add-page repair decision 3: the Filter menu itself is the only development discovery instruction.
  assert.doesNotMatch(src, /development-hidden-notice|Choose the In development filter to view them/);
  // Brief decision 4: development rows appear when that maturity filter is selected.
  assert.match(src, /const includeDevelopment = developerMode \|\| maturities\.has\("development"\)/);
  assert.match(src, /"In development"/);
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

test("transient install catalog failures disable unknown package actions without hiding installed rows", async () => {
  const src = await readFile(SOURCE_SETUP_CATALOG_FILE, "utf8");
  assert.match(src, /installCatalogTransientlyUnavailable = false/);
  // Add-page repair decision 2: when status is unknown, the row says nothing and the page keeps one retry notice.
  assert.match(src, /!packageAvailabilityUnknown && installModel\?\.action/);
  assert.match(src, /presentation="primary-action"/);
  assert.match(src, /presentation=\{primaryPackageAction \? "uninstall-only" : "details-actions"\}/);
  assert.doesNotMatch(src, /data-testid="connector-install-catalog-transient"/);
  assert.match(src, /data-testid="connector-install-catalog-recovery"/);
});

test("transient install catalog notice retries once and keeps a manual retry action", async () => {
  const src = await readFile(SOURCE_SETUP_CATALOG_FILE, "utf8");
  assert.match(src, /const TRANSIENT_CATALOG_RETRY_DELAY_MS = 5000;/);
  assert.doesNotMatch(src, /^let transientCatalog/m, "retry state must not be module-global");
  assert.match(src, /const retryStateRef = useRef<TransientCatalogRetryState>\(freshTransientCatalogRetryState\(\)\);/);
  assert.match(src, /type ConnectorCatalogRecoveryState = "exhausted" \| "refreshing" \| "scheduled";/);
  assert.match(src, /function freshTransientCatalogRetryState\(\): TransientCatalogRetryState \{/);
  assert.doesNotMatch(src, /function scheduleTransientCatalogRetryReset/);
  assert.match(src, /function useConnectorCatalogRecovery\(enabled: boolean, busySnapshotId: string \| null\)/);
  assert.match(src, /const \[recoveryState, setRecoveryState\] = useState<ConnectorCatalogRecoveryState>\("exhausted"\);/);
  assert.match(src, /const retryTimerRef = useRef<number \| null>\(null\);/);
  assert.match(src, /if \(retryStateRef\.current\.inFlight \|\| !busySnapshotId\) \{\s*return;\s*\}/);
  assert.match(src, /retryStateRef\.current\.inFlight = true;/);
  assert.match(src, /retryStateRef\.current\.pendingSnapshotId = busySnapshotId;/);
  assert.match(src, /setRecoveryState\("refreshing"\);/);
  assert.match(src, /retryStateRef\.current = freshTransientCatalogRetryState\(\);/);
  assert.match(
    src,
    /if \(retryStateRef\.current\.inFlight && retryStateRef\.current\.pendingSnapshotId !== busySnapshotId\) \{[\s\S]{0,160}setRecoveryState\("exhausted"\);/
  );
  assert.match(src, /if \(retryStateRef\.current\.inFlight\) \{\s*setRecoveryState\("refreshing"\);/);
  assert.match(src, /if \(retryStateRef\.current\.attempted\) \{\s*setRecoveryState\("exhausted"\);/);
  assert.match(src, /retryTimerRef\.current = window\.setTimeout\(\(\) => \{/);
  assert.match(src, /retryStateRef\.current\.attempted = true;[\s\S]{0,120}refreshCatalog\(\);/);
  assert.match(src, /const refreshCatalog = useCallback\(\(\) => \{[\s\S]{0,300}router\.refresh\(\);/);
  assert.match(src, /const refreshManually = useCallback\(\(\) => \{/);
  assert.match(src, /retryStateRef\.current\.attempted = true;[\s\S]{0,80}clearRetryTimer\(\);[\s\S]{0,80}refreshCatalog\(\);/);
  assert.match(src, /TRANSIENT_CATALOG_RETRY_DELAY_MS/);
  assert.match(src, /return clearRetryTimer;/);
  assert.doesNotMatch(src, /window\.setInterval/);
  assert.doesNotMatch(src, /sessionStorage/);
  assert.doesNotMatch(src, /setTimeout\(\(\) => \{\s*freshTransientCatalogRetryState/);
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

test("uninstallable connectors are filtered out before the list is built", async () => {
  const src = await readFile(SOURCE_SETUP_CATALOG_FILE, "utf8");
  // Add-page repair decision 1: an existing data source stays visible even when there is no package lifecycle entry.
  assert.match(src, /const installed = sourceIsInstalled\(entry, lifecycle, existingSourcesByConnector\);/);
  assert.match(src, /if \(!installCatalogTransientlyUnavailable && isUninstallableCatalogEntry\(entry, lifecycle\)\) continue;/);
  assert.match(src, /filterCatalogForDevelopmentVisibility\(catalog, includeDevelopment\)/);
});

// Brief decisions 2 to 4: groups stay separate and search, sort, and filter fit the same compact toolbar.
test("the add page filters as the person types and keeps installed, available, and unavailable groups separate", async () => {
  const src = await readFile(SOURCE_SETUP_CATALOG_FILE, "utf8");
  assert.match(src, /onChange=\{\(event\) => updateSearch\(event\.currentTarget\.value\)\}/);
  assert.match(src, /window\.history\.replaceState\(window\.history\.state/);
  assert.doesNotMatch(src, /<form[^>]*action=|type="submit"/);
  assert.match(src, /aria-label="Installed"/);
  assert.match(src, /aria-label="Available"/);
  assert.match(src, /Can't be added here \(\{unavailableEntries\.length\}\)/);
  assert.match(src, /function SortMenu/);
  assert.match(src, /Name<\/Menu\.Item>/);
  assert.match(src, /Ready to use/);
  assert.match(src, /In testing/);
  assert.match(src, /In development/);
});

// Brief decision 10: A8 never rendered because sourceSetupSecondaryAction always returns null.
test("the catalog no longer renders the unreachable second card action", async () => {
  const src = await readFile(SOURCE_SETUP_CATALOG_FILE, "utf8");
  assert.doesNotMatch(src, /sourceSetupSecondaryAction|secondaryAction/);
});
