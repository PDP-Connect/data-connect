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
  status?: (route: RouteView) => RouteView
  identity?: { bootId: string; instanceId: string }
  recoverAtBoot?: boolean
  recoveryRetry?: { timeoutMs?: number; baseDelayMs?: number; maxDelayMs?: number; random?: () => number }
  // When it settles, the watcher reports the route released and ends.
  released?: Promise<RouteView>
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
      return input.status ? input.status(route) : route
    },
    // The library's watcher emits nothing while a route stays healthy.
    watchRoutes: async function* ({ handle, signal }: { handle: RouteView["handle"]; signal: AbortSignal }) {
      const entry = { ended: false }
      watching.set(handle.id, entry)
      const aborted = new Promise<null>((resolve) => signal.addEventListener("abort", () => resolve(null), { once: true }))
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
      target: TARGET,
    },
  }
  return { calls, service: new ReachabilityService(api as never, host as never), watching }
}
const confined = { known: true as const, value: true }
const codeOf = (code: string) => (error: unknown) => (error as { code?: string }).code === code

test("recovery closes an attached route the previous boot left and records the result", async () => {
  const { verified } = scenarios("attached")
  const { calls, service: svc } = service({ listed: () => [verified] })
  svc.observeHostConfinement(confined)
  assert.deepEqual(await svc.recoverFromLibrary(), { closed: 1, failed: 0, reproved: 0 })
  assert.deepEqual(calls, [`close:${verified.handle.id}`])
  const [route] = svc.state().routes
  assert.equal(route?.cleanup.state, "confirmed")
  assert.equal(route?.published, null)
})

test("recovery re-proves a durable route and never trusts the old proof", async () => {
  const { verified } = scenarios("durable")
  // The library answers the proof request; the old proof names the previous boot.
  const { calls, service: svc } = service({
    identity: { bootId: "this-boot", instanceId: "fixture-instance" },
    listed: () => [verified],
  })
  svc.observeHostConfinement(confined)
  assert.deepEqual(await svc.recoverFromLibrary(), { closed: 0, failed: 0, reproved: 1 })
  assert.ok(calls.includes(`status:${verified.handle.id}`))
  assert.ok(!calls.some((call) => call.startsWith("close:")))
  const [route] = svc.state().routes
  assert.ok(route)
  // Proof from another boot is not "Verified" here, whatever the route says.
  assert.notEqual(route.verification.subject?.bootId, "this-boot")
})

test("unconfirmed cleanup after recovery blocks a new start and a commit", async () => {
  const { verified } = scenarios("attached")
  const { service: svc } = service({
    closed: (route) => ({ ...route, cleanup: { nextAction: null, state: "unconfirmed" }, routeState: "cleanup-unconfirmed" }),
    listed: () => [verified],
  })
  svc.observeHostConfinement(confined)
  assert.deepEqual(await svc.recoverFromLibrary(), { closed: 1, failed: 0, reproved: 0 })
  assert.equal(svc.state().routes[0]?.cleanup.state, "unconfirmed")
  await assert.rejects(svc.commit("draft", "r1"), { code: "configuration_in_use" })
})

test("an unreadable library is not an empty one: new starts stay blocked", async () => {
  const { service: svc } = service({
    listed: () => {
      throw new Error("library unreadable")
    },
  })
  svc.observeHostConfinement(confined)
  await assert.rejects(svc.recoverFromLibrary(), codeOf("recovery_timed_out"))
  await assert.rejects(svc.commit("draft", "r1"), { code: "configuration_in_use" })
})

test("a close that failed at boot blocks starts only until the route is closed", async () => {
  const { verified } = scenarios("attached")
  let failClose = true
  const { service: svc } = service({
    closed: (route) => {
      if (failClose) {
        throw new Error("close failed")
      }
      return confirmed(route)
    },
    listed: () => [verified],
  })
  svc.observeHostConfinement(confined)
  assert.deepEqual(await svc.recoverFromLibrary(), { closed: 0, failed: 1, reproved: 0 })
  assert.deepEqual(svc.state().recovery, {
    actions: [],
    blockedBy: "routes_unsettled",
    pending: false,
    unsettled: [verified.handle.id],
  })
  await assert.rejects(svc.commit("draft", "r1"), codeOf("configuration_in_use"))
  failClose = false
  await svc.stop(verified.handle.id, verified.handle.generation, false)
  assert.deepEqual(svc.state().recovery, { actions: [], blockedBy: null, pending: false, unsettled: [] })
  // No longer refused as busy: the draft simply does not exist.
  await assert.rejects(svc.commit("draft", "r1"), codeOf("draft_not_found"))
})

test("a route that could not be re-proved at boot stops blocking once it is observed gone", async () => {
  const { verified } = scenarios("durable")
  let reachable = false
  const { service: svc } = service({
    listed: () => [verified],
    status: () => {
      throw Object.assign(new Error("status"), { code: reachable ? "route_not_found" : "provider_unavailable" })
    },
  })
  svc.observeHostConfinement(confined)
  assert.deepEqual(await svc.recoverFromLibrary(), { closed: 0, failed: 1, reproved: 0 })
  assert.equal(svc.state().recovery.blockedBy, "routes_unsettled")
  reachable = true
  await assert.rejects(svc.check(verified.handle.id, verified.handle.generation), codeOf("route_not_found"))
  assert.equal(svc.state().recovery.blockedBy, null)
  svc.closeObservers()
})

