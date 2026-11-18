// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { JSDOM } from "jsdom"
import { describe, expect, it } from "vitest"

type Call = { command: string; args: Record<string, unknown> }
type Inspect = Record<string, unknown>

const html = readFileSync(resolve(process.cwd(), "public/attach.html"), "utf-8")
const settle = () => new Promise(done => setTimeout(done, 0))

// Runs the real inline script of the "Connect to a server" window against a
// scripted Tauri bridge.
async function openWindow(inspections: Inspect[], attachError?: string) {
  const calls: Call[] = []
  const queue = [...inspections]
  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    beforeParse(window) {
      const invoke = async (command: string, args: Record<string, unknown> = {}) => {
        calls.push({ command, args })
        if (command === "attach_window_view") return { input: "" }
        if (command === "preview_attach_target") return null
        if (command === "inspect_server") return queue.shift()
        if (command === "attach_with_pairing_code") {
          if (attachError) throw attachError
          return { origin: "https://a.example.test" }
        }
        return null
      }
      ;(window as unknown as { __TAURI__: unknown }).__TAURI__ = { core: { invoke } }
    },
  })
  await settle()
  const doc = dom.window.document
  const $ = <T extends HTMLElement>(id: string) => doc.getElementById(id) as T
  const server = $<HTMLInputElement>("server-input")
  const code = $<HTMLInputElement>("code-input")
  return {
    calls,
    code,
    async type(input: HTMLInputElement, value: string) {
      input.value = value
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }))
      await settle()
    },
    async continueWith(link: string) {
      await this.type(server, link)
      $("continue-button").click()
      await settle()
    },
    async connect() {
      $<HTMLFormElement>("attach-form").dispatchEvent(
        new dom.window.Event("submit", { bubbles: true, cancelable: true })
      )
      await settle()
    },
    lastAttach: () => calls.filter(c => c.command === "attach_with_pairing_code").at(-1)?.args,
  }
}

const serverA = { origin: "https://a.example.test", serverId: "id-a", serverKey: "key-a", matchesLink: true }
const serverB = { origin: "https://b.example.test", serverId: "id-b", serverKey: "key-b", matchesLink: true }

describe("attach window pairing code", () => {
  it("replacing a pairing link replaces its code before confirmation", async () => {
    const page = await openWindow(
      [
        { ...serverA, code: "code-a" },
        { ...serverB, code: "code-b" },
      ],
      "That pairing code has expired."
    )
    await page.continueWith("https://a.example.test/attach?code=code-a")
    await page.connect()
    expect(page.lastAttach()).toMatchObject({ confirmedKey: "key-a", code: "code-a" })

    await page.continueWith("https://b.example.test/attach?code=code-b")
    await page.connect()

    expect(page.lastAttach()).toMatchObject({
      input: "https://b.example.test/attach?code=code-b",
      confirmedKey: "key-b",
      code: "code-b",
    })
  })

  it("a fresh code for the same server replaces the expired one", async () => {
    const page = await openWindow(
      [
        { ...serverA, code: "code-a" },
        { ...serverA, code: "code-a2" },
      ],
      "That pairing code has expired."
    )
    await page.continueWith("https://a.example.test/attach?code=code-a")
    await page.connect()
    await page.continueWith("https://a.example.test/attach?code=code-a2")
    await page.connect()

    expect(page.lastAttach()).toMatchObject({ confirmedKey: "key-a", code: "code-a2" })
  })

  it("editing the link clears a code the page filled in", async () => {
    const page = await openWindow([{ ...serverA, code: "code-a" }])
    await page.continueWith("https://a.example.test/attach?code=code-a")
    expect(page.code.value).toBe("code-a")
    await page.type(page.code.ownerDocument.getElementById("server-input") as HTMLInputElement, "x")
    expect(page.code.value).toBe("")
  })

  it("hand-typed code survives a code-less re-inspect", async () => {
    const page = await openWindow([serverA, serverA])
    await page.continueWith("https://a.example.test")
    await page.type(page.code, "typed-code")
    await page.continueWith("https://a.example.test")
    await page.type(page.code, "typed-code")
    await page.connect()

    expect(page.lastAttach()).toMatchObject({ confirmedKey: "key-a", code: "typed-code" })
  })
})
