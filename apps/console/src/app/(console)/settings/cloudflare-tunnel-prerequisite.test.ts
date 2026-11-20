// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { mock, test } from "node:test"
import { fileURLToPath } from "node:url"
import { JSDOM } from "jsdom"
import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import {
  CLOUDFLARE_TUNNEL_POLL_FETCH_FAILED_REASON,
  CLOUDFLARE_TUNNEL_POLL_TIMEOUT_REASON,
  CloudflareTunnelConnectionBanner,
  decodeCloudflareTunnelToken,
  nextConnectionStatus,
} from "./cloudflare-tunnel-prerequisite.tsx"
import { OriginVerificationStatus } from "./origin-verification-status.tsx"
import { offRemoteAccessConfig, originVerificationDisplay, type RemoteAccessConfig } from "./remote-access.ts"

// The exact tunnel ID from Tim's own real Cloudflare dashboard tunnel
// ("DataConnect Testing"), confirmed live 2026-09-21 -- using a real,
// previously-observed ID here rather than an arbitrary one keeps this test
// traceable to something that actually happened, not just plausible-looking
// fiction.
const HERE = fileURLToPath(new URL(".", import.meta.url))

const REAL_TUNNEL_ID = "f0b57337-ae5b-493d-a9af-949a334f28b0"

function encodeToken(payload: Record<string, unknown>): string {
  return btoa(JSON.stringify(payload))
}

test("decodes a well-formed token into its account and tunnel IDs", () => {
  const token = encodeToken({
    a: "0123456789abcdef0123456789abcdef",
    t: REAL_TUNNEL_ID,
    s: "c29tZXNlY3JldA==",
  })
  const result = decodeCloudflareTunnelToken(token)
  assert.deepEqual(result, {
    ok: true,
    accountId: "0123456789abcdef0123456789abcdef",
    tunnelId: REAL_TUNNEL_ID,
  })
})

test("decodes correctly even with the optional endpoint field present", () => {
  // `connection.TunnelToken.Endpoint` (`"e"`) is `omitempty` in cloudflared's
  // own struct -- present on some tokens, absent on others. Must not affect
  // decoding either way.
  const token = encodeToken({
    a: "0123456789abcdef0123456789abcdef",
    t: REAL_TUNNEL_ID,
    s: "c29tZXNlY3JldA==",
    e: "198.51.100.1:7844",
  })
  const result = decodeCloudflareTunnelToken(token)
  assert.equal(result.ok, true)
})

test("never includes the secret field anywhere in a successful decode result", () => {
  const secret = "c29tZXNlY3JldA=="
  const token = encodeToken({
    a: "0123456789abcdef0123456789abcdef",
    t: REAL_TUNNEL_ID,
    s: secret,
  })
  const result = decodeCloudflareTunnelToken(token)
  assert.ok(!JSON.stringify(result).includes(secret))
})

test("rejects an empty string", () => {
  assert.deepEqual(decodeCloudflareTunnelToken(""), { ok: false, reason: "empty" })
  assert.deepEqual(decodeCloudflareTunnelToken("   "), { ok: false, reason: "empty" })
})

test("rejects a value that is not valid base64", () => {
  assert.deepEqual(decodeCloudflareTunnelToken("not valid base64!!!"), {
    ok: false,
    reason: "not-base64",
  })
})

test("rejects base64 that does not decode to JSON", () => {
  // btoa("hello") decodes cleanly as base64 but "hello" is not JSON.
  assert.deepEqual(decodeCloudflareTunnelToken(btoa("hello")), {
    ok: false,
    reason: "not-json",
  })
})

test("rejects valid JSON missing the account or tunnel fields", () => {
  assert.deepEqual(decodeCloudflareTunnelToken(encodeToken({ s: "onlyasecret" })), {
    ok: false,
    reason: "missing-fields",
  })
  assert.deepEqual(
    decodeCloudflareTunnelToken(encodeToken({ a: "account-only" })),
    { ok: false, reason: "missing-fields" }
  )
})

