// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Whether the owner can add an account through browser setup for a connector.
 *
 * One projection, three inputs, kept apart:
 *   - the selected artifact: what a run would execute (a developer-local
 *     source, else the installed version), re-verified against its recorded
 *     bytes;
 *   - host readiness: the artifact's declared requirements against this host,
 *     for an attended run (the scheduler's rules minus the unattended browser
 *     surface, which account setup does not need);
 *   - the signed catalog: discovery only. It decides between "install" and
 *     "not published" when no artifact is selected. It never makes anything
 *     runnable.
 * Roster membership and the listing tier are not inputs. The console's
 * picker and the enrollment route call this same resolver, so they cannot
 * disagree.
 */

import { checkAttendedEnrollmentHostReadiness } from "../runtime/scheduler-readiness.ts";
import { classifyConnectorIntentModality, type ConnectorManifestLike } from "./connection-setup-plan.ts";
import { canonicalConnectorKey } from "./connector-key.ts";
import type { ConnectorCatalogEntry, ConnectorInstallService, SelectedConnectorArtifact } from "./connector-install/index.ts";

export const READINESS_ACTIONS = ["connect", "install", "repair", "configure", "retry", "unavailable"] as const;
export type ReadinessAction = (typeof READINESS_ACTIONS)[number];

export const READINESS_REASONS = [
  "runnable",
  "not_installed",
  "not_published",
  "catalog_unavailable",
  "artifact_invalid",
  "inspection_unavailable",
  "not_browser_bound",
  "not_implemented",
  "host_requirement_unmet",
] as const;
export type ReadinessReason = (typeof READINESS_REASONS)[number];

export type CatalogFact = "offered" | "not_offered" | "unavailable" | "not_consulted";

export interface BrowserEnrollmentReadiness {
  readonly action: ReadinessAction;
  readonly artifact: {
    readonly digest: string | null;
    readonly source: "installed" | "developer_local" | null;
    readonly state: "none" | "verified" | "invalid" | "inspection_failed";
    readonly version: string | null;
  };
  readonly browser_bound: boolean;
  readonly catalog: CatalogFact;
  readonly connector_key: string;
  /**
   * Server diagnostic for repair, configure and retry. It can name store errors
   * and host paths. The console does not render it. Null otherwise.
   */
  readonly detail: string | null;
  readonly host: "ready" | "blocked" | "not_evaluated";
  readonly reason: ReadinessReason;
}

/**
 * What the owner console reads: the verdict, not the evidence behind it. The
 * artifact, catalog and host echoes stay server-side (tests and diagnostics).
 */
export interface BrowserEnrollmentReadinessWire {
  readonly action: ReadinessAction;
  readonly browser_bound: boolean;
  readonly connector_key: string;
  readonly detail: string | null;
  readonly reason: ReadinessReason;
}

export function toReadinessWire(readiness: BrowserEnrollmentReadiness): BrowserEnrollmentReadinessWire {
  return {
    action: readiness.action,
    browser_bound: readiness.browser_bound,
    connector_key: readiness.connector_key,
    detail: readiness.detail,
    reason: readiness.reason,
  };
}

export type ArtifactFact = SelectedConnectorArtifact | { readonly status: "inspection_failed"; readonly reason: string };

export interface ReadinessFacts {
  readonly artifact: ArtifactFact;
  readonly catalog: CatalogFact;
  /** From the offered catalog entry's bindings. Used only when no artifact is selected. */
  readonly catalogBrowserBound: boolean | null;
  readonly connectorKey: string;
  /** Null when the host was not asked: no verified browser-bound artifact. */
  readonly host: { readonly ready: boolean; readonly reason?: string } | null;
  /** A registered manifest the caller holds. The last resort for `browser_bound`. */
  readonly hintBrowserBound: boolean;
}

function isBrowserBound(manifest: object | null): boolean {
  return classifyConnectorIntentModality(manifest as ConnectorManifestLike | null) === "browser_bound";
}

/**
 * Whether the package's own manifest says it collects nothing yet. A placeholder
 * package verifies and runs, but its collection step only reports a skip, so
 * offering it would send the owner through sign-in for no data. The package
 * declares this about itself (`capabilities.collection.implemented: false`);
 * the server holds no list of such connectors, and an absent declaration means
 * the package collects.
 */
function declaresNoCollection(manifest: object | null): boolean {
  const capabilities = (manifest as { capabilities?: unknown } | null)?.capabilities;
  const collection = (capabilities as { collection?: unknown } | null | undefined)?.collection;
  return (collection as { implemented?: unknown } | null | undefined)?.implemented === false;
}

function artifactSummary(artifact: ArtifactFact): BrowserEnrollmentReadiness["artifact"] {
  switch (artifact.status) {
    case "active":
      return { digest: artifact.digest, source: artifact.source, state: "verified", version: artifact.version };
    case "invalid":
      return { digest: null, source: artifact.source, state: "invalid", version: null };
    case "inspection_failed":
      return { digest: null, source: null, state: "inspection_failed", version: null };
    default:
      return { digest: null, source: null, state: "none", version: null };
  }
}

