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

function service(input: { listed: () => RouteView[]; identity?: { bootId: string; instanceId: string } }) {
  return { service: new ReachabilityService({} as never, {
    identity: input.identity ?? SAME_BOOT,
    query: { target: TARGET },
  } as never) };
}

test("presentation says Verified only for current proof of this boot and instance", () => {
  const route = scenarios("attached").verified
  const now = Date.now()
  const fresh = {
    ...route,
    expiresAt: { known: true as const, value: new Date(now + 60_000).toISOString() },
    verification: {
      ...route.verification,
      checkedAt: new Date(now - 1000).toISOString(),
      observedAt: new Date(now - 1000).toISOString(),
      validUntil: { known: true as const, value: new Date(now + 60_000).toISOString() },
    },
  }
  const { service: same } = service({ listed: () => [fresh] })
  assert.equal(same.presentation(fresh).label, "Verified")
  const { service: otherBoot } = service({ identity: { bootId: "new-boot", instanceId: "fixture-instance" }, listed: () => [fresh] })
  assert.equal(otherBoot.presentation(fresh).label, "Unpublished")
  const { service: otherInstance } = service({ identity: { bootId: "fixture-boot", instanceId: "another" }, listed: () => [fresh] })
  assert.equal(otherInstance.presentation(fresh).label, "Unpublished")
  const expired = {
    ...fresh,
    verification: { ...fresh.verification, validUntil: { known: true as const, value: new Date(now - 1).toISOString() } },
  }
  assert.equal(same.presentation(expired).label, "Unpublished")
  const unproven = { ...fresh, published: null, verification: { ...fresh.verification, status: "unverified" as const } }
  assert.equal(same.presentation(unproven).label, "Unpublished")
})

// The shape an owner-managed durable route reports: it has no expiry to observe.
function ownerManagedRoute(now: number): RouteView {
  const base = scenarios("durable").verified
  return {
    ...base,
    expiresAt: { known: false as const, reason: "not-observed" },
    handle: { ...base.handle, kind: "external" },
    verification: {
      ...base.verification,
      checkedAt: new Date(now - 1000).toISOString(),
      observedAt: new Date(now - 1000).toISOString(),
      validUntil: { known: true as const, value: new Date(now + 14_000).toISOString() },
    },
  }
}

test("a route with no observable expiry presents as Verified while its proof is fresh", () => {
  const now = Date.now()
  const route = ownerManagedRoute(now)
  const { service: svc } = service({ listed: () => [route] })
  // Control: the same route with an expiry that has not passed is Verified, so the missing expiry is the only difference.
  const bounded = { ...route, expiresAt: { known: true as const, value: new Date(now + 60_000).toISOString() } }
  assert.equal(svc.presentation(bounded).label, "Verified")
  assert.equal(svc.presentation(route).label, "Verified")
})

test("an unknown route expiry never outlives the proof, and a known past expiry still blocks", () => {
  const now = Date.now()
  const route = ownerManagedRoute(now)
  const { service: svc } = service({ listed: () => [route] })
  const lapsed = {
    ...route,
    verification: { ...route.verification, validUntil: { known: true as const, value: new Date(now - 1).toISOString() } },
  }
  assert.equal(svc.presentation(lapsed).label, "Unpublished")
  const unboundedProof = { ...route, verification: { ...route.verification, validUntil: { known: false as const, reason: "not-observed" } } }
  assert.equal(svc.presentation(unboundedProof as RouteView).label, "Unpublished")
  const expired = { ...route, expiresAt: { known: true as const, value: new Date(now - 1).toISOString() } }
  assert.equal(svc.presentation(expired).label, "Unpublished")
  const { service: otherBoot } = service({ identity: { bootId: "new-boot", instanceId: "fixture-instance" }, listed: () => [route] })
  assert.equal(otherBoot.presentation(route).label, "Unpublished")
})
