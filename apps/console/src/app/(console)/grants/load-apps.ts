// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { applyAppReading } from "./app-reading.ts";
import { historyRange } from "../history/day-cut.ts";
import { readPersonOffset } from "../history/server-day.ts";
import { canonicalConnectorKey } from "pdpp-reference-implementation/connection-setup-plan";
import { connectionDisplayName } from "../lib/connection-display-name.ts";
import { listAppAccess, listAppHistory, listPendingApprovals } from "../lib/ref-client.ts";
import { listConnectorManifests } from "../lib/rs-client.ts";
import { isOwnerRecordKind, sourceRecordLabel } from "../lib/source-record-label.ts";
import { groupGrantAccessByApp } from "./app-access.ts";
import { loadSourceNames } from "./load-source-names.ts";
export async function loadApps(demo?: string) {
  if (process.env.NODE_ENV !== "production" && demo) {
    const { buildAppPractice } = await import("./app-practice.ts");
    return buildAppPractice(demo);
  }
  const offset = await readPersonOffset();
  const [list, approvals, sourceNames, manifests, readingHistory] = await Promise.all([
    listAppAccess(),
    listPendingApprovals(),
    loadSourceNames(),
    listConnectorManifests().catch(() => []),
    listAppHistory(historyRange(offset)),
  ]);
  const apps = groupGrantAccessByApp(list.data, Date.now(), approvals.data, sourceNames);
  for (const app of apps) {
    for (const row of app.sourceAccess) {
      const connector = row.source.connector_id ?? row.source.id;
      const manifest = manifests.find(
        (item) => canonicalConnectorKey(item.connector_id) === canonicalConnectorKey(connector)
      );
      if (!row.source.connection_id && manifest) {
        const service = connectionDisplayName(null, manifest.display_name || manifest.name, manifest.connector_id);
        row.name = row.all_accounts ? `All ${service} accounts` : service;
      }
      row.kindNames = row.kinds.filter(isOwnerRecordKind).map((name) => sourceRecordLabel(name, manifest?.streams));
    }
  }
  for (const app of apps) {
    app.sources = app.sourceAccess
      .filter((row) => app.state !== "reading" || row.in_force)
      .map((row) => row.name || "Data source");
  }
  return { apps: apps.map(app => applyAppReading(app, readingHistory.mode === "days" ? readingHistory.data : [])), approvals: approvals.data, readingHistory };
}