test("rejects a tunnel ID that is not a well-formed UUID", () => {
  // google/uuid (what cloudflared itself uses) marshals TunnelID to the
  // standard hyphenated form -- "not-a-uuid" could never be a real token.
  const token = encodeToken({ a: "account123", t: "not-a-uuid", s: "secret" })
  assert.deepEqual(decodeCloudflareTunnelToken(token), {
    ok: false,
    reason: "missing-fields",
  })
})

test("rejects a whole install command pasted instead of just the token", () => {
  // The single most likely real paste mistake, since Cloudflare's dashboard
  // shows a full `cloudflared service install <TOKEN>` (or `docker run ...
  // --token <TOKEN>`) command, not a bare token by itself.
  const token = encodeToken({
    a: "0123456789abcdef0123456789abcdef",
    t: REAL_TUNNEL_ID,
    s: "c29tZXNlY3JldA==",
  })
  const wholeCommand = `cloudflared service install ${token}`
  const result = decodeCloudflareTunnelToken(wholeCommand)
  assert.equal(result.ok, false)
})

test("a saved origin is not a verified connection and still times out", () => {
  const config = {
    ...offRemoteAccessConfig(),
    posture: "public_url" as const,
    provider: "cloudflare_tunnel" as const,
    fields: { ...offRemoteAccessConfig().fields, PDPP_REFERENCE_ORIGIN: "saved-origin" },
  }
  assert.deepEqual(nextConnectionStatus({ kind: "config", config }, 4000), {
    phase: "connecting", elapsedSeconds: 4,
  })
  assert.deepEqual(nextConnectionStatus({ kind: "config", config }, 45_000), {
    phase: "failed", reason: CLOUDFLARE_TUNNEL_POLL_TIMEOUT_REASON,
  })
})

test("connected requires a fresh matching proof and a running agent", () => {
  const now = 1000
  const config = {
    ...offRemoteAccessConfig(),
    posture: "public_url" as const,
    fields: { ...offRemoteAccessConfig().fields, PDPP_REFERENCE_ORIGIN: "saved-origin" },
    origin_verified: {
      origin: "saved-origin", checked_at: now, stale_after: 150,
      outcome: { kind: "reaches_this_console" as const },
      binding: { kind: "owner_maintained" as const, where_to_set: "the dashboard", action_url: null },
      agent: "running" as const,
    },
  }
  assert.deepEqual(nextConnectionStatus({ kind: "config", config }, 4000, now), {
    phase: "connected", origin: "saved-origin",
  })
  assert.deepEqual(nextConnectionStatus({ kind: "config", config }, 4000, now + 151), {
    phase: "connecting", elapsedSeconds: 4,
  })
  for (const change of [
    { origin: "previous-origin" },
    { checked_at: now - 151 },
    { agent: "exited" as const },
    { outcome: { kind: "unreachable" as const, reason: "No response" } },
    { outcome: { kind: "reaches_something_else" as const, status: 404 } },
  ]) {
    assert.deepEqual(nextConnectionStatus({
      kind: "config", config: { ...config, origin_verified: { ...config.origin_verified, ...change } },
    }, 4000, now), { phase: "connecting", elapsedSeconds: 4 })
  }
  assert.deepEqual(nextConnectionStatus({
    kind: "config", config: { ...config, tunnel_error: "Stopped" },
  }, 4000, now), { phase: "failed", reason: "Stopped" })
})

test("nextConnectionStatus reports the real tunnel_error the moment it appears, before the timeout", () => {
  const config = { ...offRemoteAccessConfig(), tunnel_error: "cloudflared exited before reporting a connection" }
  assert.deepEqual(nextConnectionStatus({ kind: "config", config }, 4000), {
    phase: "failed",
    reason: "cloudflared exited before reporting a connection",
  })
})

