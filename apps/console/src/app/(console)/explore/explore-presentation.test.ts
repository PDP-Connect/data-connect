// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import type { ExplorerFeedEntry } from "@pdpp/operator-ui/components/views/explorer-utils";
import type { ExplorerConnectionFacet } from "@pdpp/operator-ui/components/views/records-explorer-view";
import { buildExploreDemoData, type ExploreDemoState } from "./explore-demo-data.ts";
import type { SourceStreamGroup } from "./explore-facet-groups.ts";
import {
  exploreCountLine,
  exploreDataSourceRows,
  exploreKindLabel,
  exploreRecordRow,
  exploreRecordTime,
  exploreRecordTitle,
  EXPLORE_EMPTY_MESSAGE,
  EXPLORE_FAILED_MESSAGE,
  EXPLORE_LOADING_MESSAGE,
} from "./explore-presentation.ts";

const SYSTEM_WORDS_RE = /\b(?:stream|connector|manifest|run|trace|grant|sample|cursor|coverage|verdict|fleet|projection|bearer|instance|reference server)\b|\[(?:const|undeclared)\]/i;

function entry(preview: ExplorerFeedEntry["preview"]): Pick<ExplorerFeedEntry, "preview" | "stream"> {
  return { preview, stream: "top_artists" };
}

test("Explore count says whether it is the full total or only the loaded page", () => {
  assert.equal(exploreCountLine({ exactTotal: 42, pageCount: 32 }), "42 records");
  assert.equal(exploreCountLine({ exactTotal: null, pageCount: 32 }), "Showing the newest 32");
});

test("Explore source kind labels are human names", () => {
  assert.equal(exploreKindLabel("top_artists"), "Top artists");
});

test("one data-source list keeps account toggles above their own kind toggles", () => {
  const connections: ExplorerConnectionFacet[] = [
    { connectionId: "account-a", connectorId: "spotify", displayName: "Music account", streams: ["top_artists"] },
    { connectionId: "account-b", connectorId: "spotify", displayName: "Family account", streams: ["top_artists"] },
  ];
  const groups: SourceStreamGroup[] = connections.map((connection, index) => ({
    connectionId: connection.connectionId,
    connectorId: connection.connectorId,
    displayName: connection.displayName,
    loadedTotal: index + 1,
    streams: [{ excluded: false, loadedCount: index + 1, selected: index === 1, stream: "top_artists" }],
  }));

  assert.deepEqual(
    exploreDataSourceRows(connections, groups).map((row) => ({
      account: row.connection.displayName,
      count: row.kinds[0]?.count,
      kind: row.kinds[0]?.label,
      selected: row.kinds[0]?.selected,
    })),
    [
      { account: "Music account", count: 1, kind: "Top artists", selected: false },
      { account: "Family account", count: 2, kind: "Top artists", selected: true },
    ]
  );
});

test("Explore titles prefer a title, then human text, then the kind", () => {
  assert.equal(exploreRecordTitle(entry({ kind: "generic", title: "My title" })), "My title");
  assert.equal(exploreRecordTitle(entry({ kind: "generic", fields: [{ label: "Message", name: "body", value: "A readable sentence" }] })), "A readable sentence");
  assert.equal(exploreRecordTitle(entry({ kind: "generic", fields: [{ label: "Is self", name: "is_self", value: "true" }, { label: "Count", name: "count", value: "145" }] })), "Top artists");
});

test("Explore rows show one title, a human kind and data-source name, and a relative time", () => {
  const now = Date.UTC(2026, 10, 25, 18);
  const sourceEntry = {
    ...entry({ kind: "generic", title: "Demo order D-1048" }),
    connectionDisplayName: "Household archive",
    connectorId: "amazon",
    displayAt: "2026-11-25T15:00:00.000Z",
  } as ExplorerFeedEntry;

  assert.deepEqual(exploreRecordRow(sourceEntry, now), {
    kind: "Top artists",
    source: "Household archive",
    time: "3 hours ago",
    title: "Demo order D-1048",
  });
  assert.equal(exploreRecordTime("2026-10-01T00:00:00.000Z", now), "Oct 1, 2026");
});

test("Explore empty, loading and failed states use one plain sentence each", () => {
  // Explore repair P2: an empty state has one plain sentence.
  assert.equal(EXPLORE_EMPTY_MESSAGE, "No records match this view.");
  assert.equal(EXPLORE_LOADING_MESSAGE, "Loading records.");
  // Explore repair P2: the failed sentence and its Try again action are separate.
  assert.equal(EXPLORE_FAILED_MESSAGE, "This could not be loaded.");
});

test("all Explore demo samples keep visible copy free of system words", () => {
  const states: ExploreDemoState[] = ["results", "empty", "failed", "many-sources", "untitled"];

  for (const state of states) {
    const data = buildExploreDemoData(state);
    const copy = [
      "Explore",
      "Any time",
      "Data sources",
      exploreCountLine({
        exactTotal: data.activitySummary?.total ?? null,
        pageCount: data.feed.length,
      }),
      ...data.connections.flatMap((connection) => [
        connection.displayName,
        ...connection.streams.map(exploreKindLabel),
      ]),
      ...data.feed.map((item) => Object.values(exploreRecordRow(item, Date.UTC(2026, 6, 1))).join(" · ")),
      ...data.upcoming.map((item) => Object.values(exploreRecordRow(item, Date.UTC(2026, 6, 1))).join(" · ")),
      ...data.warnings.map((warning) => warning.message),
      ...(state === "empty" ? [EXPLORE_EMPTY_MESSAGE] : []),
      ...(state === "failed" ? [EXPLORE_FAILED_MESSAGE] : []),
    ].join(" ");

    assert.doesNotMatch(copy, SYSTEM_WORDS_RE, `${state} sample includes system wording`);
  }
});

test("empty and failed Explore demos contain no record decorations", () => {
  for (const state of ["empty", "failed"] as const) {
    const data = buildExploreDemoData(state);
    // Explore repair P2: these states keep one sentence and their one useful action, without stale feed decoration.
    assert.equal(data.newSinceAnchor, 0);
    assert.equal(data.peek, null);
    assert.deepEqual(data.streamSeeAllLinks, []);
  }
});
