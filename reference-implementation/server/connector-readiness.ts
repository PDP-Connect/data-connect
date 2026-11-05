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
 *     by the same rules the scheduler applies;
 *   - the signed catalog: discovery only. It decides between "install" and
 *     "not published" when no artifact is selected. It never makes anything
 *     runnable.
 * Roster membership and the listing tier are not inputs. The console's
 * picker and the enrollment route call this same resolver, so they cannot
 * disagree.
 */

import { checkManifestHostReadiness } from "../runtime/scheduler-readiness.ts";
import { classifyConnectorIntentModality, type ConnectorManifestLike } from "./connection-setup-plan.ts";
import { canonicalConnectorKey } from "./connector-key.ts";
import type { ConnectorCatalogEntry, ConnectorInstallService, SelectedConnectorArtifact } from "./connector-install/index.ts";

export type ReadinessAction = "connect" | "install" | "repair" | "configure" | "retry" | "unavailable";

export type ReadinessReason =
  | "runnable"
  | "not_installed"
  | "not_published"
  | "catalog_unavailable"
  | "artifact_invalid"
  | "inspection_unavailable"
  | "not_browser_bound"
  | "host_requirement_unmet";

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
  /** Owner-readable cause for repair, configure and retry. Null otherwise. */
  readonly detail: string | null;
  readonly host: "ready" | "blocked" | "not_evaluated";
  readonly reason: ReadinessReason;
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

function isBrowserBound(manifest: Record<string, unknown> | null): boolean {
  return classifyConnectorIntentModality(manifest as ConnectorManifestLike | null) === "browser_bound";
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
 *   artifact verified, host requirement unmet       -> configure  host_requirement_unmet
 *   artifact verified, host ready                   -> connect    runnable
 *   no artifact, catalog offers it                  -> install    not_installed
 *   no artifact, catalog unreachable                -> retry      catalog_unavailable
 *   no artifact, catalog does not offer it          -> unavailable not_published
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
  return result("unavailable", facts.catalog === "not_offered" ? "not_published" : "not_installed");
}

export interface BrowserEnrollmentReadinessResolver {
  resolve: (connectorKey: string) => Promise<BrowserEnrollmentReadiness>;
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
    browserBound: offered.bindings
      ? isBrowserBound({ runtime_requirements: { bindings: offered.bindings } })
      : null,
    fact: "offered" as const,
  };
}

export function createBrowserEnrollmentReadinessResolver(deps: {
  readonly installService: Pick<ConnectorInstallService, "catalog" | "inspectSelected">;
  /**
   * The registered manifest, if any. It is the last resort for `browser_bound`
   * when nothing is selected and the catalog is silent, so every caller gets the
   * same answer for the same connector. It never makes anything runnable.
   */
  readonly registeredManifest?: (connectorKey: string) => Promise<Record<string, unknown> | null>;
  /** Test seam; production uses the scheduler's host rules. */
  readonly checkHost?: typeof checkManifestHostReadiness;
}): BrowserEnrollmentReadinessResolver {
  const checkHost = deps.checkHost ?? checkManifestHostReadiness;

  const resolveWith = async (
    rawKey: string,
    readCatalog: CatalogRead
  ): Promise<BrowserEnrollmentReadiness> => {
    const connectorKey = canonicalConnectorKey(rawKey) ?? rawKey;
    let artifact: ArtifactFact;
    try {
      artifact = await deps.installService.inspectSelected(connectorKey);
    } catch (error) {
      artifact = { reason: messageOf(error), status: "inspection_failed" };
    }
    let host: ReadinessFacts["host"] = null;
    if (artifact.status === "active" && isBrowserBound(artifact.manifest)) {
      host = await checkHost(artifact.manifest);
    }
    const hint = await deps.registeredManifest?.(connectorKey).catch(() => null);
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

  const catalogReader = (): CatalogRead => {
    let pending: Promise<readonly ConnectorCatalogEntry[] | null> | undefined;
    return () => {
      pending ??= deps.installService.catalog().catch(() => null);
      return pending;
    };
  };

  return {
    resolve: (connectorKey) => resolveWith(connectorKey, catalogReader()),
    resolveMany: (connectorKeys) => {
      const readCatalog = catalogReader();
      return Promise.all(connectorKeys.map((connectorKey) => resolveWith(connectorKey, readCatalog)));
    },
  };
}
