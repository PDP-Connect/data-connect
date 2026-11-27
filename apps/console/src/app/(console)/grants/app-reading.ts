// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { canonicalConnectorKey } from "pdpp-reference-implementation/connection-setup-plan";
import type { AppReadDay } from "../lib/ref-client.ts";
import type { AppAccess } from "./app-access.ts";

type SourceAccess = AppAccess["sourceAccess"][number];
type SourceRead = AppReadDay["sources"][number];
const serviceKey = (source: SourceAccess) => canonicalConnectorKey(source.source.connector_id ?? source.source.id);
const latest = (values: (string | null | undefined)[]) => values.filter((value): value is string => Boolean(value)).sort().at(-1) ?? null;

function matchesSource(read: SourceRead, source: SourceAccess, sources: SourceAccess[]): boolean {
  if (read.source_kind && read.source_kind !== source.source.kind) return false;
  if (read.connection_id) {
    return source.source.connection_id === read.connection_id || Boolean(source.connection_ids?.includes(read.connection_id)) ||
      (!source.source.connection_id && canonicalConnectorKey(read.source_id) === serviceKey(source));
  }
  if (canonicalConnectorKey(read.source_id) !== serviceKey(source)) return false;
  // A service-only read cannot identify one of several accounts.
  return !source.source.connection_id || sources.filter(candidate => serviceKey(candidate) === serviceKey(source)).length === 1;
}

/** Reading comes only from disclosure history, including reads with no named data source. */
export function applyAppReading(app: AppAccess, history: AppReadDay[]): AppAccess {
  const rows = history.filter(row => app.clientIds.includes(row.client_id));
  const sourceReads = rows.flatMap(row => row.sources);
  return {
    ...app,
    lastRead: latest(rows.map(row => row.last_at)),
    sourceAccess: app.sourceAccess.map(source => ({
      ...source,
      last_read_at: latest(sourceReads.filter(read => matchesSource(read, source, app.sourceAccess)).map(read => read.last_at)),
    })),
  };
}
