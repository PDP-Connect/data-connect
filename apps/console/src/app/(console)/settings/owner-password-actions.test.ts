// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict"
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mock, test } from "node:test"

type OwnerPasswordActions = typeof import("./owner-password-actions.ts")
type RemoteAccessActions = typeof import("./remote-access-actions.ts")

const PROOF = "desktop-reveal-proof-0928"

// The value of the local proof cookie on the next request; null sends none.
let cookieValue: string | null = null
// How the desktop answers an OS re-auth request.
let reauthStatus = "skipped_linux_polkit_unverified"

let loaded: Promise<{
  owner: OwnerPasswordActions
  remote: RemoteAccessActions
}> | null = null

// The real actions and the real proof check in owner-credential-client.ts.
// Only the request cookie, the session check and the desktop's answer to an
// OS re-auth request are faked. The RI's request writers are real, so a
// test counts the request files they write.
function loadActions() {
  loaded ??= (async () => {
    mock.module("next/cache", {
      namedExports: { revalidatePath: () => {} },
    })
    mock.module("next/headers", {
      namedExports: {
        cookies: async () => ({
          get: (name: string) =>
            cookieValue === null ? undefined : { name, value: cookieValue },
        }),
      },
    })
    mock.module(new URL("../lib/dashboard-access.ts", import.meta.url).href, {
      namedExports: { requireDashboardAccess: async () => {} },
    })
    mock.module(new URL("../lib/verify-session.ts", import.meta.url).href, {
      namedExports: { verifyDashboardSession: async () => {} },
    })
    mock.module(new URL("../lib/login-redirect.ts", import.meta.url).href, {
      namedExports: { redirectToOwnerLogin: async () => {} },
    })
    mock.module(new URL("../lib/owner-token.ts", import.meta.url).href, {
      namedExports: {
        getAsInternalUrl: () => "http://127.0.0.1:1",
        getOwnerToken: async () => "unused",
        getRsInternalUrl: () => "http://127.0.0.1:1",
        ReferenceServerUnreachableError: Error,
        ResourceServerHttpError: Error,
        withOwnerSessionCookie: async (init: RequestInit = {}) => init,
      },
    })
    mock.module(
      new URL("../lib/remote-access-client.ts", import.meta.url).href,
      {
        namedExports: Object.fromEntries(
          [
            "getRemoteAccessConfig",
            "inspectCloudflareTunnelRemoteAccess",
            "inspectMyDevicesOnlyRemoteAccess",
            "inspectNgrokRemoteAccess",
            "inspectRemoteAccess",
            "setConsolePort",
            "setRemoteAccessConfig",
          ].map(name => [name, async () => ({})])
        ),
      }
    )
    const ownerSet =
      await import("pdpp-reference-implementation/owner-password-owner-set")
    mock.module("pdpp-reference-implementation/owner-password-owner-set", {
      namedExports: {
        ...ownerSet,
        readOwnerOsReauthRequest: async (
          _dataDir: string,
          requestId: number
        ) => ({
          completedRequestId: requestId,
          grantId: "grant-0928",
          requestId,
          status: reauthStatus,
        }),
      },
    })
    return {
      owner: await import("./owner-password-actions.ts"),
      remote: await import("./remote-access-actions.ts"),
    }
  })()
  return loaded
}

interface Desktop {
  platform: NodeJS.Platform
  proof: string | undefined
  cookie: string | null
  posture?: string
}

// Runs `run` as the desktop console on `platform`, with the desktop-given
// proof and the request's cookie, in a fresh data directory. Returns the
// result, the request files written, and the stack-restart request.
async function onDesktop<T>(
  desktop: Desktop,
  run: () => Promise<T>
): Promise<{ result: T; files: string[]; restart?: unknown }> {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")
  const names = [
    "PDPP_DATA_DIR",
    "PDPP_MANAGED_DESKTOP_HOST",
    "PDPP_OWNER_CREDENTIAL_REVEAL_PROOF",
    "PDPP_OWNER_PASSWORD_SOURCE",
  ] as const
  const saved = new Map(names.map(name => [name, process.env[name]]))
  const dataDir = await mkdtemp(join(tmpdir(), "owner-password-actions-"))
  if (desktop.posture)
    await writeFile(
      join(dataDir, "remote-access.json"),
      JSON.stringify({ posture: desktop.posture })
    )
  Object.defineProperty(process, "platform", { value: desktop.platform })
  process.env.PDPP_DATA_DIR = dataDir
  process.env.PDPP_MANAGED_DESKTOP_HOST = "1"
  process.env.PDPP_OWNER_PASSWORD_SOURCE = "desktop_generated"
  if (desktop.proof === undefined)
    delete process.env.PDPP_OWNER_CREDENTIAL_REVEAL_PROOF
  else process.env.PDPP_OWNER_CREDENTIAL_REVEAL_PROOF = desktop.proof
  cookieValue = desktop.cookie
  reauthStatus =
    desktop.platform === "linux" ? "skipped_linux_polkit_unverified" : "authenticated"
  try {
    const result = await run()
    const files = (await readdir(dataDir)).filter(
      name => name.startsWith("owner-") && !name.endsWith(".lock")
    )
    const restart = files.includes("owner-password-stack-restart-request.json")
      ? JSON.parse(
          await readFile(
            join(dataDir, "owner-password-stack-restart-request.json"),
            "utf8"
          )
        )
      : undefined
    return { files: files.sort(), restart, result }
  } finally {
    if (platform) Object.defineProperty(process, "platform", platform)
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    await rm(dataDir, { force: true, recursive: true })
  }
}