test("a library that cannot be listed blocks starts, and a later successful listing clears it", async () => {
  let readable = false
  const { service: svc } = service({
    listed: () => {
      if (!readable) {
        throw new Error("library unreadable")
      }
      return []
    },
  })
  svc.observeHostConfinement(confined)
  await assert.rejects(svc.recoverFromLibrary(), codeOf("recovery_timed_out"))
  assert.equal(svc.state().recovery.blockedBy, "recovery_timed_out")
  readable = true
  await svc.recoverFromLibrary()
  assert.equal(svc.state().recovery.blockedBy, null)
  assert.equal(svc.state().lifecycle.phase, "inactive")
})

test("requests that change routes are refused until boot recovery settles, then allowed", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const { service: svc } = service({
    listed: async () => {
      await gate
      return []
    },
    recoverAtBoot: true,
  })
  svc.observeHostConfinement(confined)
  // The listener is up before recovery starts, and again while it runs.
  const refused = () =>
    Promise.all(
      [
        svc.begin("provider", "r1"),
        svc.review("draft", { kind: "attached" }),
        svc.commit("draft", "r1"),
        svc.recoverOperation({ operationId: "op" } as never, "check", false),
      ].map((attempt) => assert.rejects(attempt, codeOf("recovery_in_progress")))
    )
  await refused()
  const recovery = svc.recoverFromLibrary()
  await refused()
  assert.equal(svc.state().recovery.pending, true)
  release()
  await recovery
  assert.equal(svc.state().recovery.pending, false)
  await assert.rejects(svc.commit("draft", "r1"), codeOf("draft_not_found"))
})

test("boot recovery that fails still ends the wait, and says why starts stay blocked", async () => {
  const { service: svc } = service({
    listed: () => {
      throw new Error("library unreadable")
    },
    recoverAtBoot: true,
  })
  await assert.rejects(svc.recoverFromLibrary(), codeOf("recovery_timed_out"))
  assert.deepEqual(svc.state().recovery, {
    actions: ["check"],
    blockedBy: "recovery_timed_out",
    pending: false,
    unsettled: [],
  })
  await assert.rejects(svc.commit("draft", "r1"), codeOf("configuration_in_use"))
})

test("a host with no disconnect acknowledgement hook stops a route without one", async () => {
  const { verified } = scenarios("durable")
  const { service: svc } = service({ listed: () => [verified] })
  svc.observeHostConfinement(confined)
  await svc.reconcileKnownHandle(verified.handle, false)
  const closed = await svc.stop(verified.handle.id, verified.handle.generation, false)
  assert.equal(closed.cleanup.state, "confirmed")
  await svc.authorizeDisconnect(false)
})

test("boot recovery retries a failing listRoutes with backoff until it answers", async () => {
  let calls = 0
  const { service: svc } = service({
    listed: () => {
      if (++calls <= 3) throw new Error("library unreadable")
      return []
    },
    recoverAtBoot: true,
    recoveryRetry: { timeoutMs: 5_000 },
  })
  assert.deepEqual(await svc.recoverFromLibrary(), { closed: 0, failed: 0, reproved: 0 })
  assert.equal(calls, 4)
  assert.equal(svc.state().recovery.blockedBy, null)
  assert.equal(svc.state().lifecycle.phase, "inactive")
})

test("backoff delays double up to the cap and are jittered", async () => {
  const stamps: number[] = []
  const { service: svc } = service({
    listed: () => {
      stamps.push(Date.now())
      if (stamps.length <= 3) throw new Error("library unreadable")
      return []
    },
    recoverAtBoot: true,
    recoveryRetry: { baseDelayMs: 20, maxDelayMs: 40, random: () => 1, timeoutMs: 5_000 },
  })
  await svc.recoverFromLibrary()
  const gaps = stamps.slice(1).map((at, index) => at - (stamps[index] as number))
  // Ceilings 20, 40, 40 (capped); a zero jitter draw waits no time at all.
  assert.ok((gaps[0] ?? 0) >= 15 && (gaps[1] ?? 0) >= 35 && (gaps[2] ?? 0) >= 35, `gaps ${gaps}`)
  assert.ok((gaps[2] ?? 0) < 200, `capped: ${gaps}`)
})

test("a listRoutes that always fails ends as unknown, possibly live, never off or failed", async () => {
  const { service: svc } = service({
    listed: () => {
      throw new Error("library unreadable")
    },
    recoverAtBoot: true,
  })
  await assert.rejects(svc.recoverFromLibrary(), codeOf("recovery_timed_out"))
  const state = svc.state()
  assert.equal(state.lifecycle.phase, "unknown")
  assert.equal(state.lifecycle.reason, "unknown-possibly-live")
  assert.equal(state.lifecycle.cleanup, "unconfirmed")
  assert.notEqual(state.lifecycle.phase, "failed")
  assert.notEqual(state.lifecycle.phase, "inactive")
  assert.equal(state.recovery.pending, false)
  assert.deepEqual(state.recovery.actions, ["check"])
  await assert.rejects(svc.commit("draft", "r1"), codeOf("configuration_in_use"))
})

test("a listRoutes that hangs is abandoned when the deadline fires", async () => {
  const { service: svc } = service({
    listed: () => new Promise<RouteView[]>(() => undefined),
    recoverAtBoot: true,
    recoveryRetry: { timeoutMs: 30 },
  })
  const started = Date.now()
  await assert.rejects(svc.recoverFromLibrary(), codeOf("recovery_timed_out"))
  assert.ok(Date.now() - started < 1_000)
  assert.equal(svc.state().lifecycle.reason, "unknown-possibly-live")
  assert.equal(svc.state().recovery.pending, false)
})
