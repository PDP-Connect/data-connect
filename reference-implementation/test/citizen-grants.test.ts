// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// DR demo: citizen "Mis autorizaciones" data assembly and the ES | EN shell toggle.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type CitizenGrantsDeps,
  listCitizenAuthorizations,
  revokeCitizenAuthorization,
} from "../server/citizen-grants.ts";
import { citizenLangHref, renderCitizenDocument } from "../server/citizen-ui.ts";

const NOW = Date.parse("2026-10-01T12:00:00Z");
const END = "2027-02-01T03:59:59.000Z";

function grantJson(source: string, stream: string, issuedAt: string): string {
  return JSON.stringify({
    issued_at: issuedAt,
    purpose_code: "https://map.gob.do/purpose/servicios-proactivos-nacimiento",
    purpose_description: "Preparar la vacunación",
    source: { id: source, kind: "connector" },
    streams: [{ fields: ["id", "nombre"], name: stream }],
  });
}

// Package gpkg_1 = sns + siuben grants from one consent; grt_old = older, revoked; grt_exp = expired.
const ROWS: Record<string, { expiresAt: string | null; grantJson: string }> = {
  grt_exp: {
    expiresAt: "2026-09-30T00:00:00Z",
    grantJson: grantJson("siuben", "miembros_hogar", "2026-09-02T00:00:00Z"),
  },
  grt_old: { expiresAt: null, grantJson: grantJson("siuben", "clasificacion_hogar", "2026-09-01T00:00:00Z") },
  grt_siuben: { expiresAt: END, grantJson: grantJson("siuben", "clasificacion_hogar", "2026-09-25T10:00:00Z") },
  grt_sns: { expiresAt: END, grantJson: grantJson("sns", "control_prenatal", "2026-09-25T10:00:00Z") },
};
const EVENTS: Record<string, { event_type: string; occurred_at: string; stream_id?: string; data?: unknown }[]> = {
  grt_old: [
    { event_type: "grant.issued", occurred_at: "2026-09-01T00:00:00Z" },
    { event_type: "grant.revoked", occurred_at: "2026-09-03T00:00:00Z" },
  ],
  grt_siuben: [
    {
      data: { source_declaration_snapshot: { declaration: { display: { name: "SIUBEN (demo)" } } } },
      event_type: "grant.issued",
      occurred_at: "2026-09-25T10:00:00Z",
    },
    { event_type: "disclosure.served", occurred_at: "2026-09-25T10:05:00Z", stream_id: "clasificacion_hogar" },
  ],
  grt_sns: [{ event_type: "disclosure.served", occurred_at: "2026-09-25T10:06:00Z", stream_id: "control_prenatal" }],
};

const deps: CitizenGrantsDeps = {
  listGrantEvents: async (id) => EVENTS[id] ?? [],
  listSpineCorrelations: async () =>
    ({
      hasMore: false,
      summaries: [
        { client_id: "cli_1", id: "grt_old" },
        { client_id: "cli_1", grant_package_id: "gpkg_1", id: "grt_sns" },
        { client_id: "cli_1", id: "grt_exp" },
        { client_id: "cli_1", grant_package_id: "gpkg_1", id: "grt_siuben" },
      ],
    }) as never,
  readGrant: async (id) => ROWS[id] ?? null,
};

test("groups one consent's grants into one authorization, newest first", async () => {
  const auths = await listCitizenAuthorizations(deps, NOW);

  assert.deepEqual(
    auths.map((auth) => [auth.grantIds, auth.status]),
    [
      [["grt_siuben", "grt_sns"], "active"],
      [["grt_exp"], "expired"],
      [["grt_old"], "revoked"],
    ]
  );
  const [pkg] = auths;
  assert.equal(pkg?.expiresAt, END);
  assert.deepEqual(
    pkg?.reads.map((read) => read.stream),
    ["control_prenatal", "clasificacion_hogar"]
  );
  assert.deepEqual(
    pkg?.sources.map((source) => source.name),
    ["SIUBEN (demo)", "sns"]
  );
  assert.equal(auths[2]?.revokedAt, "2026-09-03T00:00:00Z");
});

test("revoking a packaged grant revokes the whole package; a lone grant revokes itself", async () => {
  const calls: string[] = [];
  const revokeDeps = {
    packageIdForGrant: async (id: string) => (id === "grt_sns" ? "gpkg_1" : null),
    revokeGrant: (id: string) => {
      calls.push(`grant:${id}`);
      return Promise.resolve();
    },
    revokePackage: (id: string) => {
      calls.push(`package:${id}`);
      return Promise.resolve();
    },
  };

  await revokeCitizenAuthorization(revokeDeps, "grt_sns");
  await revokeCitizenAuthorization(revokeDeps, "grt_old");

  assert.deepEqual(calls, ["package:gpkg_1", "grant:grt_old"]);
});

test("language toggle keeps the current query and marks the active language", () => {
  assert.equal(citizenLangHref("/consent?request_uri=x&lang=es", "en"), "/consent?request_uri=x&lang=en");
  assert.equal(citizenLangHref("", "en"), "?lang=en");

  const html = renderCitizenDocument({
    body: "",
    currentUrl: "/owner/login?return_to=%2Foauth%2Fauthorize",
    lang: "en",
    shell: "cuenta-unica",
    title: "t",
  });
  assert.ok(html.includes('<html lang="en">'));
  assert.ok(html.includes("Demo environment · fictitious data"));
  assert.ok(
    html.includes(
      'data-lang-toggle="en" href="/owner/login?return_to=%2Foauth%2Fauthorize&amp;lang=en" hreflang="en" aria-current="true"'
    )
  );
  assert.ok(html.includes('lang=es" hreflang="es">ES</a>'));
});

test("shell defaults to Spanish", () => {
  const html = renderCitizenDocument({ body: "", shell: "citizen-grants", title: "t" });
  assert.ok(html.includes("Entorno de demostración · datos ficticios"));
  assert.ok(html.includes("Vista simulada de cómo podría verse en Soy Yo RD"));
  assert.ok(html.includes('data-lang-toggle="es" href="?lang=es" hreflang="es" aria-current="true"'));
});