const REFUSED = /from the local desktop app/

for (const platform of ["linux", "darwin", "win32"] as const) {
  test(`${platform}: a password change from the desktop's own webview opens the window`, async () => {
    const { owner } = await loadActions()
    const { files, result } = await onDesktop(
      { cookie: PROOF, platform, proof: PROOF },
      () => owner.requestDesktopOwnerPasswordChangeAction()
    )
    assert.deepEqual(result, {
      linuxPolkitUnverified: platform === "linux",
      ok: true,
    })
    assert.ok(
      files.some(name => name.startsWith("owner-os-reauth-request-")),
      `${files}`
    )
    assert.ok(
      files.some(name => name.startsWith("owner-password-window-request-")),
      `${files}`
    )
  })

  for (const [label, desktop] of [
    ["a forged proof cookie", { cookie: "forged-by-remote-browser", proof: PROOF }],
    ["no proof cookie (a remote browser)", { cookie: null, proof: PROOF }],
    ["a proof of a different length", { cookie: `${PROOF}x`, proof: PROOF }],
    ["an empty desktop proof", { cookie: "", proof: "" }],
    ["no desktop proof", { cookie: PROOF, proof: undefined }],
  ] as const) {
    test(`${platform}: ${label} is refused before the OS prompt or window is requested`, async () => {
      const { owner } = await loadActions()
      const { files, result } = await onDesktop({ ...desktop, platform }, () =>
        owner.requestDesktopOwnerPasswordChangeAction()
      )
      assert.equal(result.ok, false)
      assert.match(result.message ?? "", REFUSED)
      assert.deepEqual(files, [])

      const reveal = await onDesktop({ ...desktop, platform }, () =>
        owner.requireOwnerOsReauthAction()
      )
      assert.equal(reveal.result.ok, false)
      assert.deepEqual(reveal.files, [])
    })
  }
}

test("the first-password window and the restart need the verified local proof", async () => {
  const { remote } = await loadActions()
  for (const cookie of ["forged-by-remote-browser", null]) {
    const window = await onDesktop(
      { cookie, platform: "darwin", proof: PROOF },
      () => remote.requestOwnerPasswordWindowAction()
    )
    assert.equal(window.result.ok, false)
    assert.deepEqual(window.files, [])
    const restart = await onDesktop(
      { cookie, platform: "darwin", proof: PROOF },
      () => remote.restartAfterOwnerPasswordSetAction()
    )
    assert.equal(restart.result.ok, false)
    assert.deepEqual(restart.files, [])
  }

  const window = await onDesktop(
    { cookie: PROOF, platform: "darwin", proof: PROOF },
    () => remote.requestOwnerPasswordWindowAction()
  )
  assert.deepEqual(window.result, { ok: true })
  assert.ok(
    window.files.some(name => name.startsWith("owner-password-window-request-")),
    `${window.files}`
  )
  const restart = await onDesktop(
    { cookie: PROOF, platform: "darwin", proof: PROOF },
    () => remote.restartAfterOwnerPasswordSetAction()
  )
  assert.deepEqual(restart.result, { ok: true })
  assert.deepEqual(restart.files, ["owner-password-stack-restart-request.json"])
})

// The migration path: the owner picks their first password on an install
// that had remote access on before the password gate. A phone may be signed
// in with the generated password, so the restart revokes every session.
// True first setup (remote access off) revokes nothing.
test("the first-password restart revokes sessions only when remote access was already on", async () => {
  const { remote } = await loadActions()
  const on = await onDesktop(
    { cookie: PROOF, platform: "darwin", posture: "public_url", proof: PROOF },
    () => remote.restartAfterOwnerPasswordSetAction()
  )
  assert.deepEqual(on.result, { ok: true })
  assert.deepEqual(on.restart, {
    requestId: 1,
    revokeReason: "password_change",
    revokeSessions: true,
  })
  const off = await onDesktop(
    { cookie: PROOF, platform: "darwin", posture: "off", proof: PROOF },
    () => remote.restartAfterOwnerPasswordSetAction()
  )
  assert.deepEqual(off.result, { ok: true })
  assert.deepEqual(off.restart, { requestId: 1 })
})
