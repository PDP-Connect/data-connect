// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { ConnectorInstanceResolutionError } from "./stores/connector-instance-store.ts";

/**
 * Applies the reference-only write-admission lifecycle rule after a backend
 * has read a connector instance inside its durable write transaction.
 */
export function assertConnectorInstanceWritableStatus(
  status: string | null | undefined,
  connectorInstanceId: string
): void {
  // Drafts may accept their first write before the transaction activates them.
  if (status === "active" || status === "draft") {
    return;
  }
  throw new ConnectorInstanceResolutionError(
    "connector_instance_not_writable",
    `Connector instance '${connectorInstanceId}' does not have a writable status.`,
    { connectorInstanceId }
  );
}
