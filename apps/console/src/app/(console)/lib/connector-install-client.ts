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
  type ConnectorInstallSnapshot,
  type ConnectorInstallStatus,
  parseConnectorInstallCatalogResponse,
  parseConnectorInstallStatusResponse,
} from "./connector-install-contract.ts";
import { describeErrorText } from "./describe-error.ts";
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

export async function getConnectorInstallSnapshot(): Promise<ConnectorInstallSnapshot> {
  const [catalog, status] = await Promise.all([listConnectorInstallCatalog(), listConnectorInstallStatus()]);
  return { catalog, status };
}

export interface InstallConnectorInput {
  readonly connectorId: string;
  readonly digest: string;
}

function parseStatusRecord(payload: unknown, operation: "install" | "update"): ConnectorInstallStatus {
  const [status] = parseConnectorInstallStatusResponse({
    data: [payload],
    object: "connector_install_status",
  }).data;
  if (!status) {
    throw new Error(`The connector ${operation} response did not include an active status record.`);
  }
  return status;
}

export async function installConnector(input: InstallConnectorInput): Promise<ConnectorInstallStatus> {
  const payload = await connectorInstallFetch("/v1/owner/connector-install/install", {
    body: JSON.stringify({
      connector_id: input.connectorId,
      digest: input.digest,
    }),
    method: "POST",
  });
  return parseStatusRecord(payload, "install");
}

export async function updateConnector(connectorId: string): Promise<ConnectorInstallStatus> {
  const payload = await connectorInstallFetch("/v1/owner/connector-install/update", {
    body: JSON.stringify({ connector_id: connectorId }),
    method: "POST",
  });
  return parseStatusRecord(payload, "update");
}
