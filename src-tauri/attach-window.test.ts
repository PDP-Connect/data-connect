// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { JSDOM } from "jsdom"
import { describe, expect, it } from "vitest"

type Call = { command: string; args: Record<string, unknown> }
type Inspect = Record<string, unknown>
type Scripted = Inspect | Promise<Inspect>

const html = readFileSync(resolve(process.cwd(), "public/attach.html"), "utf-8")
const settle = () => new Promise(done => setTimeout(done, 0))

// Runs the real inline script of the "Connect to a server" window against a
// scripted Tauri bridge.
// What the app's native side answers when it refuses a command because the
// calling window or page is not the attach window. The checks themselves are
// native and are tested in Rust (attach_window_tests.rs); this suite checks
// what the window does with a refusal.
const REFUSED_WINDOW = "Only the DataConnect attach window can do this."
const REFUSED_PAGE = "Command attach_with_pairing_code not allowed by ACL"

async function openWindow(
  inspections: Scripted[],
  attachError?: string,
  options: { bridge?: boolean; refuse?: string } = {}
) {
  // `policy.refuse` can change after the window loaded, as it does when the
  // window's page navigates away from the app.
  const policy = { refuse: options.refuse as string | undefined }
  const calls: Call[] = []
  const queue = [...inspections]
  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    beforeParse(window) {
      const invoke = async (command: string, args: Record<string, unknown> = {}) => {
        calls.push({ command, args })
        if (policy.refuse) throw policy.refuse
        if (command === "attach_window_view") return { input: "" }
        if (command === "preview_attach_target") return null
        if (command === "inspect_server") return queue.shift()
        if (command === "attach_with_pairing_code") {
          if (attachError) throw attachError
          return { origin: "https://a.example.test" }
        }
        return null
      }
      if (options.bridge !== false) {
        ;(window as unknown as { __TAURI__: unknown }).__TAURI__ = { core: { invoke } }
      }
    },
  })
  await settle()
  const doc = dom.window.document
  const $ = <T extends HTMLElement>(id: string) => doc.getElementById(id) as T
  const server = $<HTMLInputElement>("server-input")
  const code = $<HTMLInputElement>("code-input")
  const visible = (id: string) => $(id).classList.contains("visible")
  return {
    calls,
    code,
    server,
    policy,
    text: (id: string) => $(id).textContent ?? "",
    visible,
    disabled: (id: string) => $<HTMLButtonElement>(id).disabled,
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
    continueClick: async () => {
      $("continue-button").click()
      await settle()
    },
    attachCalls: () => calls.filter(c => c.command.startsWith("attach_with_")),
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
    expect(page.code.value).toBe("typed-code")
    await page.connect()

    expect(page.lastAttach()).toMatchObject({ confirmedKey: "key-a", code: "typed-code" })
  })

  it("a rejected attach shows the error, can be retried, and reports no success", async () => {
    const page = await openWindow([{ ...serverA, code: "code-a" }], "That pairing code has expired.")
    await page.continueWith("https://a.example.test/attach?code=code-a")
    await page.connect()

    expect(page.visible("error")).toBe(true)
    expect(page.text("error")).toBe("That pairing code has expired.")
    expect(page.visible("notice")).toBe(false)
    expect(page.text("notice")).not.toContain("Connected")
    expect(page.disabled("attach-button")).toBe(false)
    expect(page.disabled("continue-button")).toBe(false)
    expect(page.calls.map(c => c.command)).not.toContain("detach_from_server")

    await page.connect()
    expect(page.attachCalls()).toHaveLength(2)
  })

  it("a stale inspection that resolves after the link was edited cannot authorize anything", async () => {
    let resolveA!: (value: Inspect) => void
    const inspectionA = new Promise<Inspect>(done => {
      resolveA = done
    })
    const page = await openWindow([inspectionA, { ...serverB, code: "code-b" }])

    await page.type(page.server, "https://a.example.test/attach?code=code-a")
    await page.continueClick()
    // The owner edits the link while A is still being checked, then checks B.
    await page.type(page.server, "https://b.example.test/attach?code=code-b")
    await page.continueClick()
    expect(page.text("confirm-server")).toBe("https://b.example.test")
    expect(page.attachCalls()).toEqual([])

    resolveA({ ...serverA, code: "code-a" })
    await settle()
    expect(page.attachCalls()).toEqual([])

    expect(page.text("confirm-server")).toBe("https://b.example.test")
    expect(page.text("confirm-id")).toBe("id-b")
    expect(page.code.value).toBe("code-b")
    await page.connect()
    expect(page.attachCalls()).toHaveLength(1)
    expect(page.lastAttach()).toMatchObject({
      input: "https://b.example.test/attach?code=code-b",
      confirmedKey: "key-b",
      code: "code-b",
    })
  })

  it("a stale inspection that resolves after the link was edited leaves nothing to confirm", async () => {
    let resolveA!: (value: Inspect) => void
    const inspectionA = new Promise<Inspect>(done => {
      resolveA = done
    })
    const page = await openWindow([inspectionA])

    await page.type(page.server, "https://a.example.test/attach?code=code-a")
    await page.continueClick()
    await page.type(page.server, "https://b.example.test")
    resolveA({ ...serverA, code: "code-a" })
    await settle()

    expect(page.visible("confirm")).toBe(false)
    expect(page.code.value).toBe("")
    await page.connect()
    expect(page.attachCalls()).toEqual([])
  })

  it("without the Tauri bridge the window says it is unavailable and attaches nothing", async () => {
    const page = await openWindow([{ ...serverA, code: "code-a" }], undefined, { bridge: false })

    expect(page.visible("error")).toBe(true)
    expect(page.text("error")).toContain("cannot reach DataConnect")
    expect(page.disabled("continue-button")).toBe(true)
    expect(page.disabled("attach-button")).toBe(true)
    await page.connect()
    expect(page.calls).toEqual([])
    expect(page.visible("confirm")).toBe(false)
  })

  // Same bridge, same pairing input; only whether the native side accepts the
  // calling window or page changes.
  describe("which window may attach", () => {
    const link = "https://a.example.test/attach?code=code-a"

    it("the attach window reaches pairing once and reports success", async () => {
      const page = await openWindow([{ ...serverA, code: "code-a" }])
      await page.continueWith(link)
      await page.connect()

      expect(page.attachCalls()).toHaveLength(1)
      expect(page.attachCalls()[0]?.args).toMatchObject({ input: link, confirmedKey: "key-a", code: "code-a" })
      expect(page.text("notice")).toContain("Connected to https://a.example.test")
      expect(page.visible("error")).toBe(false)
    })

    it("a window that is refused from the start shows the refusal and reports no success", async () => {
      const page = await openWindow([{ ...serverA, code: "code-a" }], undefined, { refuse: REFUSED_WINDOW })
      expect(page.text("error")).toBe(REFUSED_WINDOW)

      await page.continueWith(link)
      await page.connect()

      expect(page.visible("confirm")).toBe(false)
      expect(page.text("error")).toBe(REFUSED_WINDOW)
      expect(page.attachCalls()).toEqual([])
      expect(page.visible("notice")).toBe(false)
    })

    it("a page that is refused after the view was created shows the refusal and reports no success", async () => {
      const page = await openWindow([{ ...serverA, code: "code-a" }])
      await page.continueWith(link)
      expect(page.visible("confirm")).toBe(true)

      // The window navigated away from the app's own page.
      page.policy.refuse = REFUSED_PAGE
      await page.connect()

      expect(page.attachCalls()).toHaveLength(1)
      expect(page.text("error")).toBe(REFUSED_PAGE)
      expect(page.visible("notice")).toBe(false)
      expect(page.text("notice")).not.toContain("Connected")
      expect(page.disabled("attach-button")).toBe(false)

      // A retry is a new attempt with a new answer: the window must show that
      // answer, not keep the first one or stay silent.
      const second = `${REFUSED_PAGE} (second attempt)`
      page.policy.refuse = second
      await page.connect()

      expect(page.attachCalls()).toHaveLength(2)
      expect(page.text("error")).toBe(second)
      expect(page.visible("notice")).toBe(false)
      expect(page.disabled("attach-button")).toBe(false)
    })
  })
})
