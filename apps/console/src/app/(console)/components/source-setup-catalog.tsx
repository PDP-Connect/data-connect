"use client";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { buttonVariants, IcButton, IcInput, IcSelect } from "@pdpp/brand-react";
import { Section } from "@pdpp/operator-ui/components/primitives";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ConnectorMark } from "./connector-mark.tsx";
import { OpenExternalLink } from "./open-external-link.tsx";
import type { ConnectorAcquisitionPath, ConnectorCatalogEntry } from "../lib/connection-catalog.ts";
import type { ConnectorInstallLifecycle } from "../lib/connector-install-presentation.ts";
import {
  connectorInstallRowModel,
  connectorLookupKey,
  isUninstallableCatalogEntry,
} from "../lib/connector-install-presentation.ts";
import type { RefCountState } from "../lib/ref-client.ts";
import {
  buildCatalogView,
  type CatalogMaturityFilter,
  type CatalogSort,
  searchUrlFor,
} from "../lib/source-catalog-view.ts";
import {
  browserBoundWithStoredCredentials,
  sourceSetupCardAction,
  sourceSetupAvailability,
  sourceSetupContext,
  sourceSetupGuidance,
  sourceSetupRowIsUnavailable,
  sourceSetupSecondaryAction,
  sourceSetupStatus,
} from "../lib/source-setup-presentation.ts";
import { formatTotalRecordsLabel } from "../lib/total-records-label.ts";
import {
  getDeveloperModeServerSnapshot,
  getDeveloperModeSnapshot,
  subscribeToDeveloperMode,
  filterCatalogForDevelopmentVisibility,
} from "../lib/source-setup-development.ts";
import { ConnectorInstallRow } from "../sources/add/connector-install-row.tsx";

const TRANSIENT_CATALOG_RETRY_DELAY_MS = 5000;
let transientCatalogRetryAttempted = false;
let transientCatalogRefreshInFlight = false;
let transientCatalogPendingSnapshotId: string | null = null;

type ConnectorCatalogRecoveryState = "exhausted" | "refreshing" | "scheduled";

export interface ExistingSourceSetupLink {
  connectionId: string;
  displayName: string;
  latestImportFile: string | null;
  latestImportStatus: string | null;
  status: string | null;
  totalRecords: number;
  /**
   * Orthogonal state for `totalRecords` (Sol fourth-verdict P1.3).
   * `undefined` for a reference predating this field, preserving the exact
   * prior always-numeric rendering below.
   */
  totalRecordsState?: RefCountState;
}

function pathTone(path: ConnectorAcquisitionPath): string {
  if (path.posture === "primary") {
    return "border-[color:var(--success)]/30 bg-status-success-bg text-status-success-fg";
  }
  if (path.posture === "advanced") {
    return "border-[color:var(--warning)]/30 bg-status-warning-bg text-status-warning-fg";
  }
  return "border-border bg-muted/30 text-muted-foreground";
}

function SourceAcquisitionPathRow({ path }: { path: ConnectorAcquisitionPath }) {
  return (
    <li
      className="grid gap-1 rounded-md border border-border/70 bg-background/60 p-2"
      data-testid="source-acquisition-path"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="pdpp-caption font-medium text-foreground">{path.label}</span>
        <span className={`pdpp-eyebrow rounded border px-1.5 py-0.5 ${pathTone(path)}`}>{path.posture}</span>
        {path.platform ? <span className="pdpp-caption text-muted-foreground">{path.platform}</span> : null}
      </div>
      {path.detail ? <p className="pdpp-caption text-muted-foreground">{path.detail}</p> : null}
      {path.helpUrl ? (
        <Link className="pdpp-caption text-foreground underline underline-offset-4" href={path.helpUrl}>
          Open source instructions
        </Link>
      ) : null}
    </li>
  );
}

