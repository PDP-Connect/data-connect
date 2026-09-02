// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Owner-only design preview of the anticipated consent screen.
//
//   GET /_ref/design/consent
//
// This route exists so the owner can see and react to the consent design
// specified in `local/CONSENT-UI-REDTEAM-DESIGN-0902.md` before it is wired
// to the real authorization flow. It renders that design from MOCK data
// shaped like a real ChatGPT MCP authorization request, using the copy from
// §4.2 of that spec verbatim.
//
// Three properties are load-bearing and deliberate:
//
//  1. **It submits nothing.** There is no form, no POST target, and no
//     mutating handler anywhere in this file. The Allow and Cancel controls
//     are inert buttons that switch the preview's own `?state=` parameter.
//     Nothing on this route can mint, widen, or revoke a grant.
//  2. **It reads no owner data.** Every source, stream, account label, and
//     client fact below is a literal in this file. The route touches no
//     store, so the preview is identical on an empty instance and a
//     fully-connected one.
//  3. **It does not share code with the live consent path.** The real picker
//     renders through `as-consent-ui-helpers.ts`, which other lanes own and
//     which this change does not touch. Duplicating the markup here is the
//     point: the design can move ahead of the implementation without any
//     risk to the surface that actually issues grants.
//
// The live column is 640px and has no width breakpoints; the design needs a
// two-column composition with a sticky review panel, so this file carries its
// own layout stylesheet layered on the shared Ink Carbon token sheet at
// `/__pdpp/hosted-ui.css`. Tokens are inherited, never redefined.
//
// Variants, all reachable by URL:
//   /_ref/design/consent                    — the consent screen (desktop)
//   /_ref/design/consent?width=mobile       — the mobile rendering
//   /_ref/design/consent?trust=verified     — the same screen with a positive
//                                             trust signal, so both limbs of
//                                             spec-core.md:675 are reviewable
//   /_ref/design/consent?state=signin       — owner sign-in
//   /_ref/design/consent?state=deny         — the owner cancelled
//   /_ref/design/consent?state=error        — a terminal server error
//   /_ref/design/consent?state=receipt      — the post-approval receipt
//
// Auth posture: owner session, same as every other `/_ref/` surface. This is
// an internal design surface, not a PDPP protocol surface.

import { escapeHtml, HOSTED_UI_CSS_PATH, renderPdppMark } from "../hosted-ui.ts";
import type { MiddlewareHandler, RouteArg } from "./_route-contract.ts";

// ─── Minimal structural types ────────────────────────────────────────────────

interface RouteRequest {
  readonly query?: Record<string, unknown> | null;
}

interface RouteResponse {
  send: (body: string) => unknown;
  setHeader: (name: string, value: string) => unknown;
}

type RouteHandler = (req: RouteRequest, res: RouteResponse) => void;

interface AppLike {
  get: (path: string, ...args: RouteArg<RouteHandler>[]) => AppLike;
}

export interface MountRefDesignConsentMockContext {
  readonly providerName: string;
  readonly requireOwnerSession: MiddlewareHandler;
}

// ─── Mock request ────────────────────────────────────────────────────────────

// Shaped like the real ChatGPT authorization request: a plain OAuth/MCP
// client with a client metadata document and no PDPP `authorization_details`.
// Because it declares no purpose, no streams, and no retention, the design's
// hardest cases — a server-assigned purpose and an absent retention promise —
// are the default here rather than an edge case.
const CLIENT = {
  domain: "chatgpt.com",
  // Two letters from the resolved display name, per spec-core.md:676. Shown
  // only while unverified; a verified client would render its cached logo.
  monogram: "CH",
  name: "ChatGPT",
} as const;

interface MockStream {
  readonly fieldsSelected?: number;
  readonly fieldsTotal: number;
  readonly label: string;
  readonly name: string;
  readonly selected?: boolean;
  readonly sentence: string;
  // Humanized temporal phrasing, per spec-core.md:545. Present only where the
  // stream declares `consent_time_field`; absent means the control is
  // suppressed, which is the correct rendering of an inapplicable control.
  readonly timePhrase?: string;
  readonly timeSelected?: string;
}

interface MockSource {
  readonly account: string;
  readonly id: string;
  readonly name: string;
  readonly streams: readonly MockStream[];
}

