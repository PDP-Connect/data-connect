// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict"
import { mock, test } from "node:test"

type Actions = typeof import("./owner-password-actions.ts")

// What the fakes below saw and return.
let localProof = false
let reauthRequests = 0
const windowRequests: unknown[] = []

let loaded: Promise<Actions> | null = null

// The real actions with the session check, the proof cookie and the RI's
// request-file writers replaced. The desktop answers every OS re-auth
// request the way it does on Linux: no prompt, and a change grant.
function loadActions(): Promise<Actions> {
  loaded ??= (async () => {
    mock.module("next/cache", {
      namedExports: { revalidatePath: () => {} },
    })
    mock.module(new URL("../lib/dashboard-access.ts", import.meta.url).href, {
      namedExports: { requireDashboardAccess: async () => {} },
    })
    mock.module(new URL("../lib/login-redirect.ts", import.meta.url).href, {
      namedExports: { redirectToOwnerLogin: async () => {} },
    })
    mock.module(new URL("../lib/owner-token.ts", import.meta.url).href, {
      namedExports: {
        getAsInternalUrl: () => "http://127.0.0.1:1",
        withOwnerSessionCookie: async (init: RequestInit = {}) => init,
      },
    })
    mock.module(
      new URL("../lib/owner-credential-client.ts", import.meta.url).href,
      {
        namedExports: {
          hasLocalOwnerCredentialRevealProofCookie: async () => localProof,
        },
      }
    )
    const ownerSet =
      await import("pdpp-reference-implementation/owner-password-owner-set")
    mock.module("pdpp-reference-implementation/owner-password-owner-set", {
      namedExports: {
        ownerOsReauthAllowsReveal: ownerSet.ownerOsReauthAllowsReveal,
        ownerOsReauthSucceeded: ownerSet.ownerOsReauthSucceeded,
        readOwnerOsReauthRequest: async (
          _dataDir: string,
          requestId: number
        ) => ({
          completedRequestId: requestId,
          grantId: "grant-linux",
          requestId,
          status: "skipped_linux_polkit_unverified",
        }),
        requestOwnerOsReauth: async () => {
          reauthRequests += 1
          return { requestId: 7 }
        },
        requestOwnerPasswordWindow: async (
          _dataDir: string,
          options: unknown
        ) => {
          windowRequests.push(options)
          return { requestId: 8 }
        },
      },
    })
    return await import("./owner-password-actions.ts")
  })()
  return loaded
}

async function onDesktopLinux<T>(run: () => Promise<T>): Promise<T> {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")
  const saved = {
    host: process.env.PDPP_MANAGED_DESKTOP_HOST,
    source: process.env.PDPP_OWNER_PASSWORD_SOURCE,
  }
  Object.defineProperty(process, "platform", { value: "linux" })
  process.env.PDPP_MANAGED_DESKTOP_HOST = "1"
  process.env.PDPP_OWNER_PASSWORD_SOURCE = "desktop_generated"
  try {
    return await run()
  } finally {
    if (platform) Object.defineProperty(process, "platform", platform)
    for (const [name, value] of [
      ["PDPP_MANAGED_DESKTOP_HOST", saved.host],
      ["PDPP_OWNER_PASSWORD_SOURCE", saved.source],
    ] as const) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

test("Linux password change opens the window from the desktop's own webview", async () => {
  const { requestDesktopOwnerPasswordChangeAction } = await loadActions()
  localProof = true
  reauthRequests = 0
  windowRequests.length = 0
  const result = await onDesktopLinux(() =>
    requestDesktopOwnerPasswordChangeAction()
  )
  assert.deepEqual(result, { linuxPolkitUnverified: true, ok: true })
  assert.deepEqual(windowRequests, [
    { grantForRequestId: 7, grantId: "grant-linux", purpose: "change" },
  ])
})

test("Linux password change is refused without the local proof, before any request is written", async () => {
  const { requestDesktopOwnerPasswordChangeAction } = await loadActions()
  localProof = false
  reauthRequests = 0
  windowRequests.length = 0
  const result = await onDesktopLinux(() =>
    requestDesktopOwnerPasswordChangeAction()
  )
  assert.equal(result.ok, false)
  assert.match(result.message ?? "", /from the local desktop app/)
  assert.equal(reauthRequests, 0)
  assert.deepEqual(windowRequests, [])
})
