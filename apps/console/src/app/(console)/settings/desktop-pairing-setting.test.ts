// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { mock, test } from "node:test"
import { fileURLToPath } from "node:url"
import * as React from "react"
import { createElement } from "react"
Object.assign(globalThis, { React })
import { renderToStaticMarkup } from "react-dom/server"

type Setting = typeof import("./desktop-pairing-setting.tsx")

const HERE = fileURLToPath(new URL(".", import.meta.url))
const CODE = "ABCD-EFGH-JKLM"
const KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"
const FINGERPRINT = "MMG4-2KLG-YQZW-NEIS"
const ORIGIN = "https://x.example"
const LINK = `${ORIGIN}/settings#code=${CODE}&key=${KEY}`
const LIVE = {
  code: CODE,
  link: LINK,
  serverFingerprint: FINGERPRINT,
  serverOrigin: ORIGIN,
}

let loaded: Promise<Setting> | null = null

// The real component with the server action replaced: a render never calls
// it, but importing the real one needs a Next.js request.
function loadSetting(): Promise<Setting> {
  loaded ??= (async () => {
    mock.module(new URL("./desktop-pairing-actions.ts", import.meta.url).href, {
      namedExports: {
        createDesktopPairingAction: async () => ({
          message: "unused",
          ok: false,
        }),
      },
    })
    return await import("./desktop-pairing-setting.tsx")
  })()
  return loaded
}

test("before a code exists the section offers only the button and the one-line rule", async () => {
  const { DesktopPairingSetting } = await loadSetting()
  const html = renderToStaticMarkup(createElement(DesktopPairingSetting))
  assert.match(html, /Connect a DataConnect app on another computer/)
  // Round 8 (F40): the row looks like its neighbours: foreground text and the same arrow.
  assert.match(html, /text-foreground[^>]*>Connect a DataConnect app on another computer <span aria-hidden="true">→<\/span>/)
  // Brief settings-pages, decision 1: paired computers appear under Signed-in devices.
  assert.doesNotMatch(html, /Create pairing code/)
  assert.doesNotMatch(html, /Expires in/)
  assert.doesNotMatch(html, /vana:\/\//)
})

test("a live code shows the address, code, Server ID and link, three copy buttons, the countdown and the instruction", async () => {
  const { DesktopPairingDisplay } = await loadSetting()
  const html = renderToStaticMarkup(
    createElement(DesktopPairingDisplay, { ...LIVE, remainingSeconds: 582 })
  )
  assert.match(html, new RegExp(CODE))
  assert.ok(html.includes(`value="${ORIGIN}"`))
  assert.ok(html.includes(FINGERPRINT))
  assert.match(html, /Server ID/)
  // RAISE-RULES.md 4: the raw server ID stays inside the folded Details section.
  assert.doesNotMatch(html, /<details>/)
  assert.match(html, /Expires in 9:42/)
  assert.match(html, /readOnly|readonly/)
  assert.ok(html.includes(`value="${LINK.replaceAll("&", "&amp;")}"`))
  assert.equal(html.match(/>Copy</g)?.length, 3)
  for (const label of ["server address", "pairing code", "pairing link"]) {
    assert.match(html, new RegExp(`aria-label="Copy ${label}"`))
  }
  assert.match(
    html,
    /In the DataConnect desktop app choose Connect to a server, then\s+paste the link \(or the address and the code\)\./
  )
  assert.doesNotMatch(html, /vana:\/\//)
})

test("at zero the code and link are gone and the panel says to make a new one", async () => {
  const { DesktopPairingDisplay } = await loadSetting()
  const html = renderToStaticMarkup(
    createElement(DesktopPairingDisplay, { ...LIVE, remainingSeconds: 0 })
  )
  assert.match(html, /Expired\. Create a new code\./)
  assert.doesNotMatch(html, new RegExp(CODE))
  assert.doesNotMatch(html, new RegExp(FINGERPRINT))
  assert.doesNotMatch(html, /vana:\/\//)
  assert.doesNotMatch(html, />Copy</)
})

test("the settings page shows the section whenever owner sessions are shown", async () => {
  const page = await readFile(`${HERE}page.tsx`, "utf8")
  const sessions = page.indexOf("{ownerSessions.enabled ? (")
  const pairing = page.indexOf("<DesktopPairingSetting", page.indexOf('title="Advanced"'))
  assert.ok(sessions >= 0 && pairing > sessions)
  const gate = page.slice(page.lastIndexOf("{ownerSessions.enabled ? (", pairing), pairing)
  assert.match(gate, /ownerSessions\.enabled/)
  assert.match(page, /<DesktopPairingSetting \/>/)
  // Brief settings-pages, decision 1: desktop pairing stays within the Sign-in section.
  assert.match(page, /title="Advanced"[\s\S]*?<DesktopPairingSetting/)
})

test("the pairing action stays a server-only module and the setting a client module", async () => {
  const action = await readFile(`${HERE}desktop-pairing-actions.ts`, "utf8")
  const setting = await readFile(`${HERE}desktop-pairing-setting.tsx`, "utf8")
  assert.match(action, /^"use server"/)
  assert.match(setting, /^"use client"/)
  // The code is a pairing secret: neither file may log it.
  assert.doesNotMatch(action, /console\./)
  assert.doesNotMatch(setting, /console\./)
})
