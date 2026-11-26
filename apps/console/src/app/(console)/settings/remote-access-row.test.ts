// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict"
import { test } from "node:test"
import { remoteAccessWords } from "./remote-access-summary.ts"

const route = (over: Record<string, unknown> = {}) => ({
  handle: { id: "r1", kind: "session" },
  state: "active",
  routeState: "verified",
  cleanup: { state: "none" },
  verification: { status: "verified", vantage: "public", observedAt: null },
  stopRequested: false,
  ...over,
})
const state = (routes: unknown[], phase: string | null = "verified") => ({
  routes,
  reasons: {},
  lifecycle: phase ? { handle: { id: "r1" }, phase, reason: null, cleanup: "none", stopRequested: false } : undefined,
}) as Parameters<typeof remoteAccessWords>[0]

test("no route reads Off", () => {
  assert.equal(remoteAccessWords(state([], null)), "Off")
})
test("a verified route reads On with where it works", () => {
  assert.equal(remoteAccessWords(state([route()])), "On · Works from the internet")
  assert.equal(
    remoteAccessWords(state([route({ verification: { status: "verified", vantage: "tailnet", observedAt: null } })])),
    "On · Works on your devices"
  )
})
test("a route being started reads Turning on", () => {
  assert.equal(remoteAccessWords(state([route({ routeState: "applying", verification: { status: "unverified", vantage: "public", observedAt: null } })], "applying")), "Turning on")
})
test("a lost route reads Needs your action", () => {
  assert.equal(remoteAccessWords(state([route({ state: "lost" })])), "Needs your action")
})
test("a route the owner turned off reads Off", () => {
  assert.equal(remoteAccessWords(state([route({ state: "released", cleanup: { state: "confirmed" }, stopRequested: true })], null)), "Off")
})
