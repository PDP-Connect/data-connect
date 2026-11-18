// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { mock, test } from "node:test"
import { fileURLToPath } from "node:url"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

type Setting = typeof import("./desktop-pairing-setting.tsx")

const HERE = fileURLToPath(new URL(".", import.meta.url))
const CODE = "ABCD-EFGH-JKLM"
const LINK = `vana://attach?server=https%3A%2F%2Fx.example&code=${CODE}`

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
  assert.match(html, /Create pairing code/)
  assert.match(
    html,
    /A code works once and expires in 10 minutes\. Paired computers appear\s+under Owner sessions and can be signed out there\./
  )
  assert.doesNotMatch(html, /Expires in/)
  assert.doesNotMatch(html, /vana:\/\//)
})

test("a live code shows the code, the link, a copy button, the countdown and the steps", async () => {
  const { DesktopPairingDisplay } = await loadSetting()
  const html = renderToStaticMarkup(
    createElement(DesktopPairingDisplay, {
      code: CODE,
      link: LINK,
      remainingSeconds: 582,
    })
  )
  assert.match(html, new RegExp(CODE))
  assert.match(html, /Expires in 9:42/)
  assert.match(html, /readOnly|readonly/)
  assert.ok(html.includes(`value="${LINK.replaceAll("&", "&amp;")}"`))
  assert.match(html, />Copy</)
  assert.match(html, /1\. Open DataConnect on your computer\./)
  assert.match(html, /2\. From the tray menu choose Attach to a server\./)
  assert.match(html, /3\. Paste this link, or enter this server/)
})

test("at zero the code and link are gone and the panel says to make a new one", async () => {
  const { DesktopPairingDisplay } = await loadSetting()
  const html = renderToStaticMarkup(
    createElement(DesktopPairingDisplay, {
      code: CODE,
      link: LINK,
      remainingSeconds: 0,
    })
  )
  assert.match(html, /Expired\. Create a new code\./)
  assert.doesNotMatch(html, new RegExp(CODE))
  assert.doesNotMatch(html, /vana:\/\//)
  assert.doesNotMatch(html, />Copy</)
})

test("the settings page shows the section whenever owner sessions are shown", async () => {
  const page = await readFile(`${HERE}page.tsx`, "utf8")
  const sessions = page.indexOf("{ownerSessions.enabled ? (")
  const pairing = page.indexOf('title="Attach a desktop app"')
  assert.ok(sessions >= 0 && pairing > sessions)
  const gate = page.slice(page.lastIndexOf("{ownerSessions.enabled ? (", pairing), pairing)
  assert.match(gate, /ownerSessions\.enabled/)
  assert.match(page, /<DesktopPairingSetting \/>/)
  assert.match(
    page,
    /Pair the DataConnect desktop app with this server\. The desktop shows this server's console and signs in as you\./
  )
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
