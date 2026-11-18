// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Server-only client for the owner connector-install route family.
 *
 * This is deliberately separate from the connection catalog: package
 * activation is not connection setup, and its digest is never written into a
 * connector instance source binding.
 */

import {
  ConnectorInstallContractError,
  type ConnectorInstallCatalogEntry,
  type ConnectorLocalSource,
  type ConnectorInstallSnapshot,
  type ConnectorInstallStatus,
  parseConnectorInstallCatalogResponse,
  parseConnectorInstallResponse,
  parseConnectorLocalSourcesResponse,
  parseConnectorInstallStatusResponse,
} from "./connector-install-contract.ts";
import { describeErrorText } from "./describe-error.ts";
import {
  isConnectorInstallRouteUnavailableError,
  isTransientConnectorInstallCatalogError,
} from "./connector-install-transient.ts";
import {
  getOwnerToken,
  getRsInternalUrl,
  ReferenceServerUnreachableError,
  ResourceServerHttpError,
} from "./owner-token.ts";
import { verifyDashboardSession } from "./verify-session.ts";

async function connectorInstallFetch(path: string, init: RequestInit = {}): Promise<unknown> {
  await verifyDashboardSession();
  const token = await getOwnerToken();
  let response: Response;
  try {
    response = await fetch(`${getRsInternalUrl()}${path}`, {
      cache: "no-store",
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...init.headers,
      },
    });
  } catch (err) {
    // ReferenceServerUnreachableError already preserves the original cause;
    // this lint exception matches the established owner-client precedent.
    // biome-ignore lint/style/useErrorCause: see comment above.
    throw new ReferenceServerUnreachableError(`Cannot reach resource server at ${getRsInternalUrl()}`, err);
  }
  if (!response.ok) {
    const body = await response.text();
    throw new ResourceServerHttpError(
      path,
      response.status,
      describeErrorText(body, `connector install request failed (${response.status})`)
    );
  }
  return response.json();
}

function warnSkippedCatalogEntries(skipped: number): void {
  if (skipped > 0) {
    console.warn(`connector install catalog: skipped ${skipped} malformed entr${skipped === 1 ? "y" : "ies"}`);
  }
}

async function fetchInstallCatalog(): Promise<{ entries: ConnectorInstallCatalogEntry[]; skipped: number }> {
  const payload = await connectorInstallFetch("/v1/owner/connector-install/catalog");
  const parsed = parseConnectorInstallCatalogResponse(payload);
  warnSkippedCatalogEntries(parsed.skipped);
  return { entries: [...parsed.data], skipped: parsed.skipped };
}

async function fetchInstallStatus(): Promise<{ entries: ConnectorInstallStatus[]; skipped: number }> {
  const payload = await connectorInstallFetch("/v1/owner/connector-install/status");
  const parsed = parseConnectorInstallStatusResponse(payload);
  // A skipped catalog entry only hides one package offer. A skipped status
  // entry loses an installed-package fact, and the card would then render
  // that installed package as "Not installed" with an Install button, so the
  // status read stays all-or-nothing.
  if (parsed.skipped > 0) {
    throw new ConnectorInstallContractError(
      `connector install status: ${parsed.skipped} malformed entr${parsed.skipped === 1 ? "y" : "ies"}; installed state is unknown.`
    );
  }
  return { entries: [...parsed.data], skipped: 0 };
}

export async function listConnectorInstallCatalog(): Promise<ConnectorInstallCatalogEntry[]> {
  return (await fetchInstallCatalog()).entries;
}

export async function listConnectorInstallStatus(): Promise<ConnectorInstallStatus[]> {
  return (await fetchInstallStatus()).entries;
}

export async function listConnectorLocalSources(): Promise<ConnectorLocalSource[]> {
  const payload = await connectorInstallFetch("/v1/owner/connector-install/local-sources");
  return [...parseConnectorLocalSourcesResponse(payload)];
}

/**
 * One read of the three install facts, or `null` when the server predates the
 * install route family (the page then shows no package facts at all).
 */
export async function getConnectorInstallSnapshot(): Promise<ConnectorInstallSnapshot | null> {
  try {
    return await readConnectorInstallSnapshot();
  } catch (err) {
    if (isConnectorInstallRouteUnavailableError(err)) {
      return null;
    }
    throw err;
  }
}

