// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { listConnectorManifests } from "../lib/rs-client.ts";
import { sourceRecordLabel, isOwnerRecordKind } from "../lib/source-record-label.ts";
import { listAppAccess, listPendingApprovals } from "../lib/ref-client.ts";
import { groupGrantAccessByApp } from "./app-access.ts";
import { loadSourceNames } from "./load-source-names.ts";
export async function loadApps(demo?: string) {
  if (process.env.NODE_ENV !== "production" && demo) {
    const { buildAppPractice } = await import("./app-practice.ts");
    return buildAppPractice(demo);
  }
  const [list, approvals, sourceNames, manifests] = await Promise.all([
    listAppAccess(),
    listPendingApprovals(),
    loadSourceNames(),
    listConnectorManifests().catch(() => []),
  ]);
  const apps = groupGrantAccessByApp(list.data, Date.now(), approvals.data, sourceNames);
  for (const app of apps) for (const row of app.sourceAccess) {
    const manifest = manifests.find(item => item.connector_id === row.source.connector_id || item.connector_id === row.source.id);
    row.kindNames = row.kinds.filter(isOwnerRecordKind).map(name => sourceRecordLabel(name, manifest?.streams));
  }
  return { apps, approvals: approvals.data };
}
