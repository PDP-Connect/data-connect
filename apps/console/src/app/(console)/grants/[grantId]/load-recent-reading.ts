// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import type { AppAccess } from "../app-access.ts";
import { listAppHistory, type AppHistory } from "../../lib/ref-client.ts";
import { groupAppHistory } from "../../history/history-apps.ts";
import { loadHistorySources } from "../../history/load-sources.ts";
import { appPractice, historyPracticeSources, practiceEnabled } from "../../history/practice.ts";
import { readPersonOffset } from "../../history/server-day.ts";
import { historyRange } from "../../history/day-cut.ts";
export async function loadRecentReading(app: AppAccess, demo?: string, readingHistory?: AppHistory) {
  const offset = await readPersonOffset();
  if (practiceEnabled(demo)) {
    const history = readingHistory ?? appPractice(demo === "app-never-read" || app.state !== "reading" ? "unread" : "app",offset,Date.now(),app.sourceAccess);
    const rows = history.mode === "days" ? history.data.filter(row=>readingHistory ? app.clientIds.includes(row.client_id) : true).map(row=>({...row,client_id: app.clientIds[0] ?? row.client_id})) : [];
    return { rows: groupAppHistory(rows,[app]).slice(0,5), sources: historyPracticeSources(), offset };
  }
  const [history,sources] = await Promise.all([readingHistory ?? listAppHistory({ ...historyRange(offset), client_ids: app.clientIds }),loadHistorySources()]);
  return { rows: history.mode === "days" ? groupAppHistory(history.data,[app]).filter(row=>row.reads > 0).slice(0,5) : [], sources, offset };
}
