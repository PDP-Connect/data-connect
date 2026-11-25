// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/** Resolve the name shown for a connection when the saved value may be its connector key. */
export function connectionDisplayName(
  connectionName: string | null | undefined,
  connectorDisplayName: string | null | undefined,
  connectorId: string | null | undefined
): string {
  const connectorKey = connectorId?.trim().toLowerCase();
  const savedName = connectionName?.trim() || null;
  const manifestName = connectorDisplayName?.trim() || null;
  const savedNameIsConnectorKey = Boolean(savedName && savedName.toLowerCase() === connectorKey);

  return (savedName && !savedNameIsConnectorKey ? savedName : null) ?? manifestName ?? "this data source";
}
