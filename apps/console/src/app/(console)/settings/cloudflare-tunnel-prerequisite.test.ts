// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict"
import test from "node:test"
import {
  CLOUDFLARE_TUNNEL_POLL_FETCH_FAILED_REASON,
  CLOUDFLARE_TUNNEL_POLL_TIMEOUT_REASON,
  decodeCloudflareTunnelToken,
  nextConnectionStatus,
} from "./cloudflare-tunnel-prerequisite.tsx"
import { offRemoteAccessConfig } from "./remote-access.ts"

// The exact tunnel ID from Tim's own real Cloudflare dashboard tunnel
// ("DataConnect Testing"), confirmed live 2026-09-21 -- using a real,
// previously-observed ID here rather than an arbitrary one keeps this test
// traceable to something that actually happened, not just plausible-looking
// fiction.
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

test("nextConnectionStatus reports connected once the config gains a real origin", () => {
  const config = {
    ...offRemoteAccessConfig(),
    fields: { ...offRemoteAccessConfig().fields, PDPP_REFERENCE_ORIGIN: "https://vault.example.com" },
  }
  assert.deepEqual(nextConnectionStatus({ kind: "config", config }, 4000), {
    phase: "connected",
    origin: "https://vault.example.com",
  })
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
