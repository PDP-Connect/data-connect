// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { isOwnerRecordKind } from "../lib/source-record-label.ts";
import { sourceRecordLabel } from "../lib/source-record-label.ts";
import type { AppAccess } from "./app-access.ts";
import { appSourceName } from "./app-access.ts";

/** The kinds of record one source row lets the app read, as the app's own page lists them. */
export function appAccessKinds(row: AppAccess["sourceAccess"][number]): string[] {
  return row.kindNames ?? row.kinds.filter((kind) => isOwnerRecordKind(kind, row.source.connector_id ?? "")).map((kind) => sourceRecordLabel(kind));
}

/** What a reading app can read, in the same words on the list and on its page: "Steam: Your owned games". */
export function appAccessLines(app: Pick<AppAccess, "sourceAccess">): string[] {
  return app.sourceAccess
    .filter((row) => row.in_force)
    .map((row) => {
      const name = row.name || appSourceName(row.source) || "Data source";
      const kinds = appAccessKinds(row);
      const shown = kinds.length > 5 ? `${kinds.slice(0, 3).join(", ")} and ${kinds.length - 3} more` : kinds.join(", ");
      return shown ? `${name}: ${shown}` : name;
    });
}

/** Where the app runs, then "not verified" when DataConnect could not confirm who runs it. */
export function appPlaceLine(app: Pick<AppAccess, "name" | "place" | "verified">): string {
  const place = !app.place || app.place === "no address given" || app.place === app.name ? "" : app.place;
  return [place, app.verified ? "" : "not verified"].filter(Boolean).join(" · ");
}
