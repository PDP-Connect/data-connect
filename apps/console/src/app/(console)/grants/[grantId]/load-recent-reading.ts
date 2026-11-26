// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import type { AppAccess } from "../app-access.ts";
import { listAppHistory } from "../../lib/ref-client.ts";
import { groupAppHistory } from "../../history/history-apps.ts";
import { loadHistorySources } from "../../history/load-sources.ts";
import { appPractice, historyPracticeSources, practiceEnabled } from "../../history/practice.ts";
import { readPersonOffset } from "../../history/server-day.ts";
import { historyRange } from "../../history/day-cut.ts";
export async function loadRecentReading(app: AppAccess, demo?: string) {
  const offset = await readPersonOffset();
  if (practiceEnabled(demo)) {
    const history = appPractice("app",offset);
    const rows = history.mode === "days" ? history.data.map(row=>({...row,client_id: app.clientIds[0] ?? row.client_id})) : [];
    return { rows: groupAppHistory(rows,[app]).slice(0,5), sources: historyPracticeSources(), offset };
  }
  const [history,sources] = await Promise.all([listAppHistory({ ...historyRange(offset), client_ids: app.clientIds }),loadHistorySources()]);
  return { rows: history.mode === "days" ? groupAppHistory(history.data,[app]).filter(row=>row.reads > 0).slice(0,5) : [], sources, offset };
}
