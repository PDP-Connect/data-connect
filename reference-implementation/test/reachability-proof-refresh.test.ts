// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict"
import test from "node:test"
import type { RouteView } from "@tnunamak/gozar"
import { fakeRouteScenarios } from "@tnunamak/gozar/testing"
import { ReachabilityService } from "../server/reachability/service.ts"

// The library's fixtures carry this identity in their proof subjects.
const SAME_BOOT = { bootId: "fixture-boot", instanceId: "fixture-instance" }
const TARGET = "127.0.0.1:7663"

function scenarios(kind: RouteView["handle"]["kind"]) {
  const all = fakeRouteScenarios({ target: TARGET }).filter((route) => route.handle.kind === kind)
  const pick = (state: RouteView["routeState"]) => {
    const route = all.find((item) => item.routeState === state)
    assert.ok(route, `${kind}/${state}`)
    return { ...route, handle: { ...route.handle, id: `${kind}-${state}` } }
  }
  return { detected: pick("detected"), unconfirmed: pick("cleanup-unconfirmed"), verified: pick("verified") }
}

const confirmed = (route: RouteView): RouteView => ({
  ...route,
  cleanup: { nextAction: null, state: "confirmed" as const },
  published: null,
  state: "released" as const,
})

// The host leaves acknowledgeDisconnect out, as the Docker profile does.
function service(input: {
  listed: () => Promise<RouteView[]> | RouteView[]
  closed?: (route: RouteView) => RouteView
  status?: (route: RouteView) => RouteView | Promise<RouteView>
  identity?: { bootId: string; instanceId: string }
  recoverAtBoot?: boolean
  // The desktop host starts with an empty query target and reads the served target from currentTarget.
  desktopTarget?: boolean
  recoveryRetry?: { timeoutMs?: number; baseDelayMs?: number; maxDelayMs?: number; random?: () => number }
  // When it settles, the watcher reports the route released and ends.
  released?: Promise<RouteView>
  // When it settles, the watcher reports a consent change for the route first.
  consentChanged?: Promise<RouteView>
}) {
  const calls: string[] = []
  const watching = new Map<string, { ended: boolean }>()
  const api = {
    closeRoute: async ({ handle }: { handle: RouteView["handle"] }) => {
      calls.push(`close:${handle.id}`)
      const route = (await input.listed()).find((item) => item.handle.id === handle.id) as RouteView
      return input.closed ? input.closed(route) : confirmed(route)
    },
    listRoutes: async () => ({ routes: await input.listed() }),
    routeStatus: async ({ handle }: { handle: RouteView["handle"] }) => {
      calls.push(`status:${handle.id}`)
      const route = (await input.listed()).find((item) => item.handle.id === handle.id) as RouteView
      return input.status ? await input.status(route) : route
    },
    // The library's watcher emits nothing while a route stays healthy.
    watchRoutes: async function* ({ handle, signal }: { handle: RouteView["handle"]; signal: AbortSignal }) {
      const entry = { ended: false }
      watching.set(handle.id, entry)
      const aborted = new Promise<null>((resolve) => signal.addEventListener("abort", () => resolve(null), { once: true }))
      const changed = signal.aborted || !input.consentChanged ? null : await Promise.race([aborted, input.consentChanged])
      if (changed) {
        yield { route: changed, schemaVersion: 1, sequence: 0, type: "consent_changed" as const }
      }
      const released = signal.aborted ? null : await Promise.race([aborted, input.released ?? aborted])
      entry.ended = true
      if (released) {
        yield { route: released, schemaVersion: 1, sequence: 0, type: "terminal" as const }
      }
    },
  }
  const identity = input.identity ?? SAME_BOOT
  const host = {
    acknowledgeDisconnect: async () => undefined,
    hostCapabilities: {},
    identity,
    prepare: async () => undefined,
    ...(input.desktopTarget ? { currentTarget: async () => TARGET } : {}),
    ...(input.recoverAtBoot ? { recoverAtBoot: true } : {}),
    // Small and deterministic: no test waits on a real backoff.
    recoveryRetry: { baseDelayMs: 1, maxDelayMs: 2, random: () => 1, timeoutMs: 40, ...input.recoveryRetry },
    query: {
      home: "home",
      owner: "owner",
      requirements: {
        address: "any" as const,
        payloadAccess: "allow-provider" as const,
        protocols: [],
        reach: "internet" as const,
        setup: "allow" as const,
        transport: "https" as const,
      },
      schemaVersion: 1 as const,
      target: input.desktopTarget ? "" : TARGET,
    },
  }
  return { calls, service: new ReachabilityService(api as never, host as never), watching }
}
const confined = { known: true as const, value: true }
const iso = (ms: number) => new Date(ms).toISOString()
// Lets work that the fake timers released run to completion.
const settle = () => new Promise((resolve) => setImmediate(resolve))


