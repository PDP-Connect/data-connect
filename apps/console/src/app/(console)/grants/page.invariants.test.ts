// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
test("Apps reads the complete list and keeps records on the technical route", () => {
  assert.match(read("./load-apps.ts"), /groupGrantAccessByApp\(list.data\)/);
  assert.doesNotMatch(read("./page.tsx"), /listGrants|<details|IcSelect/);
  assert.match(read("./page.tsx"), /href="\/grants\/technical"/);
  assert.match(read("./technical/page.tsx"), /listGrants\(filters\)/);
});
test("old permission addresses resolve through the complete app list", () => {
  assert.match(read("./[grantId]/page.tsx"), /item.grantIds.includes/);
  assert.doesNotMatch(read("./[grantId]/page.tsx"), /listGrants|getGrantTimeline/);
});
test("only explicit confirmation triggers removal, using all registrations", () => {
  assert.match(read("./[grantId]/use-app-removal.ts"), /client_ids: clientIds/);
  assert.match(read("./[grantId]/app-page.tsx"), /role="alertdialog"/);
  assert.match(read("./[grantId]/app-page.tsx"), /Cancel/);
  assert.match(read("./remove-app-action.ts"), /await requireDashboardAccess/);
});
