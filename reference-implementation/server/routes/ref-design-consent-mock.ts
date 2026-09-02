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
// Design-system posture (owner feedback round 2, item 8): this route does
// NOT define a bespoke stylesheet with its own class vocabulary. It composes
// the SAME semantic component classes `hosted-ui.ts` already exports for
// every other hosted page (`.hosted-ui-surface`, `.hosted-ui-option`,
// `.hosted-ui-client-identity`, `.hosted-ui-button`, etc.), loaded from the
// same `/__pdpp/hosted-ui.css` these pages already share. `CONSENT_LAYOUT_CSS`
// below adds only the structural rules hosted-ui.ts has no equivalent for — a
// sticky two-column decision rail and its mobile collapse — and every value
// in it is a `var(--token)` reference into that same shared sheet. Zero new
// colors, zero new radii, zero bespoke palette.
//
// Variants, all reachable by URL:
//   /_ref/design/consent                    — the consent screen (desktop)
//   /_ref/design/consent?width=mobile       — the mobile rendering
//   /_ref/design/consent?trust=unverified   — monogram, self-reported (default)
//   /_ref/design/consent?trust=domain       — CIMD domain-verified: automatic,
//                                             no client participation, proxied
//                                             cached logo (spec-core.md:672's
//                                             "trust-registry metadata" tier
//                                             reached via automatic domain
//                                             control rather than an operator)
//   /_ref/design/consent?trust=verified     — operator allowlist / trust
//                                             registry membership: a human
//                                             action, the strongest signal,
//                                             rendered distinctly per
//                                             spec-core.md:675
//   /_ref/design/consent?state=signin       — owner sign-in
//   /_ref/design/consent?state=deny         — the owner cancelled
//   /_ref/design/consent?state=error        — a terminal server error
//   /_ref/design/consent?state=receipt      — the post-approval receipt
//   /_ref/design/consent?theme=dark         — force dark mode for review
//
// Auth posture: owner session, same as every other `/_ref/` surface. This is
// an internal design surface, not a PDPP protocol surface.

import {
  escapeHtml,
  HOSTED_UI_CSS_PATH,
  normalizeHostedThemeChoice,
  renderPdppMark,
} from "../hosted-ui.ts";
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
  // only while unverified; domain-verified and verified clients render their
  // (mock, proxied) logo instead.
  monogram: "CH",
  name: "ChatGPT",
} as const;

// Only sources with a real bundled connector icon (server/assets/source-icons,
// served by `ref-design-consent-icons.ts`) appear here; every other mock
// source falls back to the neutral placeholder rendered inline below — never
// initials where no real logo exists, per owner feedback round 1 item 7.
const SOURCE_ICONS: Record<string, string> = {
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
  // This is the DATA TIME RANGE axis (StreamGrant.time_constraint) — distinct
  // from grant validity (Grant.expires_at), which lives only in the rail.
  readonly timePhrase?: string;
  readonly timeSince?: string;
  readonly timeUntil?: string;
}

interface MockSource {
  readonly account: string;
  readonly id: string;
  readonly name: string;
  readonly streams: readonly MockStream[];
}

// 27 sources. The three that carry a selection are first, so the design's
// populated states — partial selection, narrowed fields, a date bound — are
// visible without interacting. The owner's own worked example (round 2, item
// 12) is a CPA reading 2025 transaction data across several sources for a
// grant that only lasts 30 days, so Chase/YNAB carry a 2025 range here.
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

// "All 12 fields" / "4 of 12 fields", per §4.2.
function fieldSummary(stream: MockStream): string {
  return stream.fieldsSelected === undefined
    ? `All ${stream.fieldsTotal} fields`
    : `${stream.fieldsSelected} of ${stream.fieldsTotal} fields`;
}

// DATA TIME RANGE (StreamGrant.time_constraint) — distinct from grant
// validity (Grant.expires_at), which never appears in this function or in
// the source-list body at all; it lives only in the decision rail.
function dataRangeSummary(stream: MockStream): string | null {
  if (!stream.timePhrase) {
    return null;
  }
  if (stream.timeSince && stream.timeUntil) {
    return `Data from ${stream.timeSince} to ${stream.timeUntil}`;
  }
  if (stream.timeSince) {
    return `Data from ${stream.timeSince} onward`;
  }
  return "All dates";
}

function iconMarkup(sourceId: string, sourceName: string): string {
  const file = SOURCE_ICONS[sourceId];
  if (file) {
    return `<img class="consent-source-icon" src="/_ref/design/consent/icons/${escapeHtml(file)}" alt="" width="24" height="24" />`;
  }
  // Neutral placeholder — never initials where no real logo exists (owner
  // feedback round 1, item 7). A plain muted square, not a monogram: a
  // monogram claims to BE the identity; this only marks "no icon on file."
  return `<span class="consent-source-icon consent-source-icon-placeholder" role="img" aria-label="${escapeHtml(sourceName)}"><svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/></svg></span>`;
}