async function readConnectorInstallSnapshot(): Promise<ConnectorInstallSnapshot> {
  let catalogUnavailableReason: ConnectorInstallSnapshot["catalogUnavailableReason"];
  // Settle every leg before judging any of them, so the outcome does not
  // depend on which route answers first.
  const [catalogLeg, statusLeg, localSourcesLeg] = await Promise.allSettled([
    fetchInstallCatalog().catch((err: unknown) => {
      if (isTransientConnectorInstallCatalogError(err)) {
        catalogUnavailableReason = "transient_busy";
        return { entries: [], skipped: 0 };
      }
      return Promise.reject(err);
    }),
    fetchInstallStatus(),
    // Developer local sources are optional: a server without them still has
    // package facts worth showing.
    listConnectorLocalSources().catch((err: unknown) =>
      isConnectorInstallRouteUnavailableError(err) ? [] : Promise.reject(err)
    ),
  ]);
  // An auth, server, network or contract failure wins over "this server has
  // no install routes", which the caller turns into an empty page.
  const failures = [catalogLeg, statusLeg, localSourcesLeg].flatMap((leg) =>
    leg.status === "rejected" ? [leg.reason as unknown] : []
  );
  const decisive = failures.find((err) => !isConnectorInstallRouteUnavailableError(err)) ?? failures[0];
  if (decisive !== undefined) {
    throw decisive;
  }
  if (catalogLeg.status !== "fulfilled" || statusLeg.status !== "fulfilled" || localSourcesLeg.status !== "fulfilled") {
    throw new Error("connector install snapshot: a read settled without a value.");
  }
  const catalog = catalogLeg.value;
  const status = statusLeg.value;
  const skippedEntries = catalog.skipped + status.skipped;
  return {
    catalog: catalog.entries,
    ...(catalogUnavailableReason ? { catalogUnavailableReason } : {}),
    localSources: localSourcesLeg.value,
    ...(skippedEntries > 0 ? { skippedEntries } : {}),
    status: status.entries,
  };
}

export interface InstallConnectorInput {
  readonly connectorId: string;
  readonly digest: string;
}

function parseLocalSourceRecord(payload: unknown, operation: "add" | "reload"): ConnectorLocalSource {
  const record = (payload as { data?: unknown }).data;
  const [source] = parseConnectorLocalSourcesResponse({
    data: [record],
    object: "connector_install_local_sources",
  });
  if (!source) {
    throw new Error(`The local connector source ${operation} response did not include a source record.`);
  }
  return source;
}

export async function installConnector(input: InstallConnectorInput): Promise<ConnectorInstallStatus> {
  const payload = await connectorInstallFetch("/v1/owner/connector-install/install", {
    body: JSON.stringify({
      connector_id: input.connectorId,
      digest: input.digest,
    }),
    method: "POST",
  });
  return parseConnectorInstallResponse(payload);
}

export async function updateConnector(connectorId: string): Promise<ConnectorInstallStatus> {
  const payload = await connectorInstallFetch("/v1/owner/connector-install/update", {
    body: JSON.stringify({ connector_id: connectorId }),
    method: "POST",
  });
  return parseConnectorInstallResponse(payload);
}

export async function uninstallConnector(connectorKey: string): Promise<void> {
  await connectorInstallFetch("/v1/owner/connector-install/uninstall", {
    body: JSON.stringify({ connector_key: connectorKey }),
    method: "POST",
  });
}

export async function addConnectorLocalSource(sourcePath: string): Promise<ConnectorLocalSource> {
  const payload = await connectorInstallFetch("/v1/owner/connector-install/local-sources/add", {
    body: JSON.stringify({ source_path: sourcePath }),
    method: "POST",
  });
  return parseLocalSourceRecord(payload, "add");
}

export async function reloadConnectorLocalSource(sourceId: string): Promise<ConnectorLocalSource> {
  const payload = await connectorInstallFetch("/v1/owner/connector-install/local-sources/reload", {
    body: JSON.stringify({ source_id: sourceId }),
    method: "POST",
  });
  return parseLocalSourceRecord(payload, "reload");
}

export async function removeConnectorLocalSource(sourceId: string): Promise<void> {
  await connectorInstallFetch("/v1/owner/connector-install/local-sources/remove", {
    body: JSON.stringify({ source_id: sourceId }),
    method: "POST",
  });
}

export async function selectConnectorLocalSource(input: {
  connectorKey: string;
  sourceId: string | null;
}): Promise<void> {
  await connectorInstallFetch("/v1/owner/connector-install/local-sources/select", {
    body: JSON.stringify({ connector_key: input.connectorKey, source_id: input.sourceId }),
    method: "POST",
  });
}