test("a route re-proved at boot is watched, once, like a route started in this boot", async () => {
  const { verified } = scenarios("durable")
  const { service: svc, watching } = service({ listed: () => [verified] })
  svc.observeHostConfinement(confined)
  await svc.recoverFromLibrary()
  assert.equal(watching.get(verified.handle.id)?.ended, false, "watching after recovery")
  // Checking again does not start a second watcher.
  await svc.check(verified.handle.id, verified.handle.generation)
  assert.equal(watching.size, 1)
  svc.closeObservers()
  await settle()
  assert.equal(watching.get(verified.handle.id)?.ended, true)
})

test("a healthy route still presents as Verified a minute after its first proof lapsed", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_800_000_000_000 })
  const base = scenarios("durable").verified
  // Each status call re-proves the route: proof is valid 15 s from now.
  const proven = (): RouteView => {
    const now = Date.now()
    return {
      ...base,
      expiresAt: { known: true as const, value: iso(now + 600_000) },
      verification: {
        ...base.verification,
        checkedAt: iso(now),
        observedAt: iso(now),
        validUntil: { known: true as const, value: iso(now + 15_000) },
      },
    }
  }
  const { service: svc } = service({ listed: () => [proven()] })
  svc.observeHostConfinement(confined)
  await svc.reconcileKnownHandle(base.handle, false)
  assert.equal(svc.state().lifecycle.phase, "verified")
  for (let second = 0; second < 60; second++) {
    t.mock.timers.tick(1000)
    await settle()
  }
  const [route] = svc.state().routes
  assert.ok(route)
  assert.equal(svc.state().lifecycle.phase, "verified")
  assert.equal(svc.presentation(route).label, "Verified")
  svc.closeObservers()
})

test("a route that stops being proven is withdrawn, not kept as Verified", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_800_000_000_000 })
  const base = scenarios("durable").verified
  let healthy = true
  const proven = (): RouteView => {
    const now = Date.now()
    const route = {
      ...base,
      expiresAt: { known: true as const, value: iso(now + 600_000) },
      verification: {
        ...base.verification,
        checkedAt: iso(now),
        observedAt: iso(now),
        validUntil: { known: true as const, value: iso(now + 15_000) },
      },
    }
    return healthy ? route : { ...route, published: null, verification: { ...route.verification, status: "failed" as never } }
  }
  const { service: svc } = service({ listed: () => [proven()] })
  svc.observeHostConfinement(confined)
  await svc.reconcileKnownHandle(base.handle, false)
  healthy = false
  t.mock.timers.tick(5000)
  await settle()
  const [route] = svc.state().routes
  assert.ok(route)
  assert.notEqual(svc.state().lifecycle.phase, "verified")
  assert.equal(svc.presentation(route).label, "Unpublished")
  svc.closeObservers()
})