// ─── Layout-only CSS ──────────────────────────────────────────────────────────
//
// Structural rules `hosted-ui.ts`'s shared sheet has no equivalent for: a
// sticky two-column decision rail and its mobile collapse to a fixed bottom
// bar. Every color/spacing/radius value below is a `var(--token)` reference
// into the SAME token set `/__pdpp/hosted-ui.css` defines — no hardcoded
// oklch/hex, no parallel palette (owner feedback round 2, item 8).
const CONSENT_LAYOUT_CSS = `
/* hosted-ui.ts's shared .hosted-ui-page caps at 640px for the single-column
 * live pages (device/owner-login/etc). This route's two-column decision-rail
 * composition needs more room; widen only here, only this one property. */
.consent-page {
  max-width: 960px;
}
.consent-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 336px;
  gap: 2rem;
  align-items: start;
}
.consent-body {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
  min-width: 0;
}
.consent-rail {
  position: sticky;
  top: 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.consent-rail-summary {
  font-size: 0.875rem;
  color: var(--foreground);
  line-height: 1.5;
}
.consent-rail-summary strong {
  font-variant-numeric: tabular-nums;
}

/* Grant validity — the ONE date global to the grant (Grant.expires_at). Lives
 * only here, in the rail, never in the per-stream body (see
 * .consent-stream-range below, which is deliberately a different class). */
.consent-grant-expiry {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding-top: 0.75rem;
  border-top: 1px solid var(--border);
}
.consent-grant-expiry-label { font-size: 0.75rem; font-weight: 500; color: var(--muted-foreground); }
.consent-grant-expiry-row { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
.consent-grant-expiry-row input[type="date"] {
  font: inherit;
  padding: 0.5rem 0.625rem;
  border: 1px solid var(--input);
  border-radius: var(--radius-control);
  background: var(--card);
  color: var(--foreground);
}
.consent-grant-expiry-row input[type="date"]:disabled {
  color: var(--muted-foreground);
  background: var(--muted);
}
.consent-no-end-date { display: flex; align-items: center; gap: 0.5rem; font-size: 0.8125rem; color: var(--muted-foreground); }
.consent-chip {
  padding: 0.3125rem 0.625rem;
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  background: transparent;
  color: var(--foreground);
  font: inherit;
  font-size: 0.75rem;
  cursor: pointer;
}
.consent-chip[aria-pressed="true"] { border-color: var(--human); background: var(--human-tint); color: var(--human); font-weight: 500; }
.consent-rail-ends {
  font-size: 0.8125rem;
  color: var(--muted-foreground);
}

.consent-rail-actions { display: flex; flex-direction: column; gap: 0.5rem; }

/* Source list search */
.consent-search-row { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.5rem; position: relative; }
.consent-search-row input[type="search"] {
  flex: 1 1 auto;
  font: inherit;
  padding: 0.625rem 2.25rem 0.625rem 0.75rem;
  border: 1px solid var(--input);
  border-radius: var(--radius-control);
  background: var(--card);
  color: var(--foreground);
}
/* Suppress the browser's own native search-cancel glyph — this route renders
 * its own clear button (.consent-search-clear) with count/empty-state wiring
 * the native control doesn't have, so both showing at once is redundant. */
.consent-search-row input[type="search"]::-webkit-search-cancel-button { display: none; }
.consent-search-clear {
  position: absolute;
  right: 0.5rem;
  display: none;
  align-items: center;
  justify-content: center;
  width: 1.5rem;
  height: 1.5rem;
  border: none;
  background: transparent;
  color: var(--muted-foreground);
  cursor: pointer;
}
.consent-search-clear[data-visible="true"] { display: inline-flex; }
.consent-search-count { font-size: 0.75rem; color: var(--muted-foreground); margin-bottom: 0.5rem; }
.consent-search-empty { display: none; font-size: 0.8125rem; color: var(--muted-foreground); padding: 0.75rem 0; }
.consent-search-empty[data-visible="true"] { display: block; }
.consent-source-row[data-hidden="true"] { display: none; }
.consent-source-row[data-active="true"] { outline: 2px solid var(--primary); outline-offset: -2px; }

.consent-source-icon {
  flex: 0 0 auto;
  width: 24px;
  height: 24px;
  border-radius: var(--radius-control);
  object-fit: contain;
}
.consent-source-icon-placeholder {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--muted-foreground);
  background: var(--muted);
}

/* Per-stream disclosure: field picker + DATA TIME RANGE (distinct axis from
 * grant validity above). Expands in place, never a modal. */
.consent-narrow-summary {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  font-size: 0.75rem;
  color: var(--muted-foreground);
  cursor: pointer;
  list-style: none;
}
.consent-narrow-summary::-webkit-details-marker { display: none; }
.consent-narrow-change {
  color: var(--primary);
  border-bottom: 1px solid currentColor;
}
.consent-narrow-body {
  margin-top: 0.5rem;
  padding: 0.75rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--muted);
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.consent-fields { display: flex; flex-wrap: wrap; gap: 0.375rem 1rem; }
.consent-field { display: inline-flex; align-items: center; gap: 0.375rem; font-size: 0.75rem; }
.consent-field[data-required="true"] { color: var(--muted-foreground); }
.consent-stream-range { display: flex; flex-wrap: wrap; gap: 0.375rem; align-items: center; }
.consent-stream-range input[type="date"] {
  font: inherit;
  font-size: 0.75rem;
  padding: 0.25rem 0.5rem;
  border: 1px solid var(--input);
  border-radius: var(--radius-control);
  background: var(--card);
  color: var(--foreground);
}
.consent-range-apply-all {
  align-self: flex-start;
  padding: 0.25rem 0.5rem;
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  background: transparent;
  color: var(--primary);
  font: inherit;
  font-size: 0.6875rem;
  cursor: pointer;
}

/* Terminal-state pages reuse .hosted-ui-result; nothing new needed there. */

/* Default (desktop): the grant-validity control lives only in the rail, so
 * this near-top-of-body copy stays hidden. Declared BEFORE the mobile media
 * query below — cascade order matters here, since both rules target the same
 * selector at equal specificity and the later one wins regardless of which
 * is inside a media query. .consent-rail-mobile-summary is the rail's own
 * one-line echo of "Access ends" for the mobile sticky bar — on desktop the
 * full .consent-grant-expiry block already shows that date, so this must
 * default to hidden too or the rail says "Access ends <date>" twice. */
.consent-mobile-expiry,
.consent-rail-mobile-summary { display: none; }

/* ─── Mobile: rail collapses to a fixed bottom bar ────────────────────────
 * \`fixed\`, not \`sticky\`: the rail's own content is far shorter than the
 * single-column page once the source list is above it, so a sticky child
 * would stick only within its own (already-scrolled-past) box. \`fixed\`
 * escapes document flow, matching what "reachable no matter where you
 * scroll" requires. \`.consent-body\` gets matching bottom padding so nothing
 * — including the Retention text — renders underneath it (owner feedback
 * round 2, item 11). */
@media (max-width: 899px) {
  .consent-grid { grid-template-columns: minmax(0, 1fr); gap: 1.5rem; }
  .consent-rail {
    position: fixed;
    left: 0; right: 0; bottom: 0;
    top: auto;
    padding: 0.625rem 1rem 0.75rem;
    background: var(--card);
    border-top: 1px solid var(--border);
    z-index: 10;
    gap: 0.5rem;
  }
  .consent-rail-summary,
  .consent-grant-expiry { display: none; }
  .consent-rail-mobile-summary {
    display: block;
    font-size: 0.75rem;
    color: var(--muted-foreground);
    text-align: center;
  }
  .consent-rail-actions { flex-direction: row; }
  .consent-rail-actions .hosted-ui-button { flex: 1 1 0; }
  .consent-body { padding-bottom: 6.5rem; }
  /* The grant-validity date INPUT itself stays reachable in normal flow near
   * the top of the mobile body — only its rail copy is hidden above. */
  .consent-mobile-expiry { display: block; }
}

/* \`?width=mobile\` forces the same rules at any viewport for screenshot
 * review on desktop. */
.consent-force-mobile .consent-grid { grid-template-columns: minmax(0, 1fr); gap: 1.5rem; }
.consent-force-mobile .consent-rail {
  position: fixed;
  left: 0; right: 0; bottom: 0;
  top: auto;
  padding: 0.625rem 1rem 0.75rem;
  background: var(--card);
  border-top: 1px solid var(--border);
  z-index: 10;
  gap: 0.5rem;
}
.consent-force-mobile .consent-rail-summary,
.consent-force-mobile .consent-grant-expiry { display: none; }
.consent-force-mobile .consent-rail-mobile-summary {
  display: block;
  font-size: 0.75rem;
  color: var(--muted-foreground);
  text-align: center;
}
.consent-force-mobile .consent-rail-actions { flex-direction: row; }
.consent-force-mobile .consent-rail-actions .hosted-ui-button { flex: 1 1 0; }
.consent-force-mobile .consent-body { padding-bottom: 6.5rem; }
.consent-force-mobile .consent-mobile-expiry { display: block; }
.consent-force-mobile .hosted-ui-page { max-width: 420px; }

/* ─── Preview chrome ───────────────────────────────────────────────────── */
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

// Client-side behavior only: tri-state parent checkbox, keyboard-navigable
// search filter, and the grant-validity / apply-to-all-ranges wiring. Reads
// and writes only this page's own DOM state; submits nothing.
const CONSENT_SCRIPT = `
(function () {
  // ─── Tri-state parent checkbox per source ──────────────────────────────
  var sources = document.querySelectorAll(".consent-source-row");
  sources.forEach(function (source) {
    var parent = source.querySelector(".hosted-ui-option-source-legend input");
    var children = source.querySelectorAll(".consent-stream-check input");
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

  // ─── Search filter: type-ahead, keyboard nav, clear, count, empty state ──
  var input = document.querySelector(".consent-search-row input[type=search]");
  var clearBtn = document.querySelector(".consent-search-clear");
  var countEl = document.querySelector(".consent-search-count");
  var emptyEl = document.querySelector(".consent-search-empty");
  var rows = Array.prototype.slice.call(document.querySelectorAll(".consent-source-row"));
  var activeIndex = -1;

  function rowText(row) {
    return (row.getAttribute("data-search-text") || "").toLowerCase();
  }

  function applyFilter() {
    var query = (input.value || "").trim().toLowerCase();
    clearBtn.setAttribute("data-visible", query.length > 0 ? "true" : "false");
    var visible = [];
    rows.forEach(function (row) {
      var match = query.length === 0 || rowText(row).indexOf(query) !== -1;
      row.setAttribute("data-hidden", match ? "false" : "true");
      row.setAttribute("data-active", "false");
      if (match) visible.push(row);
    });
    activeIndex = -1;
    countEl.textContent = query.length === 0
      ? visible.length + " sources"
      : visible.length + " of " + rows.length + " sources match";
    emptyEl.setAttribute("data-visible", visible.length === 0 ? "true" : "false");
    emptyEl.textContent = "No sources match \\u201c" + input.value + "\\u201d. Clear the search to see everything.";
  }

  function visibleRows() {
    return rows.filter(function (row) { return row.getAttribute("data-hidden") !== "true"; });
  }

  function setActive(index) {
    var visible = visibleRows();
    visible.forEach(function (row) { row.setAttribute("data-active", "false"); });
    if (index < 0 || index >= visible.length) { activeIndex = -1; return; }
    activeIndex = index;
    visible[index].setAttribute("data-active", "true");
    visible[index].scrollIntoView({ block: "nearest" });
  }

  if (input) {
    input.addEventListener("input", applyFilter);
    input.addEventListener("keydown", function (event) {
      var visible = visibleRows();
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActive(activeIndex + 1 >= visible.length ? 0 : activeIndex + 1);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setActive(activeIndex <= 0 ? visible.length - 1 : activeIndex - 1);
      } else if (event.key === "Enter" && activeIndex >= 0) {
        event.preventDefault();
        var checkbox = visible[activeIndex].querySelector(".hosted-ui-option-source-legend input");
        if (checkbox) checkbox.click();
      } else if (event.key === "Escape") {
        input.value = "";
        applyFilter();
      }
    });
    applyFilter();
  }
  if (clearBtn) {
    clearBtn.addEventListener("click", function () {
      input.value = "";
      applyFilter();
      input.focus();
    });
  }

  // ─── Grant validity: date input + no-end-date + quick-fill chips ────────
  var expiryInputs = document.querySelectorAll("input[data-role=grant-expiry-date]");
  var noEndInputs = document.querySelectorAll("input[data-role=grant-no-end-date]");
  var chips = document.querySelectorAll(".consent-chip[data-days]");
  var railEndsEls = document.querySelectorAll("[data-role=rail-ends-summary]");

  function todayPlusDays(days) {
    var d = new Date();
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }

  function updateEndsSummary() {
    var noEnd = noEndInputs[0] && noEndInputs[0].checked;
    var text = noEnd ? "No end date" : "Access ends " + (expiryInputs[0] ? expiryInputs[0].value : "");
    railEndsEls.forEach(function (el) { el.textContent = text; });
  }

  function setExpiryDate(value) {
    expiryInputs.forEach(function (el) { el.value = value; });
    updateEndsSummary();
  }

  chips.forEach(function (chip) {
    chip.addEventListener("click", function () {
      chips.forEach(function (c) { c.setAttribute("aria-pressed", "false"); });
      chip.setAttribute("aria-pressed", "true");
      noEndInputs.forEach(function (el) { el.checked = false; });
      expiryInputs.forEach(function (el) { el.disabled = false; });
      setExpiryDate(todayPlusDays(Number(chip.getAttribute("data-days"))));
    });
  });
  expiryInputs.forEach(function (el) {
    el.addEventListener("input", function () {
      chips.forEach(function (c) { c.setAttribute("aria-pressed", "false"); });
      updateEndsSummary();
    });
  });
  noEndInputs.forEach(function (el) {
    el.addEventListener("change", function () {
      expiryInputs.forEach(function (input) { input.disabled = el.checked; });
      chips.forEach(function (c) { c.setAttribute("aria-pressed", "false"); });
      updateEndsSummary();
    });
  });
  updateEndsSummary();

  // ─── Per-stream data range: "apply to all selected" copies dates ────────
  document.querySelectorAll(".consent-range-apply-all").forEach(function (button) {
    button.addEventListener("click", function () {
      var since = button.getAttribute("data-since");
      var until = button.getAttribute("data-until");
      var allSourceRows = document.querySelectorAll(".consent-source-row");
      allSourceRows.forEach(function (row) {
        row.querySelectorAll(".consent-stream-check input:checked").forEach(function (checkbox) {
          var stream = checkbox.closest(".hosted-ui-stream-option");
          if (!stream) return;
          var sinceInput = stream.querySelector("input[data-role=range-since]");
          var untilInput = stream.querySelector("input[data-role=range-until]");
          if (sinceInput && since) sinceInput.value = since;
          if (untilInput && until) untilInput.value = until;
        });
      });
    });
  });

  // Disclosure toggles the visible "Change"/"Done" label.
  document.querySelectorAll(".consent-narrow").forEach(function (details) {
    var label = details.querySelector(".consent-narrow-change");
    function sync() {
      if (label) label.textContent = details.open ? "Done" : "Change";
    }
    details.addEventListener("toggle", sync);
    sync();
  });
})();
`;

function renderDocument({
  body,
  forceMobile,
  providerName,
  theme,
  title,
}: {
  body: string;
  forceMobile: boolean;
  providerName: string;
  theme: "light" | "dark" | "system";
  title: string;
}): string {
  const bodyClass = forceMobile ? ' class="consent-force-mobile"' : "";
  const markSurface = theme === "dark" ? "dark" : "light";
  return `<!DOCTYPE html>
<html lang="en" data-theme="${theme}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="${HOSTED_UI_CSS_PATH}" />
<style>${CONSENT_LAYOUT_CSS}</style>
</head>
<body${bodyClass}>
${renderPreviewBanner()}
<main class="hosted-ui-page consent-page">
<header class="hosted-ui-header"><span class="hosted-ui-provider">${escapeHtml(providerName)}</span></header>
${body}
<footer class="hosted-ui-footer">
  <a class="hosted-ui-footer-attribution-link" href="https://pdpp.dev">
  ${renderPdppMark({ size: 14, surface: markSurface })}
  <span class="hosted-ui-footer-attribution">Secured by PDPP</span>
  </a>
</footer>
</main>
<script>${CONSENT_SCRIPT}</script>
</body>
</html>`;
}

function renderPreviewBanner(): string {
  return `<div class="design-banner">Design preview — mock data, nothing here is submitted. Variants:
<a href="/_ref/design/consent">consent</a> ·
<a href="/_ref/design/consent?width=mobile">mobile</a> ·
<a href="/_ref/design/consent?trust=domain">domain-verified</a> ·
<a href="/_ref/design/consent?trust=verified">verified</a> ·
<a href="/_ref/design/consent?theme=dark">dark</a> ·
<a href="/_ref/design/consent?state=signin">sign-in</a> ·
<a href="/_ref/design/consent?state=deny">cancelled</a> ·
<a href="/_ref/design/consent?state=error">error</a> ·
<a href="/_ref/design/consent?state=receipt">receipt</a></div>`;
}

// ─── The consent screen ──────────────────────────────────────────────────────

type TrustTier = "unverified" | "domain" | "verified";

// Three tiers, per spec-core.md:672's resolution precedence (local
// registration/trust-registry, then software-statement metadata, then inline
// client_display, then client_id fallback) and :675 (a positive trust signal
// MUST render distinctly from "no signal"):
//   unverified — no signal resolved. Monogram only (spec-core.md:676: never
//     fetch/render a client-supplied logo for an unverified client).
//   domain — CIMD: the AS fetched a metadata document from the client_id's
//     own origin over HTTPS and it was self-consistent. Automatic, requires
//     NO participation from the client itself. Renders a proxied/cached logo.
//   verified — an operator explicitly registered/allowlisted this client
//     (trust-registry membership). A human action, the strongest tier;
//     renders a distinct badge in addition to the logo.
function renderIdentity(trust: TrustTier): string {
  let logo: string;
  let trustLine: string;
  if (trust === "unverified") {
    logo = `<span class="hosted-ui-client-monogram" aria-hidden="true">${escapeHtml(CLIENT.monogram)}</span>`;
    trustLine = `<p class="hosted-ui-client-trust">This app isn't registered with your server. Its name and logo are self-reported.</p>`;
  } else if (trust === "domain") {
    logo = `<img class="hosted-ui-client-monogram" src="/_ref/design/consent/icons/chatgpt.svg" alt="" width="40" height="40" />`;
    trustLine = `<p class="hosted-ui-client-trust">${escapeHtml(CLIENT.domain)}'s own metadata confirms this app's identity. This check ran automatically — ${escapeHtml(CLIENT.name)} did not need to do anything.</p>`;
  } else {
    logo = `<img class="hosted-ui-client-monogram" src="/_ref/design/consent/icons/chatgpt.svg" alt="" width="40" height="40" />`;
    trustLine = `<p class="hosted-ui-client-trust" data-trust="registered">An operator registered this app with your server.</p>`;
  }
  return `<section class="hosted-ui-client-identity">
  ${logo}
  <div class="hosted-ui-client-identity-body">
    <span class="hosted-ui-client-identity-name">${escapeHtml(CLIENT.name)}</span>
    <span class="hosted-ui-client-identity-domain">${escapeHtml(CLIENT.domain)}</span>
    ${trustLine}
  </div>
</section>`;
}

