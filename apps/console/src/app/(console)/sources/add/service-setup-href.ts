// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ConnectorCatalogEntry } from "../../lib/connection-catalog.ts";
import { addSourceHref } from "./add-source-list-model.ts";

/** A program you run yourself is shown on the connect page itself, not on a separate page. */
export function isProgramService(entry: Pick<ConnectorCatalogEntry, "disposition">): boolean {
  return entry.disposition === "local_collector_enroll";
}

/** Where a person goes once the service is ready: the form of its kind. */
export function connectPageHref(entry: ConnectorCatalogEntry, setupActionHref: string): string {
  return isProgramService(entry) ? addSourceHref(entry.connectorKey) : setupActionHref;
}
