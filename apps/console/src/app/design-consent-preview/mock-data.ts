// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Mock request/source data for the consent design preview.
 *
 * Ported from `reference-implementation/server/routes/ref-design-consent-mock.ts`
 * (commit 4dbe7fa9f) so the owner sees the exact same 27-source scenario he
 * has already given feedback against. Every value here is a literal — this
 * module reads no store and touches no owner data.
 */

export const CLIENT = {
  domain: "chatgpt.com",
  monogram: "CH",
  name: "ChatGPT",
} as const;

export interface MockStream {
  readonly fieldsSelected?: number;
  readonly fieldsTotal: number;
  readonly label: string;
  readonly name: string;
  readonly selected?: boolean;
  readonly sentence: string;
  /** Humanized temporal phrasing. Present only where the stream declares a
   * time field; absent means the data-range control is suppressed. This is
   * the DATA TIME RANGE axis (StreamGrant.time_constraint) — distinct from
   * grant validity (Grant.expires_at), which lives only in the decision rail. */
  readonly timePhrase?: string;
  readonly timeSince?: string;
  readonly timeUntil?: string;
}

export interface MockSource {
  readonly account: string;
  readonly id: string;
  readonly name: string;
  readonly streams: readonly MockStream[];
}

// Sources with a real connector icon (packages/pdpp-brand-react's
// ConnectorIcon renders these as inline_svg; every other source falls back
// to ConnectorIcon's own Monogram — never a bespoke initials hack).
export const SOURCE_ICON_FILES: Record<string, string> = {
  amazon: "amazon.svg",
  apple_contacts: "icloud.svg",
  apple_health: "icloud.svg",
  chatgpt_history: "chatgpt.svg",
  doordash: "doordash.svg",
  github: "github.svg",
  goodreads: "goodreads.svg",
  instagram: "instagram.svg",
  linkedin: "linkedin.svg",
  spotify: "spotify.svg",
  uber: "uber.svg",
};