function renderTerms(): string {
  return `<section class="hosted-ui-surface" data-surface="protocol">
  <h2 class="pdpp-title">Terms</h2>
  <p class="pdpp-body">${escapeHtml(`Purpose: set by this server because ${CLIENT.name} didn't give one — use the data you select as context for your AI assistant.`)}</p>
  <p class="pdpp-body">Retention: ${escapeHtml(CLIENT.name)} did not say how long it keeps the data it receives.</p>
</section>`;
}

function renderStreamNarrowing(source: MockSource, stream: MockStream): string {
  const checkedFields = stream.fieldsSelected ?? stream.fieldsTotal;
  const fields: string[] = [];
  for (let index = 0; index < stream.fieldsTotal; index += 1) {
    const required = index < 2;
    const checked = required || index < checkedFields;
    fields.push(
      `<label class="consent-field" data-required="${required}">` +
        `<input type="checkbox"${checked ? " checked" : ""}${required ? " disabled" : ""} />` +
        `<span>field_${index + 1}${required ? " (required)" : ""}</span>` +
        "</label>"
    );
  }
  const rangeBlock = stream.timePhrase
    ? `<div class="consent-stream-range">
      <span class="pdpp-caption">${escapeHtml(dataRangeSummary(stream) ?? "All dates")}</span>
      <label class="pdpp-caption">from <input type="date" data-role="range-since" value="${escapeHtml(stream.timeSince ?? "")}" aria-label="${escapeHtml(stream.timePhrase)} since" /></label>
      <label class="pdpp-caption">to <input type="date" data-role="range-until" value="${escapeHtml(stream.timeUntil ?? "")}" aria-label="${escapeHtml(stream.timePhrase)} until" /></label>
      <button type="button" class="consent-range-apply-all" data-since="${escapeHtml(stream.timeSince ?? "")}" data-until="${escapeHtml(stream.timeUntil ?? "")}">Apply to all selected streams</button>
    </div>`
    : "";
  return `<details class="consent-narrow">
    <summary class="consent-narrow-summary">${escapeHtml(fieldSummary(stream))} <span class="consent-narrow-change">Change</span></summary>
    <div class="consent-narrow-body">
      <div class="consent-fields">${fields.join("")}</div>
      ${rangeBlock}
    </div>
  </details>`;
}

function renderStream(source: MockSource, stream: MockStream): string {
  const checked = stream.selected ? " checked" : "";
  return `<label class="hosted-ui-stream-option consent-stream-check">
  <input type="checkbox"${checked} />
  <span class="hosted-ui-stream-option-body">
    <span>${escapeHtml(stream.label)}</span>
    <span class="pdpp-caption">${escapeHtml(stream.sentence)}</span>
    ${stream.selected ? renderStreamNarrowing(source, stream) : ""}
  </span>
</label>`;
}

function renderSource(source: MockSource): string {
  const selectedCount = source.streams.filter((stream) => stream.selected).length;
  const total = source.streams.length;
  const allSelected = selectedCount === total;
  const checkboxState = allSelected ? " checked" : selectedCount > 0 ? ' data-indeterminate="true"' : "";
  const searchText = [source.name, source.account, ...source.streams.map((s) => `${s.label} ${s.name}`)]
    .join(" ")
    .toLowerCase();
  return `<fieldset class="hosted-ui-option-source consent-source-row" data-search-text="${escapeHtml(searchText)}" data-hidden="false" data-active="false">
  <legend class="hosted-ui-option-source-legend">
    <label class="hosted-ui-option">
      <input type="checkbox"${checkboxState} aria-label="Share data from ${escapeHtml(source.name)}" />
      <span class="hosted-ui-option-body">
        <span class="hosted-ui-option-title">${iconMarkup(source.id, source.name)}<span>${escapeHtml(source.name)}</span><span class="hosted-ui-connection-name">${escapeHtml(source.account)}</span></span>
        <span class="hosted-ui-option-meta">${selectedCount > 0 ? `${selectedCount} of ${total}` : total} data types</span>
      </span>
    </label>
  </legend>
  <div class="hosted-ui-option-streams">
    ${source.streams.map((stream) => renderStream(source, stream)).join("\n")}
  </div>
</fieldset>`;
}

function renderRail(selection: Selection): string {
  const { selectedSources, selectedStreamCount, totalStreamCount } = selection;
  const defaultExpiry = new Date();
  defaultExpiry.setUTCDate(defaultExpiry.getUTCDate() + 90);
  const defaultExpiryValue = defaultExpiry.toISOString().slice(0, 10);
  return `<aside class="consent-rail" aria-label="What you're allowing">
  <div class="consent-rail-summary">
    <strong>${selectedSources.length}</strong> sources · <strong>${selectedStreamCount}</strong> of ${totalStreamCount} streams selected
  </div>
  <p class="consent-rail-mobile-summary"><span data-role="rail-ends-summary">Access ends ${escapeHtml(defaultExpiryValue)}</span> · ${selectedStreamCount} streams</p>

  <div class="consent-grant-expiry">
    <span class="consent-grant-expiry-label">Access duration — how long ${escapeHtml(CLIENT.name)} can read</span>
    <div class="consent-grant-expiry-row">
      <input type="date" data-role="grant-expiry-date" value="${escapeHtml(defaultExpiryValue)}" aria-label="Access ends" />
      <button type="button" class="consent-chip" data-days="90" aria-pressed="true">90 days</button>
      <button type="button" class="consent-chip" data-days="365" aria-pressed="false">1 year</button>
    </div>
    <label class="consent-no-end-date"><input type="checkbox" data-role="grant-no-end-date" /> No end date</label>
    <p class="consent-rail-ends" data-role="rail-ends-summary">Access ends ${escapeHtml(defaultExpiryValue)}</p>
  </div>

  <div class="consent-rail-actions">
    <a class="hosted-ui-button" data-variant="primary" href="/_ref/design/consent?state=receipt">Allow access</a>
    <a class="hosted-ui-button" href="/_ref/design/consent?state=deny">Cancel</a>
  </div>
  <p class="hosted-ui-footnote">You'll return to ${escapeHtml(CLIENT.domain)}</p>
</aside>`;
}

function renderConsent(trust: TrustTier): string {
  const selection = computeSelection();
  const defaultExpiry = new Date();
  defaultExpiry.setUTCDate(defaultExpiry.getUTCDate() + 90);
  const defaultExpiryValue = defaultExpiry.toISOString().slice(0, 10);
  return `${renderIdentity(trust)}
<h1 class="pdpp-heading">${escapeHtml(CLIENT.name)} wants to read your data</h1>
<p class="pdpp-body-lg">Choose what it can read. Anything you leave unchecked stays private.</p>

<div class="consent-mobile-expiry hosted-ui-surface">
  <span class="consent-grant-expiry-label">Access duration — how long ${escapeHtml(CLIENT.name)} can read</span>
  <div class="consent-grant-expiry-row">
    <input type="date" data-role="grant-expiry-date" value="${escapeHtml(defaultExpiryValue)}" aria-label="Access ends" />
    <button type="button" class="consent-chip" data-days="90" aria-pressed="true">90 days</button>
    <button type="button" class="consent-chip" data-days="365" aria-pressed="false">1 year</button>
  </div>
  <label class="consent-no-end-date"><input type="checkbox" data-role="grant-no-end-date" /> No end date</label>
</div>

<div class="consent-grid">
  <div class="consent-body">
    ${renderTerms()}
    <section class="hosted-ui-surface">
      <h2 class="pdpp-title">What ${escapeHtml(CLIENT.name)} can read</h2>
      <div class="consent-search-row">
        <input type="search" placeholder="Search sources" aria-label="Search sources" />
        <button type="button" class="consent-search-clear" aria-label="Clear search" data-visible="false">×</button>
      </div>
      <p class="consent-search-count">${SOURCES.length} sources</p>
      <p class="consent-search-empty" data-visible="false"></p>
      <div class="hosted-ui-option-group">
        ${SOURCES.map((source) => renderSource(source)).join("\n")}
      </div>
    </section>
  </div>
  ${renderRail(selection)}
</div>`;
}

// ─── The other screens ───────────────────────────────────────────────────────

function renderResultPage({
  body,
  glyph,
  title,
  tone,
}: {
  body: string;
  glyph?: string;
  title: string;
  tone: "success" | "neutral" | "danger";
}): string {
  return `<div class="hosted-ui-result">
  <span class="hosted-ui-result-mark" data-tone="${tone}" aria-hidden="true">${escapeHtml(glyph ?? "")}</span>
  <div class="hosted-ui-result-body">
    <span class="pdpp-heading">${escapeHtml(title)}</span>
    <p class="pdpp-body">${body}</p>
    <div class="hosted-ui-decision-actions"><a class="hosted-ui-button" href="/_ref/design/consent">Back to the preview</a></div>
  </div>
</div>`;
}

function renderDeny(): string {
  return renderResultPage({
    body: `${escapeHtml(CLIENT.name)} didn't get any of your data. You can close this tab.`,
    glyph: "—",
    title: "You didn't share anything",
    tone: "neutral",
  });
}