/**
 * Pure: every state is a function of the facts. Rules are evaluated in order:
 *
 *   artifact inspection threw                       -> retry      inspection_unavailable
 *   artifact bytes fail verification                -> repair     artifact_invalid
 *   artifact verified, manifest not browser-bound   -> unavailable not_browser_bound
 *   artifact verified, declares no collection       -> unavailable not_implemented
 *   artifact verified, host requirement unmet       -> configure  host_requirement_unmet
 *   artifact verified, host ready                   -> connect    runnable
 *   no artifact, catalog offers it                  -> install    not_installed
 *   no artifact, catalog unreachable                -> retry      catalog_unavailable
 *   no artifact, catalog does not offer it          -> unavailable not_published
 *
 * With no artifact the catalog is always consulted, so `not_consulted` only
 * accompanies a selected artifact.
 *
 * A selected artifact is runnable whatever the catalog says: an older
 * installed version and an unpublished developer-local source both connect.
 */
export function projectBrowserEnrollmentReadiness(facts: ReadinessFacts): BrowserEnrollmentReadiness {
  const { artifact } = facts;
  const base = {
    artifact: artifactSummary(artifact),
    catalog: facts.catalog,
    connector_key: facts.connectorKey,
    detail: null,
    host: "not_evaluated" as const,
  };
  const browserBound =
    artifact.status === "active"
      ? isBrowserBound(artifact.manifest)
      : (facts.catalogBrowserBound ?? facts.hintBrowserBound);
  const result = (
    action: ReadinessAction,
    reason: ReadinessReason,
    extra: Partial<Pick<BrowserEnrollmentReadiness, "detail" | "host">> = {}
  ): BrowserEnrollmentReadiness => ({ ...base, ...extra, action, browser_bound: browserBound, reason });

  if (artifact.status === "inspection_failed") {
    return result("retry", "inspection_unavailable", { detail: artifact.reason });
  }
  if (artifact.status === "invalid") {
    return result("repair", "artifact_invalid", { detail: artifact.reason });
  }
  if (artifact.status === "active") {
    if (!browserBound) {
      return result("unavailable", "not_browser_bound");
    }
    if (declaresNoCollection(artifact.manifest)) {
      return result("unavailable", "not_implemented");
    }
    if (facts.host && !facts.host.ready) {
      return result("configure", "host_requirement_unmet", { detail: facts.host.reason ?? null, host: "blocked" });
    }
    return result("connect", "runnable", { host: "ready" });
  }
  if (facts.catalog === "offered") {
    return browserBound ? result("install", "not_installed") : result("unavailable", "not_browser_bound");
  }
  if (facts.catalog === "unavailable") {
    return result("retry", "catalog_unavailable");
  }
  return result("unavailable", "not_published");
}

/**
 * One sentence per reason, safe to show an owner or put in an error. The
 * verdict's `detail` (store errors, host paths) is a diagnostic and is never
 * part of this text.
 */
export function readinessReasonMessage(reason: ReadinessReason): string {
  switch (reason) {
    case "not_installed":
      return "its package is not installed yet";
    case "not_published":
      return "it is not published, and no local source or installed package provides it";
    case "catalog_unavailable":
      return "the connector catalog could not be reached";
    case "artifact_invalid":
      return "its installed package failed verification";
    case "inspection_unavailable":
      return "its installed package could not be checked just now";
    case "not_browser_bound":
      return "it does not use browser setup";
    case "not_implemented":
      return "it does not collect data yet";
    case "host_requirement_unmet":
      return "this server is not set up to run it yet";
    case "runnable":
      return "it can run";
  }
}

export interface BrowserEnrollmentReadinessResolver {
  /**
   * The verdict for one connector, asking the host afresh (the action-time
   * check). `registeredManifest`, when the caller already holds it, replaces the
   * resolver's own lookup of the registered manifest.
   */
  resolve: (
    connectorKey: string,
    registeredManifest?: object | null
  ) => Promise<BrowserEnrollmentReadiness>;
  /** One catalog read for the whole list. */
  resolveMany: (connectorKeys: readonly string[]) => Promise<readonly BrowserEnrollmentReadiness[]>;
}

type CatalogRead = () => Promise<readonly ConnectorCatalogEntry[] | null>;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function catalogFactFor(connectorKey: string, entries: readonly ConnectorCatalogEntry[] | null) {
  if (entries === null) {
    return { browserBound: null, fact: "unavailable" as const };
  }
  const matches = entries.filter(
    (candidate) =>
      (canonicalConnectorKey(candidate.connector_key) ?? candidate.connector_key) === connectorKey ||
      candidate.connector_id === connectorKey
  );
  const offered = matches.find((candidate) => candidate.latest === true) ?? matches[0];
  if (!offered) {
    return { browserBound: null, fact: "not_offered" as const };
  }
  return {
    // A catalog entry that declares no bindings says nothing about browser use.
    browserBound:
      offered.bindings && Object.keys(offered.bindings).length > 0
        ? isBrowserBound({ runtime_requirements: { bindings: offered.bindings } })
        : null,
    fact: "offered" as const,
  };
}

