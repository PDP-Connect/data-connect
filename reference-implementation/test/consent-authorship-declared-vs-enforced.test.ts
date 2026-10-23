// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Consent screens keep three things apart (spec-core.md §6, ~728 and ~740-746):
 *
 *   1. what the server ENFORCES (access mode, access end from `expires_at`),
 *   2. structured policy the client DECLARED (purpose, retention) — shown,
 *      not enforced (spec-core.md §7: retention is not technically enforced),
 *   3. free-text client CLAIMS (`client_claims.commitments`).
 *
 * Pure renderer tests: no DB, no HTTP. Production `escapeHtml` and
 * `renderKeyValueList` are wired in; only the page wrappers are pass-throughs.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { escapeHtml, renderKeyValueList } from "../server/hosted-ui.ts";
import {
  type ConsentUiRenderer,
  type PendingGrant,
  renderPendingGrantConsentHtml,
} from "../server/routes/as-consent-ui-helpers.ts";

const ui: ConsentUiRenderer = {
  escapeHtml,
  renderActionRow: (actions) => actions.map((a) => `<button>${escapeHtml(a.label)}</button>`).join("\n"),
  renderHostedDocument: ({ body }) => `<!doctype html><html><body>${body}</body></html>`,
  renderKeyValueList,
  renderPageIntro: ({ title }) => `<h1>${escapeHtml(title)}</h1>`,
  renderResultState: ({ title, body }) => `<div>${escapeHtml(title)}${escapeHtml(body)}</div>`,
  renderSurface: ({ children }) => `<section>${children}</section>`,
};

const PURPOSE_DESCRIPTION = "Recommend concerts from your listening";
const PURPOSE_CODE = "https://pdpp.dev/purpose/personalization";
const CLAIM = "We never sell your data";
const EXPIRES_AT = "2026-12-01T00:00:00.000Z";
const RETENTION = { max_duration: "P30D", on_expiry: "delete" } as const;

// Walk <div data-authorship="X"> blocks, balancing <div> depth.
function authorshipBlocks(html: string, authorship: string): string {
  const blocks: string[] = [];
  const markerRe = new RegExp(`<div[^>]*data-authorship="${authorship}"`, "g");
  let marker = markerRe.exec(html);
  while (marker !== null) {
    let depth = 0;
    let end = marker.index;
    const tagRe = /<\/?div\b[^>]*>/g;
    tagRe.lastIndex = marker.index;
    let tag = tagRe.exec(html);
    while (tag !== null) {
      depth += tag[0].startsWith("</") ? -1 : 1;
      if (depth === 0) {
        end = tag.index + tag[0].length;
        break;
      }
      tag = tagRe.exec(html);
    }
    blocks.push(html.slice(marker.index, end));
    marker = markerRe.exec(html);
  }
  return blocks.join("\n");
}

// The artifact type is internal to the renderer; fixtures are structurally valid.
function asReview(review: unknown): NonNullable<PendingGrant["review"]> {
  return review as NonNullable<PendingGrant["review"]>;
}

function render(pending: PendingGrant): string {
  return renderPendingGrantConsentHtml(pending, "urn:req:1", "csrf", "csrf_token", "Test Server", ui);
}

function assertGrouped(html: string, opts: { expectsAccessEnd: string }): void {
  const enforced = authorshipBlocks(html, "protocol");
  const declared = authorshipBlocks(html, "declared");
  const claims = authorshipBlocks(html, "client");

  // Enforced: access mode and access end.
  assert.match(enforced, /continuous/, "access mode is enforced");
  assert.ok(enforced.includes(opts.expectsAccessEnd), `access end "${opts.expectsAccessEnd}" is enforced`);

  // Declared: purpose and retention, labelled as not enforced.
  assert.ok(declared.includes(PURPOSE_DESCRIPTION) || declared.includes(PURPOSE_CODE), "purpose is declared");
  assert.match(declared, /30 days/, "retention is declared");
  assert.match(declared, /does not enforce it/i, "declared group says it is not enforced");

  // Retention and purpose are never under the enforced heading.
  assert.equal(/30 days|P30D|retention/i.test(enforced), false, "retention is never in the enforced group");
  assert.equal(enforced.includes(PURPOSE_DESCRIPTION), false, "purpose is never in the enforced group");

  // Free-text claim: only in the client-claims group.
  assert.ok(claims.includes(CLAIM), "free-text claim is in the claims group");
  assert.equal(declared.includes(CLAIM), false, "claim is not in the declared group");
  assert.equal(enforced.includes(CLAIM), false, "claim is not in the enforced group");
  assert.equal(claims.includes("30 days"), false, "retention is not a free-text claim");

  // The three groups carry three different eyebrows.
  assert.match(html, /Your server enforces/);
  assert.match(html, /The app declared this — your server does not enforce it/);
  assert.match(html, /They claim — not verified by your server/);
}

const reviewBase = {
  ai_training_consented: false,
  client: { client_id: "concert_app", registration_mode: "pre_registered" },
  client_claims: { commitments: [CLAIM] },
  purpose_code: PURPOSE_CODE,
  purpose_description: PURPOSE_DESCRIPTION,
  resolved_streams: [],
  retention: RETENTION,
  selection_preset: null,
  source: { id: "spotify", kind: "connector" },
  source_declaration: { digest: "d", version: "v1" },
  subject: { id: "owner_local" },
  version: "reference.approval-review.v1",
} as const;

test("pre-review single consent: enforced, declared and claims are separate groups", () => {
  const html = render({
    request: {
      client: { client_id: "concert_app" },
      selection: {
        access_mode: "continuous",
        client_claims: { commitments: [CLAIM] },
        purpose_code: PURPOSE_CODE,
        purpose_description: PURPOSE_DESCRIPTION,
        retention: RETENTION,
        streams: [{ name: "top_artists" }],
      },
      source_binding: { id: "spotify", kind: "connector" },
    },
  });
  assertGrouped(html, { expectsAccessEnd: "Until you revoke it" });
});