function renderError(): string {
  return renderResultPage({
    body: "Something went wrong on your server. Nothing was shared.",
    glyph: "!",
    title: "Nothing was shared",
    tone: "danger",
  });
}

function renderReceipt(providerName: string): string {
  const selection = computeSelection();
  const rows = selection.selectedSources
    .map((source) => {
      const streams = source.streams.filter((stream) => stream.selected).map((stream) => stream.label);
      return `<div class="hosted-ui-kv">
      <dt>${iconMarkup(source.id, source.name)} ${escapeHtml(source.name)}</dt>
      <dd>${escapeHtml(streams.join(", "))} — ${escapeHtml(source.account)}</dd>
    </div>`;
    })
    .join("\n");
  return `<div class="hosted-ui-result">
  <span class="hosted-ui-result-mark" data-tone="success" aria-hidden="true">✓</span>
  <div class="hosted-ui-result-body">
    <span class="pdpp-heading">${escapeHtml(CLIENT.name)} can now read what you chose</span>
    <p class="pdpp-body">${escapeHtml(CLIENT.name)} made no retention promise.</p>
    ${rows}
    <div class="hosted-ui-decision-actions"><a class="hosted-ui-button" href="/_ref/design/consent">Back to the preview</a></div>
    <p class="hosted-ui-footnote">Returning you to ${escapeHtml(CLIENT.domain)}. This record stays on ${escapeHtml(providerName)}.</p>
  </div>
</div>`;
}

