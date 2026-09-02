// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
// biome-ignore-all lint/performance/useTopLevelRegex: render assertions intentionally keep regexes next to the semantic assertion.

/**
 * Hosted MCP picker — render-layer regression lock-in.
 *
 * The hosted MCP picker UX (collapsed-by-default sources, bulk affordances,
 * nothing-preselected, no owner-visible URL/placeholder labels, orphaned-stream
 * rejection) was classified by the console functional-gap audit
 * (`tmp/workstreams/ri-console-functional-gap-audit-v1-report.md`, Gap 4) as
 * "Mostly FIXED — already at SLVP", with the explicit residual that **no
 * regression test pins the fixes at the render layer**. The existing coverage
 * proves the behavior through a live `/oauth/authorize` server round-trip
 * (`hosted-mcp-oauth.test.js`); a refactor of the pure HTML builder could
 * regress the UX without a live server in the loop.
 *
 * This suite locks the picker UX directly against the pure render helpers in
 * `server/routes/as-consent-ui-helpers.ts` — `renderHostedMcpSourceSelection`
 * and `listHostedMcpPickerRows` — with no DB and no HTTP. Production
 * primitives (`escapeHtml`, the selection encoders, `hostedMcpSourceKey`,
 * `canonicalConnectorKey`) are wired in exactly as `server/index.js` injects
 * them; only the async store reads and the presentational document wrappers
 * are faked. Assertions target stable semantic hooks (`data-hosted-mcp-*`,
 * `<details>`/`open`, `data-source-selected`) and owner-facing copy rather
 * than brittle whitespace.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { canonicalConnectorKey } from "../server/connector-key.ts";
import {
  encodeHostedMcpSelection,
  encodeHostedMcpStreamSelection,
  hostedMcpSourceKey,
} from "../server/hosted-mcp-selection.ts";
import { escapeHtml, renderKeyValueList } from "../server/hosted-ui.ts";
import {
  ActiveBindingLookupError,
  type ConsentPickerBinding,
  type ConsentPickerCapabilities,
  type ConsentUiRenderer,
  listHostedMcpPickerRows,
  renderHostedMcpSourceSelection,
} from "../server/routes/as-consent-ui-helpers.ts";

// ── Presentational renderer (pass-through) ───────────────────────────────────
// The real document/surface wrappers only add brand chrome around the picker
// body. We keep them as faithful pass-throughs so the inner picker markup —
// the thing every assertion below inspects — is preserved verbatim. Using the
// real `escapeHtml` keeps label-suppression assertions honest.
const ui: ConsentUiRenderer = {
  escapeHtml,
  renderActionRow: (actions) => actions.map((a) => `<button>${escapeHtml(a.label)}</button>`).join("\n"),
  renderHostedDocument: ({ body }) => `<!doctype html><html><body>${body}</body></html>`,
  renderKeyValueList,
  renderPageIntro: ({ title }) => `<h1>${escapeHtml(title)}</h1>`,
  renderResultState: ({ title, body }) => `<div>${escapeHtml(title)}${escapeHtml(body)}</div>`,
  renderSurface: ({ children }) => `<section>${children}</section>`,
};

// ── Fixture connector set ────────────────────────────────────────────────────
// Two registered connectors with URL-shaped ids (the first-party reference
// connectors are `https://registry.pdpp.dev/connectors/<name>`), plus one
// internal connector that the picker MUST skip. Bindings carry deliberately
// adversarial display names to exercise the redundant/placeholder/URL label
// suppression path (`ownerFacingConnectionName`).

const SPOTIFY_ID = "https://registry.pdpp.dev/connectors/spotify";
const GITHUB_ID = "https://registry.pdpp.dev/connectors/github";
const INTERNAL_ID = "pdpp-internal-audit";

interface FixtureManifest {
  display_name: string;
  source_declaration?: { source: { id: string; kind: string } };
  streams: Array<{ name: string; description: string | null }>;
}

const MANIFESTS: Record<string, FixtureManifest> = {
  [SPOTIFY_ID]: {
    display_name: "Spotify",
    source_declaration: { source: { id: SPOTIFY_ID, kind: "connector" } },
    streams: [
      { description: "Tracks you saved", name: "saved_tracks" },
      { description: null, name: "top_artists" },
    ],
  },
  [GITHUB_ID]: {
    display_name: "GitHub",
    source_declaration: { source: { id: GITHUB_ID, kind: "connector" } },
    streams: [
      { description: "Repos you own", name: "repositories" },
      { description: "Repos you starred", name: "starred_repos" },
      { description: null, name: "issues" },
    ],
  },
};

interface FixtureBinding extends ConsentPickerBinding {
  _display: string;
  connectorInstanceId: string;
}

// Bindings keyed by connector id. The display names here are the suppression
// adversaries: a registry URL, a `cin_*` placeholder, and a label that simply
// echoes the connector label. None may surface as an owner-visible connection
// name. Spotify gets one binding with a genuinely useful, distinct name that
// MUST survive.
const BINDINGS: Record<string, FixtureBinding[]> = {
  [SPOTIFY_ID]: [{ _display: "Personal listening", connectorInstanceId: "cin_spotify_1" }],
  [GITHUB_ID]: [
    { _display: "https://registry.pdpp.dev/connectors/github", connectorInstanceId: "cin_github_url" },
    { _display: "cin_github_placeholder", connectorInstanceId: "cin_github_placeholder" },
    { _display: "GitHub", connectorInstanceId: "cin_github_echo" },
  ],
};

// Default fixture: every manifest-declared stream actually holds data for
// every connection, so the pre-existing render assertions (written before
// the picker distinguished "grantable" from "held") keep passing unchanged.
// Tests that exercise the honesty fix override this per-case.
function defaultListStreamsWithRecords({ connectorId }: { connectorId: string }): Promise<string[]> {
  return Promise.resolve((MANIFESTS[connectorId]?.streams ?? []).map((stream) => stream.name));
}

function makeCaps(overrides: Partial<ConsentPickerCapabilities> = {}): ConsentPickerCapabilities {
  return {
    canonicalConnectorKey,
    encodeHostedMcpSelection,
    encodeHostedMcpStreamSelection,
    getConnectorManifest: async (connectorId: string) => MANIFESTS[connectorId] ?? null,
    hostedMcpSourceKey,
    isInternalConnectorId: (connectorId: string) => connectorId === INTERNAL_ID,
    listActiveBindingsForGrant: async ({ connectorId }: { connectorId: string }) => BINDINGS[connectorId] ?? [],
    listRegisteredConnectorIds: async () => [SPOTIFY_ID, GITHUB_ID, INTERNAL_ID],
    listStreamsWithRecords: defaultListStreamsWithRecords,
    projectBindingForWire: (conn) => ({
      connection_id: conn.connectorInstanceId ?? null,
      // biome-ignore lint/suspicious/noUnnecessaryConditions: the runtime fixture intentionally maps absent display names to null.
      display_name: (conn as FixtureBinding)._display ?? null,
    }),
    ...overrides,
  };
}

const AUTHORIZE_QUERY = {
  client_id: "client_demo",
  code_challenge: "a".repeat(43),
  code_challenge_method: "S256",
  redirect_uri: "https://client.example/callback",
  response_type: "code",
  scope: "mcp",
  state: "render-test",
};

function mustExist<T>(value: T | null | undefined, description: string): T {
  assert.ok(value, description);
  return value;
}

// biome-ignore lint/suspicious/useAwait: preserve the async helper contract used by the async render tests.
async function renderPicker(
  caps: ConsentPickerCapabilities = makeCaps(),
  opts: Parameters<typeof renderHostedMcpSourceSelection>[6] = {}
): Promise<string> {
  return renderHostedMcpSourceSelection("owner_local", AUTHORIZE_QUERY, "csrf-token", "PDPP", caps, ui, opts);
}

// A CIMD client whose self-described `client_display.name` ("ChatGPT")
// differs from its verified origin identity ("https://chatgpt.com") — the
// scenario FIX 3's H1 must distinguish (verified origin vs. self-described
// name, never presenting the latter as verified).
const CIMD_CLIENT_SELF_DESCRIBED = {
  client_display: { name: "ChatGPT" },
  client_id: "https://chatgpt.com/oauth/abc123/client.json",
  registration_mode: "client_id_metadata_document",
};

// A pre-registered client with no distinct self-described name beyond its
// registration-time display name — the H1 must fall back to the single-name
// form (no parenthetical) since there is nothing to distinguish.
const PREREGISTERED_CLIENT = {
  client_display: { name: "Demo App" },
  client_id: "client_demo",
  registration_mode: "pre_registered_public",
};

// Returns the array of full `<input ...>` tags matching a marker attribute.
function inputsWith(html: string, marker: string): string[] {
  return [...html.matchAll(new RegExp(`<input[^>]*${marker}[^>]*>`, "g"))].map((m) =>
    mustExist(m[0], "match must have a full-match group")
  );
}

function isChecked(tag: string): boolean {
  return /\schecked(?:\s|\/|>|")/.test(tag);
}

// ── Acceptance criterion 1: sources collapsed by default ─────────────────────

test("every picker source <details> renders collapsed (no open attribute)", async () => {
  const html = await renderPicker();
  const details = [...html.matchAll(/<details class="hosted-ui-option-source"[^>]*>/g)].map((m) => m[0]);
  assert.ok(details.length >= 2, "render must contain at least the two registered source <details>");
  for (const tag of details) {
    assert.equal(/\sopen(?:\s|>|")/.test(tag), false, "source <details> must not carry the open attribute");
  }
});

// ── Acceptance criterion 2: bulk affordances present ─────────────────────────

test("picker exposes Select all / Clear all / Expand all / Collapse all controls", async () => {
  const html = await renderPicker();
  // Stable behavior hooks the picker JS binds to.
  assert.match(html, /data-hosted-mcp-select-sources/, "select-all hook present");
  assert.match(html, /data-hosted-mcp-clear-sources/, "clear-all hook present");
  assert.match(html, /data-hosted-mcp-expand-all/, "expand-all hook present");
  assert.match(html, /data-hosted-mcp-collapse-all/, "collapse-all hook present");
  // Owner-facing labels.
  assert.match(html, />Select every source</, "bulk select is owner-labelled");
  assert.match(html, />Clear selection</, "bulk clear is owner-labelled");
  assert.match(html, />Show all data types</, "expand is owner-labelled");
  assert.match(html, />Hide all data types</, "collapse is owner-labelled");
  // The 54 per-source buttons are gone: the tri-state parent checkbox already
  // selects and clears its own source, and 27 sources x 2 buttons was the
  // page compensating for a list that should have been shorter.
  assert.equal(html.includes("data-hosted-mcp-select-streams"), false, "no per-source select-every button");
  assert.equal(html.includes("data-hosted-mcp-clear-streams"), false, "no per-source clear button");
});

// ── Acceptance criterion 3: nothing preselected on first render ──────────────

test("no source and no stream checkbox is checked on first render", async () => {
  const html = await renderPicker();
  const sourceBoxes = inputsWith(html, "data-hosted-mcp-source-checkbox");
  const streamBoxes = inputsWith(html, "data-hosted-mcp-stream-checkbox");

  // Guard against vacuous pass.
  assert.ok(sourceBoxes.length >= 2, "render must contain source checkboxes");
  assert.ok(streamBoxes.length >= 2, "render must contain stream checkboxes");

  assert.equal(sourceBoxes.filter(isChecked).length, 0, "no source may be pre-checked");
  assert.equal(streamBoxes.filter(isChecked).length, 0, "no stream may be pre-checked");

  // The derived "source participates" state must also start false everywhere,
  // so a source is never selected-with-streams-clear by default.
  const groups = [...html.matchAll(/<details class="hosted-ui-option-source"[^>]*>/g)].map((m) => m[0]);
  assert.equal(groups.length, sourceBoxes.length, "one source group per source checkbox");
  for (const group of groups) {
    assert.match(group, /data-source-selected="false"/, "each source group starts unselected");
  }
});

// ── Acceptance criterion 4: placeholder/URL labels not owner-visible ─────────

test("redundant URL / placeholder connection labels never surface as owner-visible names", async () => {
  const html = await renderPicker();

  // The connector id legitimately appears inside machine-only carriers — the
  // opaque `data-source-key` hook and the base64url `value="..."` form
  // payloads — so a blanket substring check would be wrong. "Owner-visible"
  // means rendered text nodes: the content between `>` and `<`. The three
  // adversarial GitHub bindings (URL display name, `cin_*` placeholder, label
  // echoing the connector) must produce NO visible label text.
  const textNodes = [...html.matchAll(/>([^<]+)</g)].map((m) => mustExist(m[1], "capture group must exist"));
  for (const text of textNodes) {
    assert.equal(
      text.includes("https://registry.pdpp.dev/connectors/github"),
      false,
      `a registry-URL display name must never render as visible text (saw: ${text.trim().slice(0, 60)})`
    );
    assert.equal(
      text.includes("cin_github_placeholder"),
      false,
      `a cin_* placeholder must never render as visible text (saw: ${text.trim().slice(0, 60)})`
    );
  }

  // Only Spotify's genuinely distinct name survives as a connection-name span.
  const connectionNames = [...html.matchAll(/<span class="hosted-ui-connection-name">([^<]*)<\/span>/g)].map((m) =>
    mustExist(m[1], "capture group must exist")
  );
  assert.deepEqual(
    connectionNames.sort((a, b) => a.localeCompare(b)),
    ["Personal listening"],
    "only the distinct, non-redundant connection name is shown"
  );

  // The connector type label itself stays clean (no scheme leak in the row title).
  const typeLabels = [...html.matchAll(/<span class="hosted-ui-connector-type">([^<]*)<\/span>/g)].map((m) =>
    mustExist(m[1], "capture group must exist")
  );
  assert.ok(typeLabels.includes("Spotify") && typeLabels.includes("GitHub"), "connector type labels are human names");
  for (const label of typeLabels) {
    assert.equal(label.includes("https"), false, "connector type label must not leak a URL scheme");
  }
});

test("picker row meta never repeats a URL-shaped connector id as the technical key", async () => {
  const html = await renderPicker();
  const metas = [...html.matchAll(/<span class="hosted-ui-option-meta"[^>]*>([^<]*)<\/span>/g)].map((m) =>
    mustExist(m[1], "capture group must exist")
  );
  assert.ok(metas.length >= 2, "each source row carries a meta line");
  for (const meta of metas) {
    assert.equal(meta.includes("https"), false, "row meta must not echo a registry URL");
    assert.equal(meta.includes("/connectors/"), false, "row meta must not echo a registry URL path");
    assert.match(meta, /\d+ data types?/, "row meta still summarizes the count of data the owner holds");
    assert.equal(/\bstreams?\b/.test(meta), false, '"stream" is a protocol noun, not owner-facing copy');
  }
});

// ── listHostedMcpPickerRows: internal connectors excluded, labels canonical ──

test("listHostedMcpPickerRows skips internal connectors and emits canonical owner labels", async () => {
  const rows = await listHostedMcpPickerRows(makeCaps(), "owner_local");

  // Internal connector excluded; Spotify (1 binding) + GitHub (3 bindings) = 4 rows.
  assert.equal(rows.length, 4, "internal connector excluded; one row per active binding");
  assert.ok(
    rows.every((r) => r.connectorId !== INTERNAL_ID),
    "internal connector must never appear as a picker row"
  );

  // Connector type labels are the human manifest names, never the URL id.
  for (const row of rows) {
    assert.ok(
      ["Spotify", "GitHub"].includes(row.connectorTypeLabel),
      `clean type label, got ${row.connectorTypeLabel}`
    );
  }

  // GitHub's three adversarial binding names all suppress to null; Spotify's
  // distinct name survives.
  const names = rows.map((r) => r.connectionName).filter(Boolean);
  assert.deepEqual(names, ["Personal listening"], "only the distinct connection name survives");
});

// ── Instances-not-catalog fix: an unheld connector renders no row at all ─────
//
// Root cause (owner-reported): the picker rendered one row per REGISTERED
// connector, including connectors the owner has never connected (e.g. Oura
// sleep/readiness/activity appeared for an owner with no Oura connection at
// all). Selecting such a row — or a "select all" over the rendered rows —
// produced `{"error":"source.authorization_details_invalid"}`: the AS has no
// eligible connector instance to satisfy a grant against a connector the
// owner does not hold. The fix: the picker must render only what the owner's
// instance actually has, not the static connector catalog. A connector with
// zero active bindings now yields NO row, and a "select all" over what
// remains can never name an uninstalled connector.
test("a connector with zero bindings yields no picker row at all", async () => {
  const caps = makeCaps({
    listActiveBindingsForGrant: async () => [],
    listRegisteredConnectorIds: async () => [SPOTIFY_ID],
    // Must not even be consulted for a connector with zero bindings — there
    // is no connection to ask "which of your streams have records". If this
    // fires, buildConnectorPickerRows regressed to querying holdings for a
    // source the owner was never asked to grant anything real from.
    listStreamsWithRecords: () => {
      throw new Error("listStreamsWithRecords must not be called for an unheld connector");
    },
  });
  const rows = await listHostedMcpPickerRows(caps, "owner_local");
  assert.deepEqual(rows, [], "a registered-but-unconnected connector must render no picker row");
});

test("a mix of held and unheld connectors renders rows only for the held ones", async () => {
  const caps = makeCaps({
    listActiveBindingsForGrant: async ({ connectorId }: { connectorId: string }) =>
      connectorId === SPOTIFY_ID ? (BINDINGS[SPOTIFY_ID] ?? []) : [],
    listRegisteredConnectorIds: async () => [SPOTIFY_ID, GITHUB_ID],
  });
  const rows = await listHostedMcpPickerRows(caps, "owner_local");
  assert.equal(rows.length, 1, "only the connected connector (Spotify) yields a row");
  const row = mustExist(rows[0], "the Spotify row must exist");
  assert.equal(row.connectorId, SPOTIFY_ID);
  assert.equal(
    rows.some((r) => r.connectorId === GITHUB_ID),
    false,
    "GitHub has zero active bindings and must not appear"
  );
});

test("an active-binding storage failure is not rendered as an unconnected source", async () => {
  const caps = makeCaps({
    listActiveBindingsForGrant: async () => {
      throw new Error("injected storage failure");
    },
    listRegisteredConnectorIds: async () => [SPOTIFY_ID],
  });

  await assert.rejects(
    listHostedMcpPickerRows(caps, "owner_local"),
    ActiveBindingLookupError,
    "a failed active-binding lookup must remain distinguishable from an honest empty binding list"
  );
});

// ── Anti-over-correction guard: a HELD connector still renders its real streams ──
//
// The fix must not degrade a connector the owner genuinely holds. GitHub's
// manifest declares 3 streams (repositories, starred_repos, issues); this
// connection has actually synced records for only 2 of them (starred_repos
// has none yet). The picker must report the true held count (2), matching
// the `/sources` console idiom of counting streams that hold data, not the
// manifest's full catalog (3) and not zero (which would wrongly say the
// connector holds nothing at all).
test("a held connector's 'streams available' count reflects real per-connection holdings, not the manifest catalog", async () => {
  const heldByConnection: Record<string, string[]> = {
    cin_github_echo: ["repositories", "issues"],
  };
  const caps = makeCaps({
    listActiveBindingsForGrant: async ({ connectorId }: { connectorId: string }) =>
      connectorId === GITHUB_ID ? [BINDINGS[GITHUB_ID]?.[2] as FixtureBinding] : [],
    listRegisteredConnectorIds: async () => [GITHUB_ID],
    listStreamsWithRecords: async ({ connectorInstanceId }: { connectorInstanceId: string | null }) =>
      Promise.resolve((connectorInstanceId && heldByConnection[connectorInstanceId]) || []),
  });
  const rows = await listHostedMcpPickerRows(caps, "owner_local");
  assert.equal(rows.length, 1, "GitHub's single connected binding yields one row");
  const row = mustExist(rows[0], "the GitHub connection row must exist");

  // Real holdings (2), not the manifest's full offering (3) and not 0.
  assert.match(row.meta, /\b2 data types\b/, `expected the real held count of 2, got meta: ${row.meta}`);
  assert.equal(row.meta.includes("3 streams available"), false, "must not fall back to the manifest catalog count");

  // The full manifest catalog must still be present in the grantable stream
  // list — including `starred_repos`, which has no data yet — so the owner
  // can still choose to pre-authorize it. Real data the owner DOES hold
  // (repositories, issues) must also still be present: this is the anti-
  // hiding guard (P1: no data known to the system may be invisible).
  const grantableNames = row.streams.map((s) => s.name).sort();
  assert.deepEqual(
    grantableNames,
    ["issues", "repositories", "starred_repos"],
    "every manifest stream stays selectable regardless of whether it currently holds data"
  );
});

// ── Acceptance criterion 5: orphaned-stream rejection is user-friendly ───────
// The server-side ignore-orphan-streams behavior is covered end-to-end in
// hosted-mcp-oauth.test.js. Here we pin the *render-layer* guards that make
// that path reachable without a raw-JSON error page: the client-side
// validation messages and the inline error banner the form surfaces instead.

test("picker carries the source-first validation guards and an inline error banner (no raw error page)", async () => {
  const html = await renderPicker();

  // The form-level error region the picker JS writes into (instead of
  // navigating to a JSON error). Starts hidden.
  const banner = html.match(/<div[^>]*data-hosted-mcp-picker-error[^>]*>/);
  assert.ok(banner, "picker renders an inline error region");
  assert.match(banner[0], /role="alert"/, "error region is an assertive live region");
  assert.match(banner[0], /\shidden(?:\s|>|")/, "error region starts hidden");

  // The two guard messages that keep an orphaned stream / sourceless submit
  // from ever reaching the server as a confusing grant.
  assert.match(html, /Choose at least one data type to continue/i, "guards against a sourceless submit");
  assert.match(
    html,
    /Choose data from each selected source, or clear the source/i,
    "guards against a selected source with no checked data"
  );

  // The picker JS derives the source checkbox from its checked streams, so a
  // source cannot stay selected while every stream is clear — the structural
  // root of the "stream-without-source" defect.
  assert.match(html, /sourceBox\.checked = selected/, "source checked state is derived from streams");
  assert.match(html, /event\.preventDefault\(\)/, "invalid submits are blocked client-side, not posted raw");
});

// ── Acceptance criterion 6: SLVP owner-facing copy ───────────────────────────
// The picker's behavior was already correct on `main`; the remaining UAT gap was
// comprehension — the copy read like a technical demo and explained the model
// twice. These assertions pin the polished owner-facing copy so the source =
// its-streams model, the "no streams checked = not shared" rule, and the honest
// retention caveat survive future refactors of the pure render helper.

test("picker copy carries no instructions for its own checkbox, and no revoke promise the product cannot keep", async () => {
  const html = await renderPicker();

  // The ~70 words that used to teach the owner how a tri-state checkbox
  // works are gone. Explanatory copy at that density signals a broken
  // control, and this one was never broken — the parent already goes
  // `indeterminate` on partial selection. Pin the deletion so it does not
  // creep back.
  assert.equal(html.includes("A source is its streams"), false, "the checkbox model is not explained in prose");
  assert.equal(
    html.includes("Check one stream to share just that stream"),
    false,
    "single-stream grants are discoverable from the control, not from a sentence about it"
  );

  // The revoke promise is stated at the granularity the product actually
  // delivers. Per-source revoke has a route and no UI, so promising it is a
  // reversibility claim the owner cannot act on.
  assert.equal(
    /revoke any source you approve/i.test(html),
    false,
    "no per-source revoke promise: the route exists but no UI calls it"
  );
  assert.match(html, /You can revoke this access later from your grants page/i, "the package-level promise is kept");
  assert.equal(html.includes("retention limit"), false, 'copy avoids the jargon "retention limit"');

  // No technical-demo phrasing or registry leakage in the *visible prose*. The
  // connector id legitimately rides inside machine-only carriers (the opaque
  // `data-source-key` hook and base64url form `value="..."` payloads), so we
  // inspect rendered text nodes only — the content between `>` and `<`.
  const textNodes = [...html.matchAll(/>([^<]+)</g)].map((m) => mustExist(m[1], "capture group must exist"));
  for (const text of textNodes) {
    assert.equal(text.includes("registry.pdpp.dev"), false, "copy never leaks a registry URL as visible text");
    assert.equal(/\bcin_[a-z0-9]/i.test(text), false, "copy never leaks a cin_ id as visible text");
  }
});

test("no owner-facing sentence appears twice on the page", async () => {
  const html = await renderPicker(makeCaps(), { client: CIMD_CLIENT_SELF_DESCRIBED });
  // Rendered text only — the connector id legitimately repeats inside opaque
  // machine carriers (`data-source-key`, base64url form values).
  const sentences = [...html.matchAll(/>([^<]+)</g)]
    .map((m) => mustExist(m[1], "capture group must exist").trim())
    // Long enough to be prose rather than a label, number, or stream name.
    .filter((text) => text.length > 40);
  const seen = new Map<string, number>();
  for (const sentence of sentences) {
    seen.set(sentence, (seen.get(sentence) ?? 0) + 1);
  }
  const duplicated = [...seen.entries()].filter(([, count]) => count > 1).map(([text]) => text);
  assert.deepEqual(duplicated, [], "every owner-facing sentence is said once");
});

// ── Empty-state: no sources registered ───────────────────────────────────────

test("empty connector set renders a calm owner message with no form controls", async () => {
  const caps = makeCaps({ listRegisteredConnectorIds: async () => [INTERNAL_ID] });
  const html = await renderPicker(caps);
  assert.match(html, /You haven&#39;t connected any data sources yet/i, "owner sees a plain empty-state message");
  // The empty picker must not be a dead end — an owner who reaches it can
  // still refuse, and is told what to do next.
  assert.match(html, /Connect one, then start this request again/i, "the empty state names the way out");
  assert.match(html, /value="cancel"/, "refusal is reachable even with nothing to grant");
  assert.equal(inputsWith(html, "data-hosted-mcp-source-checkbox").length, 0, "no source checkboxes in empty state");
  assert.equal(html.includes("data-hosted-mcp-select-sources"), false, "no bulk toolbar in empty state");
});

// ── FIX 2: purpose is server-assigned, not a client claim ────────────────────
// The hosted-MCP authorize shortcut never receives `authorization_details`
// from the client — this picker mints its own fixed purpose and assigns it
// to every grant it issues. The old "They claim — not verified by your
// server" framing misattributed authorship to an app that declared nothing.

test("picker states the purpose once, naming its origin, with no purpose-code URI on the owner surface", async () => {
  const html = await renderPicker(makeCaps(), { client: CIMD_CLIENT_SELF_DESCRIBED });
  // One sentence carrying both facts — who assigned it and what it is —
  // replacing three rows (`Purpose`, `Purpose description`, `Purpose code`)
  // that said one idea three times, one of them as a URI.
  assert.match(
    html,
    /Set by this server because ChatGPT didn&#39;t give one: use the data you select as context for your AI assistant\./,
    "purpose is one sentence that names its own origin"
  );
  assert.equal(
    html.includes("https://pdpp.dev/purpose/agent_context"),
    false,
    "the registry purpose code is a protocol identifier, not owner-facing copy — it stays in the grant and audit record"
  );
  assert.equal(html.includes("Purpose description"), false, "no label-plus-sentence redundancy");
  assert.equal(
    html.includes("They claim — not verified by your server"),
    false,
    "the purpose block must not carry the 'they claim' eyebrow — no purpose arrived in this request to attribute to the app"
  );
  assert.match(
    html,
    /class="hosted-ui-authorship" data-authorship="manifest"[^>]*aria-label="Assigned purpose"/,
    "the purpose block renders as server-generated text (manifest authorship), not a client claim"
  );
});

// ── FIX 1: retention is a structured policy declaration, not enforcement ─────

test("picker never states a retention the client did not declare", async () => {
  const html = await renderPicker(makeCaps(), { client: CIMD_CLIENT_SELF_DESCRIBED });

  // The defect this pins: the page told the owner "data it reads is deleted
  // within 90 days". Read plainly, the subject is what the APP does —
  // ChatGPT never promised it, and this server has no mechanism to cause it
  // (spec-core.md:948 — PDPP does not retroactively reach into client-side
  // data stores; :951 — retention is a commitment BY the recipient). No
  // feature can make that sentence true, so the only fix is to state the
  // absence.
  assert.match(
    html,
    /ChatGPT did not say how long it keeps the data it receives\./,
    "the absence is stated, naming the app whose silence it is"
  );
  assert.equal(
    /deleted within 90\s*days/i.test(html),
    false,
    "the server must never tell the owner the client deletes their data on a schedule the client never accepted"
  );
  assert.equal(/\b90 days\b/.test(html), false, "no fabricated retention window anywhere on the owner surface");
  assert.equal(html.includes("P90D"), false, "no retention bound is asserted at all");

  // Retention now lives on the approval artifact, as one of the exact terms
  // the owner binds to (spec-core.md:873-877), rather than as a standalone
  // block above the list that repeated the same sentence.
  assert.match(
    html,
    /data-hosted-mcp-review[\s\S]*ChatGPT did not say how long it keeps the data it receives\./,
    "the retention state is stated on the artifact the owner approves"
  );
  assert.equal(
    /aria-label="Data retention"[^>]*>[\s\S]{0,120}Your server enforces/.test(html),
    false,
    "retention must never render under the 'Your server enforces' eyebrow — it is not enforced"
  );
});

// ── The H1 names the requester and the verb; the URL is not headline material ──

test("H1 uses the resolved display name, never the client_id URL", async () => {
  const html = await renderPicker(makeCaps(), { client: CIMD_CLIENT_SELF_DESCRIBED });
  // spec-core.md:673 requires the resolved display name when it is available,
  // and makes client_id the fallback for when it is not. ChatGPT's metadata
  // document carries `"client_name": "ChatGPT"`, so headlining
  // `https://chatgpt.com` was showing the fallback while holding the answer.
  assert.match(html, /<h1[^>]*>ChatGPT wants to read your data<\/h1>/, "H1 is the name plus the verb");
  assert.equal(
    /<h1[^>]*>[^<]*https:\/\//.test(html),
    false,
    "no URL in the headline — the domain does its anti-phishing job in the identity block, quietly"
  );
  // The domain is still shown, as its own quiet line, and the trust status
  // sits with it so a resolved name is never presented as verified.
  assert.match(html, /hosted-ui-client-identity-domain[^>]*>chatgpt\.com</, "the domain renders as a quiet second line");
  assert.match(
    html,
    /This app isn't registered with your server\. Its name and logo are self-reported\./,
    "trust status is a neutral fact adjacent to the name"
  );
  assert.equal(
    html.includes("Unverified app"),
    false,
    "the unconditional badge is replaced by a fact line — a badge that cannot vary carries no information"
  );
});

test("H1 falls back to the registered name for a client with no distinct origin identity", async () => {
  // Pre-registered/public clients have no verifiable origin distinct from
  // their registered display name — `titleName` IS the client-authored name.
  const html = await renderPicker(makeCaps(), { client: PREREGISTERED_CLIENT });
  assert.match(html, /<h1[^>]*>Demo App wants to read your data<\/h1>/, "H1 uses the single registered name");
});

test("the metadata-document URL never reaches the owner surface", async () => {
  const html = await renderPicker(makeCaps(), { client: CIMD_CLIENT_SELF_DESCRIBED });
  // A client_id with a `token_endpoint_auth_method` query parameter is debug
  // output: it means something to an engineer inspecting a registration and
  // nothing to the person deciding whether to share their bank transactions.
  assert.equal(html.includes("Metadata document"), false, "no metadata-document row on the consent surface");
  assert.equal(
    html.includes("token_endpoint_auth_method"),
    false,
    "no auth-method query parameter rendered to the owner"
  );
});

// ── FIX 3: source-kind summary — uniform vs. mixed ────────────────────────────

test("a uniform source kind is not rendered at all — it carries no bits for the owner", async () => {
  const html = await renderPicker();
  // `source.kind` is real protocol (source-kinds:731-743) but its audience is
  // the CLIENT, which reads it as a trust expectation about declaration
  // provenance. To the owner, "connector" answers a question nobody asked —
  // and because every row resolved to the same kind, it consumed a badge slot
  // on all 27 rows while distinguishing nothing. It stays in the grant and
  // the audit record.
  assert.equal(html.includes("All sources below are"), false, "no uniform-kind summary line");
  assert.equal(html.includes("hosted-ui-option-source-kind-badge"), false, "no per-row connector badge");
  assert.equal(/>connector</.test(html), false, 'the raw enum never renders as owner-facing copy');
});

test("mixed source kinds across rows fall back to a full per-row line, no false summary", async () => {
  const caps = makeCaps({
    getConnectorManifest: async (connectorId: string) => {
      const base = MANIFESTS[connectorId];
      if (!base) {
        return null;
      }
      // GitHub resolves to provider_native, Spotify stays connector — a real
      // mixed-kind picker (rare, but the summary must not lie about it).
      const kind = connectorId === GITHUB_ID ? "provider_native" : "connector";
      return { ...base, source_declaration: { source: { id: connectorId, kind } } };
    },
  });
  const html = await renderPicker(caps);
  assert.equal(
    html.includes("All sources below are"),
    false,
    "mixed kinds must not render a uniform summary line that would misstate one of the kinds"
  );
  // When provenance genuinely differs between rows, the difference IS worth
  // surfacing — but worded as a consequence for the owner, never as the raw
  // enum.
  assert.match(html, /Read directly from this source/, "the connector-backed row names its consequence");
  assert.match(html, /Read from data you imported/, "the provider-native row names its consequence");
  assert.equal(/>provider_native</.test(html), false, "the raw enum never reaches the owner surface");
});

// ── FIX 4: grant expiry is stated, tied to the access-mode control ───────────

test("picker states grant expiry under 'Your server enforces', tied to the access-mode choice", async () => {
  const html = await renderPicker();
  assert.match(
    html,
    /This authorization has no scheduled end date\./,
    "picker must state grant expiry as its own fact"
  );
  // Expiry is orthogonal to access mode (spec-core.md:889 — grant validity,
  // data temporal scope, and access pattern must not be conflated). The old
  // copy restated the mode and contradicted "One-time access" directly above
  // it.
  assert.equal(
    /whichever access mode/i.test(html),
    false,
    "the expiry row must not restate the access mode"
  );
  // The expiry statement must sit immediately after the access-mode fieldset
  // (same protocol-enforced block), so the two can never silently contradict
  // each other. Assert ordering: access-mode fieldset close, then the expiry
  // note, before the block itself closes.
  const accessModeIndex = html.indexOf('class="hosted-ui-access-mode"');
  const expiryIndex = html.indexOf("This authorization has no scheduled end date.");
  assert.ok(accessModeIndex >= 0, "access-mode fieldset must be present");
  assert.ok(expiryIndex > accessModeIndex, "expiry note must render after the access-mode fieldset, not before it");
  const protocolLabelIndex = html.indexOf('aria-label="Streams and access mode your server will enforce"');
  assert.ok(protocolLabelIndex >= 0, "the protocol-enforced streams/access-mode block must be present");
  assert.ok(
    protocolLabelIndex < accessModeIndex && accessModeIndex < expiryIndex,
    "the expiry statement must be co-located inside the same protocol-enforced block as the access-mode control"
  );
});

// ── FIX 5: resolved fields and time range are stated ──────────────────────────

test("picker states the resolved field/time-range scope once, on the approval artifact", async () => {
  const html = await renderPicker();
  // This flow has no field-projection or time-range UI, so every checked
  // data type resolves to all of its fields with no temporal bound — an
  // exact resolved term the artifact must carry (spec-core.md:873-877).
  const occurrences = [...html.matchAll(/Everything in each data type you check, with no date limit\./g)];
  assert.equal(occurrences.length, 1, "the coverage term is stated exactly once");
  assert.match(
    html,
    /data-hosted-mcp-review[\s\S]*Everything in each data type you check, with no date limit\./,
    "the coverage term renders on the artifact the owner approves"
  );
});
