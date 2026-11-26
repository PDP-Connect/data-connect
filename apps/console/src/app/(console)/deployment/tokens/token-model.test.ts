import assert from "node:assert/strict"
import { test } from "node:test"
import { tokenGroups, buildTokenPractice } from "./token-model.ts"
test("all legacy owner tokens are reachable, without duplicate removal rows", () => {
  const sample = buildTokenPractice("scripts")!
  const groups = tokenGroups(sample.clients, sample.details, sample.owners)
  assert.equal(groups.length, 2)
  assert.equal(
    groups.reduce((n, row) => n + row.tokens.length, 0),
    4
  )
})
for (const state of ["none", "scripts", "created"])
  test(`tokens practice ${state} builds`, () =>
    assert.ok(buildTokenPractice(state)))

test("legacy technical token labels become plain script names", () => {
  const groups = tokenGroups([], {}, [{ id: "practice", label: "PDPP CLI bearer", createdAt: "2026-11-24T10:00:00Z", expiresAt: null }]);
  assert.equal(groups[0]!.name, "Script or tool");
  assert.equal(groups[0]!.tokens.length, 1);
});
