// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ConnectorUpdatesRead } from "../updates-ready-model.ts";
import { connectorLookupKey } from "../../lib/connector-install-presentation.ts";
import type { SourceUpdateModel } from "./source-update-section.tsx";

type UpdateRead = () => Promise<ConnectorUpdatesRead>;

/** Build the update shown for this data source from the shared list-page read. */
export async function buildSourceUpdateModel(
  connectorId: string,
  sourceName: string,
  read: UpdateRead
): Promise<SourceUpdateModel | null> {
  try {
    const { existingSources, snapshot } = await read();
    if (!snapshot || existingSources.truncated) return null;

    const identity = connectorLookupKey(connectorId);
    const matches = (candidate: string | undefined) => Boolean(candidate && connectorLookupKey(candidate) === identity);
    const targets = snapshot.catalog.filter((entry) =>
      entry.latest && [entry.connector_id, entry.connector_key, entry.catalog_connector_id].some(matches)
    );
    const installed = snapshot.status.filter((entry) => matches(entry.connector_id));
    if (targets.length === 0 || installed.length !== 1) return null;
    if (new Set(targets.map((entry) => entry.digest)).size !== 1) return null;

    const target = targets[0];
    const current = installed[0];
    if (!target || !current || target.digest === current.digest) return null;

    const otherSources = Object.entries(existingSources.byConnector)
      .filter(([key]) => matches(key))
      .flatMap(([, sources]) => sources.map((source) => source.displayName))
      .filter((name) => name && name !== sourceName);

    return {
      connectorKey: target.connector_key,
      currentVersion: current.version,
      otherSources: [...new Set(otherSources)].sort((a, b) => a.localeCompare(b)),
      targetVersion: target.version,
    };
  } catch {
    return null;
  }
}
