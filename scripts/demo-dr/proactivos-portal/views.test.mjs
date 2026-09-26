// Run: node --test scripts/demo-dr/proactivos-portal/views.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { LANG, renderListo } from "./views.mjs";

// The citizen unticked the household-count field but kept the member list.
const GRANTED = {
  clasificacion_hogar: ["id", "icv_grupo", "icv_descripcion", "municipio", "provincia", "source_updated_at"],
  control_prenatal: ["id", "fecha_probable_parto", "semanas_gestacion", "source_updated_at"],
  miembros_hogar: ["id", "hogar_id", "nombre", "parentesco", "edad"],
};

const RESULT = {
  grant: { granted: GRANTED, ids: ["gpkg_test"], revoked: false, sources: ["sns", "siuben"], until: "2027-01-31T23:59:59-04:00" },
  hogar: { icv_descripcion: "Pobreza moderada", icv_grupo: "ICV-2", id: "h1", municipio: "Santo Domingo Este", provincia: "Santo Domingo" },
  miembros: [
    { edad: 29, id: "m1", nombre: "María", parentesco: "Jefa del hogar" },
    { edad: 31, id: "m2", nombre: "Luis", parentesco: "Cónyuge" },
  ],
  prenatal: { fecha_probable_parto: "2026-11-20", id: "p1", semanas_gestacion: 32 },
  receivedAt: new Date("2026-09-25T12:00:00Z"),
};

test("an unticked household-count field shows as not shared, not derived from the member list", () => {
  const html = renderListo({ lang: LANG.EN, misAutorizacionesUrl: "/owner/autorizaciones", path: "/listo", result: RESULT });

  assert.match(html, /data-not-shared="miembros_hogar_count"/);
  assert.doesNotMatch(html, /Household members<\/dt><dd>2<\/dd>/);
});
