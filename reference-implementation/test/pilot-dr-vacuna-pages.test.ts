// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// DR pilot pages and lifecycle answer, without a database:
// language resolution (i18n.ts), one language per rendered page (html.ts),
// and the held-data answer for a grant row (grant-lifecycle.ts).

import assert from "node:assert/strict";
import test from "node:test";

import { assessGrant } from "../server/pilot-dr-vacuna/grant-lifecycle.ts";
import { ageLabel, authorizationsPage, reviewPage } from "../server/pilot-dr-vacuna/html.ts";
import { langHref, resolveLang } from "../server/pilot-dr-vacuna/i18n.ts";
import type { RepresentativeGrantRow } from "../server/pilot-dr-vacuna/store.ts";

const session = {
  cedula: "00100000011",
  csrfToken: "csrf-1",
  displayName: "María <Rodríguez>",
  expiresAt: Date.now() + 60_000,
  parentRef: "cu_x",
  sessionId: "s1",
};

const row = (over: Partial<RepresentativeGrantRow> = {}): RepresentativeGrantRow => ({
  approved_at: "2026-10-01T12:00:00.000Z",
  capacity: "parent",
  child_id: "DR-9100001",
  client_display_name: "Vacuna al día",
  client_id: "cli_a",
  disposition: null,
  expires_at: "2044-06-20T00:00:00.000Z",
  fields: ["child_id", "doses"],
  grant_id: "grt_1",
  grant_status: "active",
  parent_ref: "cu_x",
  purpose_description: "Recordatorios de vacunación",
  revoked_at: null,
  ...over,
});

test("language: ?lang beats ?ui_locales beats the cookie beats Spanish", () => {
  assert.equal(resolveLang({ headers: {} }), "es");
  assert.equal(resolveLang({ headers: { cookie: "a=1; pdpp_demo_lang=en" } }), "en");
  assert.equal(resolveLang({ headers: { cookie: "pdpp_demo_lang=en" }, query: { lang: "es" } }), "es");
  assert.equal(resolveLang({ headers: {}, query: { ui_locales: "en-US es" } }), "en");
  assert.equal(resolveLang({ headers: {}, query: { lang: "fr" } }), "es");
  assert.equal(langHref("/pilot/vacuna/consent?request_uri=a%3Ab&lang=es", "en"), "/pilot/vacuna/consent?request_uri=a%3Ab&lang=en");
});

test("review page: one language, the representative context, escaped names", () => {
  const review = {
    capacity: "legal_guardian" as const,
    child: { birth_date: "2023-04-15", child_id: "DR-9100005", family_name: "Cruz", given_name: "Valentina" },
    clientName: "Vacuna <al> día",
    expiresAt: "2041-04-15T00:00:00.000Z",
    fields: ["birth_date", "doses"],
    pilotRevision: "rev",
    purposeDescription: "Recordatorios de vacunación",
    requestUri: "urn:x",
  };
  const es = reviewPage({ currentUrl: "/pilot/vacuna/consent/review?request_uri=urn%3Ax", lang: "es", review, session });
  assert.match(es, /Usted está actuando como <b>tutor o tutora legal<\/b> de <b>Valentina Cruz<\/b>/);
  assert.match(es, /15 de abril de 2041/);
  assert.match(es, /Vacuna &lt;al&gt; día/);
  assert.match(es, /María &lt;Rodríguez&gt;/);
  assert.doesNotMatch(es, /You are acting as/);
  const en = reviewPage({ currentUrl: "/x", lang: "en", review, session });
  assert.match(en, /You are acting as <b>legal guardian<\/b> of <b>Valentina Cruz<\/b>/);
  assert.match(en, /April 15, 2041/);
  assert.match(en, /Vaccination reminders/);
  assert.doesNotMatch(en, /Usted está actuando/);
});

test("Mis autorizaciones: grouped by child, who approved, revoke only while active", () => {
  const children = [
    { birth_date: "2026-06-20", capacity: "parent" as const, child_id: "DR-9100001", family_name: "Rodríguez", given_name: "Sofía" },
    { birth_date: "2022-11-02", capacity: "parent" as const, child_id: "DR-9100002", family_name: "Pérez", given_name: "Luis" },
  ];
  const html = authorizationsPage({
    children,
    currentUrl: "/pilot/vacuna/autorizaciones",
    flash: null,
    grants: [
      { ...row(), approved_by_you: false },
      {
        ...row({ disposition: "delete", grant_id: "grt_2", grant_status: "revoked", revoked_at: "2026-10-02T12:00:00.000Z" }),
        approved_by_you: true,
      },
    ],
    lang: "es",
    session,
  });
  assert.match(html, /data-child-section="DR-9100001"/);
  assert.match(html, /data-grant-id="grt_1"[^>]*data-grant-status="active"/);
  assert.match(html, /data-grant-id="grt_2"[^>]*data-grant-status="revoked"/);
  assert.equal((html.match(/data-revoke-form/g) ?? []).length, 1, "only the active grant can be withdrawn");
  assert.match(html, /data-approved-by="other"/);
  assert.match(html, /data-disposition="delete"/);
  assert.match(html, /Ningún servicio tiene autorización para este registro/, "a child with no grants says so");
});

test("ages read naturally", () => {
  const now = Date.parse("2026-10-14T12:00:00Z");
  assert.equal(ageLabel("2026-09-20", "es", now), "recién nacido/a");
  assert.equal(ageLabel("2026-02-10", "es", now), "8 meses");
  assert.equal(ageLabel("2022-11-02", "en", now), "3 years");
});

test("lifecycle answer: active, revoked keep, revoked delete, expired, other client", () => {
  const now = Date.parse("2026-10-14T12:00:00Z");
  assert.deepEqual(assessGrant("grt_1", row(), "cli_a", now), {
    assessed_at: "2026-10-14T12:00:00.000Z",
    grant_id: "grt_1",
    held_data: "permitted",
    read_state: "active",
  });
  const keep = assessGrant(
    "grt_1",
    row({ disposition: "keep", grant_status: "revoked", revoked_at: "2026-10-14T10:00:00.000Z" }),
    "cli_a",
    now
  );
  assert.ok("read_state" in keep);
  assert.equal(keep.read_state, "revoked");
  assert.equal(keep.held_data, "permitted");
  const erase = assessGrant(
    "grt_1",
    row({ disposition: "delete", grant_status: "revoked", revoked_at: "2026-10-14T10:00:00.000Z" }),
    "cli_a",
    now
  );
  assert.ok("erasure" in erase && erase.erasure);
  assert.equal(erase.held_data, "erase");
  assert.equal(erase.erasure.stop_use_by, "2026-10-16T10:00:00.000Z");
  const expired = assessGrant("grt_1", row({ expires_at: "2026-10-01T00:00:00.000Z" }), "cli_a", now);
  assert.equal("read_state" in expired && expired.read_state, "expired");
  assert.deepEqual(assessGrant("grt_1", row(), "cli_other", now), { error: "invalid_grant", grant_id: "grt_1" });
  assert.deepEqual(assessGrant("grt_9", null, "cli_a", now), { error: "invalid_grant", grant_id: "grt_9" });
});
