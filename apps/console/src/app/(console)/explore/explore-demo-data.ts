// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { RecordsExplorerData } from "@pdpp/operator-ui/components/views/records-explorer-view";

const SNAPSHOT = "2026-07-01T12:10:00.000Z";

function demoBucketSeries(total: number): NonNullable<RecordsExplorerData["bucketSeries"]> {
  return {
    buckets: [
      {
        count: Math.floor(total / 2),
        endMs: Date.UTC(2026, 6, 1),
        key: "2026-06-01",
        startMs: Date.UTC(2026, 5, 1),
      },
      {
        count: total - Math.floor(total / 2),
        endMs: Date.UTC(2026, 7, 1),
        key: "2026-07-01",
        startMs: Date.UTC(2026, 6, 1),
      },
    ],
    granularity: "month",
    partial: false,
    total,
  };
}

export type ExploreDemoState = "results" | "empty" | "failed" | "many-sources" | "untitled";

export function buildExploreDemoData(state: ExploreDemoState = "results"): RecordsExplorerData {
  const data: RecordsExplorerData = {
    activitySummary: {
      source: "exact_window",
      text: "Records over time · by day",
      total: 4,
    },
    bucketRequest: null,
    bucketSeries: demoBucketSeries(4),
    connectionsPageError: null,
    connectionsPageHasMore: false,
    connectionsPageIsPaged: false,
    connections: [
      {
        connectionId: "cin_demo_chatgpt_work",
        connectorId: "chatgpt",
        displayName: "ChatGPT work profile",
        streams: ["conversations", "messages"],
      },
      {
        connectionId: "cin_demo_amazon_home",
        connectorId: "amazon",
        displayName: "Amazon household archive",
        streams: ["orders", "order_items"],
      },
    ],
    cursorTrail: [],
    descriptor: {
      completeness: "exhaustive",
      cursor: "cursor_demo_next",
      has_more: true,
      kind: "complete_chronological",
      ordering: "time",
    },
    excludeConnectionIds: [],
    excludeStreams: [],
    feed: [
      {
        connectionDisplayName: "ChatGPT work profile",
        connectionId: "cin_demo_chatgpt_work",
        connectorId: "chatgpt",
        displayAt: "2026-07-01T11:58:00.000Z",
        displayIsSemantic: true,
        emittedAt: "2026-07-01T11:58:01.000Z",
        kind: "message",
        preview: {
          author: "Owner",
          body: "Summarize the data source health changes and flag anything that needs action.",
          kind: "message",
          title: "Owner asked about data source health",
        },
        recordId: "msg_demo_001",
        stream: "messages",
      },
      {
        connectionDisplayName: "Amazon household archive",
        connectionId: "cin_demo_amazon_home",
        connectorId: "amazon",
        displayAt: "2026-06-29T18:20:00.000Z",
        displayIsSemantic: true,
        emittedAt: "2026-06-29T20:57:21.000Z",
        kind: "generic",
        preview: {
          fields: [
            { label: "Order", name: "order_number", value: "D-1048" },
            { label: "Status", name: "status", value: "delivered" },
            { label: "Item count", name: "item_count", value: "3" },
          ],
          kind: "generic",
          title: "Demo order D-1048",
        },
        recordId: "ord_demo_1048",
        stream: "orders",
      },
      {
        connectionDisplayName: "ChatGPT work profile",
        connectionId: "cin_demo_chatgpt_work",
        connectorId: "chatgpt",
        displayAt: "2026-06-28T15:30:00.000Z",
        displayIsSemantic: true,
        emittedAt: "2026-06-28T15:30:01.000Z",
        kind: "message",
        preview: {
          author: "Assistant",
          body: "The data source status should show one action, not three duplicate rows.",
          kind: "message",
          title: "Assistant response",
        },
        recordId: "msg_demo_002",
        stream: "messages",
      },
    ],
    fromSearch: false,
    hybridUsed: false,
    lens: "recent",
    newSinceAnchor: 2,
    nextCursor: "cursor_demo_next",
    peek: {
      bodyJson: JSON.stringify(
        {
          author: "Owner",
          content: "Summarize the data source health changes and flag anything that needs action.",
          conversation_id: "conv_demo_atlas",
          created_at: "2026-07-01T11:58:00.000Z",
        },
        null,
        2
      ),
      connectionDisplayName: "ChatGPT work profile",
      connectionId: "cin_demo_chatgpt_work",
      connectorId: "chatgpt",
      emittedAt: "2026-07-01T11:58:01.000Z",
      error: null,
      fields: [
        { name: "author", state: "visible", type: "string", valueJson: JSON.stringify("Owner") },
        {
          name: "content",
          state: "visible",
          type: "string",
          valueJson: JSON.stringify("Summarize the data source health changes and flag anything that needs action."),
        },
        {
          name: "conversation_id",
          state: "visible",
          type: "string",
          valueJson: JSON.stringify("conv_demo_atlas"),
        },
      ],
      readUrl: "/v1/records/chatgpt/messages/msg_demo_001",
      recordId: "msg_demo_001",
      semanticTimestamp: { label: "created at", value: "2026-07-01T11:58:00.000Z" },
      stream: "messages",
    },
    query: "",
    searchHasMore: false,
    searchNextCursor: null,
    searchSort: "relevance",
    selectedConnectionIds: [],
    selectedStreams: [],
    serverFilterableFields: ["author", "status"],
    since: "",
    snapshotAnchor: SNAPSHOT,
    streamDoor: null,
    streamSeeAllLinks: [
      {
        connectionId: "cin_demo_chatgpt_work",
        connectorId: "chatgpt",
        displayName: "ChatGPT work profile",
        stream: "messages",
        total: 133_848,
      },
      {
        connectionId: "cin_demo_amazon_home",
        connectorId: "amazon",
        displayName: "Amazon household archive",
        stream: "orders",
        total: 1183,
      },
    ],
    supportsTimelineDirection: true,
    truncated: true,
    until: "",
    upcoming: [
      {
        connectionDisplayName: "Calendar Demo",
        connectionId: "cin_demo_calendar",
        connectorId: "calendar",
        displayAt: "2026-07-03T16:00:00.000Z",
        displayIsSemantic: true,
        emittedAt: "2026-07-01T12:00:00.000Z",
        kind: "event",
        preview: {
        body: "Review the data source status guide.",
          eventTime: "4:00 PM",
          kind: "event",
          title: "Review owner console packet",
        },
        recordId: "evt_demo_001",
        stream: "events",
      },
    ],
    upcomingHasMore: false,
    upcomingNextCursor: null,
    upcomingTotal: 1,
    upcomingTrail: [],
    warnings: [
      {
        code: "partial_fan_in",
        message: "One data source is not part of this view.",
      },
    ],
  };

  if (state === "empty") {
    return {
      ...data,
      activitySummary: { source: "exact_window", text: "Records by month", total: 0 },
      bucketSeries: null,
      descriptor: { ...data.descriptor, cursor: null, has_more: false },
      feed: [],
      nextCursor: null,
      truncated: false,
      upcoming: [],
      upcomingHasMore: false,
      upcomingNextCursor: null,
      upcomingTotal: 0,
    };
  }

  if (state === "failed") {
    return {
      ...data,
      bucketSeries: null,
      feed: [],
      upcoming: [],
      upcomingTotal: 0,
    };
  }

  if (state === "many-sources") {
    const seeds = data.connections;
    return {
      ...data,
      connections: Array.from({ length: 12 }, (_, index) => {
        const seed = seeds[index % seeds.length];
        if (seed === undefined) {
          throw new Error("Explore demo needs at least one data source.");
        }
        return {
          ...seed,
          connectionId: `cin_demo_source_${index + 1}`,
          displayName: `Demo data source ${index + 1}`,
          streams: index === 0 ? seed.streams : [],
        };
      }),
    };
  }

  if (state === "untitled") {
    return {
      ...data,
      activitySummary: { source: "exact_window", text: "Records by month", total: 5 },
      bucketSeries: demoBucketSeries(5),
      feed: [
        ...data.feed,
        {
          connectionDisplayName: "ChatGPT work profile",
          connectionId: "cin_demo_chatgpt_work",
          connectorId: "chatgpt",
          displayAt: "2026-06-30T11:58:00.000Z",
          displayIsSemantic: true,
          emittedAt: "2026-06-30T11:58:01.000Z",
          kind: "generic",
          preview: {
            fields: [
              { label: "Is self", name: "is_self", value: "true" },
              { label: "Comment count", name: "comment_count", value: "145" },
              { label: "Score", name: "score", value: "892" },
            ],
            kind: "generic",
          },
          recordId: "post_demo_untitled",
          stream: "posts",
        },
      ],
    };
  }

  return data;
}