// 27 sources. The three that carry a selection are first, so the design's
// populated states — partial selection, narrowed fields, a date bound — are
// visible without interacting.
const SOURCES: readonly MockSource[] = [
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
        timeSelected: "1 March 2026",
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
        timeSelected: "1 March 2026",
      },
      {
        fieldsTotal: 6,
        label: "Threads",
        name: "threads",
        selected: true,
        sentence: "How your messages group into conversations.",
        timePhrase: "Threads started",
      },
      {
        fieldsTotal: 4,
        label: "Labels",
        name: "labels",
        sentence: "The labels and folders you file mail under.",
      },
      {
        fieldsTotal: 8,
        label: "Contacts",
        name: "contacts",
        sentence: "The people you email and their addresses.",
      },
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
      {
        fieldsTotal: 12,
        label: "Profile",
        name: "user",
        sentence: "Your public profile — name, bio, company, and location.",
        timePhrase: "Profile updated",
      },
      {
        fieldsTotal: 9,
        label: "Contribution counts",
        name: "user_stats",
        sentence: "How much you have committed, reviewed, and starred.",
        timePhrase: "Counted on or after",
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
        fieldsTotal: 6,
        label: "Messages",
        name: "messages",
        sentence: "Individual turns within each conversation.",
        timePhrase: "Messages sent",
      },
      {
        fieldsTotal: 5,
        label: "Memories",
        name: "memories",
        sentence: "What the assistant saved to remember about you.",
        timePhrase: "Saved on or after",
      },
      {
        fieldsTotal: 4,
        label: "Custom instructions",
        name: "custom_instructions",
        sentence: "The standing instructions you gave the assistant.",
      },
      {
        fieldsTotal: 7,
        label: "Shared conversations",
        name: "shared_conversations",
        sentence: "Conversations you published as links.",
        timePhrase: "Shared on or after",
      },
      {
        fieldsTotal: 8,
        label: "Custom GPTs",
        name: "custom_gpts",
        sentence: "The assistants you built and their instructions.",
        timePhrase: "Created on or after",
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
      },
      { fieldsTotal: 9, label: "Categories", name: "categories", sentence: "Your budget categories and targets." },
      {
        fieldsTotal: 12,
        label: "Monthly budgets",
        name: "month_categories",
        sentence: "What you budgeted and spent in each category, month by month.",
        timePhrase: "Months beginning",
      },
      { fieldsTotal: 6, label: "Payees", name: "payees", sentence: "The people and businesses you pay." },
      {
        fieldsTotal: 8,
        label: "Scheduled transactions",
        name: "scheduled_transactions",
        sentence: "Transactions you set up to repeat.",
        timePhrase: "Next due on or after",
      },
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
      {
        fieldsTotal: 8,
        label: "Playlists",
        name: "playlists",
        sentence: "Your playlists and what is in them.",
        timePhrase: "Playlists created",
      },
      {
        fieldsTotal: 6,
        label: "Saved tracks",
        name: "saved_tracks",
        sentence: "Songs you have saved to your library.",
        timePhrase: "Saved on or after",
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
      { fieldsTotal: 5, label: "Address books", name: "address_books", sentence: "Which address books you keep." },
      { fieldsTotal: 4, label: "Groups", name: "contact_groups", sentence: "How you have grouped your contacts." },
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
      {
        fieldsTotal: 8,
        label: "Trips",
        name: "timeline_segments",
        sentence: "Journeys your phone inferred between places, with how you travelled.",
        timePhrase: "Trips taken",
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
      { fieldsTotal: 6, label: "Reactions", name: "reactions", sentence: "The emoji you reacted with." },
      { fieldsTotal: 5, label: "Files", name: "files", sentence: "Files you shared in Slack." },
      { fieldsTotal: 8, label: "People", name: "users", sentence: "Everyone in the workspace and their profiles." },
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
      { fieldsTotal: 6, label: "Friends", name: "friends", sentence: "The people you pay and get paid by." },
      { fieldsTotal: 8, label: "Profile", name: "profile", sentence: "Your Venmo profile and username." },
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
      {
        fieldsTotal: 7,
        label: "Chats",
        name: "chats",
        sentence: "Who you talk to, one-to-one and in groups.",
        timePhrase: "Chats started",
      },
      {
        fieldsTotal: 8,
        label: "Attachments",
        name: "attachments",
        sentence: "Photos, videos, and voice notes you exchanged.",
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
      {
        fieldsTotal: 9,
        label: "Comments",
        name: "comments",
        sentence: "Comments you left anywhere on Reddit.",
        timePhrase: "Comments posted",
      },
      { fieldsTotal: 5, label: "Saved", name: "saved", sentence: "Posts and comments you saved." },
      {
        fieldsTotal: 4,
        label: "Upvoted",
        name: "upvoted",
        sentence: "Posts you upvoted.",
        timePhrase: "Upvoted on or after",
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
      { fieldsTotal: 9, label: "Profile", name: "profile", sentence: "Your bio, links, and profile photo." },
    ],
  },
  {
    account: "Tim Nunamaker",
    id: "linkedin",
    name: "LinkedIn",
    streams: [
      { fieldsTotal: 14, label: "Profile", name: "profile", sentence: "Your work history, education, and skills." },
      {
        fieldsTotal: 9,
        label: "Work history",
        name: "experience",
        sentence: "The roles you have held and when.",
        timePhrase: "Roles starting",
      },
      { fieldsTotal: 7, label: "Education", name: "education", sentence: "The schools you attended." },
      { fieldsTotal: 6, label: "Skills", name: "skills", sentence: "The skills listed on your profile." },
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
      { fieldsTotal: 5, label: "Ratings", name: "ratings", sentence: "Titles you rated." },
      { fieldsTotal: 4, label: "My list", name: "my_list", sentence: "Titles you saved to watch later." },
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
      { fieldsTotal: 5, label: "Order items", name: "order_items", sentence: "The individual dishes in each order." },
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
      {
        fieldsTotal: 8,
        label: "Reviews",
        name: "reviews",
        sentence: "Reviews and ratings you wrote.",
        timePhrase: "Reviews posted",
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
      { fieldsTotal: 5, label: "Servers", name: "guilds", sentence: "The servers you belong to." },
      { fieldsTotal: 4, label: "Friends", name: "relationships", sentence: "Your friends list." },
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
      {
        fieldsTotal: 9,
        label: "Databases",
        name: "databases",
        sentence: "Your databases and every row in them.",
        timePhrase: "Rows edited",
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
      {
        fieldsTotal: 7,
        label: "Direct messages",
        name: "direct_messages",
        sentence: "Your private conversations.",
        timePhrase: "Messages sent",
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
      {
        fieldsTotal: 9,
        label: "Search history",
        name: "search_history",
        sentence: "What you searched for on Google.",
        timePhrase: "Searched on or after",
      },
      {
        fieldsTotal: 8,
        label: "YouTube watch history",
        name: "youtube_watch_history",
        sentence: "What you watched on YouTube.",
        timePhrase: "Watched on or after",
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
      {
        fieldsTotal: 5,
        label: "Groups",
        name: "groups",
        sentence: "The groups you belong to.",
        timePhrase: "Groups joined",
      },
      {
        fieldsTotal: 7,
        label: "Direct messages",
        name: "direct_messages",
        sentence: "Your one-to-one conversations.",
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
      {
        fieldsTotal: 6,
        label: "Conversations",
        name: "conversations",
        sentence: "Who you talk to, one-to-one and in groups.",
      },
      { fieldsTotal: 5, label: "Reactions", name: "reactions", sentence: "The emoji you reacted with." },
      { fieldsTotal: 7, label: "Attachments", name: "attachments", sentence: "Photos and files you exchanged." },
    ],
  },
];

// ─── Derived selection facts ─────────────────────────────────────────────────

interface Selection {
  readonly selectedSources: readonly MockSource[];
  readonly selectedStreamCount: number;
  readonly totalStreamCount: number;
}

function computeSelection(): Selection {
  const selectedSources = SOURCES.filter((source) => source.streams.some((stream) => stream.selected));
  return {
    selectedSources,
    selectedStreamCount: SOURCES.reduce(
      (total, source) => total + source.streams.filter((stream) => stream.selected).length,
      0
    ),
    totalStreamCount: SOURCES.reduce((total, source) => total + source.streams.length, 0),
  };
}

// "All 12 fields" / "4 of 12 fields", per §4.2. The summary line is what the
// owner reads on the default path; the field list itself stays behind the
// disclosure, because 154 streams times a dozen fields each is not a screen
// anyone can read.
function fieldSummary(stream: MockStream): string {
  return stream.fieldsSelected === undefined
    ? `All ${stream.fieldsTotal} fields`
    : `${stream.fieldsSelected} of ${stream.fieldsTotal} fields`;
}

// Humanized temporal consent, per spec-core.md:545 — the field name in words,
// never the parameter. Streams that declare no `consent_time_field` render
// nothing at all: silence is the correct rendering of an inapplicable control.
function timeSummary(stream: MockStream): string | null {
  if (!stream.timePhrase) {
    return null;
  }
  return stream.timeSelected ? `${stream.timePhrase} on or after ${stream.timeSelected}` : "All dates";
}

// ─── Design layout stylesheet ────────────────────────────────────────────────

// Layered on `/__pdpp/hosted-ui.css`, which supplies the Ink Carbon tokens and
// the type scale. Nothing here redefines a token; this is composition only —
// the parts of §4.1/§4.3 the live stylesheet has no equivalent for.
//
// The live sheet is a fixed 640px column with zero width-based media queries.
// The design needs a two-column desktop composition with a sticky review panel
// (structural, not decorative: once the last thing the owner reads is the exact
// summary they are binding to, that summary needs a column), plus a real mobile
// rendering with 44px touch targets and a disclosure control that does not
// share a hit area with a checkbox.
const DESIGN_CSS = `
.design-shell {
  max-width: 960px;
  margin: 0 auto;
  padding: 2.5rem 1.5rem 4rem;
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

.design-header {
  display: flex;
  align-items: center;
  padding-bottom: 0.25rem;
}
.design-instance {
  font-weight: 600;
  font-size: 0.9375rem;
  letter-spacing: -0.01em;
}

.design-columns {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 320px;
  gap: 2rem;
  align-items: start;
}
.design-main {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
  min-width: 0;
}

/* ─── Identity ─────────────────────────────────────────────────────────── */
.design-identity {
  display: flex;
  gap: 1rem;
  align-items: flex-start;
}
.design-monogram {
  flex: 0 0 auto;
  width: 44px;
  height: 44px;
  display: grid;
  place-items: center;
  border: 1px solid var(--border);
  background: var(--muted);
  color: var(--muted-foreground);
  font-family: var(--font-mono);
  font-size: 0.9375rem;
  font-weight: 500;
  letter-spacing: 0.04em;
  border-radius: var(--radius);
}
.design-identity-body { display: flex; flex-direction: column; gap: 0.25rem; min-width: 0; }
.design-client-name { font-size: 1.0625rem; font-weight: 600; letter-spacing: -0.01em; }
.design-client-domain { color: var(--muted-foreground); font-size: 0.8125rem; }

/* Unverified is a neutral fact line, not a badge shouting at a client that has
 * done nothing wrong. A positive trust signal renders distinctly (spec-core.md:675). */
.design-trust {
  margin-top: 0.375rem;
  font-size: 0.8125rem;
  color: var(--muted-foreground);
  line-height: 1.5;
}
.design-trust[data-trust="registered"] {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.125rem 0.5rem;
  border: 1px solid color-mix(in oklch, var(--success) 45%, transparent);
  background: color-mix(in oklch, var(--success) 10%, transparent);
  color: var(--success);
  border-radius: var(--radius);
  font-weight: 500;
}

.design-headline {
  font-size: 1.75rem;
  font-weight: 600;
  line-height: 1.15;
  letter-spacing: -0.02em;
  margin: 0;
}
.design-lede { color: var(--muted-foreground); margin: 0.5rem 0 0; font-size: 1rem; line-height: 1.6; }

/* ─── Sections ─────────────────────────────────────────────────────────── */
.design-section {
  border: 1px solid var(--border);
  background: var(--card);
  border-radius: var(--radius);
  padding: 1.25rem;
}
.design-section-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 0.875rem;
}
.design-section-title { font-size: 0.9375rem; font-weight: 600; margin: 0; }
.design-counter { font-size: 0.8125rem; color: var(--muted-foreground); font-variant-numeric: tabular-nums; }

.design-terms { display: flex; flex-direction: column; gap: 0.875rem; }
.design-term-label {
  display: block;
  font-size: 0.75rem;
  font-weight: 500;
  color: var(--muted-foreground);
  margin-bottom: 0.1875rem;
}
.design-term-value { font-size: 0.9375rem; line-height: 1.55; margin: 0; }

/* ─── Duration ─────────────────────────────────────────────────────────── */
.design-radio-group { display: flex; flex-direction: column; gap: 0.5rem; border: 0; margin: 0; padding: 0; }
.design-radio {
  display: flex;
  gap: 0.75rem;
  align-items: flex-start;
  padding: 0.75rem;
  min-height: 44px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  cursor: pointer;
}
.design-radio:has(input:checked) {
  border-color: var(--human);
  background: var(--human-wash);
}
.design-radio input { margin: 0.25rem 0 0; width: 18px; height: 18px; accent-color: var(--human); flex: 0 0 auto; }
.design-radio-label { font-size: 0.9375rem; font-weight: 500; }
.design-radio-meta { display: block; margin-top: 0.1875rem; font-size: 0.8125rem; color: var(--muted-foreground); line-height: 1.5; }

.design-expiry-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  margin-top: 0.875rem;
  padding-top: 0.875rem;
  border-top: 1px solid var(--border);
}
.design-chip {
  padding: 0.375rem 0.75rem;
  min-height: 32px;
  display: inline-flex;
  align-items: center;
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  background: transparent;
  color: var(--foreground);
  font: inherit;
  font-size: 0.8125rem;
  cursor: pointer;
}
.design-chip[aria-pressed="true"] { border-color: var(--human); background: var(--human-wash); color: var(--human); font-weight: 500; }

/* ─── Source list ──────────────────────────────────────────────────────── */
.design-search {
  width: 100%;
  padding: 0.625rem 0.75rem;
  min-height: 44px;
  border: 1px solid var(--input);
  border-radius: var(--radius-control);
  background: var(--card);
  color: var(--foreground);
  font: inherit;
  font-size: 0.875rem;
  margin-bottom: 0.75rem;
}
.design-sources { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--border); }
.design-source { border-bottom: 1px solid var(--border); }

/* The disclosure control is its own element with its own hit area, separated
 * from the checkbox. On the live page both share one row, so a phone tap has
 * two possible outcomes. */
.design-source-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  min-height: 52px;
  padding: 0.5rem 0;
}
.design-source-check {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 44px;
  cursor: pointer;
}
.design-source-check input { width: 20px; height: 20px; margin: 0; accent-color: var(--human); flex: 0 0 auto; }
.design-source-text { display: flex; flex-direction: column; gap: 0.125rem; min-width: 0; }
.design-source-name { font-size: 0.9375rem; font-weight: 500; }
.design-source-account { font-size: 0.8125rem; color: var(--muted-foreground); }
.design-source-count { font-size: 0.8125rem; color: var(--muted-foreground); font-variant-numeric: tabular-nums; white-space: nowrap; }
.design-disclosure {
  flex: 0 0 auto;
  width: 44px;
  height: 44px;
  display: grid;
  place-items: center;
  border: 1px solid transparent;
  border-radius: var(--radius-control);
  background: transparent;
  color: var(--muted-foreground);
  cursor: pointer;
}
.design-disclosure:hover { background: var(--muted); }
.design-disclosure svg { display: block; transition: transform 120ms ease; }
.design-source[open] .design-disclosure svg { transform: rotate(90deg); }

/* ─── Stream list ──────────────────────────────────────────────────────── */
.design-streams { list-style: none; margin: 0 0 0.75rem; padding: 0 0 0 2.75rem; display: flex; flex-direction: column; gap: 0.125rem; }
.design-stream { padding: 0.5rem 0; }
.design-stream-check { display: flex; gap: 0.75rem; align-items: flex-start; min-height: 44px; cursor: pointer; }
.design-stream-check input { width: 20px; height: 20px; margin: 0.125rem 0 0; accent-color: var(--human); flex: 0 0 auto; }
.design-stream-body { display: flex; flex-direction: column; gap: 0.1875rem; min-width: 0; }
.design-stream-label { font-size: 0.875rem; font-weight: 500; }
.design-stream-sentence { font-size: 0.8125rem; color: var(--muted-foreground); line-height: 1.5; }

/* Field and date narrowing is progressive disclosure: the summary line is the
 * default path, the controls open only on request. */
.design-narrow { margin-top: 0.375rem; }
.design-narrow-summary {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  min-height: 32px;
  font-size: 0.75rem;
  color: var(--muted-foreground);
  cursor: pointer;
  list-style: none;
}
.design-narrow-summary::-webkit-details-marker { display: none; }
.design-narrow-summary::after {
  content: "Edit";
  color: var(--primary);
  border-bottom: 1px solid currentColor;
}
.design-narrow[open] .design-narrow-summary::after { content: "Done"; }
.design-narrow-body {
  margin-top: 0.5rem;
  padding: 0.75rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--muted);
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.design-narrow-title { font-size: 0.75rem; font-weight: 500; margin: 0 0 0.375rem; }
.design-fields { display: flex; flex-wrap: wrap; gap: 0.375rem 1rem; }
.design-field { display: inline-flex; align-items: center; gap: 0.375rem; font-size: 0.75rem; min-height: 28px; }
.design-field input { width: 16px; height: 16px; margin: 0; accent-color: var(--human); }
.design-field[data-required="true"] { color: var(--muted-foreground); }
.design-field-required { font-size: 0.6875rem; color: var(--muted-foreground); }
.design-date-row { display: flex; flex-wrap: wrap; gap: 0.375rem; align-items: center; }

/* ─── Review panel — the approval artifact ─────────────────────────────── */
.design-review {
  position: sticky;
  top: 1.5rem;
  border: 1px solid var(--human);
  border-radius: var(--radius);
  background: var(--card);
  display: flex;
  flex-direction: column;
}
.design-review-head {
  padding: 1rem 1.25rem 0.875rem;
  border-bottom: 1px solid var(--border);
  background: var(--human-wash);
}
.design-review-title { font-size: 0.9375rem; font-weight: 600; margin: 0; }
.design-review-body { padding: 1rem 1.25rem; display: flex; flex-direction: column; gap: 0.875rem; max-height: 52vh; overflow-y: auto; }
.design-review-row { display: flex; flex-direction: column; gap: 0.1875rem; }
.design-review-label { font-size: 0.6875rem; font-weight: 500; color: var(--muted-foreground); text-transform: uppercase; letter-spacing: 0.06em; }
.design-review-value { font-size: 0.875rem; line-height: 1.5; }
.design-review-source { font-size: 0.8125rem; line-height: 1.5; }
.design-review-source + .design-review-source { margin-top: 0.5rem; }
.design-review-source-name { font-weight: 500; }
.design-review-streams { color: var(--muted-foreground); }
.design-review-empty { font-size: 0.875rem; color: var(--muted-foreground); }

.design-actions {
  padding: 1rem 1.25rem;
  border-top: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.design-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 44px;
  padding: 0.625rem 1rem;
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  background: var(--card);
  color: var(--foreground);
  font: inherit;
  font-size: 0.875rem;
  font-weight: 500;
  cursor: pointer;
  text-decoration: none;
}
.design-btn:hover { background: var(--muted); }
/* Copper is reserved for owner consent acts, so Allow is the only copper
 * element on the screen. */
.design-btn[data-variant="human"] {
  background: var(--human);
  border-color: var(--human);
  color: var(--human-foreground);
}
.design-btn[data-variant="human"]:hover { filter: brightness(1.06); }
.design-footnote { font-size: 0.75rem; color: var(--muted-foreground); line-height: 1.5; margin: 0.25rem 0 0; }

.design-footer {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-top: 1rem;
  padding-top: 1rem;
  border-top: 1px solid var(--border);
  color: var(--muted-foreground);
  font-size: 0.75rem;
}

/* ─── Terminal states ──────────────────────────────────────────────────── */
/* Left-aligned under the instance name rather than centred in the 960px
 * shell: a terminal state is the same page, not a different one, and a block
 * that drifts away from the header reads as a separate screen. */
.design-terminal { max-width: 480px; margin: 3rem 0 0; text-align: left; display: flex; flex-direction: column; gap: 0.75rem; }
.design-terminal-mark {
  width: 40px; height: 40px; display: grid; place-items: center;
  border-radius: var(--radius); background: var(--muted); color: var(--muted-foreground); font-size: 1.125rem;
}
.design-terminal-mark[data-tone="success"] { background: color-mix(in oklch, var(--success) 14%, transparent); color: var(--success); }
.design-terminal-mark[data-tone="danger"] { background: color-mix(in oklch, var(--destructive) 12%, transparent); color: var(--destructive); }
.design-terminal-title { font-size: 1.375rem; font-weight: 600; letter-spacing: -0.015em; margin: 0; }
.design-terminal-body { color: var(--muted-foreground); line-height: 1.6; margin: 0; font-size: 0.9375rem; }
.design-terminal-actions { margin-top: 0.75rem; display: flex; gap: 0.5rem; }

/* Sign-in */
.design-signin { max-width: 380px; margin: 3rem 0 0; display: flex; flex-direction: column; gap: 1rem; }
.design-field-block { display: flex; flex-direction: column; gap: 0.375rem; }
.design-field-block label { font-size: 0.8125rem; font-weight: 500; }
.design-input {
  width: 100%;
  padding: 0.625rem 0.75rem;
  min-height: 44px;
  border: 1px solid var(--input);
  border-radius: var(--radius-control);
  background: var(--card);
  color: var(--foreground);
  font: inherit;
  font-size: 0.9375rem;
}

/* ─── Receipt ──────────────────────────────────────────────────────────── */
.design-receipt-rows { display: flex; flex-direction: column; gap: 0.75rem; margin-top: 0.5rem; }

/* ─── Mobile ───────────────────────────────────────────────────────────── */
/* The live stylesheet has zero width-based media queries. Both the real
 * viewport breakpoint and the forced \`?width=mobile\` class render the same
 * rules, so the preview is honest about what a phone actually gets. */
@media (max-width: 899px) {
  .design-columns { grid-template-columns: minmax(0, 1fr); gap: 1.5rem; }
  .design-review { position: static; }
}

@media (max-width: 599px) {
  .design-shell { padding: 1.5rem 1rem 7.5rem; }
  .design-section { border-left: 0; border-right: 0; border-radius: 0; margin: 0 -1rem; padding: 1.25rem 1rem; }
  .design-headline { font-size: 1.5rem; }
  .design-streams { padding-left: 2rem; }
  /* Actions leave the panel and become a bottom bar. Our list is far longer
   * than a five-row scope card, so the action must stay reachable. */
  .design-actions {
    position: fixed;
    left: 0; right: 0; bottom: 0;
    flex-direction: row;
    padding: 0.75rem 1rem;
    background: var(--card);
    border-top: 1px solid var(--border);
    z-index: 10;
  }
  .design-btn { flex: 1 1 0; }
  .design-actions .design-footnote { display: none; }
}

/* \`?width=mobile\` forces the same rules at any viewport, so the mobile
 * rendering can be screenshotted and reviewed on a desktop. */
.design-force-mobile .design-columns { grid-template-columns: minmax(0, 1fr); gap: 1.5rem; }
.design-force-mobile .design-review { position: static; }
.design-force-mobile .design-shell { max-width: 420px; padding: 1.5rem 1rem 7.5rem; }
.design-force-mobile .design-headline { font-size: 1.5rem; }
.design-force-mobile .design-streams { padding-left: 2rem; }
.design-force-mobile .design-actions {
  position: sticky;
  bottom: 0;
  flex-direction: row;
  padding: 0.75rem 1rem;
  background: var(--card);
  border-top: 1px solid var(--border);
}
.design-force-mobile .design-btn { flex: 1 1 0; }
.design-force-mobile .design-actions .design-footnote { display: none; }

/* ─── Preview chrome ───────────────────────────────────────────────────── */
/* Marks the page as a design preview so nobody mistakes it for the live
 * consent screen. Not part of the design. */
.design-banner {
  background: var(--warning);
  color: oklch(0.16 0.01 70);
  padding: 0.5rem 1rem;
  font-size: 0.75rem;
  text-align: center;
  line-height: 1.5;
}
.design-banner a { color: inherit; font-weight: 500; }
`;

// ─── Document shell ──────────────────────────────────────────────────────────

const CHEVRON = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

// `indeterminate` is a DOM property with no HTML attribute, so the tri-state
// parent checkbox — the control that replaces 54 per-source buttons — cannot be
// rendered server-side. This sets it from `data-indeterminate` and keeps it in
// sync as the owner clicks, so the preview shows the real behaviour of the
// control rather than a picture of it. It reads and writes only checkbox state
// on this page; it submits nothing.
const TRISTATE_SCRIPT = `
(function () {
  var sources = document.querySelectorAll(".design-source");
  sources.forEach(function (source) {
    var parent = source.querySelector(".design-source-check input");
    var children = source.querySelectorAll(".design-stream-check input");
    if (!parent || !children.length) return;
    function sync() {
      var checked = 0;
      children.forEach(function (child) { if (child.checked) checked += 1; });
      parent.checked = checked === children.length;
      parent.indeterminate = checked > 0 && checked < children.length;
    }
    parent.addEventListener("change", function () {
      children.forEach(function (child) { child.checked = parent.checked; });
      parent.indeterminate = false;
    });
    children.forEach(function (child) { child.addEventListener("change", sync); });
    sync();
  });
  // The disclosure chevron is inside the <summary>, so a click on it would
  // toggle twice. Let the summary own the toggle.
  document.querySelectorAll(".design-source-check").forEach(function (label) {
    label.addEventListener("click", function (event) { event.stopPropagation(); });
  });
})();
`;

// A banner, not a watermark: this route is reachable on a running instance and
// must never be mistaken for the screen that issues grants.
function renderPreviewBanner(): string {
  return `<div class="design-banner">Design preview — mock data, nothing here is submitted. Variants:
<a href="/_ref/design/consent">consent</a> ·
<a href="/_ref/design/consent?width=mobile">mobile</a> ·
<a href="/_ref/design/consent?trust=verified">verified</a> ·
<a href="/_ref/design/consent?state=signin">sign-in</a> ·
<a href="/_ref/design/consent?state=deny">cancelled</a> ·
<a href="/_ref/design/consent?state=error">error</a> ·
<a href="/_ref/design/consent?state=receipt">receipt</a></div>`;
}

function renderDocument({
  body,
  forceMobile,
  providerName,
  title,
}: {
  body: string;
  forceMobile: boolean;
  providerName: string;
  title: string;
}): string {
  const bodyClass = forceMobile ? ' class="design-force-mobile"' : "";
  return `<!DOCTYPE html>
<html lang="en" data-theme="system">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="${HOSTED_UI_CSS_PATH}" />
<style>${DESIGN_CSS}</style>
</head>
<body${bodyClass}>
${renderPreviewBanner()}
<main class="design-shell">
<header class="design-header"><span class="design-instance">${escapeHtml(providerName)}</span></header>
${body}
<footer class="design-footer">${renderPdppMark({ size: 14 })}<span>Secured by PDPP</span></footer>
</main>
<script>${TRISTATE_SCRIPT}</script>
</body>
</html>`;
}

// ─── The consent screen ──────────────────────────────────────────────────────

function renderIdentity(verified: boolean): string {
  // spec-core.md:675 has two limbs — render a positive trust signal
  // distinctly, and treat a client with no signal as unverified. Both are
  // reachable here (`?trust=verified`), because a badge that cannot vary
  // carries no information.
  const trust = verified
    ? `<p class="design-trust" data-trust="registered">Registered with your server</p>`
    : `<p class="design-trust">This app isn't registered with your server. Its name and logo are self-reported.</p>`;
  return `<section class="design-identity">
  <span class="design-monogram" aria-hidden="true">${escapeHtml(CLIENT.monogram)}</span>
  <div class="design-identity-body">
    <span class="design-client-name">${escapeHtml(CLIENT.name)}</span>
    <span class="design-client-domain">${escapeHtml(CLIENT.domain)}</span>
    ${trust}
  </div>
</section>`;
}

// Purpose is stated once, in the server's voice, with the origin named in the
// same sentence. Retention states the absence rather than inventing a promise
// the client never made (spec-core.md:951).
function renderTerms(): string {
  return `<section class="design-section">
  <div class="design-section-head"><h2 class="design-section-title">Terms</h2></div>
  <div class="design-terms">
    <div>
      <span class="design-term-label">Purpose</span>
      <p class="design-term-value">Set by this server because ${escapeHtml(CLIENT.name)} didn't give one: use the data you select as context for your AI assistant.</p>
    </div>
    <div>
      <span class="design-term-label">Retention</span>
      <p class="design-term-value">${escapeHtml(CLIENT.name)} did not say how long it keeps the data it receives.</p>
    </div>
  </div>
</section>`;
}

// `access_mode` and `expires_at` are orthogonal (spec-core.md:889), so expiry
// is its own row and never restates the access mode.
function renderDuration(): string {
  return `<section class="design-section">
  <div class="design-section-head"><h2 class="design-section-title">Access duration</h2></div>
  <fieldset class="design-radio-group">
    <legend class="design-term-label">How long ${escapeHtml(CLIENT.name)} can read</legend>
    <label class="design-radio">
      <input type="radio" name="design-access-mode" value="continuous" checked />
      <span>
        <span class="design-radio-label">Ongoing access</span>
        <span class="design-radio-meta">${escapeHtml(CLIENT.name)} can read the data you select, including new matching records, until you revoke access.</span>
      </span>
    </label>
    <label class="design-radio">
      <input type="radio" name="design-access-mode" value="single_use" />
      <span>
        <span class="design-radio-label">One-time access</span>
        <span class="design-radio-meta">${escapeHtml(CLIENT.name)} can start one retrieval. It can't start another without your approval.</span>
      </span>
    </label>
  </fieldset>
  <div class="design-expiry-row">
    <span class="design-term-label" style="margin:0">Access ends 1 December 2026.</span>
    <button type="button" class="design-chip" aria-pressed="true">90 days</button>
    <button type="button" class="design-chip" aria-pressed="false">1 year</button>
    <button type="button" class="design-chip" aria-pressed="false">No end date</button>
  </div>
</section>`;
}

// Field narrowing: schema-required fields render checked and disabled — the
// per-stream consent floor (spec-core.md:772). Date narrowing appears only
// where the stream declares `consent_time_field`.
function renderNarrowing(source: MockSource, stream: MockStream): string {
  const summaryParts = [fieldSummary(stream)];
  const time = timeSummary(stream);
  if (time) {
    summaryParts.push(time);
  }
  const checkedFields = stream.fieldsSelected ?? stream.fieldsTotal;
  const fields: string[] = [];
  for (let index = 0; index < stream.fieldsTotal; index += 1) {
    const required = index < 2;
    const checked = required || index < checkedFields;
    fields.push(
      `<label class="design-field" data-required="${required}">` +
        `<input type="checkbox"${checked ? " checked" : ""}${required ? " disabled" : ""} />` +
        `<span>field_${index + 1}</span>` +
        (required ? `<span class="design-field-required">required</span>` : "") +
        "</label>"
    );
  }
  const dateBlock = stream.timePhrase
    ? `<div>
      <p class="design-narrow-title">Dates</p>
      <div class="design-date-row">
        <button type="button" class="design-chip" aria-pressed="${stream.timeSelected ? "false" : "true"}">All dates</button>
        <button type="button" class="design-chip" aria-pressed="false">Last 30 days</button>
        <button type="button" class="design-chip" aria-pressed="${stream.timeSelected ? "true" : "false"}">Last 12 months</button>
        <input class="design-input" style="min-height:32px;width:auto;padding:0.25rem 0.5rem;font-size:0.75rem" type="date" value="${stream.timeSelected ? "2026-03-01" : ""}" aria-label="${escapeHtml(stream.timePhrase)} on or after" />
      </div>
    </div>`
    : "";
  return `<details class="design-narrow" data-source="${escapeHtml(source.id)}" data-stream="${escapeHtml(stream.name)}">
    <summary class="design-narrow-summary">${escapeHtml(summaryParts.join(" · "))}</summary>
    <div class="design-narrow-body">
      <div>
        <p class="design-narrow-title">Fields</p>
        <div class="design-fields">${fields.join("")}</div>
      </div>
      ${dateBlock}
    </div>
  </details>`;
}

function renderStream(source: MockSource, stream: MockStream): string {
  const checked = stream.selected ? " checked" : "";
  return `<li class="design-stream">
  <label class="design-stream-check">
    <input type="checkbox"${checked} />
    <span class="design-stream-body">
      <span class="design-stream-label">${escapeHtml(stream.label)}</span>
      <span class="design-stream-sentence">${escapeHtml(stream.sentence)}</span>
    </span>
  </label>
  ${stream.selected ? renderNarrowing(source, stream) : ""}
</li>`;
}

// The tri-state parent checkbox does the job the 54 per-source buttons were
// doing, so there is no per-source button pair and no paragraph teaching the
// owner how a checkbox works.
function renderSource(source: MockSource): string {
  const selectedCount = source.streams.filter((stream) => stream.selected).length;
  const total = source.streams.length;
  const allSelected = selectedCount === total;
  const open = selectedCount > 0;
  const count = selectedCount > 0 ? `${selectedCount} of ${total} data types` : `${total} data types`;
  let checkboxState = "";
  if (allSelected) {
    checkboxState = " checked";
  } else if (selectedCount > 0) {
    checkboxState = ` data-indeterminate="true"`;
  }
  return `<li class="design-source-item"><details class="design-source"${open ? " open" : ""}>
  <summary class="design-source-row">
    <span class="design-source-check">
      <input type="checkbox"${checkboxState} aria-label="Share data from ${escapeHtml(source.name)}" />
      <span class="design-source-text">
        <span class="design-source-name">${escapeHtml(source.name)}</span>
        <span class="design-source-account">${escapeHtml(source.account)}</span>
      </span>
    </span>
    <span class="design-source-count">${escapeHtml(count)}</span>
    <span class="design-disclosure" role="presentation">${CHEVRON}</span>
  </summary>
  <ul class="design-streams">
    ${source.streams.map((stream) => renderStream(source, stream)).join("\n")}
  </ul>
</details></li>`;
}

// The review panel IS the approval artifact: the exact decision, not the menu
// of choices (spec-core.md:873-877). In the real screen the digest is computed
// over exactly this summary and its absence fails closed. Here it renders
// static, because this route binds nothing.
function renderReview(selection: Selection): string {
  const { selectedSources, selectedStreamCount } = selection;
  if (selectedStreamCount === 0) {
    return `<p class="design-review-empty">Nothing selected yet.</p>`;
  }
  const sourceRows = selectedSources
    .map((source) => {
      const streams = source.streams.filter((stream) => stream.selected);
      const detail = streams
        .map((stream) => {
          const parts = [stream.label, fieldSummary(stream)];
          const time = timeSummary(stream);
          if (time) {
            parts.push(time);
          }
          return escapeHtml(parts.join(" · "));
        })
        .join("<br />");
      return `<div class="design-review-source">
        <span class="design-review-source-name">${escapeHtml(source.name)}</span>
        <span class="design-review-streams"> — ${escapeHtml(source.account)}</span>
        <div class="design-review-streams">${detail}</div>
      </div>`;
    })
    .join("\n");
  return `<div class="design-review-row">
    <span class="design-review-label">App</span>
    <span class="design-review-value">${escapeHtml(CLIENT.name)} · ${escapeHtml(CLIENT.domain)}</span>
  </div>
  <div class="design-review-row">
    <span class="design-review-label">Data</span>
    <span class="design-review-value">${selectedStreamCount} data types from ${selectedSources.length} sources</span>
    ${sourceRows}
  </div>
  <div class="design-review-row">
    <span class="design-review-label">Duration</span>
    <span class="design-review-value">Ongoing access</span>
  </div>
  <div class="design-review-row">
    <span class="design-review-label">Ends</span>
    <span class="design-review-value">1 December 2026</span>
  </div>
  <div class="design-review-row">
    <span class="design-review-label">Retention</span>
    <span class="design-review-value">${escapeHtml(CLIENT.name)} made no retention promise</span>
  </div>`;
}

function renderConsent(verified: boolean): string {
  const selection = computeSelection();
  const { selectedSources, selectedStreamCount, totalStreamCount } = selection;
  return `${renderIdentity(verified)}
<div>
  <h1 class="design-headline">${escapeHtml(CLIENT.name)} wants to read your data</h1>
  <p class="design-lede">Choose what it can read. Anything you leave unchecked stays private.</p>
</div>
<div class="design-columns">
  <div class="design-main">
    ${renderTerms()}
    <section class="design-section">
      <div class="design-section-head">
        <h2 class="design-section-title">What ${escapeHtml(CLIENT.name)} can read</h2>
        <span class="design-counter">${selectedSources.length} sources · ${selectedStreamCount} of ${totalStreamCount} streams</span>
      </div>
      <input class="design-search" type="search" placeholder="Search sources" aria-label="Search sources" />
      <ul class="design-sources">
        ${SOURCES.map((source) => renderSource(source)).join("\n")}
      </ul>
    </section>
    ${renderDuration()}
  </div>
  <aside class="design-review" aria-label="What you're allowing">
    <div class="design-review-head"><h2 class="design-review-title">What you're allowing</h2></div>
    <div class="design-review-body">${renderReview(selection)}</div>
    <div class="design-actions">
      <a class="design-btn" data-variant="human" href="/_ref/design/consent?state=receipt">Allow access</a>
      <a class="design-btn" href="/_ref/design/consent?state=deny">Cancel</a>
      <p class="design-footnote">You'll return to ${escapeHtml(CLIENT.domain)}</p>
    </div>
  </aside>
</div>`;
}

// ─── The other screens ───────────────────────────────────────────────────────

function renderTerminal({
  actions,
  body,
  title,
  tone,
}: {
  actions?: string;
  body: string;
  title: string;
  tone: "success" | "neutral" | "danger";
}): string {
  const glyphs = { danger: "!", neutral: "—", success: "✓" } as const;
  const glyph = glyphs[tone];
  return `<section class="design-terminal">
  <span class="design-terminal-mark" data-tone="${tone}" aria-hidden="true">${glyph}</span>
  <h1 class="design-terminal-title">${escapeHtml(title)}</h1>
  <p class="design-terminal-body">${escapeHtml(body)}</p>
  ${actions ?? ""}
</section>`;
}

// Declining is not an error, so it is not dressed as one. The real screen also
// redirects to the client with `error=access_denied` (RFC 6749 §4.1.2.1); this
// preview only shows what the owner sees.
function renderDeny(): string {
  return renderTerminal({
    actions: `<div class="design-terminal-actions"><a class="design-btn" href="/_ref/design/consent">Back to the preview</a></div>`,
    body: `${CLIENT.name} didn't get any of your data. You can close this tab.`,
    title: "You didn't share anything",
    tone: "neutral",
  });
}

// Replaces one of the ~30 failures that return raw JSON to the browser today.
function renderError(): string {
  return renderTerminal({
    actions: `<div class="design-terminal-actions"><a class="design-btn" href="/_ref/design/consent">Back to the preview</a></div>`,
    body: "Something went wrong on your server. Nothing was shared.",
    title: "Nothing was shared",
    tone: "danger",
  });
}

// The OAuth path shows the owner no receipt at all today — the redirect is a
// bare 302. This is what an owner-facing record would look like.
function renderReceipt(providerName: string): string {
  const selection = computeSelection();
  const rows = selection.selectedSources
    .map((source) => {
      const streams = source.streams.filter((stream) => stream.selected).map((stream) => stream.label);
      return `<div class="design-review-row">
      <span class="design-review-label">${escapeHtml(source.name)}</span>
      <span class="design-review-value">${escapeHtml(streams.join(", "))} — ${escapeHtml(source.account)}</span>
    </div>`;
    })
    .join("\n");
  return `<section class="design-terminal" style="max-width:560px">
  <span class="design-terminal-mark" data-tone="success" aria-hidden="true">✓</span>
  <h1 class="design-terminal-title">${escapeHtml(CLIENT.name)} can now read what you chose</h1>
  <p class="design-terminal-body">Ongoing access, ending 1 December 2026. ${escapeHtml(CLIENT.name)} made no retention promise.</p>
  <div class="design-receipt-rows">${rows}</div>
  <div class="design-terminal-actions">
    <a class="design-btn" href="/_ref/design/consent">Back to the preview</a>
  </div>
  <p class="design-footnote">Returning you to ${escapeHtml(CLIENT.domain)}. This record stays on ${escapeHtml(providerName)}.</p>
</section>`;
}

function renderSignin(providerName: string): string {
  return `<section class="design-signin">
  <div>
    <h1 class="design-terminal-title">Sign in to ${escapeHtml(providerName)}</h1>
    <p class="design-terminal-body">${escapeHtml(CLIENT.name)} is asking to read your data. Sign in to decide what it can see.</p>
  </div>
  <div class="design-field-block">
    <label for="design-owner-password">Owner password</label>
    <input class="design-input" id="design-owner-password" type="password" autocomplete="current-password" />
  </div>
  <a class="design-btn" data-variant="human" href="/_ref/design/consent">Sign in</a>
  <p class="design-footnote">You'll come back to this request after you sign in.</p>
</section>`;
}

// ─── Mount ───────────────────────────────────────────────────────────────────

type DesignState = "consent" | "deny" | "error" | "receipt" | "signin";

function parseState(value: unknown): DesignState {
  return value === "deny" || value === "error" || value === "receipt" || value === "signin" ? value : "consent";
}

// GET /_ref/design/consent
export function mountRefDesignConsentMock(app: AppLike, ctx: MountRefDesignConsentMockContext): void {
  app.get("/_ref/design/consent", ctx.requireOwnerSession, (req: RouteRequest, res: RouteResponse) => {
    const { providerName } = ctx;
    const state = parseState(req.query?.state);
    const forceMobile = req.query?.width === "mobile";
    const verified = req.query?.trust === "verified";

    let body: string;
    let title: string;
    switch (state) {
      case "deny":
        body = renderDeny();
        title = `${providerName} — Nothing shared`;
        break;
      case "error":
        body = renderError();
        title = `${providerName} — Nothing shared`;
        break;
      case "receipt":
        body = renderReceipt(providerName);
        title = `${providerName} — Access granted`;
        break;
      case "signin":
        body = renderSignin(providerName);
        title = `${providerName} — Sign in`;
        break;
      default:
        body = renderConsent(verified);
        title = `${providerName} — ${CLIENT.name} wants to read your data`;
        break;
    }

    res.setHeader("Cache-Control", "no-store");
    res.send(renderDocument({ body, forceMobile, providerName, title }));
  });
}