test("nextConnectionStatus keeps waiting while there is no origin and no error yet, before the timeout", () => {
  assert.deepEqual(
    nextConnectionStatus({ kind: "config", config: offRemoteAccessConfig() }, 6000),
    { phase: "connecting", elapsedSeconds: 6 }
  )
})

test("nextConnectionStatus times out honestly once the poll window elapses with no origin or error", () => {
  assert.deepEqual(
    nextConnectionStatus({ kind: "config", config: offRemoteAccessConfig() }, 45_000),
    { phase: "failed", reason: CLOUDFLARE_TUNNEL_POLL_TIMEOUT_REASON }
  )
})

test("nextConnectionStatus keeps retrying a failed status fetch until its own timeout, not the first failure", () => {
  assert.deepEqual(nextConnectionStatus({ kind: "fetch-failed" }, 4000), {
    phase: "connecting",
    elapsedSeconds: 4,
  })
})

test("nextConnectionStatus gives up on repeated fetch failures once the poll window elapses", () => {
  assert.deepEqual(nextConnectionStatus({ kind: "fetch-failed" }, 45_000), {
    phase: "failed",
    reason: CLOUDFLARE_TUNNEL_POLL_FETCH_FAILED_REASON,
  })
})

test("the tunnel walkthrough URL is only ever a link target, never unclickable text", async () => {
  // Printed as text beside the link, it looks clickable and is not.
  for (const file of ["cloudflare-tunnel-prerequisite.tsx", "remote-access-setting.tsx"]) {
    const source = await readFile(`${HERE}${file}`, "utf8")
    assert.match(source, /href=\{CLOUDFLARE_TUNNEL_SETUP_URL\}/, `${file} must link the walkthrough`)
    assert.doesNotMatch(source, /(?<!=)\{\s*CLOUDFLARE_TUNNEL_SETUP_URL\s*\}/, `${file} prints the URL as text`)
  }
})

test("verified connection copy is explicit", () => {
  const markup = renderToStaticMarkup(createElement(CloudflareTunnelConnectionBanner, {
    status: { phase: "connected", origin: "saved-origin" },
  }))
  assert.match(markup, /Verified connection/)
  assert.doesNotMatch(markup, /Whether this/)
})

test("an exited agent never renders a current verified claim", () => {
  const markup = renderToStaticMarkup(createElement(OriginVerificationStatus, {
    consolePort: null, origin: "saved-origin",
    display: {
      reading: { kind: "reaches_this_console", checkedAt: 1000 },
      binding: null, agentExited: true,
    },
  }))
  assert.doesNotMatch(markup, /this address reaches this DataConnect/)
  assert.match(markup, /process has since stopped/)
})

function verifiedConfig(): RemoteAccessConfig {
  return {
    ...offRemoteAccessConfig(),
    posture: "public_url",
    provider: "cloudflare_tunnel",
    fields: { ...offRemoteAccessConfig().fields, PDPP_REFERENCE_ORIGIN: "saved-origin" },
    origin_verified: {
      origin: "saved-origin", checked_at: 1000, stale_after: 150,
      outcome: { kind: "reaches_this_console" },
      binding: { kind: "owner_maintained", where_to_set: "the dashboard", action_url: null },
      agent: "running",
    },
  }
}

for (const [label, agent] of [
  ["missing", undefined], ["null", null], ["stopped", "stopped"],
] as const) {
  test(`Cloudflare rejects a fresh proof with a ${label} agent`, () => {
    const config = verifiedConfig()
    assert.ok(config.origin_verified)
    if (agent === undefined) delete config.origin_verified.agent
    else config.origin_verified.agent = agent
    assert.deepEqual(nextConnectionStatus({ kind: "config", config }, 4000, 1000), {
      phase: "connecting", elapsedSeconds: 4,
    })
  })
  test(`Cloudflare shows historical proof with a ${label} agent`, () => {
    const config = verifiedConfig()
    assert.ok(config.origin_verified)
    if (agent === undefined) delete config.origin_verified.agent
    else config.origin_verified.agent = agent
    const markup = renderToStaticMarkup(createElement(OriginVerificationStatus, {
      consolePort: null, origin: "saved-origin", display: originVerificationDisplay(config, 1000),
    }))
    assert.doesNotMatch(markup, /this address reaches this DataConnect/)
    assert.match(markup, /verified earlier/)
  })
}