// 27 sources. The three that carry a selection are first, so the design's
// populated states — partial selection, narrowed fields, a date bound — are
// visible without interacting. The owner's own worked example (round 2, item
// 12) is a CPA reading 2025 transaction data across several sources for a
// grant that only lasts 30 days, so Chase/YNAB carry a 2025 range here.
export const SOURCES: readonly MockSource[] = [
  {
    account: "Personal · ••4417",
    id: "chase",
    name: "Chase",
    streams: [
      {
        fieldsSelected: 4,
        fieldsTotal: 12,
        label: "Accounts",
        name: "accounts",
        selected: true,
        sentence: "Your account names, types, and balances.",
      },
      {
        fieldsTotal: 18,
        label: "Transactions",
        name: "transactions",
        selected: true,
        sentence: "Every purchase, payment, and transfer, with amounts and merchants.",
        timePhrase: "Transactions dated",
        timeSince: "2025-01-01",
        timeUntil: "2025-12-31",
      },
      {
        fieldsTotal: 9,
        label: "Recent activity",
        name: "current_activity",
        sentence: "Charges that have not settled yet.",
        timePhrase: "Activity dated",
      },
      {
        fieldsTotal: 7,
        label: "Statements",
        name: "statements",
        sentence: "Your monthly statement documents.",
        timePhrase: "Statements dated",
      },
      {
        fieldsTotal: 5,
        label: "Scheduled payments",
        name: "scheduled_payments",
        sentence: "Payments you have set up to happen later.",
      },
    ],
  },
  {
    account: "tim@gmail.com",
    id: "gmail",
    name: "Gmail",
    streams: [
      {
        fieldsTotal: 14,
        label: "Messages",
        name: "messages",
        selected: true,
        sentence: "The full text of your email, including attachment names.",
        timePhrase: "Messages sent",
      },
      {
        fieldsTotal: 6,
        label: "Threads",
        name: "threads",
        selected: true,
        sentence: "How your messages group into conversations.",
        timePhrase: "Threads started",
      },
      { fieldsTotal: 4, label: "Labels", name: "labels", sentence: "The labels and folders you file mail under." },
      { fieldsTotal: 8, label: "Contacts", name: "contacts", sentence: "The people you email and their addresses." },
      {
        fieldsTotal: 11,
        label: "Attachments",
        name: "attachments",
        sentence: "Files sent to and from your inbox.",
        timePhrase: "Attachments received",
      },
    ],
  },
  {
    account: "tnunamak",
    id: "github",
    name: "GitHub",
    streams: [
      {
        fieldsTotal: 16,
        label: "Repositories",
        name: "repositories",
        selected: true,
        sentence: "The repositories you own or contribute to.",
        timePhrase: "Repositories created",
      },
      {
        fieldsTotal: 15,
        label: "Pull requests",
        name: "pull_requests",
        selected: true,
        sentence: "Pull requests you opened, reviewed, or commented on.",
        timePhrase: "Pull requests opened",
      },
      {
        fieldsTotal: 13,
        label: "Issues",
        name: "issues",
        sentence: "Issues you filed or were assigned.",
        timePhrase: "Issues opened",
      },
      {
        fieldsTotal: 7,
        label: "Starred repositories",
        name: "starred",
        sentence: "The repositories you have starred.",
        timePhrase: "Starred on or after",
      },
      {
        fieldsTotal: 8,
        label: "Gists",
        name: "gists",
        sentence: "The code snippets you published as gists.",
        timePhrase: "Gists created",
      },
    ],
  },
  {
    account: "tim@openai-personal",
    id: "chatgpt_history",
    name: "ChatGPT",
    streams: [
      {
        fieldsTotal: 10,
        label: "Conversations",
        name: "conversations",
        sentence: "Your chat history, including what you asked and what was answered.",
        timePhrase: "Conversations started",
      },
      {
        fieldsTotal: 5,
        label: "Memories",
        name: "memories",
        sentence: "What the assistant saved to remember about you.",
        timePhrase: "Saved on or after",
      },
    ],
  },
  {
    account: "tim@gmail.com",
    id: "amazon",
    name: "Amazon",
    streams: [
      {
        fieldsTotal: 19,
        label: "Orders",
        name: "orders",
        sentence: "What you bought, when, and what you paid.",
        timePhrase: "Orders placed",
      },
      {
        fieldsTotal: 8,
        label: "Order items",
        name: "order_items",
        sentence: "The individual products in each order.",
        timePhrase: "Ordered on or after",
      },
    ],
  },
  {
    account: "Tim's budget",
    id: "ynab",
    name: "YNAB",
    streams: [
      { fieldsTotal: 11, label: "Accounts", name: "accounts", sentence: "The accounts in your budget." },
      {
        fieldsTotal: 14,
        label: "Transactions",
        name: "transactions",
        sentence: "Every transaction you have categorized.",
        timePhrase: "Transactions dated",
        timeSince: "2025-01-01",
        timeUntil: "2025-12-31",
      },
      { fieldsTotal: 9, label: "Categories", name: "categories", sentence: "Your budget categories and targets." },
    ],
  },
  {
    account: "tim",
    id: "spotify",
    name: "Spotify",
    streams: [
      {
        fieldsTotal: 10,
        label: "Recently played",
        name: "recently_played",
        sentence: "What you played and when.",
        timePhrase: "Played on or after",
      },
      { fieldsTotal: 5, label: "Top artists", name: "top_artists", sentence: "The artists you listen to most." },
    ],
  },
  {
    account: "iPhone 15 Pro",
    id: "apple_health",
    name: "Apple Health",
    streams: [
      {
        fieldsTotal: 11,
        label: "Health records",
        name: "records",
        sentence: "Steps, heart rate, sleep, and weight, reading by reading.",
        timePhrase: "Recorded on or after",
      },
      {
        fieldsTotal: 12,
        label: "Workouts",
        name: "workouts",
        sentence: "Your recorded workouts, including GPS routes.",
        timePhrase: "Workouts started",
      },
    ],
  },
  {
    account: "iCloud",
    id: "apple_contacts",
    name: "Apple Contacts",
    streams: [
      {
        fieldsTotal: 15,
        label: "Contacts",
        name: "contacts",
        sentence: "Names, numbers, addresses, and birthdays in your address book.",
      },
    ],
  },
  {
    account: "tim@gmail.com",
    id: "google_maps",
    name: "Google Maps",
    streams: [
      {
        fieldsTotal: 11,
        label: "Location history",
        name: "timeline_points",
        sentence: "Where your phone has been, minute by minute.",
        timePhrase: "Locations recorded",
      },
    ],
  },
  {
    account: "Vana",
    id: "slack",
    name: "Slack",
    streams: [
      {
        fieldsTotal: 13,
        label: "Messages",
        name: "messages",
        sentence: "What you posted in channels and DMs.",
        timePhrase: "Messages sent",
      },
      { fieldsTotal: 7, label: "Channels", name: "channels", sentence: "The channels you belong to." },
    ],
  },
  {
    account: "@tnunamak",
    id: "venmo",
    name: "Venmo",
    streams: [
      {
        fieldsTotal: 12,
        label: "Payments",
        name: "transactions",
        sentence: "Money you sent and received, with notes.",
        timePhrase: "Payments dated",
      },
    ],
  },
  {
    account: "+1 ••• ••• 4417",
    id: "whatsapp",
    name: "WhatsApp",
    streams: [
      {
        fieldsTotal: 11,
        label: "Messages",
        name: "messages",
        sentence: "The text of your chats.",
        timePhrase: "Messages sent",
      },
    ],
  },
  {
    account: "u/tnunamak",
    id: "reddit",
    name: "Reddit",
    streams: [
      {
        fieldsTotal: 10,
        label: "Posts",
        name: "submitted",
        sentence: "Threads you submitted.",
        timePhrase: "Posts submitted",
      },
    ],
  },
  {
    account: "@tnunamak",
    id: "instagram",
    name: "Instagram",
    streams: [
      {
        fieldsTotal: 12,
        label: "Posts",
        name: "posts",
        sentence: "Photos and videos you published.",
        timePhrase: "Posts published",
      },
    ],
  },
  {
    account: "Tim Nunamaker",
    id: "linkedin",
    name: "LinkedIn",
    streams: [
      { fieldsTotal: 14, label: "Profile", name: "profile", sentence: "Your work history, education, and skills." },
    ],
  },
  {
    account: "tim@gmail.com",
    id: "netflix",
    name: "Netflix",
    streams: [
      {
        fieldsTotal: 8,
        label: "Viewing activity",
        name: "viewing_activity",
        sentence: "What you watched and when.",
        timePhrase: "Watched on or after",
      },
    ],
  },
  {
    account: "tim@gmail.com",
    id: "uber",
    name: "Uber",
    streams: [
      {
        fieldsTotal: 15,
        label: "Trips",
        name: "trips",
        sentence: "Every ride, including where you were picked up and dropped off, and what it cost.",
        timePhrase: "Trips taken",
      },
    ],
  },
  {
    account: "tim@gmail.com",
    id: "doordash",
    name: "DoorDash",
    streams: [
      {
        fieldsTotal: 13,
        label: "Orders",
        name: "orders",
        sentence: "What you ordered, from where, and what you paid.",
        timePhrase: "Orders placed",
      },
    ],
  },
  {
    account: "tnunamak",
    id: "strava",
    name: "Strava",
    streams: [
      {
        fieldsTotal: 16,
        label: "Activities",
        name: "activities",
        sentence: "Your runs and rides, including GPS routes and heart rate.",
        timePhrase: "Activities recorded",
      },
    ],
  },
  {
    account: "Tim N.",
    id: "goodreads",
    name: "Goodreads",
    streams: [
      {
        fieldsTotal: 11,
        label: "Books",
        name: "books",
        sentence: "Books on your shelves and their status.",
        timePhrase: "Shelved on or after",
      },
    ],
  },
  {
    account: "tnunamak",
    id: "discord",
    name: "Discord",
    streams: [
      {
        fieldsTotal: 10,
        label: "Messages",
        name: "messages",
        sentence: "What you posted in servers and DMs.",
        timePhrase: "Messages sent",
      },
    ],
  },
  {
    account: "Tim's workspace",
    id: "notion",
    name: "Notion",
    streams: [
      {
        fieldsTotal: 12,
        label: "Pages",
        name: "pages",
        sentence: "The content of your pages.",
        timePhrase: "Pages edited",
      },
    ],
  },
  {
    account: "@tnunamak",
    id: "x",
    name: "X",
    streams: [
      {
        fieldsTotal: 11,
        label: "Posts",
        name: "tweets",
        sentence: "What you posted, including replies.",
        timePhrase: "Posts published",
      },
    ],
  },
  {
    account: "tim@gmail.com",
    id: "google_photos",
    name: "Google Photos",
    streams: [
      {
        fieldsTotal: 14,
        label: "Photos",
        name: "photos",
        sentence: "Your photos and videos, with the place and time each was taken.",
        timePhrase: "Taken on or after",
      },
    ],
  },
  {
    account: "+1 ••• ••• 4417",
    id: "groupme",
    name: "GroupMe",
    streams: [
      {
        fieldsTotal: 9,
        label: "Group messages",
        name: "group_messages",
        sentence: "What you posted in group chats.",
        timePhrase: "Messages sent",
      },
    ],
  },
  {
    account: "Tim (desktop)",
    id: "signal",
    name: "Signal",
    streams: [
      {
        fieldsTotal: 10,
        label: "Messages",
        name: "messages",
        sentence: "The text of your conversations.",
        timePhrase: "Messages sent",
      },
    ],
  },
];

export function fieldSummary(stream: MockStream): string {
  return stream.fieldsSelected === undefined
    ? `All ${stream.fieldsTotal} fields`
    : `${stream.fieldsSelected} of ${stream.fieldsTotal} fields`;
}

// DATA TIME RANGE (StreamGrant.time_constraint) — never grant validity.
export function dataRangeSummary(stream: MockStream): string {
  if (!stream.timePhrase) {
    return "";
  }
  if (stream.timeSince && stream.timeUntil) {
    return `Data from ${stream.timeSince} to ${stream.timeUntil}`;
  }
  if (stream.timeSince) {
    return `Data from ${stream.timeSince} onward`;
  }
  return "All dates";
}