const HOST_CHECK_TTL_MS = 30_000;
const CATALOG_READ_TIMEOUT_MS = 5000;

/** Resolves to `null` if `work` has not settled within `ms`. */
async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function createBrowserEnrollmentReadinessResolver(deps: {
  readonly installService: Pick<ConnectorInstallService, "catalog" | "inspectSelected">;
  /**
   * The registered manifest, if any. It is the last resort for `browser_bound`
   * when nothing is selected and the catalog is silent, so every caller gets the
   * same answer for the same connector. It never makes anything runnable.
   */
  readonly registeredManifest?: (connectorKey: string) => Promise<Record<string, unknown> | null>;
  /** Test seams; production uses the attended-enrollment host rules, the wall clock and the defaults above. */
  readonly checkHost?: typeof checkAttendedEnrollmentHostReadiness;
  readonly now?: () => number;
  readonly catalogTimeoutMs?: number;
}): BrowserEnrollmentReadinessResolver {
  const checkHost = deps.checkHost ?? checkAttendedEnrollmentHostReadiness;
  const now = deps.now ?? Date.now;
  const catalogTimeoutMs = deps.catalogTimeoutMs ?? CATALOG_READ_TIMEOUT_MS;

  // Host detection spawns the manifest's detect commands. A list read reuses a
  // result for the same declared requirements for a short time; a single read at action time
  // (`resolve`) always asks the host.
  const hostResults = new Map<string, { at: number; result: Promise<{ ready: boolean; reason?: string }> }>();
  const hostFor = (
    connectorKey: string,
    artifact: Extract<ArtifactFact, { status: "active" }>,
    reuse: boolean
  ): Promise<{ ready: boolean; reason?: string }> => {
    const key = `${connectorKey}\u0000${JSON.stringify(artifact.manifest.runtime_requirements ?? null)}`;
    const cached = hostResults.get(key);
    if (reuse && cached && now() - cached.at < HOST_CHECK_TTL_MS) {
      return cached.result;
    }
    const result = checkHost(artifact.manifest);
    hostResults.set(key, { at: now(), result });
    result.catch(() => hostResults.delete(key));
    return result;
  };

  const resolveUnchecked = async (
    connectorKey: string,
    readCatalog: CatalogRead,
    reuseHostResult: boolean,
    heldManifest: object | null | undefined
  ): Promise<BrowserEnrollmentReadiness> => {
    const artifact = await deps.installService.inspectSelected(connectorKey);
    const host =
      artifact.status === "active" && isBrowserBound(artifact.manifest) && !declaresNoCollection(artifact.manifest)
        ? await hostFor(connectorKey, artifact, reuseHostResult)
        : null;
    const hint =
      heldManifest === undefined ? await deps.registeredManifest?.(connectorKey).catch(() => null) : heldManifest;
    const catalog =
      artifact.status === "none"
        ? catalogFactFor(connectorKey, await readCatalog())
        : { browserBound: null, fact: "not_consulted" as const };
    return projectBrowserEnrollmentReadiness({
      artifact,
      catalog: catalog.fact,
      catalogBrowserBound: catalog.browserBound,
      connectorKey,
      hintBrowserBound: isBrowserBound(hint ?? null),
      host,
    });
  };

  // Total: one connector's failure (a store error, a malformed manifest, a host
  // probe that throws) is that connector's `retry` verdict, never a failed list.
  const resolveWith = async (
    rawKey: string,
    readCatalog: CatalogRead,
    reuseHostResult: boolean,
    heldManifest?: object | null
  ): Promise<BrowserEnrollmentReadiness> => {
    const connectorKey = canonicalConnectorKey(rawKey) ?? rawKey;
    try {
      return await resolveUnchecked(connectorKey, readCatalog, reuseHostResult, heldManifest);
    } catch (error) {
      return projectBrowserEnrollmentReadiness({
        artifact: { reason: messageOf(error), status: "inspection_failed" },
        catalog: "not_consulted",
        catalogBrowserBound: null,
        connectorKey,
        hintBrowserBound: false,
        host: null,
      });
    }
  };

  const catalogReader = (): CatalogRead => {
    let pending: Promise<readonly ConnectorCatalogEntry[] | null> | undefined;
    return () => {
      pending ??= withTimeout(
        deps.installService.catalog().catch(() => null),
        catalogTimeoutMs
      );
      return pending;
    };
  };

  return {
    resolve: (connectorKey, registeredManifest) =>
      resolveWith(connectorKey, catalogReader(), false, registeredManifest),
    resolveMany: (connectorKeys) => {
      const readCatalog = catalogReader();
      return Promise.all(connectorKeys.map((connectorKey) => resolveWith(connectorKey, readCatalog, true)));
    },
  };
}
