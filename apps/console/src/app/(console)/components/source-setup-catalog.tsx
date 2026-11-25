"use client";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { Menu } from "@base-ui/react/menu";
import { buttonVariants, IcButton, IcInput } from "@pdpp/brand-react";
import { Section } from "@pdpp/operator-ui/components/primitives";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Suspense, use, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ConnectorMark } from "./connector-mark.tsx";
import { OpenExternalLink } from "./open-external-link.tsx";
import type { ConnectorAcquisitionPath, ConnectorCatalogEntry } from "../lib/connection-catalog.ts";
import type { ConnectorInstallLifecycle } from "../lib/connector-install-presentation.ts";
import { readinessBlockNote } from "../lib/connector-readiness-copy.ts";
import {
  connectorInstallRowModel,
  connectorLookupKey,
  isUninstallableCatalogEntry,
} from "../lib/connector-install-presentation.ts";
import type { RefCountState } from "../lib/ref-client.ts";
import { UpdatesReadySlot } from "../sources/updates-ready.tsx";
import type { UpdatesReadyModel } from "../sources/updates-ready-model.ts";
import {
  browserBoundWithStoredCredentials,
  sourceSetupCardModel,
  sourceSetupAvailability,
  sourceSetupContext,
  sourceSetupGuidance,
  sourceSetupRowIsUnavailable,
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

export interface UncataloguedSourceSetupLink {
  connectorId: string;
  connectionId: string;
  displayName: string;
}

export type SourceSetupMaturity = "ready" | "testing" | "development";

export interface SourceSummaryRead {
  byConnector: Readonly<Record<string, readonly ExistingSourceSetupLink[]>>;
  truncated: boolean;
  uncataloguedSources?: readonly UncataloguedSourceSetupLink[];
}

export type SourceSummaryReadResult = { ok: true; value: SourceSummaryRead } | { ok: false };

export function sourceIsInstalled(
  entry: ConnectorCatalogEntry,
  lifecycle: ConnectorInstallLifecycle | null | undefined,
  existingSourcesByConnector?: Readonly<Record<string, readonly ExistingSourceSetupLink[]>>
): boolean {
  return Boolean(lifecycle?.installed || existingSourcesByConnector?.[entry.connectorKey]?.length);
}

function maturityFor(entry: ConnectorCatalogEntry): SourceSetupMaturity {
  if (entry.publicTier === "development") return "development";
  return entry.publicTier === "preview" || entry.publicTier === "unknown" ? "testing" : "ready";
}

function sortSourceCatalog(catalog: readonly ConnectorCatalogEntry[]): ConnectorCatalogEntry[] {
  return [...catalog].sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/** Ready and testing rows show by default; development rows only when the filter asks for them. */
export const DEFAULT_SOURCE_MATURITIES: ReadonlySet<SourceSetupMaturity> = new Set(["ready", "testing"]);

export function filterSourceCatalog(
  catalog: readonly ConnectorCatalogEntry[],
  query: string,
  maturities: ReadonlySet<SourceSetupMaturity>,
  isInstalled: (entry: ConnectorCatalogEntry) => boolean = () => false
): ConnectorCatalogEntry[] {
  const needle = query.trim().toLowerCase();
  return sortSourceCatalog(catalog).filter((entry) => {
    if (!isInstalled(entry) && !maturities.has(maturityFor(entry))) return false;
    return !needle || [entry.displayName, entry.connectorKey, entry.disposition, entry.setupModality, entry.supportState]
      .join(" ")
      .toLowerCase()
      .includes(needle);
  });
}

function MaturityFilter({ value, onChange }: {
  value: ReadonlySet<SourceSetupMaturity>;
  onChange: (value: ReadonlySet<SourceSetupMaturity>) => void;
}) {
  const toggle = (option: SourceSetupMaturity, checked: boolean) => {
    const next = new Set(value);
    if (checked) next.add(option);
    else next.delete(option);
    // Keep at least one tier selected so the list never empties by filter alone.
    if (next.size > 0) onChange(next);
  };
  return (
    <Menu.Root>
      <Menu.Trigger className={buttonVariants({ size: "sm", variant: "ghost", className: "min-h-11 border-border-strong px-3 sm:min-h-[30px]" })} type="button">Filter</Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner className="z-50" sideOffset={6}>
          <Menu.Popup className="grid min-w-44 rounded-control border border-border bg-background p-1 text-foreground shadow-lg">
            {(["ready", "testing", "development"] as const).map((option) => (
              <Menu.CheckboxItem
                checked={value.has(option)}
                className="flex min-h-11 items-center gap-2 rounded-control px-3 py-2 text-left text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                closeOnClick={false}
                key={option}
                onCheckedChange={(checked) => toggle(option, checked)}
              >
                <span aria-hidden className="w-4">
                  <Menu.CheckboxItemIndicator>✓</Menu.CheckboxItemIndicator>
                </span>
                {option === "ready" ? "Ready to use" : option === "testing" ? "In testing" : "In development"}
              </Menu.CheckboxItem>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

function SortMenu() {
  return (
    <Menu.Root>
      <Menu.Trigger className={buttonVariants({ size: "sm", variant: "ghost", className: "min-h-11 border-border-strong px-3 sm:min-h-[30px]" })} type="button">Sort</Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner className="z-50" sideOffset={6}>
          <Menu.Popup className="grid min-w-36 rounded-control border border-border bg-background p-1 text-foreground shadow-lg">
            <Menu.Item className="min-h-11 rounded-control px-3 py-2 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" disabled>Name</Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

function SourceSummaryNotice({ read }: { read: Promise<SourceSummaryReadResult> }) {
  const result = use(read);
  if (!result.ok) {
    return <p className="pdpp-caption py-2 text-muted-foreground" role="alert">Couldn't load data sources. Try again.</p>;
  }
  if (!result.value.truncated) return null;
  return (
    <p className="pdpp-caption py-2 text-muted-foreground" role="status">
      Some data sources could not be loaded. Check Data sources before adding another copy.
    </p>
  );
}

function pathTone(path: ConnectorAcquisitionPath): string {
  if (path.posture === "primary") {
    return "text-muted-foreground";
  }
  if (path.posture === "advanced") {
    return "text-attention";
  }
  return "text-muted-foreground";
}

function SourceAcquisitionPathRow({ path }: { path: ConnectorAcquisitionPath }) {
  return (
    <li
      className="grid gap-1 border-b border-border py-2"
      data-testid="source-acquisition-path"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="pdpp-caption font-medium text-foreground">{path.label}</span>
        <span className={`pdpp-caption ${pathTone(path)}`}>{path.posture}</span>
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
        <div className="mt-2 grid gap-1">
          <p className="pdpp-caption text-muted-foreground">Other ways to add data</p>
          <ul className="grid gap-2">
            {secondary.map((path) => (
              <SourceAcquisitionPathRow key={`${path.posture}:${path.label}`} path={path} />
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Development-tier method line, resolved before the `not_available_here`
 * short-circuit below. `sourceSetupAvailability` reports `not_available_here`
 * for every Development entry regardless of whether it renders an add
 * action (see `sourceSetupAction`'s disposition check), so that check alone
 * would print "No proven setup path is available" directly above a real
 * "Add account" button for a self-testable entry -- contradicting the
 * action right next to it.
 */
function developmentMethodLine(entry: ConnectorCatalogEntry): string {
  return readinessBlockNote(entry.readiness) ?? "Setup path implemented, not yet proven against a live account.";
}

function sourceMethodLine(entry: ConnectorCatalogEntry, existingSourceCount: number): string | null {
  if (entry.publicTier === "development") {
    return developmentMethodLine(entry);
  }
  if (browserBoundWithStoredCredentials(entry) && entry.disposition === "static_secret_connect") {
    return "Connect with this data source's sign-in details and complete any required steps in the secure browser.";
  }
  if (sourceSetupAvailability(entry) === "not_available_here") {
    return "No proven setup path is available in this dashboard.";
  }
  switch (entry.disposition) {
    case "local_collector_enroll":
      return "Start the local collector on the machine that has this data.";
    case "static_secret_connect":
      return "Enter the provider credential for this account.";
    case "static_secret_experimental":
      return "Enter the provider credential for this account. Preview: not yet live-validated.";
    case "provider_auth_connect":
      return "Authorize this account through the provider.";
    case "manual_upload_connect":
      return existingSourceCount > 0 ? null : "Owner-exported file import.";
    case "provider_auth_deployment_blocked":
      return "This data source needs provider authorization. Configure provider settings before adding an account.";
    case "browser_collector_manual":
    case "browser_bound_runbook":
      return entry.disposition === "browser_collector_manual"
        ? "Connect account from a secure browser session."
        : "Browser setup is not available in this dashboard yet.";
    default:
      return "No setup path is available in this dashboard.";
  }
}

function unavailableReason(
  entry: ConnectorCatalogEntry,
  lifecycle: ConnectorInstallLifecycle | null
): string {
  switch (entry.readiness?.reason) {
    case "not_implemented": return "This data source is a placeholder and does not collect data yet.";
    case "not_published": return "No package for this data source is published or installed here.";
    case "host_requirement_unmet": return "This data source is not available on this server yet.";
    case "inspection_unavailable": return "This data source could not be checked just now. Try again.";
    case "catalog_unavailable": return "The package catalog could not be reached. Try again.";
  }
  const hostBlockReason = lifecycle ? connectorInstallRowModel(entry, lifecycle).hostBlockReason : null;
  if (hostBlockReason) return `This data source is not available here: ${hostBlockReason}`;
  switch (entry.disposition) {
    case "browser_bound_runbook": return "Browser setup is not available in this app yet.";
    case "local_collector_unproven": return "This data source needs a local setup that is not available here yet.";
    case "provider_auth_deployment_blocked": return "This data source needs server settings before setup.";
    case "manual_upload_pending": return "File import is not available in this app yet.";
    default: return "Setup is not available here yet.";
  }
}

function maturityLabel(entry: ConnectorCatalogEntry): string | null {
  if (entry.publicTier === "development") return "Experimental";
  if (entry.publicTier === "preview") return "In testing";
  return null;
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

function ExistingSourceIdentity({ connectorKey, sources }: {
  connectorKey: string;
  sources: readonly ExistingSourceSetupLink[];
}) {
  if (sources.length === 1) {
    const source = sources[0];
    if (!source) return null;
    return (
      <Link
        aria-label={`Source details for ${source.displayName}`}
        className="pdpp-caption text-muted-foreground underline underline-offset-2 hover:text-foreground"
        href={sourceDetailHref(connectorKey, source.connectionId)}
      >
        {source.displayName}
      </Link>
    );
  }
  if (sources.length > 1) {
    return <span className="pdpp-caption text-muted-foreground">{sources.length} data sources</span>;
  }
  return null;
}

function ExistingSourceDetails({ connectorKey, sources }: {
  connectorKey: string;
  sources: readonly ExistingSourceSetupLink[];
}) {
  if (sources.length === 0) return null;
  return (
    <ul className="grid gap-2" data-testid="existing-source-links">
      {sources.map((source) => {
        const latestFact = source.latestImportStatus ?? source.status ?? null;
        return (
          <li className="grid gap-1 border-b border-border pb-2 last:border-0" key={source.connectionId}>
            <Link className="pdpp-caption text-foreground underline underline-offset-2" href={sourceDetailHref(connectorKey, source.connectionId)}>
              {source.displayName}
            </Link>
            <p className="pdpp-caption text-muted-foreground">{formatTotalRecordsLabel(source.totalRecords, source.totalRecordsState, "records")}</p>
            {latestFact ? <p className="pdpp-caption text-muted-foreground">Latest activity: {latestFact}</p> : null}
            {source.latestImportFile ? <p className="pdpp-caption break-all text-muted-foreground">Import file: {source.latestImportFile}</p> : null}
            <Link className="pdpp-caption text-muted-foreground underline underline-offset-2" href={sourceRecordsHref(source.connectionId)}>
              Open in Explore
            </Link>
          </li>
        );
      })}
    </ul>
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
    <div className="grid gap-2" data-testid="source-setup-details">
      {hasRichImportDetail ? (
        <>
          <p className="pdpp-caption text-muted-foreground">{guidance}</p>
          <SourceAcquisitionPaths paths={entry.acquisitionPaths} />
        </>
      ) : null}
      <SourceExternalDocs entry={entry} />
    </div>
  );
}

interface TransientCatalogRetryState {
  attempted: boolean;
  inFlight: boolean;
  pendingSnapshotId: string | null;
}

function freshTransientCatalogRetryState(): TransientCatalogRetryState {
  return { attempted: false, inFlight: false, pendingSnapshotId: null };
}

function useConnectorCatalogRecovery(enabled: boolean, busySnapshotId: string | null): {
  readonly refreshManually: () => void;
  readonly recoveryState: ConnectorCatalogRecoveryState;
} {
  const router = useRouter();
  const [recoveryState, setRecoveryState] = useState<ConnectorCatalogRecoveryState>("exhausted");
  const retryTimerRef = useRef<number | null>(null);
  // Retry bookkeeping belongs to this mounted catalog, not to the module, so a
  // second catalog on the page keeps its own once-per-snapshot retry.
  const retryStateRef = useRef<TransientCatalogRetryState>(freshTransientCatalogRetryState());

  const clearRetryTimer = useCallback(() => {
    if (retryTimerRef.current) {
      window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  }, []);

  const refreshCatalog = useCallback(() => {
    if (retryStateRef.current.inFlight || !busySnapshotId) {
      return;
    }
    retryStateRef.current.inFlight = true;
    retryStateRef.current.pendingSnapshotId = busySnapshotId;
    setRecoveryState("refreshing");
    try {
      router.refresh();
    } catch {
      retryStateRef.current.inFlight = false;
      retryStateRef.current.pendingSnapshotId = null;
      setRecoveryState("exhausted");
    }
  }, [busySnapshotId, router]);

  const refreshManually = useCallback(() => {
    retryStateRef.current.attempted = true;
    clearRetryTimer();
    refreshCatalog();
  }, [clearRetryTimer, refreshCatalog]);

  useEffect(() => {
    if (!enabled) {
      retryStateRef.current = freshTransientCatalogRetryState();
      clearRetryTimer();
      setRecoveryState("exhausted");
      return;
    }
    if (retryStateRef.current.inFlight && retryStateRef.current.pendingSnapshotId !== busySnapshotId) {
      retryStateRef.current.inFlight = false;
      retryStateRef.current.pendingSnapshotId = null;
      setRecoveryState("exhausted");
      return;
    }
    if (retryStateRef.current.inFlight) {
      setRecoveryState("refreshing");
      return;
    }
    if (retryStateRef.current.attempted) {
      setRecoveryState("exhausted");
      return clearRetryTimer;
    }
    setRecoveryState("scheduled");
    retryTimerRef.current = window.setTimeout(() => {
      retryStateRef.current.attempted = true;
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
  installCatalogTransientlyUnavailable,
  installLifecycle,
}: {
  entry: ConnectorCatalogEntry;
  existingSources: readonly ExistingSourceSetupLink[];
  installCatalogTransientlyUnavailable: boolean;
  installLifecycle: ConnectorInstallLifecycle | null;
}) {
  const status = sourceSetupStatus(entry);
  const readinessNote = readinessBlockNote(entry.readiness);
  const {
    installModel,
    noSetupPath,
    packageAvailabilityUnknown,
    packageNeedsInstall,
    registrationPending,
    setupAction: action,
    unavailable: isUnavailable,
  } = sourceSetupCardModel(entry, installLifecycle, installCatalogTransientlyUnavailable);
  const maturity = maturityLabel(entry);
  const primaryPackageAction = Boolean(
    !packageAvailabilityUnknown && installModel?.action && (installModel.action.kind === "update" || !action)
  );
  const primarySetupAction = Boolean(action && !primaryPackageAction);
  const setupActionLabel = action?.label === "Add account" && existingSources.length > 0
    ? "Add another account"
    : action?.label;
  const methodLine = !isUnavailable ? sourceMethodLine(entry, existingSources.length) : null;
  return (
    <li
      className="grid min-w-0 gap-3 border-b border-border py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start"
      data-testid={`source-setup-${entry.connectorKey}`}
      data-install-state={installModel?.activationState ?? "unknown"}
      data-row-unavailable={isUnavailable}
      data-tier={entry.publicTier}
    >
      <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <ConnectorMark connectorId={entry.connectorKey} icon={entry.icon} name={entry.displayName} />
          {maturity ? <span className="pdpp-caption text-muted-foreground">{maturity}</span> : null}
          <h3 className="pdpp-title text-foreground">{entry.displayName}</h3>
          </div>
          {existingSources.length > 0 ? (
            <p className="mt-1"><ExistingSourceIdentity connectorKey={entry.connectorKey} sources={existingSources} /></p>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2" data-testid="source-setup-install">
          {primaryPackageAction && installModel ? (
            <ConnectorInstallRow model={installModel} presentation="primary-action" />
          ) : primarySetupAction && action ? (
            <Link className={buttonVariants({ size: "sm", variant: "ghost", className: "min-h-11 sm:min-h-[30px]" })} href={action.href}>
              {setupActionLabel}
            </Link>
          ) : null}
        </div>
      </div>
      <details className="group">
        <summary className="pdpp-caption cursor-pointer list-none text-muted-foreground underline decoration-dotted underline-offset-4 hover:text-foreground">
          Details
        </summary>
        <div className="mt-2 grid gap-2">
          {methodLine ? <p className="pdpp-caption text-muted-foreground">{methodLine.replaceAll("connector", "data source")}</p> : null}
          {existingSources.length ? <ExistingSourceDetails connectorKey={entry.connectorKey} sources={existingSources} /> : null}
          {isUnavailable ? <p className="pdpp-caption text-muted-foreground">{unavailableReason(entry, installLifecycle)}</p> : null}
          {status.label ? (
            <p className="pdpp-caption text-muted-foreground" data-testid="source-support-fact">
              {status.label}: {status.description}
            </p>
          ) : null}
          {readinessNote ? (
            <p className="pdpp-caption text-muted-foreground" data-testid="connector-readiness-note">
              {readinessNote.replaceAll("connector", "data source")}
            </p>
          ) : null}
          {noSetupPath ? (
            <p className="pdpp-caption text-muted-foreground" data-testid="connector-install-disabled">
              Not installable: no setup path is available here.
            </p>
          ) : null}
          {packageNeedsInstall ? <p className="pdpp-caption text-muted-foreground" data-testid="connector-install-next-step">Install package first</p> : null}
          {installModel?.installedDigest ? (
            <p className="pdpp-caption text-muted-foreground">
              Installed digest <code className="font-mono text-foreground" title={installModel.installedDigestFull ?? undefined}>{installModel.installedDigest}</code>
              {installModel.targetVersion ? ` · Target v${installModel.targetVersion}` : ""}
            </p>
          ) : null}
          {installModel?.hostBlockReason ? <p className="pdpp-caption text-attention">Host blocked: {installModel.hostBlockReason}</p> : null}
          {registrationPending ? <p className="pdpp-caption text-muted-foreground">Setup appears once the server is ready.</p> : null}
          {action && !primarySetupAction ? (
            <Link className="pdpp-caption text-foreground underline underline-offset-2" href={action.href}>{setupActionLabel}</Link>
          ) : null}
          {!packageAvailabilityUnknown && installModel ? (
            <ConnectorInstallRow
              model={installModel}
              presentation={primaryPackageAction ? "uninstall-only" : "details-actions"}
            />
          ) : null}
          <SourceSetupContext entry={entry} />
          <SourceSetupDetails entry={entry} />
        </div>
      </details>
    </li>
  );
}

/* Preview and development are row properties; they are never nested groups. */

function SourceSetupCardList({
  entries,
  existingSourcesByConnector,
  installCatalogTransientlyUnavailable,
  installLifecycleByConnector,
}: {
  entries: readonly ConnectorCatalogEntry[];
  existingSourcesByConnector?: Readonly<Record<string, readonly ExistingSourceSetupLink[]>>;
  installCatalogTransientlyUnavailable: boolean;
  installLifecycleByConnector?: Readonly<Record<string, ConnectorInstallLifecycle>> | null;
}) {
  return (
    <ul className="grid gap-3" data-testid="source-setup-list">
      {entries.map((entry) => (
        <SourceSetupCard
          entry={entry}
          existingSources={existingSourcesByConnector?.[entry.connectorKey] ?? []}
          installCatalogTransientlyUnavailable={installCatalogTransientlyUnavailable}
          installLifecycle={installLifecycleFor(entry, installLifecycleByConnector)}
          key={entry.connectorKey}
        />
      ))}
    </ul>
  );
}

interface SourceSetupGroupsProps {
  catalog: readonly ConnectorCatalogEntry[];
  existingSourcesByConnector?: Readonly<Record<string, readonly ExistingSourceSetupLink[]>>;
  uncataloguedSources?: readonly UncataloguedSourceSetupLink[];
  installCatalogTransientlyUnavailable: boolean;
  installLifecycleByConnector?: Readonly<Record<string, ConnectorInstallLifecycle>> | null;
  updatesReady?: Promise<UpdatesReadyModel | null>;
  query: string;
  maturities: ReadonlySet<SourceSetupMaturity>;
}

function SourceSetupGroupsContent({
  catalog,
  existingSourcesByConnector,
  uncataloguedSources = [],
  installCatalogTransientlyUnavailable,
  installLifecycleByConnector,
  updatesReady,
  query,
  maturities,
  checkingSources = false,
}: SourceSetupGroupsProps & { checkingSources?: boolean }) {
  const entries = filterSourceCatalog(catalog, query, maturities, (entry) =>
    sourceIsInstalled(entry, installLifecycleFor(entry, installLifecycleByConnector), existingSourcesByConnector)
  );
  const installedEntries: ConnectorCatalogEntry[] = [];
  const availableEntries: ConnectorCatalogEntry[] = [];
  const unavailableEntries: ConnectorCatalogEntry[] = [];

  for (const entry of entries) {
    const lifecycle = installLifecycleFor(entry, installLifecycleByConnector);
    const installed = sourceIsInstalled(entry, lifecycle, existingSourcesByConnector);
    if (installed) {
      installedEntries.push(entry);
      continue;
    }
    if (!installCatalogTransientlyUnavailable && isUninstallableCatalogEntry(entry, lifecycle)) continue;
    const { unavailable } = sourceSetupCardModel(entry, lifecycle, installCatalogTransientlyUnavailable);
    (unavailable ? unavailableEntries : availableEntries).push(entry);
  }

  const search = query.trim().toLowerCase();
  const visibleUncataloguedSources = uncataloguedSources.filter((source) =>
    !search || `${source.displayName} ${source.connectorId}`.toLowerCase().includes(search)
  );

  const hasVisible = installedEntries.length > 0 || visibleUncataloguedSources.length > 0 || availableEntries.length > 0 || unavailableEntries.length > 0;
  if (!hasVisible) {
    return (
      <p className="pdpp-caption py-3 text-muted-foreground" data-testid="source-catalog-empty">
        {query ? `No data sources match “${query}”.` : "No data sources are available to add here."}
      </p>
    );
  }

  return (
    <div className="grid gap-5">
      <section aria-label="Installed" data-testid="installed-sources">
        <h2 className="pdpp-eyebrow mb-1 text-muted-foreground">Installed</h2>
        {updatesReady ? (
          <Suspense fallback={null}>
            <UpdatesReadySlot interactive updates={updatesReady} />
          </Suspense>
        ) : null}
        {installedEntries.length ? (
          <SourceSetupCardList
            entries={installedEntries}
            existingSourcesByConnector={existingSourcesByConnector}
            installCatalogTransientlyUnavailable={installCatalogTransientlyUnavailable}
            installLifecycleByConnector={installLifecycleByConnector}
          />
        ) : null}
        {visibleUncataloguedSources.length ? (
          <ul className="grid gap-3" data-testid="uncatalogued-installed-sources">
            {visibleUncataloguedSources.map((source) => (
              <li className="flex min-w-0 items-center gap-2 border-b border-border py-4" key={source.connectionId}>
                <ConnectorMark connectorId={source.connectorId} name={source.displayName} />
                <Link
                  className="min-w-0 text-foreground underline underline-offset-2"
                  href={sourceDetailHref(source.connectorId, source.connectionId)}
                >
                  {source.displayName}
                </Link>
              </li>
            ))}
          </ul>
        ) : null}
        {!installedEntries.length && !visibleUncataloguedSources.length ? (
          <p className="pdpp-caption py-2 text-muted-foreground">
            {checkingSources ? "Checking data sources…" : "No installed data sources."}
          </p>
        ) : null}
      </section>
      <section aria-label="Available" data-testid="available-sources">
        <h2 className="pdpp-eyebrow mb-1 text-muted-foreground">Available</h2>
        {availableEntries.length ? (
          <SourceSetupCardList
            entries={availableEntries}
            existingSourcesByConnector={existingSourcesByConnector}
            installCatalogTransientlyUnavailable={installCatalogTransientlyUnavailable}
            installLifecycleByConnector={installLifecycleByConnector}
          />
        ) : <p className="pdpp-caption py-2 text-muted-foreground">No available data sources.</p>}
      </section>
      {unavailableEntries.length > 0 ? (
        <details className="group" data-testid="unavailable-connectors-disclosure">
          <summary className="pdpp-caption cursor-pointer list-none text-muted-foreground underline decoration-dotted underline-offset-4 hover:text-foreground">
            Can't be added here ({unavailableEntries.length})
          </summary>
          <div className="mt-2">
            <SourceSetupCardList
              entries={unavailableEntries}
              existingSourcesByConnector={existingSourcesByConnector}
              installCatalogTransientlyUnavailable={installCatalogTransientlyUnavailable}
              installLifecycleByConnector={installLifecycleByConnector}
            />
          </div>
        </details>
      ) : null}
    </div>
  );
}

function ResolvedSourceSetupGroups({ read, ...props }: SourceSetupGroupsProps & { read: Promise<SourceSummaryReadResult> }) {
  const result = use(read);
  return (
    <SourceSetupGroupsContent
      {...props}
      existingSourcesByConnector={result.ok ? result.value.byConnector : props.existingSourcesByConnector}
      uncataloguedSources={result.ok ? result.value.uncataloguedSources : props.uncataloguedSources}
    />
  );
}

export function SourceSetupCatalog({
  catalog,
  existingSourcesByConnector,
  uncataloguedSources,
  existingSourcesRead,
  installCatalogBusySnapshotId = null,
  installCatalogTransientlyUnavailable = false,
  installLifecycleByConnector = null,
  installSkippedEntries = 0,
  updatesReady,
  query,
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
  uncataloguedSources?: readonly UncataloguedSourceSetupLink[];
  existingSourcesRead?: Promise<SourceSummaryReadResult>;
  installCatalogBusySnapshotId?: string | null;
  installCatalogTransientlyUnavailable?: boolean;
  /** Null means the install route is not available on this server. */
  installLifecycleByConnector?: Readonly<Record<string, ConnectorInstallLifecycle>> | null;
  /** Package offers the console could not read; they are missing from the list. */
  installSkippedEntries?: number;
  updatesReady?: Promise<UpdatesReadyModel | null>;
  query: string;
}) {
  const [searchText, setSearchText] = useState(query);
  const [maturities, setMaturities] = useState<ReadonlySet<SourceSetupMaturity>>(DEFAULT_SOURCE_MATURITIES);
  useEffect(() => setSearchText(query), [query]);
  const updateSearch = (value: string) => {
    setSearchText(value);
    const url = new URL(window.location.href);
    if (value) url.searchParams.set("source_q", value);
    else url.searchParams.delete("source_q");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  };
  const developerMode = useSyncExternalStore(
    subscribeToDeveloperMode,
    getDeveloperModeSnapshot,
    getDeveloperModeServerSnapshot,
  );
  const connectorCatalogRecovery = useConnectorCatalogRecovery(
    installCatalogTransientlyUnavailable,
    installCatalogBusySnapshotId
  );
  // The maturity filter controls which tier is shown here. Developer mode
  // continues to gate local-source controls; selecting In development is
  // enough to reveal development entries in this catalog.
  const hasInstalledDevelopment = catalog.some(
    (entry) => entry.publicTier === "development" && sourceIsInstalled(entry, installLifecycleFor(entry, installLifecycleByConnector), existingSourcesByConnector)
  );
  const includeDevelopment = developerMode || maturities.has("development") || hasInstalledDevelopment || Boolean(existingSourcesRead);
  const visibleCatalog = filterCatalogForDevelopmentVisibility(catalog, includeDevelopment);
  return (
    <Section>
      {existingSourcesRead ? (
        <Suspense fallback={null}><SourceSummaryNotice read={existingSourcesRead} /></Suspense>
      ) : null}
      {installSkippedEntries > 0 ? (
        <p className="pdpp-caption mb-3 text-muted-foreground" data-testid="install-skipped-notice">
          {installSkippedEntries} package {installSkippedEntries === 1 ? "offer" : "offers"} could not be read and{" "}
          {installSkippedEntries === 1 ? "is" : "are"} not listed. Check the service logs.
        </p>
      ) : null}
      <ConnectorCatalogRecoveryNotice
        enabled={installCatalogTransientlyUnavailable}
        recoveryState={connectorCatalogRecovery.recoveryState}
        refreshManually={connectorCatalogRecovery.refreshManually}
      />
      <div className="mb-4 flex min-w-0 flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor="source_q">
          Search data sources
        </label>
        <IcInput autoComplete="off" className="min-w-0 flex-1" id="source_q" name="source_q" onChange={(event) => updateSearch(event.currentTarget.value)} placeholder="Search data sources" type="search" value={searchText} />
        <SortMenu />
        <MaturityFilter onChange={setMaturities} value={maturities} />
      </div>
      {existingSourcesRead ? (
        <Suspense fallback={
          <SourceSetupGroupsContent
            catalog={visibleCatalog}
            installCatalogTransientlyUnavailable={installCatalogTransientlyUnavailable}
            installLifecycleByConnector={installLifecycleByConnector}
            query={searchText}
            maturities={maturities}
            uncataloguedSources={uncataloguedSources}
            checkingSources
            updatesReady={updatesReady}
          />
        }>
          <ResolvedSourceSetupGroups
            catalog={visibleCatalog}
            installCatalogTransientlyUnavailable={installCatalogTransientlyUnavailable}
            installLifecycleByConnector={installLifecycleByConnector}
            query={searchText}
            maturities={maturities}
            uncataloguedSources={uncataloguedSources}
            read={existingSourcesRead}
            updatesReady={updatesReady}
          />
        </Suspense>
      ) : (
        <SourceSetupGroupsContent
          catalog={visibleCatalog}
          existingSourcesByConnector={existingSourcesByConnector}
          uncataloguedSources={uncataloguedSources}
          installCatalogTransientlyUnavailable={installCatalogTransientlyUnavailable}
          installLifecycleByConnector={installLifecycleByConnector}
          query={searchText}
          maturities={maturities}
          updatesReady={updatesReady}
        />
      )}
    </Section>
  );
}
