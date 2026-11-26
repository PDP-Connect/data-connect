// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { ReachabilitySetups } from "../../../../reference-implementation/server/reachability/setups.ts"
import { migrateLegacySetupReservations } from "./legacy-setup-reservations.ts"

const setups = "reachability-setup-reservations-v1"
const draft = "reachability-draft"
const record = (operationId: string) => ({
  operationId, providerId: "provider", providerLabel: "Provider", draftId: "draft",
  actionId: "action", expectedConfigurationRevision: "revision", usage: "personal",
})
const ok = (data: unknown) => ({ ok: true as const, data })
function store(key: string, value: string | null = null) {
  const data = new Map<string, string>()
  if (value !== null) data.set(key, value)
  return {
    getItem: (name: string) => data.get(name) ?? null,
    setItem: (name: string, raw: string) => { data.set(name, raw) },
    removeItem: (name: string) => { data.delete(name) },
  }
}
const storesWith = (local: string | null, session: string | null = null) => ({
  local: store(setups, local), session: store(draft, session),
})

test("mixed legacy rows retain unsupported JSON tokens without reserialization", async () => {
  const unsupported = '{ "large": 9007199254740993123, "escapes": "\\u0061,]" }'
  const stores = storesWith(`[${JSON.stringify(record("one"))},${unsupported},null]`)
  const result = await migrateLegacySetupReservations(async (_, body) => {
    assert.equal(body?.operationId, "one")
    return ok({ adopted: true })
  }, stores)
  assert.equal(stores.local.getItem(setups), `[${unsupported},null]`)
  assert.equal(result.adopted, 1)
  assert.equal(result.deferred, 2)
})

test("unreadable storage is retained and reported deferred", async () => {
  for (const raw of ["{broken", '{"not":"a list"}']) {
    const stores = storesWith(raw, "{broken")
    const result = await migrateLegacySetupReservations(async () => assert.fail("unexpected request"), stores)
    assert.deepEqual(result, { adopted: 0, dropped: 0, deferred: 1, cleanup: 0, draft: "deferred" })
    assert.equal(stores.local.getItem(setups), raw)
    assert.equal(stores.session.getItem(draft), "{broken")
  }
})

test("adoption and cleanup acknowledgments are checkpointed before a later throw", async () => {
  const stores = storesWith(JSON.stringify(["first", "second", "last"].map(record)))
  const calls: unknown[] = []
  await assert.rejects(migrateLegacySetupReservations(async (_, body) => {
    calls.push(body?.operationId)
    if (calls.length === 1) return ok({ adopted: true })
    if (calls.length === 2) return ok({ adopted: false, reason: "needs_cleanup" })
    assert.deepEqual(JSON.parse(stores.local.getItem(setups)!), [record("last")])
    throw new Error("interrupted")
  }, stores), /interrupted/)
  await migrateLegacySetupReservations(async (_, body) => {
    calls.push(body?.operationId)
    return ok({ adopted: true })
  }, stores)
  assert.deepEqual(calls, ["first", "second", "last", "last"])
})

test("response removes only the unchanged original from the latest browser array", async () => {
  const original = record("same")
  const replacement = { ...original, providerLabel: "new label" }
  const other = record("added")
  for (const latest of [[original, other], [replacement, other]]) {
    const stores = storesWith(JSON.stringify([original]))
    let respond!: () => void
    const pending = migrateLegacySetupReservations(
      () => new Promise(resolve => { respond = () => resolve(ok({ adopted: true })) }),
      stores
    )
    stores.local.setItem(setups, JSON.stringify(latest))
    respond()
    await pending
    assert.deepEqual(JSON.parse(stores.local.getItem(setups)!), latest.filter(row => row !== original))
  }
})

test("draft clears only for explicit Host outcomes and only if still the original", async () => {
  const raw = JSON.stringify({ providerId: "provider", draftId: "first" })
  const replacement = JSON.stringify({ providerId: "provider", draftId: "later" })
  for (const data of [
    { adopted: true }, { adopted: false, reason: "unknown" },
    { adopted: false, reason: "service_has_draft" }, { adopted: false }, null,
  ]) {
    const stores = storesWith(null, raw)
    const result = await migrateLegacySetupReservations(async () => ok(data), stores)
    const settled = !!data && (data.adopted || "reason" in data)
    assert.equal(result.draft, settled ? "sent" : "deferred")
    assert.equal(stores.session.getItem(draft), settled ? null : raw)
  }
  const stores = storesWith(null, raw)
  let respond!: () => void
  const pending = migrateLegacySetupReservations(
    () => new Promise(resolve => { respond = () => resolve(ok({ adopted: true })) }),
    stores
  )
  stores.session.setItem(draft, replacement)
  respond()
  await pending
  assert.equal(stores.session.getItem(draft), replacement)
})

test("the Host journal idempotently adopts the same operation after a browser checkpoint loss", async t => {
  const root = await mkdtemp(join(tmpdir(), "legacy-setup-journal-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const legacy = record("same")
  const journal = new ReachabilitySetups(root)
  const input = {
    providerId: legacy.providerId, providerLabel: legacy.providerLabel,
    draftId: legacy.draftId, usage: legacy.usage, committed: false,
    setup: { operationId: legacy.operationId, actionId: legacy.actionId,
      expectedConfigurationRevision: legacy.expectedConfigurationRevision },
  }
  assert.equal((await journal.adoptSetup(input)).adopted, true)
  const restarted = new ReachabilitySetups(root)
  assert.equal((await restarted.adoptSetup(input)).adopted, true)
  assert.deepEqual(await restarted.list(), [{ ...input, cleanup: [] }])
})
