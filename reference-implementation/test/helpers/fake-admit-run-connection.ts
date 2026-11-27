// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { RuntimeRunConnectorOptions } from "../../runtime/index.ts";

/** Admits a direct `runConnector` call without a stored connection, naming one from the connector id. */
export function fakeAdmitRunConnection(): NonNullable<RuntimeRunConnectorOptions["admitRunConnection"]> {
  return ({ connectorId, connectorInstanceId, ownerSubjectId }) => {
    const owner = ownerSubjectId || "owner_direct_run_test";
    const exactId = connectorInstanceId ?? `cin_${owner}_${connectorId.replace(/[^a-z0-9]+/gi, "_")}`;
    return Promise.resolve({ connectorId, connectorInstanceId: exactId, ownerSubjectId: owner });
  };
}