function SourceAcquisitionPaths({ paths }: { paths: readonly ConnectorAcquisitionPath[] }) {
  if (!paths.length) {
    return null;
  }
  const primary = paths.filter((path) => path.posture === "primary");
  const visible = primary.length > 0 ? primary : paths.slice(0, 1);
  const visibleLabels = new Set(visible.map((path) => path.label));
  const secondary = paths.filter((path) => !visibleLabels.has(path.label));
  return (
    <div className="mt-3" data-testid="source-acquisition-paths">
      <p className="pdpp-eyebrow mb-1 text-muted-foreground">Ways to add data</p>
      <ul className="grid gap-2">
        {visible.map((path) => (
          <SourceAcquisitionPathRow key={`${path.posture}:${path.label}`} path={path} />
        ))}
      </ul>
      {secondary.length > 0 ? (
        <details className="group mt-2">
          <summary className="pdpp-caption cursor-pointer list-none text-muted-foreground underline decoration-dotted underline-offset-4 hover:text-foreground">
            Other ways to add data
          </summary>
          <ul className="mt-2 grid gap-2">
            {secondary.map((path) => (
              <SourceAcquisitionPathRow key={`${path.posture}:${path.label}`} path={path} />
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

/**
 * Development-tier method line, resolved before the `not_available_here`
 * short-circuit below. `sourceSetupAvailability` reports `not_available_here`
 * for every Development entry regardless of whether it renders an add
 * action (see `sourceSetupAction`'s scaffold check), so that check alone
 * would print "No proven setup path is available" directly above a real
 * "Add account" button for a self-testable entry -- contradicting the
 * action right next to it.
 */
function developmentMethodLine(entry: ConnectorCatalogEntry): string {
  if (entry.isKnownScaffold) {
    return "Not built yet: nobody has written this connector's collection code.";
  }
  return "Setup path implemented, not yet proven against a live account.";
}

function sourceMethodLine(entry: ConnectorCatalogEntry, existingSourceCount: number): string {
  if (entry.publicTier === "development") {
    return developmentMethodLine(entry);
  }
  if (browserBoundWithStoredCredentials(entry) && entry.disposition === "static_secret_connect") {
    return "Connect with this source's sign-in details and complete any required steps in the secure browser.";
  }
  if (sourceSetupAvailability(entry) === "not_available_here") {
    return "No proven setup path is available in this dashboard.";
  }
  switch (entry.disposition) {
    case "local_collector_enroll":
      return "Run the local collector on the machine that has this data.";
    case "static_secret_connect":
      return "Enter the provider credential for this account.";
    case "static_secret_experimental":
      return "Enter the provider credential for this account. Preview: not yet live-validated.";
    case "provider_auth_connect":
      return "Authorize this account through the provider.";
    case "manual_upload_connect":
      return existingSourceCount > 0
        ? `${existingSourceCount} existing ${existingSourceCount === 1 ? "source" : "sources"} can receive another export; choose on the import page.`
        : "Owner-exported file import.";
    case "provider_auth_deployment_blocked":
      return "This source needs provider authorization. Configure provider settings before adding an account.";
    case "browser_collector_manual":
    case "browser_bound_runbook":
      return entry.disposition === "browser_collector_manual"
        ? "Connect account from a secure browser session."
        : "Browser setup is not available in this dashboard yet.";
    default:
      return "No setup path is available in this dashboard.";
  }
}

function SourceSetupContext({ entry }: { entry: ConnectorCatalogEntry }) {
  const context = sourceSetupContext(entry);
  // A row already saying "no setup path is available here" must never also
  // show manifest-authored setup instructions for one right below it -- that
  // is the exact same-row contradiction as the "not available" bucket
  // claiming a connector has none.
  if (!context || sourceSetupRowIsUnavailable(entry)) {
    return null;
  }
  return (
    <p className="pdpp-caption mt-2 text-muted-foreground" data-testid="source-setup-context">
      {context}
    </p>
  );
}

function sourceDetailHref(connectorKey: string, connectionId: string): string {
  const params = new URLSearchParams({ connection_id: connectionId });
  return `/sources/${encodeURIComponent(connectorKey)}?${params.toString()}`;
}

function sourceRecordsHref(connectionId: string): string {
  const params = new URLSearchParams({ connection: connectionId });
  return `/explore?${params.toString()}`;
}

function ExistingSourceLinks({
  connectorKey,
  icon,
  sources,
}: {
  connectorKey: string;
  icon: ConnectorCatalogEntry["icon"];
  sources: readonly ExistingSourceSetupLink[];
}) {
  if (sources.length === 0) {
    return null;
  }
  return (
    <div className="mt-4 border-t border-border/60 pt-3" data-testid="existing-source-links">
      <p className="pdpp-eyebrow text-muted-foreground">Existing accounts</p>
      <ul className="mt-2 divide-y divide-border/60">
        {sources.map((source) => {
          const latestFact = source.latestImportStatus ?? source.status ?? null;
          return (
            <li
              className="grid gap-2 py-2 first:pt-0 last:pb-0 sm:grid-cols-[minmax(0,1fr)_auto]"
              key={source.connectionId}
            >
              <div className="min-w-0">
                <p className="flex items-center gap-2 pdpp-caption font-medium text-foreground">
                  <ConnectorMark className="size-5 shrink-0" icon={icon} name={source.displayName} />
                  {source.displayName}
                </p>
                <p className="pdpp-caption text-muted-foreground">
                  {formatTotalRecordsLabel(source.totalRecords, source.totalRecordsState, "records")}
                  {latestFact ? ` · ${latestFact}` : ""}
                </p>
                {source.latestImportFile ? (
                  <p className="pdpp-caption truncate text-muted-foreground">{source.latestImportFile}</p>
                ) : null}
              </div>
              <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                <Link
                  className={buttonVariants({ size: "sm", variant: "ghost" })}
                  href={sourceRecordsHref(source.connectionId)}
                >
                  Open in Explore
                </Link>
                <Link
                  className={buttonVariants({ size: "sm", variant: "ghost" })}
                  href={sourceDetailHref(connectorKey, source.connectionId)}
                >
                  Source details
                </Link>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function SourceExternalDocs({ entry }: { entry: ConnectorCatalogEntry }) {
  if (entry.externalDocs.length === 0) {
    return null;
  }
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1">
      <span className="pdpp-caption text-muted-foreground">Provider documentation:</span>
      {entry.externalDocs.map((doc) => (
        <OpenExternalLink
          className="pdpp-caption text-foreground underline underline-offset-4"
          href={doc.url}
          key={`${entry.connectorKey}:${doc.url}`}
          title="Opens in a new tab"
        >
          {doc.label} (opens in a new tab)
        </OpenExternalLink>
      ))}
    </div>
  );
}

function SourceSetupDetails({ entry }: { entry: ConnectorCatalogEntry }) {
  const guidance = sourceSetupGuidance(entry);
  const hasRichImportDetail = entry.disposition === "manual_upload_connect" && entry.acquisitionPaths.length > 0;

  if (!hasRichImportDetail && entry.externalDocs.length === 0) {
    return null;
  }

  return (
    <details className="group mt-2" data-testid="source-setup-details">
      <summary className="pdpp-caption cursor-pointer list-none text-muted-foreground underline decoration-dotted underline-offset-4 hover:text-foreground">
        {hasRichImportDetail ? "Show import options" : "Provider documentation"}
      </summary>
      <div className="mt-2 grid gap-2">
        {hasRichImportDetail ? (
          <>
            <p className="pdpp-caption text-muted-foreground">{guidance}</p>
            <SourceAcquisitionPaths paths={entry.acquisitionPaths} />
          </>
        ) : null}
        <SourceExternalDocs entry={entry} />
      </div>
    </details>
  );
}

function resetTransientCatalogRetry(): void {
  transientCatalogRetryAttempted = false;
  transientCatalogRefreshInFlight = false;
  transientCatalogPendingSnapshotId = null;
}

function useConnectorCatalogRecovery(enabled: boolean, busySnapshotId: string | null): {
  readonly refreshManually: () => void;
  readonly recoveryState: ConnectorCatalogRecoveryState;
} {
  const router = useRouter();
  const [recoveryState, setRecoveryState] = useState<ConnectorCatalogRecoveryState>("exhausted");
  const retryTimerRef = useRef<number | null>(null);

  const clearRetryTimer = useCallback(() => {
    if (retryTimerRef.current) {
      window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  }, []);

  const refreshCatalog = useCallback(() => {
    if (transientCatalogRefreshInFlight || !busySnapshotId) {
      return;
    }
    transientCatalogRefreshInFlight = true;
    transientCatalogPendingSnapshotId = busySnapshotId;
    setRecoveryState("refreshing");
    try {
      router.refresh();
    } catch {
      transientCatalogRefreshInFlight = false;
      transientCatalogPendingSnapshotId = null;
      setRecoveryState("exhausted");
    }
  }, [busySnapshotId, router]);

  const refreshManually = useCallback(() => {
    transientCatalogRetryAttempted = true;
    clearRetryTimer();
    refreshCatalog();
  }, [clearRetryTimer, refreshCatalog]);

  useEffect(() => {
    if (!enabled) {
      resetTransientCatalogRetry();
      clearRetryTimer();
      setRecoveryState("exhausted");
      return;
    }
    if (transientCatalogRefreshInFlight && transientCatalogPendingSnapshotId !== busySnapshotId) {
      transientCatalogRefreshInFlight = false;
      transientCatalogPendingSnapshotId = null;
      setRecoveryState("exhausted");
      return;
    }
    if (transientCatalogRefreshInFlight) {
      setRecoveryState("refreshing");
      return;
    }
    if (transientCatalogRetryAttempted) {
      setRecoveryState("exhausted");
      return clearRetryTimer;
    }
    setRecoveryState("scheduled");
    retryTimerRef.current = window.setTimeout(() => {
      transientCatalogRetryAttempted = true;
      retryTimerRef.current = null;
      refreshCatalog();
    }, TRANSIENT_CATALOG_RETRY_DELAY_MS);
    return clearRetryTimer;
  }, [busySnapshotId, clearRetryTimer, enabled, refreshCatalog]);

  return { recoveryState, refreshManually };
}

function ConnectorCatalogRecoveryNotice({
  enabled,
  recoveryState,
  refreshManually,
}: {
  enabled: boolean;
  recoveryState: ConnectorCatalogRecoveryState;
  refreshManually: () => void;
}) {
  if (!enabled) {
    return null;
  }

  return (
    <div className="mb-4 grid gap-2 rounded-sm border border-status-warning-border bg-status-warning-bg p-3 text-status-warning-fg" data-testid="connector-install-catalog-recovery">
      <p className="pdpp-caption">
        {recoveryState === "refreshing"
          ? "Checking the package catalog now. Retry will be available again if the catalog is still busy."
          : recoveryState === "scheduled"
            ? "The package catalog is refreshing. This page will retry once in a few seconds; use Retry now if package actions still do not appear."
            : "The package catalog is still busy. Use Retry to check again for package actions."}
      </p>
      <div>
        <IcButton
          disabled={recoveryState === "refreshing"}
          onClick={refreshManually}
          size="sm"
          type="button"
          variant="ghost"
        >
          Retry
        </IcButton>
      </div>
    </div>
  );
}

function installLifecycleFor(
  entry: ConnectorCatalogEntry,
  installLifecycleByConnector: Readonly<Record<string, ConnectorInstallLifecycle>> | null | undefined
): ConnectorInstallLifecycle | null {
  if (installLifecycleByConnector === null) {
    return null;
  }
  return installLifecycleByConnector?.[connectorLookupKey(entry.connectorKey)] ?? { catalog: null, installed: null };
}

function SourceSetupCard({
  entry,
  existingSources,
  installCatalogRecoveryState,
  installCatalogTransientlyUnavailable,
  installLifecycle,
}: {
  entry: ConnectorCatalogEntry;
  existingSources: readonly ExistingSourceSetupLink[];
  installCatalogRecoveryState: ConnectorCatalogRecoveryState;
  installCatalogTransientlyUnavailable: boolean;
  installLifecycle: ConnectorInstallLifecycle | null;
}) {
  const status = sourceSetupStatus(entry);
  // A row with no click target at all must never offer an install control
  // either: an OCI package can exist for a connector this dashboard cannot
  // otherwise use (a known scaffold, a proof-gated or unsupported
  // disposition), and offering Install there is exactly the dead control the
  // owner rejected -- a package state fact is still shown, just without a
  // button that can never do anything.
  const isUnavailable = sourceSetupRowIsUnavailable(entry);
  const installModel = installLifecycle ? connectorInstallRowModel(entry, installLifecycle) : null;
  const packageAvailabilityUnknown = installCatalogTransientlyUnavailable && !installLifecycle?.installed;
  const packageNeedsInstall = !isUnavailable && installModel?.activationState === "not_installed";
  const action = sourceSetupCardAction(entry, installModel?.activationState ?? null, packageAvailabilityUnknown);
  const secondaryAction = sourceSetupSecondaryAction(entry);
  return (
    <li
      className={`grid gap-4 rounded-sm border border-border/80 bg-card px-4 py-4 sm:grid-cols-[minmax(0,2fr)_minmax(10rem,1fr)_auto] sm:items-start ${
        isUnavailable ? "opacity-70" : ""
      }`}
      data-testid={`source-setup-${entry.connectorKey}`}
      data-install-state={installModel?.activationState ?? "unknown"}
      data-row-unavailable={isUnavailable}
      data-tier={entry.publicTier}
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <ConnectorMark className="size-8 shrink-0" icon={entry.icon} name={entry.displayName} />
          <h3 className="pdpp-title text-foreground">{entry.displayName}</h3>
          {installModel?.activationState === "update_available" ? (
            <span
              className="pdpp-eyebrow rounded border border-[color:var(--warning)]/30 bg-status-warning-bg px-1.5 py-0.5 text-status-warning-fg"
              data-testid="source-update-badge"
            >
              Update available
            </span>
          ) : null}
          {/* Current support / blocked fact, kept distinct from the next action. */}
          {status.label ? (
            <span
              aria-label={`${status.label}: ${status.description}`}
              className={`pdpp-eyebrow rounded border px-1.5 py-0.5 ${status.tone}`}
              data-testid="source-support-fact"
              title={status.description}
            >
              {status.label}
            </span>
          ) : null}
        </div>
        <p
          className="pdpp-caption mt-1 text-muted-foreground"
          data-testid={isUnavailable ? "source-unavailable-reason" : undefined}
        >
          {sourceMethodLine(entry, existingSources.length)}
        </p>
        <SourceSetupContext entry={entry} />
        <ExistingSourceLinks connectorKey={entry.connectorKey} icon={entry.icon} sources={existingSources} />
        <SourceSetupDetails entry={entry} />
      </div>
      <div className="border-t border-border/60 pt-3 sm:border-t-0 sm:border-l sm:pl-4" data-testid="source-setup-install">
        <p className="pdpp-eyebrow mb-2 text-muted-foreground">Package</p>
        {isUnavailable ? (
          <span className="pdpp-caption text-muted-foreground" data-testid="connector-install-disabled">
            Not installable: no setup path is available here.
          </span>
        ) : packageAvailabilityUnknown ? (
          <span className="pdpp-caption text-status-warning-fg" data-testid="connector-install-catalog-transient">
            {installCatalogRecoveryState === "scheduled"
              ? "Package availability is unknown while the catalog is busy; this page will retry once shortly."
              : installCatalogRecoveryState === "refreshing"
                ? "Checking package availability now."
                : "Package availability is unknown while the catalog is busy; use Retry to check again."}
          </span>
        ) : installModel ? (
          <>
            <ConnectorInstallRow compact model={installModel} />
            {installCatalogTransientlyUnavailable ? (
              <span className="pdpp-caption text-muted-foreground" data-testid="connector-install-catalog-transient">
                {installCatalogRecoveryState === "scheduled"
                  ? "This page will check the package catalog for updates shortly."
                  : installCatalogRecoveryState === "refreshing"
                    ? "Checking the package catalog for updates now."
                    : "The package catalog is still busy; use Retry to check for updates."}
              </span>
            ) : null}
          </>
        ) : (
          <span className="pdpp-caption text-muted-foreground">Package status unavailable</span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-border/60 pt-3 sm:border-t-0 sm:justify-end sm:pt-0">
        {packageNeedsInstall && installModel?.action ? (
          <span className="pdpp-caption text-muted-foreground" data-testid="connector-install-next-step">
            Install package first
          </span>
        ) : action ? (
          <>
            <Link className={buttonVariants({ size: "sm", variant: "default" })} href={action.href}>
              {action.label}
            </Link>
            {secondaryAction ? (
              <Link className={buttonVariants({ size: "sm", variant: "ghost" })} href={secondaryAction.href}>
                {secondaryAction.label}
              </Link>
            ) : null}
          </>
        ) : null}
      </div>
    </li>
  );
}

/* Preview and development are row properties; they are never nested groups. */

function SourceSetupCardList({
  entries,
  existingSourcesByConnector,
  installCatalogRecoveryState,
  installCatalogTransientlyUnavailable,
  installLifecycleByConnector,
}: {
  entries: readonly ConnectorCatalogEntry[];
  existingSourcesByConnector?: Readonly<Record<string, readonly ExistingSourceSetupLink[]>>;
  installCatalogRecoveryState: ConnectorCatalogRecoveryState;
  installCatalogTransientlyUnavailable: boolean;
  installLifecycleByConnector?: Readonly<Record<string, ConnectorInstallLifecycle>> | null;
}) {
  return (
    <ul className="grid gap-3" data-testid="source-setup-list">
      {entries.map((entry) => (
        <SourceSetupCard
          entry={entry}
          existingSources={existingSourcesByConnector?.[entry.connectorKey] ?? []}
          installCatalogRecoveryState={installCatalogRecoveryState}
          installCatalogTransientlyUnavailable={installCatalogTransientlyUnavailable}
          installLifecycle={installLifecycleFor(entry, installLifecycleByConnector)}
          key={entry.connectorKey}
        />
      ))}
    </ul>
  );
}


const SORT_OPTIONS = [
  { label: "Name", value: "name" },
  { label: "Maturity", value: "maturity" },
] as const;

const MATURITY_OPTIONS = [
  { label: "All", value: "all" },
  { label: "Supported", value: "supported" },
  { label: "Preview", value: "preview" },
  { label: "In development", value: "development" },
] as const;

const TOOLBAR_SELECT_STYLE = { width: "auto" } as const;

function isCatalogSort(value: string | null): value is CatalogSort {
  return SORT_OPTIONS.some((option) => option.value === value);
}

function isMaturityFilter(value: string | null): value is CatalogMaturityFilter {
  return MATURITY_OPTIONS.some((option) => option.value === value);
}

function CatalogColumnHeads() {
  return (
    <div className="hidden grid-cols-[minmax(0,2fr)_minmax(10rem,1fr)_auto] gap-4 px-4 sm:grid">
      <span className="pdpp-eyebrow text-muted-foreground">Connector</span>
      <span className="pdpp-eyebrow text-muted-foreground">Package state</span>
      <span className="pdpp-eyebrow text-muted-foreground">Action</span>
    </div>
  );
}

function CatalogToolbar({
  maturity,
  onMaturityChange,
  onSortChange,
  onWorksHereOnlyChange,
  sort,
  worksHereOnly,
}: {
  maturity: CatalogMaturityFilter;
  onMaturityChange: (value: CatalogMaturityFilter) => void;
  onSortChange: (value: CatalogSort) => void;
  onWorksHereOnlyChange: (value: boolean) => void;
  sort: CatalogSort;
  worksHereOnly: boolean;
}) {
  return (
    <div
      aria-label="Sort and filter sources"
      className="mb-3 flex flex-wrap items-center gap-x-5 gap-y-2"
      data-testid="source-catalog-toolbar"
      role="group"
    >
      <div className="flex items-center gap-2">
        <span className="pdpp-caption text-muted-foreground" id="source-sort-label">
          Sort
        </span>
        <IcSelect
          aria-label="Sort sources by"
          onValueChange={(value) => isCatalogSort(value) && onSortChange(value)}
          options={SORT_OPTIONS}
          style={TOOLBAR_SELECT_STYLE}
          value={sort}
        />
      </div>
      <div className="flex items-center gap-2">
        <span className="pdpp-caption text-muted-foreground" id="source-maturity-label">
          Maturity
        </span>
        <IcSelect
          aria-label="Filter sources by maturity"
          onValueChange={(value) => isMaturityFilter(value) && onMaturityChange(value)}
          options={MATURITY_OPTIONS}
          style={TOOLBAR_SELECT_STYLE}
          value={maturity}
        />
      </div>
      <label className="pdpp-caption flex cursor-pointer items-center gap-2 text-muted-foreground">
        <input
          checked={worksHereOnly}
          className="size-4 accent-[var(--foreground)]"
          data-testid="works-here-filter"
          onChange={(event) => onWorksHereOnlyChange(event.target.checked)}
          type="checkbox"
        />
        Works on this device
      </label>
    </div>
  );
}

export function SourceSetupCatalog({
  catalog,
  existingSourcesByConnector,
  installCatalogBusySnapshotId = null,
  installCatalogTransientlyUnavailable = false,
  installLifecycleByConnector = null,
  query: initialQuery,
}: {
  catalog: readonly ConnectorCatalogEntry[];
  /**
   * Built from `listConnectionsByConnector` (one exact `GET
   * /_ref/connections?connector_id=` call per catalog entry) — the full
   * owner-scoped set for each connector, never a fleet page filtered
   * client-side. There is no "incomplete" state to render here: each
   * connector's existing-sources list is exact by construction.
   */
  existingSourcesByConnector?: Readonly<Record<string, readonly ExistingSourceSetupLink[]>>;
  installCatalogBusySnapshotId?: string | null;
  installCatalogTransientlyUnavailable?: boolean;
  /** Null means the install route is not available on this server. */
  installLifecycleByConnector?: Readonly<Record<string, ConnectorInstallLifecycle>> | null;
  /** The `source_q` the page was opened with; later typing stays in the browser. */
  query: string;
}) {
  const developerMode = useSyncExternalStore(
    subscribeToDeveloperMode,
    getDeveloperModeSnapshot,
    getDeveloperModeServerSnapshot,
  );
  const connectorCatalogRecovery = useConnectorCatalogRecovery(
    installCatalogTransientlyUnavailable,
    installCatalogBusySnapshotId
  );
  // Search, sort and filters run in the browser over the catalog the page
  // already loaded. Only the query is mirrored into the URL (replaceState, so
  // no navigation and no server work) so a copied link reopens the search.
  const [query, setQuery] = useState(initialQuery);
  // The URL stays the source of truth for the query: a new `source_q` prop
  // (navigation that keeps this component mounted) or back/forward replaces it.
  const [seenInitialQuery, setSeenInitialQuery] = useState(initialQuery);
  if (initialQuery !== seenInitialQuery) {
    setSeenInitialQuery(initialQuery);
    setQuery(initialQuery);
  }
  useEffect(() => {
    const syncFromUrl = () => setQuery(new URLSearchParams(window.location.search).get("source_q") ?? "");
    window.addEventListener("popstate", syncFromUrl);
    return () => window.removeEventListener("popstate", syncFromUrl);
  }, []);
  const [sort, setSort] = useState<CatalogSort>("name");
  const [maturity, setMaturity] = useState<CatalogMaturityFilter>("all");
  const [worksHereOnly, setWorksHereOnly] = useState(false);
  const updateQuery = useCallback((value: string) => {
    setQuery(value);
    window.history.replaceState(window.history.state, "", searchUrlFor(window.location.href, value));
  }, []);
  // Developer mode (Settings) is the single control for development-tier
  // visibility; this surface never grows a second toggle for the same
  // concept. When it's off, the hidden count stays discoverable via the
  // quiet line below instead of a silently shrinking list.
  // A connector with no package, no installed package, and no registration
  // has nothing the owner can install or set up here, so it is not listed.
  // While the package catalog is busy every lifecycle reads as "no package",
  // so nothing is hidden until the catalog answers.
  const installableCatalog = installCatalogTransientlyUnavailable
    ? catalog
    : catalog.filter(
        (entry) => !isUninstallableCatalogEntry(entry, installLifecycleFor(entry, installLifecycleByConnector))
      );
  const visibleCatalog = filterCatalogForDevelopmentVisibility(installableCatalog, developerMode);
  const hiddenDevelopmentCount = installableCatalog.length - visibleCatalog.length;
  const ownedKeys = new Set(
    visibleCatalog
      .filter((entry) => (existingSourcesByConnector?.[entry.connectorKey]?.length ?? 0) > 0)
      .map((entry) => entry.connectorKey)
  );
  const updateKeys = new Set(
    visibleCatalog
      .filter((entry) => {
        const lifecycle = installLifecycleFor(entry, installLifecycleByConnector);
        return lifecycle !== null && connectorInstallRowModel(entry, lifecycle).activationState === "update_available";
      })
      .map((entry) => entry.connectorKey)
  );
  const view = buildCatalogView(visibleCatalog, { maturity, ownedKeys, query, sort, updateKeys, worksHereOnly });
  const updateCount = view.yours.filter((entry) => updateKeys.has(entry.connectorKey)).length;
  const filtersActive = maturity !== "all" || worksHereOnly;
  const nothingMatches = view.yours.length + view.addable.length + view.unavailable.length === 0;
  const clearFilters = () => {
    setMaturity("all");
    setWorksHereOnly(false);
  };
  // Every visible connector is one row. Tier, lifecycle exceptions, and
  // package activation are row properties, so Preview and In development do
  // not create nested containers or disappear from the scan path.
  //
  // The one exception: a row with no click target at all (known scaffold,
  // proof-gated, unsupported, unknown -- see `sourceSetupRowIsUnavailable`)
  // carries no scannable information a working row doesn't already imply, so
  // it never sits in the middle of the actionable list. It sits in its own
  // collapsed group after it, each row stating its reason.
  const listProps = {
    existingSourcesByConnector,
    installCatalogRecoveryState: connectorCatalogRecovery.recoveryState,
    installCatalogTransientlyUnavailable,
    installLifecycleByConnector,
  };
  return (
    <div data-testid="source-setup-catalog">
      {hiddenDevelopmentCount > 0 ? (
        <p className="pdpp-caption mb-4 text-muted-foreground" data-testid="development-hidden-notice">
          {hiddenDevelopmentCount} {hiddenDevelopmentCount === 1 ? "connector is" : "connectors are"} hidden by{" "}
          <Link className="underline underline-offset-4 hover:text-foreground" href="/settings">
            Developer mode
          </Link>
          .
        </p>
      ) : null}
      <ConnectorCatalogRecoveryNotice
        enabled={installCatalogTransientlyUnavailable}
        recoveryState={connectorCatalogRecovery.recoveryState}
        refreshManually={connectorCatalogRecovery.refreshManually}
      />
      <form className="mb-6" onSubmit={(event) => event.preventDefault()} role="search">
        <label className="sr-only" htmlFor="source_q">
          Search data sources
        </label>
        <IcInput
          autoComplete="off"
          id="source_q"
          name="source_q"
          onChange={(event) => updateQuery(event.target.value)}
          placeholder="Search source name or connector key"
          type="search"
          value={query}
        />
      </form>
      {nothingMatches ? (
        <p
          className="pdpp-caption rounded-md border border-border/80 border-dashed p-4 text-muted-foreground"
          data-testid="source-catalog-empty"
        >
          {query.trim() ? (
            <>
              No connector matched <span className="font-medium text-foreground">{query.trim()}</span>
              {filtersActive ? " with these filters" : ""}. Try the source name or connector key.
            </>
          ) : (
            "No connector matches these filters."
          )}
          {filtersActive ? (
            <>
              {" "}
              <button className="underline underline-offset-4 hover:text-foreground" onClick={clearFilters} type="button">
                Clear filters
              </button>
            </>
          ) : null}
        </p>
      ) : null}
      {view.yours.length > 0 ? (
        <Section
          description={
            updateCount > 0
              ? `${updateCount} ${updateCount === 1 ? "needs" : "need"} an update.`
              : "Sources already connected to this instance."
          }
          title="Your sources"
        >
          <div className="grid gap-3" data-testid="your-sources">
            <CatalogColumnHeads />
            <SourceSetupCardList entries={view.yours} {...listProps} />
          </div>
        </Section>
      ) : null}
      {nothingMatches ? null : (
        <Section
          description="Choose a connector to add data. Supported is the default; exception labels explain preview, in-development, and setup limits."
          title="Add a source"
        >
          <CatalogToolbar
            maturity={maturity}
            onMaturityChange={setMaturity}
            onSortChange={setSort}
            onWorksHereOnlyChange={setWorksHereOnly}
            sort={sort}
            worksHereOnly={worksHereOnly}
          />
          <div className="grid gap-3">
            {view.addable.length > 0 ? (
              <>
                <CatalogColumnHeads />
                <SourceSetupCardList entries={view.addable} {...listProps} />
              </>
            ) : view.unavailable.length === 0 ? (
              <p className="pdpp-caption text-muted-foreground" data-testid="source-catalog-no-more">
                No other sources match.
                {filtersActive ? (
                  <>
                    {" "}
                    <button
                      className="underline underline-offset-4 hover:text-foreground"
                      onClick={clearFilters}
                      type="button"
                    >
                      Clear filters
                    </button>
                  </>
                ) : null}
              </p>
            ) : null}
            {view.unavailable.length > 0 ? (
              <details
                className="group"
                data-testid="unavailable-connectors-disclosure"
                open={query.trim() ? true : undefined}
              >
                <summary className="pdpp-caption cursor-pointer list-none text-muted-foreground underline decoration-dotted underline-offset-4 hover:text-foreground">
                  {view.unavailable.length} more {view.unavailable.length === 1 ? "source" : "sources"} cannot be added
                  yet
                </summary>
                <div className="mt-3">
                  <SourceSetupCardList entries={view.unavailable} {...listProps} />
                </div>
              </details>
            ) : null}
          </div>
        </Section>
      )}
    </div>
  );
}
