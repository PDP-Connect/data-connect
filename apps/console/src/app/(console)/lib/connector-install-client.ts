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
import { isTransientConnectorInstallCatalogError } from "./connector-install-transient.ts";
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

export async function listConnectorInstallCatalog(): Promise<ConnectorInstallCatalogEntry[]> {
  const payload = await connectorInstallFetch("/v1/owner/connector-install/catalog");
  return [...parseConnectorInstallCatalogResponse(payload).data];
}

export async function listConnectorInstallStatus(): Promise<ConnectorInstallStatus[]> {
  const payload = await connectorInstallFetch("/v1/owner/connector-install/status");
  return [...parseConnectorInstallStatusResponse(payload).data];
}

export async function listConnectorLocalSources(): Promise<ConnectorLocalSource[]> {
  const payload = await connectorInstallFetch("/v1/owner/connector-install/local-sources");
  return [...parseConnectorLocalSourcesResponse(payload)];
}

export async function getConnectorInstallSnapshot(): Promise<ConnectorInstallSnapshot> {
  const [catalog, status, localSources] = await Promise.all([
    listConnectorInstallCatalog().catch((err: unknown) => {
      if (isTransientConnectorInstallCatalogError(err)) {
        return [];
      }
      return Promise.reject(err);
    }),
    listConnectorInstallStatus(),
    listConnectorLocalSources(),
  ]);
  return { catalog, localSources, status };
}

export interface InstallConnectorInput {
  readonly connectorId: string;
  readonly digest: string;
}

function parseStatusRecord(payload: unknown): ConnectorInstallStatus {
  return parseConnectorInstallResponse(payload);
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
  return parseStatusRecord(payload);
}

export async function updateConnector(connectorId: string): Promise<ConnectorInstallStatus> {
  const payload = await connectorInstallFetch("/v1/owner/connector-install/update", {
    body: JSON.stringify({ connector_id: connectorId }),
    method: "POST",
  });
  return parseStatusRecord(payload);
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