function renderSignin(providerName: string): string {
  return `<section class="hosted-ui-surface">
  <h1 class="pdpp-heading">Sign in to ${escapeHtml(providerName)}</h1>
  <p class="pdpp-body">${escapeHtml(CLIENT.name)} is asking to read your data. Sign in to decide what it can see.</p>
  <div class="hosted-ui-field">
    <label for="design-owner-password">Owner password</label>
    <input class="hosted-ui-field-input" id="design-owner-password" type="password" autocomplete="current-password" />
  </div>
  <a class="hosted-ui-button" data-variant="primary" href="/_ref/design/consent">Sign in</a>
  <p class="hosted-ui-footnote">You'll come back to this request after you sign in.</p>
</section>`;
}

// ─── Mount ───────────────────────────────────────────────────────────────────

type DesignState = "consent" | "deny" | "error" | "receipt" | "signin";

function parseState(value: unknown): DesignState {
  return value === "deny" || value === "error" || value === "receipt" || value === "signin" ? value : "consent";
}

function parseTrust(value: unknown): TrustTier {
  if (value === "domain") {
    return "domain";
  }
  // `?trust=verified` alone (without an intermediate `domain` hop) still
  // resolves to the top tier — a client can be operator-registered without
  // this preview needing to model the domain-check step separately.
  if (value === "verified") {
    return "verified";
  }
  return "unverified";
}

// GET /_ref/design/consent
export function mountRefDesignConsentMock(app: AppLike, ctx: MountRefDesignConsentMockContext): void {
  app.get("/_ref/design/consent", ctx.requireOwnerSession, (req: RouteRequest, res: RouteResponse) => {
    const { providerName } = ctx;
    const state = parseState(req.query?.state);
    const forceMobile = req.query?.width === "mobile";
    const trust = parseTrust(req.query?.trust);
    const theme = normalizeHostedThemeChoice(req.query?.theme);

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
        body = renderConsent(trust);
        title = `${providerName} — ${CLIENT.name} wants to read your data`;
        break;
    }

    res.setHeader("Cache-Control", "no-store");
    res.send(renderDocument({ body, forceMobile, providerName, theme, title }));
  });
}
