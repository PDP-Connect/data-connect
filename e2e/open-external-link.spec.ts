// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Runtime proof for the console-to-native open-external-url bridge
 * (`OpenExternalLink`, apps/console/src/app/(console)/components/
 * open-external-link.tsx -> owner-open-external-url.ts ->
 * open_external_url.rs).
 *
 * THIS SPEC PREVIOUSLY PASSED FIVE TIMES WHILE EVERY ONE OF THE 35 CALL
 * SITES WAS COMPLETELY DEAD IN THE REAL SHIPPED APP. Its `markAsTauriRuntime`
 * helper injected `window.__TAURI_INTERNALS__ = {}` before every test ran --
 * a flag that is ALWAYS ABSENT in the real console window (Tauri Discussion
 * #2650: `WebviewUrl::External` never gets Tauri's IPC injection, so neither
 * `__TAURI__` nor `__TAURI_INTERNALS__` is ever set there, in any build).
 * The component's `isTauriRuntime()` gate checked exactly those two flags,
 * so this spec was testing a synthetic condition engineered to make the
 * gate pass -- it never once exercised the actual, unmodified runtime
 * condition a real click hits. Confirmed directly against a real running
 * app, not assumed: the gate always evaluated false there, so the bridge
 * never fired, for every build since #200 merged.
 *
 * The fix removed the gate entirely -- the bridge is attempted
 * unconditionally now, with a `window.open` fallback for whichever case it
 * fails in (plain browser tab, desktop app not running). That makes a PLAIN
 * Playwright browser -- no injected flags, no synthetic runtime markers --
 * the CORRECT test of the real behavior for the first time: this is what
 * the click looks like in the actual shipped console, not a stand-in for
 * it. Keep it that way. If a future change reintroduces a runtime gate,
 * this spec should fail loudly rather than quietly get "fixed" by injecting
 * whatever flag makes it pass again.
 *
 * This test cannot exercise the Rust half (open::that_detached actually
 * spawning a system-browser process) -- Playwright drives a plain browser
 * over the console's HTTP port, not the Tauri webview, and there is no
 * native process on the other end here to observe. See
 * `owner-open-external-url-route.test.ts` and
 * `src-tauri/src/commands/open_external_url.rs`'s unit tests for the parts
 * this test cannot reach: the HTTP route's scheme validation (covered
 * end-to-end below) and the Rust queue-apply logic (covered by Rust unit
 * tests only, plus a manual verification recorded in the PR body).
 *
 * Target a running console with:
 *   E2E_BASE_URL=http://127.0.0.1:PORT E2E_OWNER_PASSWORD=... \
 *     npx playwright test open-external-link.spec.ts
 */
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { expect, test } from "@playwright/test"

const BASE_URL = process.env.E2E_BASE_URL ?? "http://127.0.0.1:1421"
const OWNER_PASSWORD = process.env.E2E_OWNER_PASSWORD ?? ""
// Optional: PDPP_DATA_DIR of the target instance. When set, this spec reads
// open-external-url-queue.json directly after the click and asserts the
// exact URL landed there -- the strongest available proof short of running
// inside the real Tauri process, which this Playwright-over-HTTP harness
// cannot do (see the module doc above). Skipped when unset because a
// remotely-tunneled console's data dir is not filesystem-visible here.
const DATA_DIR = process.env.E2E_PDPP_DATA_DIR

async function loginAsOwner(
  page: import("@playwright/test").Page
): Promise<void> {
  if (!OWNER_PASSWORD) {
    throw new Error("E2E_OWNER_PASSWORD is not set.")
  }
  await page.goto(`${BASE_URL}/owner/login?return_to=%2F`)
  await page.getByLabel("Owner password").fill(OWNER_PASSWORD)
  const [response] = await Promise.all([
    page.waitForResponse(
      res =>
        res.url().includes("/owner/login") && res.request().method() === "POST"
    ),
    page.getByRole("button", { name: "Sign in" }).click(),
  ])
  expect(response.status()).toBeLessThan(400)
  await page.waitForLoadState("networkidle")
}

test("clicking an external link in a real (unmodified) browser POSTs to the owner open-external-url bridge, not a dead invoke()", async ({
  page,
}) => {
  await loginAsOwner(page)
  await page.goto(`${BASE_URL}/settings`, { waitUntil: "networkidle" })

  const docsLink = page.getByRole("link", { name: "Docs" })
  await expect(docsLink).toBeVisible()

  const bridgeRequest = page.waitForRequest(
    req =>
      req.url().includes("/owner/open-external-url") ||
      (req.url() === `${BASE_URL}/settings` && req.method() === "POST")
  )

  const consoleErrors: string[] = []
  page.on("console", msg => {
    if (msg.type() === "error") consoleErrors.push(msg.text())
  })

  await docsLink.click()

  // The Server Action posts back to the current page URL (Next.js Server
  // Action wire protocol), not directly to /v1/owner/open-external-url from
  // the browser -- that internal-network hop happens server-side in
  // open-external-url-client.ts. So the observable browser-side proof is:
  // (a) a POST fires (the action was invoked at all, unlike the dead
  // invoke() promise that previously vanished with nothing sent), and
  // (b) it resolves without surfacing the "Failed to open external link"
  // console.error the component logs on a rejected action result.
  const request = await bridgeRequest
  const response = await request.response()
  expect(
    response?.status(),
    "expected the open-external-url Server Action POST to succeed"
  ).toBeLessThan(400)

  expect(
    consoleErrors.filter(text => text.includes("Failed to open external link")),
    "a successful bridge call must not log the open-external-link failure path"
  ).toEqual([])

  if (DATA_DIR) {
    const queuePath = join(DATA_DIR, "open-external-url-queue.json")
    const queue = JSON.parse(await readFile(queuePath, "utf8")) as {
      pending: { id: number; url: string }[]
    }
    expect(
      queue.pending.some(entry => entry.url === "https://pdpp.dev/"),
      `expected open-external-url-queue.json to contain the Docs link's URL; found ${JSON.stringify(queue.pending)}`
    ).toBe(true)
  }
})
