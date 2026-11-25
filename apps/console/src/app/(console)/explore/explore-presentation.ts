// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { formatCalendarDate, formatRelative, humanizeFieldLabel } from "@pdpp/display";
import type { ExplorerFeedEntry } from "@pdpp/operator-ui/components/views/explorer-utils";
import type { ExplorerConnectionFacet } from "@pdpp/operator-ui/components/views/records-explorer-view";
import type { SourceStreamGroup } from "./explore-facet-groups.ts";

export const EXPLORE_LOADING_MESSAGE = "Loading records.";
export const EXPLORE_EMPTY_MESSAGE = "Nothing matches. Try another word or date.";
export const EXPLORE_FAILED_MESSAGE = "This could not be loaded. Try again.";

const NUMBER_ONLY_RE = /^[-+]?\d+(?:[.,]\d+)?%?$/;
const BOOLEAN_ONLY_RE = /^(?:true|false)$/i;

function humanText(value: string | undefined): string | undefined {
  const text = value?.replace(/\s+/g, " ").trim();
  if (!text || NUMBER_ONLY_RE.test(text) || BOOLEAN_ONLY_RE.test(text)) {
    return undefined;
  }
  return text;
}

/** The feed title rule: authored title, first human text, then the human kind. */
export function exploreRecordTitle({ preview, stream }: Pick<ExplorerFeedEntry, "preview" | "stream">): string {
  const title = humanText(preview?.title);
  if (title) {
    return title;
  }

  const text = humanText(preview?.body) ?? humanText(preview?.author) ?? preview?.fields?.map((field) => humanText(field.value)).find(Boolean);
  return text ?? humanizeFieldLabel(stream);
}

export function exploreKindLabel(stream: string): string {
  return humanizeFieldLabel(stream);
}

export interface ExploreDataSourceRow {
  connection: ExplorerConnectionFacet;
  kinds: Array<{ count: number; excluded: boolean; label: string; selected: boolean; stream: string }>;
}

/** Pair each account with its own selectable record kinds for the single filter list. */
export function exploreDataSourceRows(
  connections: readonly ExplorerConnectionFacet[],
  groups: readonly SourceStreamGroup[]
): ExploreDataSourceRow[] {
  const groupByConnection = new Map(groups.map((group) => [group.connectionId, group]));
  return connections.map((connection) => ({
    connection,
    kinds: (groupByConnection.get(connection.connectionId)?.streams ?? []).map((kind) => ({
      count: kind.loadedCount,
      excluded: kind.excluded,
      label: exploreKindLabel(kind.stream),
      selected: kind.selected,
      stream: kind.stream,
    })),
  }));
}

/** The one row's visible text, kept free of wire names and technical identifiers. */
export function exploreRecordRow(entry: Pick<ExplorerFeedEntry, "connectionDisplayName" | "displayAt" | "preview" | "stream">, now = Date.now()) {
  return {
    kind: exploreKindLabel(entry.stream),
    source: entry.connectionDisplayName ?? "Data source",
    time: exploreRecordTime(entry.displayAt, now),
    title: exploreRecordTitle(entry),
  };
}

/** Recent times use relative language. Older records use a calendar date. */
export function exploreRecordTime(value: string, now = Date.now()): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const withinAWeek = Math.abs(date.getTime() - now) < 7 * 24 * 60 * 60 * 1000;
  return withinAWeek ? formatRelative(date, now) : formatCalendarDate(date);
}

export function exploreCountLine(args: {
  exactTotal: number | null;
  pageCount: number;
}): string {
  return args.exactTotal === null
    ? `Showing the newest ${args.pageCount.toLocaleString()}`
    : `${args.exactTotal.toLocaleString()} records`;
}