test("the proof refresh stops once a route is released or closed", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_800_000_000_000 })
  const { verified } = scenarios("durable")
  let release!: (route: RouteView) => void
  const released = new Promise<RouteView>((resolve) => {
    release = resolve
  })
  const { calls, service: svc } = service({ listed: () => [verified], released })
  svc.observeHostConfinement(confined)
  await svc.reconcileKnownHandle(verified.handle, false)
  release(confirmed(verified))
  await settle()
  calls.length = 0
  for (let second = 0; second < 30; second++) {
    t.mock.timers.tick(1000)
    await settle()
  }
  assert.deepEqual(calls, [], "no status poll after the route was released")

  // A stop that finds cleanup already confirmed also ends the refresh.
  const other = service({ listed: () => [verified], status: confirmed })
  other.service.observeHostConfinement(confined)
  await other.service.reconcileKnownHandle(verified.handle, false).catch(() => undefined)
  assert.equal(other.service.state().routes[0]?.cleanup.state, "confirmed")
  await other.service.stop(verified.handle.id, verified.handle.generation, true)
  other.calls.length = 0
  for (let second = 0; second < 30; second++) {
    t.mock.timers.tick(1000)
    await settle()
  }
  assert.deepEqual(other.calls, [], "no status poll after the route was closed")
})

test("a consent change that lands while a check waits for status wins over that check's late proof", async () => {
  const { verified } = scenarios("durable")
  let held: Promise<void> | null = null
  let answer!: () => void
  let changeConsent!: (route: RouteView) => void
  const consentChanged = new Promise<RouteView>((resolve) => {
    changeConsent = resolve
  })
  const { service: svc } = service({
    consentChanged,
    listed: () => [verified],
    status: async (route) => {
      await held
      return route
    },
  })
  svc.observeHostConfinement(confined)
  await svc.reconcileKnownHandle(verified.handle, false)
  held = new Promise((resolve) => {
    answer = resolve
  })
  const checking = svc.check(verified.handle.id, verified.handle.generation)
  changeConsent(verified)
  await settle()
  assert.equal(svc.state().lifecycle.phase, "review")
  answer()
  // The late proof is superseded: the check settles and the route still needs review.
  const settled = await checking
  assert.equal(settled.handle.id, verified.handle.id)
  assert.equal(svc.state().lifecycle.phase, "review")
  svc.closeObservers()
})

test("a proven route presents as Verified on a host that reads its served target from currentTarget", async () => {
  const base = scenarios("durable").verified
  const now = Date.now()
  const proven: RouteView = {
    ...base,
    expiresAt: { known: true as const, value: iso(now + 600_000) },
    verification: {
      ...base.verification,
      checkedAt: iso(now),
      observedAt: iso(now),
      validUntil: { known: true as const, value: iso(now + 15_000) },
    },
  }
  // The packaged desktop host builds its query with target "" and answers the real target through currentTarget,
  // so a label that compares the proof with query.target alone never reads Verified.
  const { service: svc } = service({ desktopTarget: true, listed: () => [proven] })
  svc.observeHostConfinement(confined)
  await svc.reconcileKnownHandle(base.handle, false)
  assert.equal(svc.state().lifecycle.phase, "verified")
  assert.equal(svc.presentation(proven).label, "Verified")
  svc.closeObservers()
})

test("the same route is not Verified when the host serves a different target", async () => {
  const base = scenarios("durable").verified
  const now = Date.now()
  const proven: RouteView = {
    ...base,
    expiresAt: { known: true as const, value: iso(now + 600_000) },
    verification: {
      ...base.verification,
      checkedAt: iso(now),
      observedAt: iso(now),
      validUntil: { known: true as const, value: iso(now + 15_000) },
    },
  }
  const moved: RouteView = { ...proven, verification: { ...proven.verification, subject: { ...(proven.verification.subject as NonNullable<RouteView["verification"]["subject"]>), target: "127.0.0.1:9" } } }
  const { service: svc } = service({ desktopTarget: true, listed: () => [moved] })
  svc.observeHostConfinement(confined)
  await svc.reconcileKnownHandle(base.handle, false)
  assert.equal(svc.presentation(moved).label, "Unpublished")
  svc.closeObservers()
})