test("supervised ngrok proof requires a running agent", () => {
  for (const agent of [undefined, null, "stopped", "exited", "running"] as const) {
    const config = verifiedConfig()
    config.provider = "ngrok"
    assert.ok(config.origin_verified)
    if (agent === undefined) delete config.origin_verified.agent
    else config.origin_verified.agent = agent
    assert.equal(originVerificationDisplay(config, 1000).reading.kind,
      agent === "running" ? "reaches_this_console" : "agent_unconfirmed")
  }
})

test("owner-operated proxies preserve fresh verification without an agent", () => {
  for (const agent of [undefined, null]) {
    const config = verifiedConfig()
    config.provider = "user_supplied_origin"
    assert.ok(config.origin_verified)
    if (agent === undefined) delete config.origin_verified.agent
    else config.origin_verified.agent = agent
    const markup = renderToStaticMarkup(createElement(OriginVerificationStatus, {
      consolePort: null, origin: "saved-origin", display: originVerificationDisplay(config, 1000),
    }))
    assert.match(markup, /this address reaches this DataConnect/)
  }
})

test("mounted verification expires without a config update and clears its interval on unmount", async (t) => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>")
  const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true }
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  const config = verifiedConfig()
  const data = { config, effectiveConsolePort: null, stableConsolePort: null, ownerPasswordOwnerSet: true,
    inspection: { availability: "available", authentication: "not_required" } }
  const live = mock.module(new URL("../components/live-provider.tsx", import.meta.url).href, {
    namedExports: { LiveReadAt: () => null, useLiveQuery: () => ({ data, dataUpdatedAt: 0, isError: false }) },
  })
  const unusedAction = async () => { throw new Error("Unexpected server action") }
  const actions = mock.module(new URL("./remote-access-actions.ts", import.meta.url).href, {
    namedExports: { loadRemoteAccessStateAction: unusedAction, restartAfterOwnerPasswordSetAction: unusedAction,
      requestOwnerPasswordWindowAction: unusedAction, setConsolePortAction: unusedAction, setRemoteAccessConfigAction: unusedAction },
  })
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1000_000 })
  const intervals = t.mock.method(globalThis, "setInterval")
  const clears = t.mock.method(globalThis, "clearInterval")
  const container = dom.window.document.createElement("div")
  const root = createRoot(container)
  let unmounted = false
  try {
    const { RemoteAccessSetting } = await import("./remote-access-setting.tsx")
    await act(async () => root.render(createElement(RemoteAccessSetting)))
    assert.match(container.textContent ?? "", /this address reaches this DataConnect/)
    assert.match(container.textContent ?? "", /Saved address:/)
    await act(async () => t.mock.timers.tick(150_000))
    assert.match(container.textContent ?? "", /this address reaches this DataConnect/)
    await act(async () => t.mock.timers.tick(1000))
    assert.doesNotMatch(container.textContent ?? "", /this address reaches this DataConnect/)
    assert.match(container.textContent ?? "", /Not checked since/)
    assert.equal(data.config, config)
    assert.equal(intervals.mock.callCount(), 1)
    const intervalCall = intervals.mock.calls[0]
    assert.ok(intervalCall)
    const timer = intervalCall.result
    await act(async () => root.unmount())
    unmounted = true
    assert.ok(clears.mock.calls.some(call => call.arguments[0] === timer), "verification interval must be cleared")
  } finally {
    if (!unmounted) await act(async () => root.unmount())
    intervals.mock.restore()
    clears.mock.restore()
    t.mock.timers.reset()
    live.restore()
    actions.restore()
    dom.window.close()
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