test("pre-review continuous warning does not tie access end to retention", () => {
  const html = render({
    request: {
      selection: { access_mode: "continuous", retention: RETENTION, streams: [{ name: "top_artists" }] },
    },
  });
  assert.equal(/retention bound/i.test(html), false, "access end is not described by a retention bound");
  assert.match(html, /until you revoke the grant/);
});

test("reviewed single consent: expires_at is the access end and groups are separate", () => {
  const html = render({
    request: {},
    review: asReview({ ...reviewBase, access_mode: "continuous", expires_at: EXPIRES_AT }),
    reviewRevision: "rev1",
  });
  assertGrouped(html, { expectsAccessEnd: EXPIRES_AT });
});

test("reviewed single consent: no expires_at says access lasts until revoked", () => {
  const html = render({
    request: {},
    review: asReview({ ...reviewBase, access_mode: "continuous", expires_at: null }),
    reviewRevision: "rev1",
  });
  assertGrouped(html, { expectsAccessEnd: "Until you revoke it" });
  assert.match(
    authorshipBlocks(html, "protocol"),
    /Access ends<\/[^>]+>\s*<[^>]+>Until you revoke it/,
    "access end row says until revoked"
  );
});

test("reviewed batch consent: per-source groups are separate and expires_at ends access", () => {
  const source = {
    access_mode: "continuous",
    client_claims: { commitments: [CLAIM] },
    index: 0,
    purpose_code: PURPOSE_CODE,
    purpose_description: PURPOSE_DESCRIPTION,
    resolved_streams: [],
    retention: RETENTION,
    selection_preset: null,
    source: { id: "spotify", kind: "connector" },
    source_declaration: { digest: "d", version: "v1" },
  };
  const html = render({
    batch: true,
    request: {},
    review: {
      access_mode: "continuous",
      approved_source_indexes: [0],
      client: { client_id: "concert_app", registration_mode: "pre_registered" },
      expires_at: EXPIRES_AT,
      parent_package_id: null,
      source_narrowing: {},
      sources: [source],
      subject: { id: "owner_local" },
      version: "reference.batch-approval-review.v1",
    },
    reviewRevision: "rev1",
  });
  assertGrouped(html, { expectsAccessEnd: EXPIRES_AT });
});

test("pre-review batch cards: purpose and retention are declared, not enforced", () => {
  const html = render({
    batch: true,
    cards: [
      {
        access_mode: "continuous",
        client_claims: { commitments: [CLAIM] },
        index: 0,
        purpose_code: PURPOSE_CODE,
        retention: RETENTION,
        source: { id: "spotify", kind: "connector" },
      },
    ],
    request: {},
  });
  const enforced = authorshipBlocks(html, "protocol");
  const declared = authorshipBlocks(html, "declared");
  assert.match(enforced, /Until you revoke it/);
  assert.equal(/30 days|retention/i.test(enforced), false, "retention is never in the enforced group");
  assert.match(declared, /30 days/);
  assert.ok(declared.includes(PURPOSE_CODE));
  assert.ok(authorshipBlocks(html, "client").includes(CLAIM));
});

// ── Self-described client metadata is a claim, never an enforced fact ────────

const SELF_DESCRIBED_CLIENT = {
  client_display: {
    logo_uri: "https://app.example/logo.png",
    name: "Unverified App Name",
    policy_uri: "https://app.example/privacy",
    tos_uri: "https://app.example/terms",
    uri: "https://app.example",
  },
  client_id: "concert_app",
  registration_mode: "pre_registered",
};

function assertClientMetadataIsAClaim(html: string): void {
  const enforced = authorshipBlocks(html, "protocol");
  const claims = authorshipBlocks(html, "client");
  for (const needle of ["Unverified App Name", "https://app.example/privacy", "https://app.example/logo.png"]) {
    assert.equal(enforced.includes(needle), false, `"${needle}" must not appear under the enforced heading`);
    assert.ok(claims.includes(needle), `"${needle}" must appear in the client-claims group`);
  }
  // Server-verified identity stays enforced.
  assert.ok(enforced.includes("concert_app"), "client id stays enforced");
  assert.ok(enforced.includes("pre_registered"), "registration mode stays enforced");
}

test("reviewed single consent: client_display metadata is a client claim", () => {
  const html = render({
    request: {},
    review: asReview({
      ...reviewBase,
      access_mode: "continuous",
      client: SELF_DESCRIBED_CLIENT,
      expires_at: null,
    }),
    reviewRevision: "rev1",
  });
  assertClientMetadataIsAClaim(html);
});

test("reviewed batch consent: client_display metadata is a client claim", () => {
  const html = render({
    batch: true,
    request: {},
    review: asReview({
      access_mode: "continuous",
      approved_source_indexes: [],
      client: SELF_DESCRIBED_CLIENT,
      expires_at: null,
      parent_package_id: null,
      source_narrowing: {},
      sources: [],
      subject: { id: "owner_local" },
      version: "reference.batch-approval-review.v1",
    }),
    reviewRevision: "rev1",
  });
  assertClientMetadataIsAClaim(html);
});

test("reviewed single consent: single-use with no expires_at is not described as lasting until revoked", () => {
  const html = render({
    request: {},
    review: asReview({ ...reviewBase, access_mode: "single_use", expires_at: null }),
    reviewRevision: "rev1",
  });
  const enforced = authorshipBlocks(html, "protocol");
  assert.equal(/until you revoke/i.test(enforced), false);
  assert.match(enforced, /single_use/);
});
